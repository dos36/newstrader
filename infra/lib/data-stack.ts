import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
} from 'aws-cdk-lib';
import type { StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

/**
 * Data stack: S3 buckets + RDS Postgres. Deploys ~never.
 *
 * NETWORKING STANCE (architecture §4.4 — deliberate, do not "fix"):
 * There is NO app VPC, NO NAT gateway, NO interface endpoints. Every Lambda runs
 * outside any VPC ($0 networking); the one thing that must live in a VPC — RDS —
 * sits in the account's DEFAULT VPC's public subnets, publicly accessible, with
 * TLS forced (rds.force_ssl=1) and scram-sha-256 password auth. For a paper-trading
 * system whose DB holds no secrets of value, private networking is cost without
 * threat-model justification (NAT: $33/mo + $0.045/GB; endpoints: $22/mo).
 *
 * THE LAMBDA-EGRESS PROBLEM: Lambdas outside a VPC egress from Amazon's shared
 * pool — there is no stable CIDR to allowlist. So the security group has:
 *   1. an always-on ingress from `DbAllowlistCidr` (the operator's own IP,
 *      default 127.0.0.1/32 i.e. effectively closed — override at deploy), and
 *   2. a 0.0.0.0/0:5432 ingress that exists ONLY when `DbOpenIngress=ENABLED`
 *      (default DISABLED). Flipping it on is what actually lets the no-VPC
 *      Lambdas reach Postgres. The tradeoff is explicit: with it enabled, the
 *      perimeter is not the network — scram-sha-256 auth + forced TLS + a
 *      32-char generated password are the real gate, and 5432 will see
 *      internet background scan noise. If this ever feels wrong, the documented
 *      alternative is the split-VPC topology at +$22/mo (architecture §4.4).
 */
export class DataStack extends Stack {
  public readonly rawBucket: s3.Bucket;
  public readonly llmAuditBucket: s3.Bucket;
  public readonly db: rds.DatabaseInstance;
  public readonly dbSecret: secretsmanager.ISecret;
  public readonly databaseName = 'newstrader';

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------- S3 ----
    // raw/: immutable fetch payloads — the replay source of truth. Never deleted,
    // only tiered down (IA at 30d, Glacier at 180d).
    this.rawBucket = new s3.Bucket(this, 'RawBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false, // payloads are content-addressed and write-once; versioning buys nothing
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'tier-down-never-delete',
          transitions: [
            { storageClass: s3.StorageClass.INFREQUENT_ACCESS, transitionAfter: Duration.days(30) },
            { storageClass: s3.StorageClass.GLACIER, transitionAfter: Duration.days(180) },
          ],
        },
      ],
    });

    // llm/: full prompt + raw response audit trail (populated from M2). No
    // lifecycle yet — tiering decided once real volume exists.
    this.llmAuditBucket = new s3.Bucket(this, 'LlmAuditBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --------------------------------------------------------------- RDS ----
    const vpc = ec2.Vpc.fromLookup(this, 'DefaultVpc', { isDefault: true });

    const allowlistCidr = new CfnParameter(this, 'DbAllowlistCidr', {
      type: 'String',
      default: '127.0.0.1/32',
      allowedPattern: '^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}/\\d{1,2}$',
      description:
        'CIDR always allowed to reach Postgres on 5432 (your workstation IP, e.g. 203.0.113.7/32). ' +
        'Default 127.0.0.1/32 is effectively closed — override at deploy.',
    });

    const openIngress = new CfnParameter(this, 'DbOpenIngress', {
      type: 'String',
      default: 'DISABLED',
      allowedValues: ['DISABLED', 'ENABLED'],
      description:
        'ENABLED adds a 0.0.0.0/0 ingress on 5432 so no-VPC Lambdas (no stable egress CIDR) can reach ' +
        'Postgres. scram-sha-256 + forced TLS are the real gate. Default DISABLED.',
    });
    const openIngressEnabled = new CfnCondition(this, 'DbOpenIngressEnabled', {
      expression: Fn.conditionEquals(openIngress.valueAsString, 'ENABLED'),
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description:
        'newstrader Postgres — allowlist CIDR always; world-open 5432 only when DbOpenIngress=ENABLED',
      allowAllOutbound: true,
    });
    dbSecurityGroup.addIngressRule(
      ec2.Peer.ipv4(allowlistCidr.valueAsString),
      ec2.Port.tcp(5432),
      'operator allowlist CIDR',
    );
    const worldOpenRule = new ec2.CfnSecurityGroupIngress(this, 'DbWorldOpenIngress', {
      groupId: dbSecurityGroup.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 5432,
      toPort: 5432,
      cidrIp: '0.0.0.0/0',
      description: 'no-VPC Lambda egress has no stable CIDR; gated by DbOpenIngress parameter',
    });
    worldOpenRule.cfnOptions.condition = openIngressEnabled;

    const engine = rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_16,
    });

    // TLS is enforced server-side, not by client convention: rds.force_ssl=1
    // rejects any non-TLS connection outright.
    const parameterGroup = new rds.ParameterGroup(this, 'DbParameterGroup', {
      engine,
      description: 'newstrader postgres16 — force TLS on every connection',
      parameters: { 'rds.force_ssl': '1' },
    });

    // SECRETS EXCEPTION (architecture §4.4 says SSM SecureString, $0): neither
    // CloudFormation nor CDK can auto-generate a password INTO an SSM
    // SecureString — generation is a Secrets-Manager-only capability. Rather
    // than hand-managing the master password out of band, we accept exactly one
    // Secrets Manager secret ($0.40/mo) for the DB credentials. All other
    // secrets (API keys, kill switch) stay in SSM.
    this.db = new rds.DatabaseInstance(this, 'Db', {
      engine,
      parameterGroup,
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      publiclyAccessible: true,
      multiAz: false,
      databaseName: this.databaseName,
      credentials: rds.Credentials.fromGeneratedSecret('newstrader'),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      securityGroups: [dbSecurityGroup],
      backupRetention: Duration.days(7),
      autoMinorVersionUpgrade: true,
      deletionProtection: true,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      cloudwatchLogsExports: ['postgresql'],
    });

    const secret = this.db.secret;
    if (!secret) {
      throw new Error('DatabaseInstance was expected to create a generated secret');
    }
    this.dbSecret = secret;

    // DATABASE_URL parts. The full URL is deliberately NOT an output or a Lambda
    // env var — the password lives only in the secret. Consumers assemble
    // postgresql://user:pass@host:port/db at runtime from DB_SECRET_ARN.
    new CfnOutput(this, 'DbHost', { value: this.db.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DbPort', { value: this.db.dbInstanceEndpointPort });
    new CfnOutput(this, 'DbName', { value: this.databaseName });
    new CfnOutput(this, 'DbUser', { value: 'newstrader' });
    new CfnOutput(this, 'DbSecretArn', { value: secret.secretArn });
    new CfnOutput(this, 'RawBucketName', { value: this.rawBucket.bucketName });
    new CfnOutput(this, 'LlmAuditBucketName', { value: this.llmAuditBucket.bucketName });
  }
}

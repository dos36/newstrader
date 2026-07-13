import { KILL_SWITCH_ENV } from '@newstrader/db';
import { afterEach, describe, expect, it } from 'vitest';
import { CLI_KILL_SWITCH_SSM_PARAM_ENV, cliKillSwitch } from './trading.js';

/**
 * cliKillSwitch (fix for the CLI bypassing the SSM kill switch): unset
 * KILL_SWITCH_SSM_PARAM falls back to the local env reader; set, it must
 * fail CLOSED on any read failure rather than let the CLI fall through to
 * "just trade". The SSM-path test below never touches real AWS: aws-api.ts's
 * awsJsonCall throws synchronously (no network call) when AWS_REGION /
 * credentials are absent, which — with those vars cleared — is exactly the
 * "read failed" case cliKillSwitch must map to a halt.
 */
describe('cliKillSwitch', () => {
  const saved: Record<string, string | undefined> = {
    [CLI_KILL_SWITCH_SSM_PARAM_ENV]: process.env[CLI_KILL_SWITCH_SSM_PARAM_ENV],
    [KILL_SWITCH_ENV]: process.env[KILL_SWITCH_ENV],
    AWS_REGION: process.env['AWS_REGION'],
    AWS_DEFAULT_REGION: process.env['AWS_DEFAULT_REGION'],
    AWS_ACCESS_KEY_ID: process.env['AWS_ACCESS_KEY_ID'],
    AWS_SECRET_ACCESS_KEY: process.env['AWS_SECRET_ACCESS_KEY'],
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('falls back to the local env reader (NEWSTRADER_KILL_SWITCH) when KILL_SWITCH_SSM_PARAM is unset', async () => {
    delete process.env[CLI_KILL_SWITCH_SSM_PARAM_ENV];
    delete process.env[KILL_SWITCH_ENV];
    expect(await cliKillSwitch()).toEqual({ state: 'run', halted: false, raw: null });

    process.env[KILL_SWITCH_ENV] = 'halt';
    expect((await cliKillSwitch()).halted).toBe(true);
  });

  it('fails CLOSED when KILL_SWITCH_SSM_PARAM is set but the SSM read fails', async () => {
    process.env[CLI_KILL_SWITCH_SSM_PARAM_ENV] = '/newstrader/kill-switch';
    // No region/credentials in this process: the SSM call cannot succeed —
    // exactly the "read failed" condition this getter must fail closed on.
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    delete process.env['AWS_ACCESS_KEY_ID'];
    delete process.env['AWS_SECRET_ACCESS_KEY'];
    // A local 'run' must NOT leak through — the SSM path never reads it.
    process.env[KILL_SWITCH_ENV] = 'run';

    const status = await cliKillSwitch();
    expect(status).toEqual({ state: 'halt', halted: true, raw: null });
  });
});

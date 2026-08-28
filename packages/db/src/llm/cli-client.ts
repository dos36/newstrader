import { spawn } from 'node:child_process';

import { InterpretationSchema } from '@newstrader/core';
import { z } from 'zod';

import type { LlmTransport } from '../shared-constants.js';
import type { LlmCallOutcome, LlmCallRequest, LlmClient } from './anthropic-client.js';
import type { LlmUsage } from './cost.js';

/**
 * Second transport for the interpret stage: the Claude Code CLI, authenticated
 * by the operator's subscription instead of an API key. DEV-ONLY, and the
 * divergences below are the reason it is a separate client rather than a flag
 * on the API one.
 *
 * What it buys: prompt iteration and eyeball checks with no ANTHROPIC_API_KEY.
 *
 * What it costs — measured 2026-08-21, not theoretical:
 *   1. ~25.7k tokens of Claude Code harness system prompt ride along on EVERY
 *      call (26,014 cache-creation tokens for a 10-token probe; 4,201 created +
 *      21,501 read with tools disabled). Nothing removes it. computeCostUsd
 *      therefore reports a number dominated by harness overhead, which the
 *      daily spend cap treats as spend — deliberately, since over-estimating
 *      is the safe direction for a circuit breaker.
 *   2. No structured-output enforcement. The model answered inside a ```json
 *      fence even when told not to, so the response is scraped and re-validated
 *      here; a scrape/schema miss is a CONTENT failure, exactly like the API
 *      client's `parsed_output === null` branch.
 *   3. `effort` and `max_tokens` are NOT settable through the CLI. The prompt
 *      registry treats both as part of the call contract, so a CLI row did NOT
 *      honour its registered prompt version's contract. Recorded as
 *      `contractDivergence` in the raw projection.
 *   4. Our system prompt is APPENDED to Claude Code's, which we neither own nor
 *      version. So CLI output is not a pure function of promptVersion+modelId
 *      and is NOT replayable across CLI upgrades.
 *
 * Because of 3 and 4, CLI rows carry transport='cli', get a `:cli`-suffixed
 * signal_key (so they never occupy an API row's slot), and must be excluded
 * from calibration and golden-eval comparisons.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
/** One corrective re-ask before burning a sweep attempt (fences are common). */
const DEFAULT_PARSE_RETRIES = 1;

/**
 * Appended after the registered system prompt. The CLI has no JSON mode, so
 * the instruction is all we get — and it is not reliably obeyed, which is why
 * extractJsonObject() exists.
 */
const JSON_ONLY_INSTRUCTION =
  '\n\nOUTPUT CONTRACT: reply with the raw JSON object only. No markdown code ' +
  'fence, no prose before or after, no explanation.';

const RETRY_NUDGE =
  '\n\nYour previous reply was not valid JSON for the required schema. ' +
  'Reply again with the raw JSON object only.';

/**
 * Env this client refuses to hand the child. `ANTHROPIC_BASE_URL` plus the
 * `CLAUDE_CODE_*` session vars leak in when the sweep itself runs inside a
 * Claude Code session, and the nested CLI then dies with "OAuth session
 * expired and could not be refreshed". `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
 * are stripped so that mode 'cli' unambiguously means "billed to the
 * subscription" — if you want key billing, use the API client.
 */
const STRIPPED_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDECODE',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
];
const STRIPPED_ENV_PREFIXES: readonly string[] = ['CLAUDE_CODE_'];

/** Envelope fields we depend on; unknown keys are ignored, missing ones throw. */
const CliEnvelopeSchema = z
  .object({
    is_error: z.boolean(),
    subtype: z.string().nullish(),
    result: z.string().nullish(),
    stop_reason: z.string().nullish(),
    terminal_reason: z.string().nullish(),
    api_error_status: z.unknown().nullish(),
    num_turns: z.number().nullish(),
    session_id: z.string().nullish(),
    total_cost_usd: z.number().nullish(),
    usage: z
      .object({
        input_tokens: z.number().nullish(),
        output_tokens: z.number().nullish(),
        cache_creation_input_tokens: z.number().nullish(),
        cache_read_input_tokens: z.number().nullish(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

type CliEnvelope = z.infer<typeof CliEnvelopeSchema>;

export interface CliRunInput {
  command: string;
  args: string[];
  /** The user prompt — untrusted news text, so it goes over stdin, never argv. */
  stdin: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Process seam (FetchLike/S3ClientLike precedent) — tests inject a fake. */
export type CliRunner = (input: CliRunInput) => Promise<CliRunResult>;

export interface ClaudeCliClientOptions {
  /** Executable name or absolute path. Default 'claude'. */
  command?: string;
  runner?: CliRunner;
  timeoutMs?: number;
  maxParseRetries?: number;
  /** Base env, sanitized before spawn. Default process.env. */
  env?: Record<string, string | undefined>;
}

export class ClaudeCliLlmClient implements LlmClient {
  readonly transport: LlmTransport = 'cli';

  private readonly command: string;
  private readonly runner: CliRunner;
  private readonly timeoutMs: number;
  private readonly maxParseRetries: number;
  private readonly env: Record<string, string | undefined>;

  constructor(options: ClaudeCliClientOptions = {}) {
    const env = options.env ?? process.env;
    // Fail-closed against the deployed path: subscription auth is interactive,
    // rate-limited for interactive use, and produces non-replayable rows.
    // Lambda must never reach it, whatever the config says.
    if (
      env['AWS_LAMBDA_FUNCTION_NAME'] !== undefined ||
      env['AWS_EXECUTION_ENV']?.startsWith('AWS_Lambda_') === true
    ) {
      throw new Error(
        'ClaudeCliLlmClient is dev-only and must never run in Lambda — ' +
          'provision the ANTHROPIC_API_KEY parameter and use the API client.',
      );
    }
    this.command = options.command ?? 'claude';
    this.runner = options.runner ?? spawnCliRunner;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxParseRetries = options.maxParseRetries ?? DEFAULT_PARSE_RETRIES;
    this.env = env;
  }

  async interpret(request: LlmCallRequest): Promise<LlmCallOutcome> {
    const startedAt = Date.now();
    const attempts: unknown[] = [];
    const usage: LlmUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    };
    let lastFailure = 'no attempt recorded';
    let lastStopReason: string | null = null;

    // Re-ask loop. Only a SCRAPE/SCHEMA miss retries: that is the gap left by
    // having no structured-output enforcement, and a stray code fence should
    // not burn one of the candidate's three sweep attempts. Everything else is
    // terminal, exactly as in the API client — a refusal repeated is still a
    // refusal, and transport problems throw straight out so the sweep aborts
    // the pass without burning an attempt at all.
    for (let attempt = 0; attempt <= this.maxParseRetries; attempt += 1) {
      const stdin = attempt === 0 ? request.userPrompt : request.userPrompt + RETRY_NUDGE;
      const envelope = await this.runOnce(request, stdin);
      addUsage(usage, envelope);
      lastStopReason = envelope.stop_reason ?? null;
      attempts.push(projectEnvelope(envelope, request));

      const contentFailure = classifyContentFailure(envelope);
      if (contentFailure !== null) {
        return {
          interpretation: null,
          failure: contentFailure,
          stopReason: lastStopReason,
          usage,
          rawResponse: rawProjection(attempts, request),
          latencyMs: Date.now() - startedAt,
        };
      }

      const text = envelope.result ?? '';
      const json = extractJsonObject(text);
      if (json === null) {
        lastFailure = `no JSON object found in CLI result (${text.length} chars)`;
        continue;
      }
      const validated = InterpretationSchema.safeParse(json);
      if (!validated.success) {
        lastFailure = `schema validation failed: ${validated.error.message.slice(0, 300)}`;
        continue;
      }
      return {
        interpretation: validated.data,
        failure: null,
        stopReason: lastStopReason,
        usage,
        rawResponse: rawProjection(attempts, request),
        latencyMs: Date.now() - startedAt,
      };
    }

    return {
      interpretation: null,
      failure: lastFailure,
      stopReason: lastStopReason,
      usage,
      rawResponse: rawProjection(attempts, request),
      latencyMs: Date.now() - startedAt,
    };
  }

  /** One spawn. Throws for transport problems, returns the parsed envelope otherwise. */
  private async runOnce(request: LlmCallRequest, stdin: string): Promise<CliEnvelope> {
    const args = [
      '-p',
      '--output-format',
      'json',
      '--model',
      request.modelId,
      '--max-turns',
      '1',
      // No tools and no MCP: the interpreter must read only the prompt. Without
      // this the agent can hit the filesystem and the web mid-interpretation.
      '--allowed-tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--append-system-prompt',
      request.systemPrompt + JSON_ONLY_INSTRUCTION,
    ];

    let run: CliRunResult;
    try {
      run = await this.runner({
        command: this.command,
        args,
        stdin,
        timeoutMs: this.timeoutMs,
        env: sanitizeEnv(this.env),
      });
    } catch (error) {
      throw new Error(
        `claude CLI spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (run.timedOut) {
      throw new Error(`claude CLI timed out after ${this.timeoutMs}ms`);
    }

    const trimmed = run.stdout.trim();
    if (trimmed === '') {
      throw new Error(
        `claude CLI produced no output (exit ${String(run.code)}): ${run.stderr.slice(0, 300)}`,
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(trimmed);
    } catch {
      // Format drift, not a model mistake — throw rather than ingest partial data.
      throw new Error(`claude CLI stdout was not JSON: ${trimmed.slice(0, 300)}`);
    }
    const envelope = CliEnvelopeSchema.safeParse(parsedJson);
    if (!envelope.success) {
      throw new Error(
        `claude CLI envelope drifted from the expected shape: ${envelope.error.message.slice(0, 300)}`,
      );
    }

    const transportFailure = classifyTransportFailure(envelope.data, run.code);
    if (transportFailure !== null) throw new Error(transportFailure);
    return envelope.data;
  }
}

/** Factory mirroring anthropicLlmClient(env). */
export function claudeCliLlmClient(
  env: Record<string, string | undefined>,
  options: Omit<ClaudeCliClientOptions, 'env'> = {},
): ClaudeCliLlmClient {
  const command = env['CLAUDE_CLI_PATH']?.trim();
  return new ClaudeCliLlmClient({
    ...options,
    env,
    ...(command !== undefined && command !== '' ? { command } : {}),
  });
}

/**
 * Transport vs content, the same split the API client makes: auth failures,
 * upstream API errors and a non-zero exit are infrastructure (throw, retry next
 * tick for free); a refusal or a turn limit is the model's answer (content).
 */
function classifyTransportFailure(envelope: CliEnvelope, code: number | null): string | null {
  const result = envelope.result ?? '';
  if (envelope.terminal_reason === 'api_error' || envelope.api_error_status != null) {
    return `claude CLI upstream API error: ${result.slice(0, 300)}`;
  }
  if (
    /failed to authenticate|oauth|not logged in|invalid api key|usage limit|rate limit/i.test(
      result,
    )
  ) {
    return `claude CLI auth/limit failure: ${result.slice(0, 300)}`;
  }
  if (envelope.is_error && code !== 0) {
    return `claude CLI exited ${String(code)} with error: ${result.slice(0, 300)}`;
  }
  return null;
}

function classifyContentFailure(envelope: CliEnvelope): string | null {
  if (envelope.stop_reason === 'refusal') return 'safety refusal (stop_reason=refusal)';
  if (envelope.stop_reason === 'max_tokens') return 'output truncated (stop_reason=max_tokens)';
  if (envelope.subtype === 'error_max_turns') return 'turn limit reached before an answer';
  if (envelope.is_error) {
    return `CLI reported is_error with no transport cause: ${(envelope.result ?? '').slice(0, 200)}`;
  }
  if (envelope.result == null || envelope.result.trim() === '') return 'CLI returned empty result';
  return null;
}

/**
 * Scrape one JSON object out of the reply. Fences first (the measured common
 * case), then first-brace-to-last-brace, which recovers a reply wrapped in
 * prose. Returns null when neither yields parseable JSON.
 */
export function extractJsonObject(text: string): unknown {
  // A reply that parses cleanly as an array is REJECTED outright, before the
  // brace-slice fallback below can dig an object out of it. The contract is one
  // signal; `[{...},{...}]` means the model answered a different question, and
  // silently taking element 0 would invent a decision it did not make.
  try {
    const whole: unknown = JSON.parse(text.trim());
    if (Array.isArray(whole)) return null;
  } catch {
    // Not whole-text JSON — fall through to the scrapers.
  }

  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  candidates.push(text);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));

  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed === '') continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed;
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

/** Usage is summed across re-asks: a re-ask is real spend, cap must see it. */
function addUsage(usage: LlmUsage, envelope: CliEnvelope): void {
  const u = envelope.usage;
  if (u == null) return;
  usage.inputTokens += u.input_tokens ?? 0;
  usage.outputTokens += u.output_tokens ?? 0;
  usage.cacheCreationInputTokens += u.cache_creation_input_tokens ?? 0;
  usage.cacheReadInputTokens += u.cache_read_input_tokens ?? 0;
}

function projectEnvelope(envelope: CliEnvelope, request: LlmCallRequest): unknown {
  return {
    sessionId: envelope.session_id ?? null,
    isError: envelope.is_error,
    subtype: envelope.subtype ?? null,
    stopReason: envelope.stop_reason ?? null,
    terminalReason: envelope.terminal_reason ?? null,
    numTurns: envelope.num_turns ?? null,
    totalCostUsd: envelope.total_cost_usd ?? null,
    usage: envelope.usage ?? null,
    result: envelope.result ?? null,
    modelRequested: request.modelId,
  };
}

function rawProjection(attempts: unknown[], request: LlmCallRequest): unknown {
  return {
    transport: 'cli',
    attempts,
    /**
     * The contract this call could NOT honour. Read this before treating a CLI
     * row as comparable to an API row.
     */
    contractDivergence: {
      effortRequested: request.effort,
      effortApplied: null,
      maxTokensRequested: request.maxTokens,
      maxTokensApplied: null,
      systemPromptMode: 'appended-to-claude-code-harness-prompt',
      structuredOutput: 'none (scraped and re-validated locally)',
    },
  };
}

function sanitizeEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    if (STRIPPED_ENV_KEYS.includes(key)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    clean[key] = value;
  }
  return clean;
}

/** Default runner: spawn, feed stdin, collect both streams, kill on timeout. */
const spawnCliRunner: CliRunner = async (input) =>
  new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, input.timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    child.stdin.on('error', () => {
      // EPIPE when the child exits before reading — 'close' carries the real story.
    });
    child.stdin.end(input.stdin, 'utf8');
  });

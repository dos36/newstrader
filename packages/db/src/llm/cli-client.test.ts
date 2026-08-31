import { describe, expect, it } from 'vitest';

import {
  ClaudeCliLlmClient,
  claudeCliLlmClient,
  extractJsonObject,
  type CliRunInput,
  type CliRunResult,
} from './cli-client.js';
import type { LlmCallRequest } from './anthropic-client.js';

/**
 * The CLI transport's whole risk is misclassification: a transport problem read
 * as a content failure burns a candidate's attempts for free, and a content
 * failure read as transport aborts a healthy pass. Every case below pins one
 * side of that split. The process is a seam, so nothing here spawns `claude`.
 */

const REQUEST: LlmCallRequest = {
  systemPrompt: 'SYSTEM PROMPT BODY',
  userPrompt: 'Headline: ACME beats Q3 estimates.',
  modelId: 'claude-sonnet-5',
  maxTokens: 1500,
  effort: 'medium',
};

const VALID_SIGNAL = {
  event_type: 'earnings_result',
  direction: 'bullish',
  expected_move_bps: 180,
  horizon: '1d',
  already_expected: false,
  materiality: 0.7,
  confidence: 0.62,
  reasoning: 'Beat on both lines with a raise.',
};

function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_error: false,
    subtype: 'success',
    terminal_reason: 'completed',
    stop_reason: 'end_turn',
    api_error_status: null,
    num_turns: 1,
    session_id: 'sess-1',
    total_cost_usd: 0.03,
    result: JSON.stringify(VALID_SIGNAL),
    usage: {
      input_tokens: 10,
      output_tokens: 200,
      cache_creation_input_tokens: 25_812,
      cache_read_input_tokens: 0,
    },
    ...overrides,
  });
}

/** Runner that replays a queue of stdouts and records what it was asked to run. */
function queueRunner(stdouts: string[]): {
  runner: (input: CliRunInput) => Promise<CliRunResult>;
  calls: CliRunInput[];
} {
  const calls: CliRunInput[] = [];
  const queue = [...stdouts];
  return {
    calls,
    runner: (input): Promise<CliRunResult> => {
      calls.push(input);
      const stdout = queue.shift();
      if (stdout === undefined) throw new Error('queueRunner: no stdout queued');
      return Promise.resolve({ code: 0, stdout, stderr: '', timedOut: false });
    },
  };
}

function client(
  stdouts: string[],
  options: { env?: Record<string, string | undefined>; maxParseRetries?: number } = {},
): {
  instance: ClaudeCliLlmClient;
  calls: CliRunInput[];
} {
  const { runner, calls } = queueRunner(stdouts);
  const instance = new ClaudeCliLlmClient({
    runner,
    env: options.env ?? {},
    ...(options.maxParseRetries !== undefined ? { maxParseRetries: options.maxParseRetries } : {}),
  });
  return { instance, calls };
}

describe('ClaudeCliLlmClient — success path', () => {
  it('scrapes a fenced reply, stamps transport=cli, and sums the harness usage', async () => {
    const fenced = envelope({ result: `\`\`\`json\n${JSON.stringify(VALID_SIGNAL)}\n\`\`\`` });
    const { instance } = client([fenced]);

    const outcome = await instance.interpret(REQUEST);

    expect(instance.transport).toBe('cli');
    expect(outcome.failure).toBeNull();
    expect(outcome.interpretation?.event_type).toBe('earnings_result');
    expect(outcome.interpretation?.expected_move_bps).toBe(180);
    // The ~25.7k harness prefix is REPORTED, not hidden: the spend cap must see it.
    expect(outcome.usage).toEqual({
      inputTokens: 10,
      outputTokens: 200,
      cacheCreationInputTokens: 25_812,
      cacheReadInputTokens: 0,
    });
  });

  it('records the contract it could not honour', async () => {
    const { instance } = client([envelope()]);

    const outcome = await instance.interpret(REQUEST);

    expect(outcome.rawResponse).toMatchObject({
      transport: 'cli',
      contractDivergence: {
        effortRequested: 'medium',
        effortApplied: null,
        maxTokensRequested: 1500,
        maxTokensApplied: null,
      },
    });
  });

  it('sends the untrusted user prompt on stdin and disables tools and MCP', async () => {
    const { instance, calls } = client([envelope()]);

    await instance.interpret(REQUEST);

    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.stdin).toBe(REQUEST.userPrompt);
    // News text must never reach argv — quoting and ARG_MAX are not a parser.
    expect(call?.args.join(' ')).not.toContain('ACME');
    expect(call?.args).toContain('--allowed-tools');
    expect(call?.args).toContain('--strict-mcp-config');
    expect(call?.args).toContain('{"mcpServers":{}}');
    expect(call?.args).toEqual(expect.arrayContaining(['--model', 'claude-sonnet-5']));
    // The registered system prompt still goes over, appended to the harness one.
    expect(call?.args.some((arg) => arg.startsWith('SYSTEM PROMPT BODY'))).toBe(true);
  });
});

describe('ClaudeCliLlmClient — env handling', () => {
  it('strips the vars that break or re-bill a nested run, keeps the rest', async () => {
    const { instance, calls } = client([envelope()], {
      env: {
        PATH: '/usr/bin',
        HOME: '/Users/dev',
        // These leak in when the sweep itself runs inside Claude Code; the
        // nested CLI then dies with "OAuth session expired".
        ANTHROPIC_BASE_URL: 'https://gateway.example',
        CLAUDE_CODE_SESSION_ID: 'abc',
        CLAUDECODE: '1',
        // Stripped so mode=cli unambiguously means "billed to the subscription".
        ANTHROPIC_API_KEY: 'sk-should-not-pass-through',
      },
    });

    await instance.interpret(REQUEST);

    const passed = calls[0]?.env ?? {};
    expect(passed['PATH']).toBe('/usr/bin');
    expect(passed['HOME']).toBe('/Users/dev');
    expect(passed).not.toHaveProperty('ANTHROPIC_BASE_URL');
    expect(passed).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(passed).not.toHaveProperty('CLAUDE_CODE_SESSION_ID');
    expect(passed).not.toHaveProperty('CLAUDECODE');
  });

  it('refuses to construct inside Lambda', () => {
    expect(
      () => new ClaudeCliLlmClient({ env: { AWS_LAMBDA_FUNCTION_NAME: 'newstrader-interpret' } }),
    ).toThrow(/dev-only and must never run in Lambda/);
    expect(
      () => new ClaudeCliLlmClient({ env: { AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x' } }),
    ).toThrow(/dev-only and must never run in Lambda/);
  });

  it('honours CLAUDE_CLI_PATH through the factory', async () => {
    const { runner, calls } = queueRunner([envelope()]);
    const instance = claudeCliLlmClient(
      { CLAUDE_CLI_PATH: '/opt/homebrew/bin/claude' },
      { runner },
    );

    await instance.interpret(REQUEST);

    expect(calls[0]?.command).toBe('/opt/homebrew/bin/claude');
  });
});

describe('ClaudeCliLlmClient — transport failures throw (no attempt burned)', () => {
  it('throws on an auth failure', async () => {
    const { instance } = client([
      envelope({
        is_error: true,
        terminal_reason: 'api_error',
        result: 'Failed to authenticate: OAuth session expired and could not be refreshed',
      }),
    ]);

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/upstream API error|auth\/limit/i);
  });

  it('throws when the subscription hits a usage limit', async () => {
    const { instance } = client([
      envelope({ is_error: true, result: 'Claude usage limit reached. Try again later.' }),
    ]);

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/auth\/limit failure/);
  });

  it('throws on a non-JSON stdout rather than ingesting partial data', async () => {
    const { instance } = client(['claude: command panicked\n']);

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/stdout was not JSON/);
  });

  it('throws when the envelope shape drifts', async () => {
    const { instance } = client([JSON.stringify({ result: '{}' })]); // no is_error

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/envelope drifted/);
  });

  it('throws on empty stdout', async () => {
    const { instance } = client(['   ']);

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/produced no output/);
  });

  it('throws when the runner itself fails', async () => {
    const instance = new ClaudeCliLlmClient({
      env: {},
      runner: () => Promise.reject(new Error('ENOENT: claude not found')),
    });

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/spawn failed: ENOENT/);
  });

  it('throws on a timeout', async () => {
    const instance = new ClaudeCliLlmClient({
      env: {},
      timeoutMs: 1234,
      runner: () => Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: true }),
    });

    await expect(instance.interpret(REQUEST)).rejects.toThrow(/timed out after 1234ms/);
  });
});

describe('ClaudeCliLlmClient — content failures return (attempt burned)', () => {
  it('re-asks once when the reply is not parseable, then succeeds', async () => {
    const { instance, calls } = client([
      envelope({ result: 'I think this is bullish, roughly 2%.' }),
      envelope(),
    ]);

    const outcome = await instance.interpret(REQUEST);

    expect(outcome.failure).toBeNull();
    expect(outcome.interpretation?.direction).toBe('bullish');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.stdin).toContain('not valid JSON');
    // Both spawns are real spend and both are counted.
    expect(outcome.usage.cacheCreationInputTokens).toBe(2 * 25_812);
  });

  it('gives up after the re-ask and returns a content failure', async () => {
    const offTaxonomy = { ...VALID_SIGNAL, event_type: 'strong_earnings' };
    const { instance, calls } = client([
      envelope({ result: JSON.stringify(offTaxonomy) }),
      envelope({ result: JSON.stringify(offTaxonomy) }),
    ]);

    const outcome = await instance.interpret(REQUEST);

    expect(outcome.interpretation).toBeNull();
    expect(outcome.failure).toMatch(/schema validation failed/);
    expect(calls).toHaveLength(2);
  });

  it('does not re-ask a refusal — a refusal repeated is still a refusal', async () => {
    const { instance, calls } = client([envelope({ stop_reason: 'refusal', result: 'I cannot.' })]);

    const outcome = await instance.interpret(REQUEST);

    expect(outcome.interpretation).toBeNull();
    expect(outcome.failure).toMatch(/safety refusal/);
    expect(calls).toHaveLength(1);
  });

  it('treats truncation as a content failure, not a transport error', async () => {
    const { instance } = client([envelope({ stop_reason: 'max_tokens', result: '{"event_ty' })]);

    const outcome = await instance.interpret(REQUEST);

    expect(outcome.failure).toMatch(/output truncated/);
  });

  it('treats a turn-limit stop as a content failure', async () => {
    const { instance } = client([
      envelope({ is_error: true, subtype: 'error_max_turns', result: '' }),
    ]);

    const outcome = await instance.interpret(REQUEST);

    expect(outcome.failure).toMatch(/turn limit reached/);
  });
});

describe('extractJsonObject', () => {
  it('reads a bare object', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('reads a fenced object — the measured common case', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('recovers an object wrapped in prose', () => {
    expect(extractJsonObject('Here you go:\n{"a":1}\nHope that helps.')).toEqual({ a: 1 });
  });

  it('rejects an array outright instead of unwrapping element 0', () => {
    // The brace-slice fallback would happily dig {"a":1} out of this. Taking it
    // would invent a single answer from a reply that gave a list.
    expect(extractJsonObject('[{"a":1}]')).toBeNull();
    expect(extractJsonObject('[{"a":1},{"a":2}]')).toBeNull();
  });

  it('returns null on garbage', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('{unclosed')).toBeNull();
  });
});

describe('ClaudeCliLlmClient — discovery contract', () => {
  const VALID_DISCOVERY = {
    macro_event_type: 'commodity_supply',
    market_scope: 'companies',
    company_exposures: [
      { symbol: 'EWG', direction: 'bearish', materiality: 0.6, expected_move_bps: 90 },
    ],
    horizon: '1d',
    already_expected: false,
    materiality: 0.6,
    confidence: 0.5,
    reasoning: 'Supply fell; the country fund tracking the affected market is directly exposed.',
  };

  const DISCOVERY_REQUEST: LlmCallRequest = {
    systemPrompt: 'DISCOVERY SYSTEM BODY',
    cachedContext: 'CANDIDATE UNIVERSE (2 instruments...):\nAAA | Alpha\nEWG | Germany fund',
    userPrompt: 'Headline: crisis halts commerce.',
    modelId: 'claude-sonnet-5',
    maxTokens: 10_000,
    effort: 'medium',
  };

  it('parses a valid discovery judgment and folds the universe into the system prompt', async () => {
    const { instance, calls } = client([
      envelope({ result: JSON.stringify(VALID_DISCOVERY) }),
    ]);

    const outcome = await instance.interpretDiscovery(DISCOVERY_REQUEST);

    expect(outcome.failure).toBeNull();
    expect(outcome.interpretation?.company_exposures[0]?.symbol).toBe('EWG');
    // The CLI has no cache semantics, so the universe block must ride in the
    // appended system prompt — otherwise the model never sees its candidates.
    const appended = calls[0]?.args.join(' ') ?? '';
    expect(appended).toContain('DISCOVERY SYSTEM BODY');
    expect(appended).toContain('CANDIDATE UNIVERSE');
  });

  it('treats an incoherent answer as a content failure, exactly like the API client', async () => {
    const incoherent = { ...VALID_DISCOVERY, market_scope: 'none' };
    const { instance } = client([envelope({ result: JSON.stringify(incoherent) })], {
      maxParseRetries: 0,
    });

    const outcome = await instance.interpretDiscovery(DISCOVERY_REQUEST);

    expect(outcome.interpretation).toBeNull();
    expect(outcome.failure).toMatch(/incoherent/);
  });

  it('rejects a company-schema answer against the discovery schema', async () => {
    // A response shaped for the WRONG contract must fail validation, not be
    // half-read: field names overlap enough (direction, horizon...) that a
    // permissive parser could smuggle one through.
    const { instance } = client([envelope()], { maxParseRetries: 0 });

    const outcome = await instance.interpretDiscovery(DISCOVERY_REQUEST);

    expect(outcome.interpretation).toBeNull();
    expect(outcome.failure).toMatch(/schema|json/i);
  });
});

describe('turn-limit death with a non-zero exit — the tool-reach case', () => {
  it('burns an attempt instead of aborting the pass', async () => {
    // The live shape, measured 2026-08-31 on world-news discovery prompts:
    // the model reaches for web search, hits the turn cap, and the CLI exits 1
    // with subtype=error_max_turns and an EMPTY result. Before the fix this
    // took the generic is_error-and-exit-1 transport branch, which aborts the
    // pass and burns nothing — so a story that reliably tempted the model into
    // a tool call blocked the queue forever.
    const stdout = envelope({
      is_error: true,
      subtype: 'error_max_turns',
      terminal_reason: 'max_turns',
      stop_reason: 'tool_use',
      result: null,
    });
    const calls: CliRunInput[] = [];
    const instance = new ClaudeCliLlmClient({
      env: {},
      maxParseRetries: 0,
      runner: (input): Promise<CliRunResult> => {
        calls.push(input);
        return Promise.resolve({ code: 1, stdout, stderr: '', timedOut: false });
      },
    });

    // Must RESOLVE (content failure), never throw (transport abort).
    const outcome = await instance.interpret(REQUEST);

    expect(outcome.interpretation).toBeNull();
    expect(outcome.failure).toMatch(/turn limit reached/);
    // And the call itself must have banned the tools that cause this.
    const args = calls[0]?.args ?? [];
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe('WebSearch,WebFetch');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('2');
  });
});

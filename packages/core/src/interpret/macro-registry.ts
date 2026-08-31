import {
  buildMacroSystemPromptV1,
  buildMacroUserPrompt,
  type MacroInterpretContext,
} from './macro-prompt.js';

/**
 * Macro prompt registry — same discipline as {@link PROMPT_REGISTRY}, separate
 * table.
 *
 * Kept separate rather than merged because the two paths take different context
 * types: a company prompt renders an instrument, a macro prompt cannot. One
 * registry would need a union that every consumer narrows at every use, and the
 * first thing anyone would do to avoid that is cast — which is exactly how a
 * company prompt ends up rendered with macro context.
 *
 * The immutability rule carries over unchanged: a version is the WHOLE call
 * contract (system text, user renderer, model id, effort, max tokens), the
 * signal_key embeds promptVersion and modelId, and re-prompting inserts new
 * rows rather than updating old ones. Editing a published version's text in
 * place silently re-labels history and must never happen; mint a new entry.
 *
 * Version ids carry an `m` suffix (`v1m`) so a macro row can never be confused
 * with a company row of the same generation when both sit in `llm_signals`.
 */
export interface MacroPromptDefinition {
  version: string;
  systemPrompt: string;
  buildUserPrompt: (context: MacroInterpretContext) => string;
  /** Exact Anthropic model id stamped into llm_signals.model_id. */
  modelId: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /**
   * Hard per-response ceiling, sized the same way the company registry sizes
   * it: claude-sonnet-5 spends adaptive thinking from this number before the
   * output JSON is written, so this is not "JSON size plus slack". Unused
   * headroom costs nothing because billing is on tokens generated.
   *
   * 10_000 matches v3 rather than being tuned down. The macro prompt asks for
   * an explicit four-step chain, which is more reasoning than the company
   * prompt requests, so a tighter cap would truncate the very deliberation the
   * stage exists to produce — and a truncation is recorded as a content
   * failure, burning one of three attempts.
   */
  maxTokens: number;
}

export const MACRO_PROMPT_REGISTRY: Readonly<Record<string, MacroPromptDefinition>> = {
  /**
   * v1m — the first macro version, and the one the source-evaluation question
   * is asked with.
   *
   * `effort: 'medium'` deliberately, matching v3 for the same reason v3 chose
   * it: this version exists to answer "is there an edge in macro news at all",
   * and the cheapest honest read answers that. A signal that only appears at
   * maximum reasoning depth is too fragile to build on. Effort and model are
   * the first sweep dimensions once viability is settled, and because both are
   * part of the contract, each setting earns its own registry entry rather
   * than a flag on this one.
   */
  v1m: {
    version: 'v1m',
    systemPrompt: buildMacroSystemPromptV1(),
    buildUserPrompt: buildMacroUserPrompt,
    modelId: 'claude-sonnet-5',
    effort: 'medium',
    maxTokens: 10_000,
  },
};

export const CURRENT_MACRO_PROMPT_VERSION = 'v1m';

export function getMacroPromptDefinition(version: string): MacroPromptDefinition {
  const def = MACRO_PROMPT_REGISTRY[version];
  if (def === undefined) {
    throw new Error(
      `Unknown macro prompt version "${version}" — registered: ${Object.keys(
        MACRO_PROMPT_REGISTRY,
      ).join(', ')}`,
    );
  }
  return def;
}

/**
 * Macro versions are namespaced by an `m` suffix so the two registries can
 * never collide in `llm_signals.prompt_version`. Enforced by a test rather
 * than by types, because the constraint is about the STRING that reaches the
 * database, not about the shape of the object.
 */
export function isMacroPromptVersion(version: string): boolean {
  return Object.hasOwn(MACRO_PROMPT_REGISTRY, version);
}

export * from './schema.js';
export * from './client.js';
export * from './clustering-repo.js';
export * from './universe/index.js';
export * from './resolver/index.js';
export * from './bars/index.js';
export * from './reaction/index.js';
export * from './calendar/index.js';
// EDGAR filing bodies — the interpreter's article text for 8-K items.
export * from './documents/index.js';
export * from './shared-constants.js';
// M4: signal/rules/decision/replay orchestration + SimBroker execution.
// No export-name overlap with the barrels above (verified — an overlap would
// silently drop the name from the package surface, like the http.js seams).
// Note: execution/position-manager.ts exports its own ExitEvaluation type;
// core's decide/exit-rules.ts exports an identically NAMED interface, but the
// two live in different packages, so both survive their respective indexes.
export * from './trading/index.js';
export * from './execution/index.js';
// M2: LLM interpretation (client seam, sweep, audit, spend accounting).
// LlmUsage/LlmClient/interpretSweep etc. collide with nothing above.
export * from './llm/index.js';
// Backtest mode (decide-path replay over historical signals). Depends on
// trading/ and execution/, so it exports last.
export * from './backtest/index.js';

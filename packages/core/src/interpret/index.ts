// M2 interpretation — pure prompt/schema/taxonomy layer. No I/O, no clock:
// the db-side sweep (packages/db/src/llm) assembles context and calls the API.
export * from './taxonomy.js';
export * from './schema.js';
export * from './prompt.js';
export * from './registry.js';

// The MACRO path, for stories that name no company. Same layering rules — pure,
// clock-free — with its own taxonomy, schema, prompt, and registry because it
// asks a different question (which instruments does this affect?) than the
// company path (does this affect THIS instrument?). `macro-fanout` is the
// deterministic half: it turns one judgment into rows and baskets, so the model
// never picks an instrument.
export * from './macro-taxonomy.js';
export * from './macro-schema.js';
export * from './macro-prompt.js';
export * from './macro-registry.js';
export * from './macro-fanout.js';

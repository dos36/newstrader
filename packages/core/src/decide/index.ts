/**
 * Pure decision engine — barrel for packages/core/src/decide.
 * Nothing under this directory performs I/O, reads a clock, or uses
 * randomness (enforced by purity.test.ts).
 */
export * from './decide.js';
export * from './decimal.js';
export * from './default-rules.js';
export * from './exit-rules.js';
export * from './intent.js';
export * from './sha256.js';
export * from './sizing.js';

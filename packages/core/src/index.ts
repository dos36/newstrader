export * from './contracts.js';
export * from './ids.js';
export * from './clustering/similarity.js';
export * from './trading/contracts.js';
// M4: pure decision engine + SimBroker fill model. The two decimal modules
// (decide/decimal.ts fixed-scale BigInt vs broker/decimal.ts variable-scale
// Dec) share no export names by construction — parseScaled/formatScaled vs
// parseDec/formatDec — so both star-exports are collision-free (verified; a
// future duplicate name would be silently DROPPED from the package surface,
// see the bars/calendar http.js notes in packages/db).
export * from './decide/index.js';
export * from './broker/index.js';

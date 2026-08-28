/**
 * M5 evaluation math — pure statistics (calibration, rank correlation) and
 * per-run trade metrics. No I/O anywhere under this directory; the SQL that
 * feeds these functions lives in services/cli (stats.ts pattern).
 */
export * from './calibration.js';
export * from './metrics.js';

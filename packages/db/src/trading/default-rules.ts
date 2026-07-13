import { DEFAULT_RULES_LABEL, DEFAULT_RULES_V1 } from '@newstrader/core';

import type { Db } from '../client.js';
import { createRulesVersion, type RulesVersionRecord } from './rules-repo.js';

/**
 * Seed the engine's shipped default config (long-only, EMPTY event-type
 * whitelist — trades NOTHING until event-study evidence earns entries,
 * architecture §6) as a rules_versions row. Idempotent: re-running returns
 * the existing row; a drifted DEFAULT_RULES_V1 under the same label throws
 * via the immutability guard — a changed default must ship as a new label.
 *
 * Value (not type-only) import from @newstrader/core is safe: core has no db
 * imports, so no cycle.
 */
export async function ensureDefaultRules(db: Db): Promise<RulesVersionRecord> {
  return createRulesVersion(db, {
    label: DEFAULT_RULES_LABEL,
    config: DEFAULT_RULES_V1,
    description: 'Shipped v1 default: long-only, empty event-type whitelist (trades nothing).',
  });
}

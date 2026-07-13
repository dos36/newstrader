import { RulesConfig, newId } from '@newstrader/core';
import { eq } from 'drizzle-orm';

import type { Db } from '../client.js';
import { rulesVersions } from '../schema.js';
import { configHash } from './canonical-json.js';

/**
 * rules_versions repository — versioned deterministic-engine config
 * (architecture §5.4). Rows are IMMUTABLE once written: a rule change ships
 * as a new row under a new label, never an in-place edit. createRulesVersion
 * enforces that as a hard guard — re-registering a label with the same
 * canonical config is an idempotent no-op, re-registering it with a
 * DIFFERENT config throws.
 */

export interface CreateRulesVersionInput {
  label: string;
  /** Validated through RulesConfig — malformed config never reaches the table. */
  config: unknown;
  parentVersionId?: string | null;
  description?: string | null;
}

export interface RulesVersionRecord {
  id: string;
  label: string;
  config: RulesConfig;
  configHash: string;
  /** False when the identical (label, hash) row already existed. */
  created: boolean;
}

export async function createRulesVersion(
  db: Db,
  input: CreateRulesVersionInput,
): Promise<RulesVersionRecord> {
  const config = RulesConfig.parse(input.config);
  const hash = configHash(config);

  const inserted = await db
    .insert(rulesVersions)
    .values({
      id: newId(),
      versionLabel: input.label,
      config,
      configHash: hash,
      parentVersionId: input.parentVersionId ?? null,
      description: input.description ?? null,
    })
    .onConflictDoNothing({ target: rulesVersions.versionLabel })
    .returning({ id: rulesVersions.id });

  const insertedRow = inserted[0];
  if (insertedRow !== undefined) {
    return { id: insertedRow.id, label: input.label, config, configHash: hash, created: true };
  }

  const existing = await loadByLabel(db, input.label);
  if (existing === undefined) {
    throw new Error(
      `createRulesVersion: conflict on version_label "${input.label}" but no row found`,
    );
  }
  if (existing.configHash !== hash) {
    throw new Error(
      `createRulesVersion: rules version "${input.label}" already exists with a different ` +
        `config (stored hash ${existing.configHash}, submitted ${hash}) — rules are immutable; ` +
        `ship the change as a NEW version label`,
    );
  }
  return {
    id: existing.id,
    label: input.label,
    config: RulesConfig.parse(existing.config),
    configHash: existing.configHash,
    created: false,
  };
}

export interface RulesVersion {
  id: string;
  label: string;
  config: RulesConfig;
}

/** Load a rules version by label, zod-parsing the stored config back. Throws when missing. */
export async function getRulesVersion(db: Db, label: string): Promise<RulesVersion> {
  const row = await loadByLabel(db, label);
  if (row === undefined) {
    throw new Error(`getRulesVersion: no rules version with label "${label}"`);
  }
  return { id: row.id, label, config: RulesConfig.parse(row.config) };
}

async function loadByLabel(db: Db, label: string) {
  const rows = await db
    .select({
      id: rulesVersions.id,
      config: rulesVersions.config,
      configHash: rulesVersions.configHash,
    })
    .from(rulesVersions)
    .where(eq(rulesVersions.versionLabel, label));
  return rows[0];
}

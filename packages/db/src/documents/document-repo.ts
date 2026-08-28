import { and, asc, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { itemDocuments, newsSources, rawNewsItems } from '../schema.js';
import { EDGAR_FETCHER_VERSION } from './edgar-documents.js';

/**
 * Work queue and bookkeeping for EDGAR filing-document fetching.
 *
 * Queue definition — an item is a candidate when it is an EDGAR filing with a
 * stored index URL and it has no usable document yet:
 *   - no item_documents row at all, or
 *   - status='failed' with attempts below the cap.
 * status='ok' and status='empty' are both terminal. 'empty' is terminal on
 * purpose: a filing that listed no content documents will list none tomorrow,
 * and retrying it forever would starve the queue.
 */

/** Deterministic raw-store key: one filing, one blob, refetch overwrites itself. */
export function filingDocumentKey(itemId: string): string {
  return `edgar-docs/${itemId}.json`;
}

export interface FilingFetchCandidate {
  itemId: string;
  url: string;
  formType: string | null;
  headline: string;
}

export interface LoadFilingCandidatesOptions {
  batch: number;
  /** Give up on an item after this many failed attempts. */
  maxAttempts: number;
  /**
   * Restrict to `meta->>'formType'` values starting with any of these
   * prefixes. Defaults to the 8-K family only: Form 4
   * and the 424B and 497 prospectus families carry no interpretable event, and
   * fetching them would spend the SEC request budget on noise.
   */
  formTypes?: string[];
  /**
   * Re-queue items that already have stored text. For when the extractor
   * improves — the blob key is deterministic, so a refetch overwrites in place
   * rather than accumulating copies.
   */
  includeStored?: boolean;
  /**
   * With includeStored, re-queue ONLY filings stored by an older fetcher
   * version AND trimmed by that version's caps — i.e. the ones a cap increase
   * can actually improve. Converges: a refetch stamps the current version, so
   * each filing is revisited at most once per bump even if it is still too long
   * for the new cap.
   */
  onlyStale?: boolean;
}

/**
 * Form-type PREFIXES, matched the same way the EDGAR adapter decides what is a
 * genuine 8-K (`f.startsWith('8-K')`, edgar.ts ACCEPTED_FORM_TYPES). An exact
 * list was wrong: it silently skipped 8-K12B / 8-K12G3 / 8-K15D5 — 11 real
 * filings in the local store — which the ingest side deliberately accepts as
 * 8-K events. The two stages must agree on what an 8-K is, or the queue looks
 * empty while documents are missing. Safe as a prefix because no unrelated
 * form starts with "8-K" (unlike type=4, which prefix-matches 424B2 etc.).
 */
const DEFAULT_FORM_PREFIXES = ['8-K'];

/** meta->>'formType' LIKE any of the given prefixes. */
function formTypeMatches(prefixes: string[]) {
  return or(
    ...prefixes.map((prefix) => sql`${rawNewsItems.meta}->>'formType' LIKE ${prefix + '%'}`),
  );
}

export async function loadFilingFetchCandidates(
  db: Db,
  options: LoadFilingCandidatesOptions,
): Promise<FilingFetchCandidate[]> {
  const formTypes = options.formTypes ?? DEFAULT_FORM_PREFIXES;
  const rows = await db
    .select({
      itemId: rawNewsItems.id,
      url: rawNewsItems.url,
      formType: sql<string | null>`${rawNewsItems.meta}->>'formType'`,
      headline: rawNewsItems.headline,
    })
    .from(rawNewsItems)
    .innerJoin(newsSources, eq(newsSources.id, rawNewsItems.sourceId))
    .leftJoin(itemDocuments, eq(itemDocuments.itemId, rawNewsItems.id))
    .where(
      and(
        eq(newsSources.kind, 'sec_edgar'),
        isNotNull(rawNewsItems.url),
        formTypeMatches(formTypes),
        queuePredicate(options),
      ),
    )
    // Oldest first, so a re-run of the same command walks forward like the
    // interpret backfill does rather than re-shuffling the queue.
    .orderBy(asc(rawNewsItems.receivedAt), asc(rawNewsItems.id))
    .limit(options.batch);

  return rows.flatMap((row) => (row.url === null ? [] : [{ ...row, url: row.url }]));
}

/** Remaining candidates under the same predicate, ignoring the batch limit. */
export async function countFilingFetchCandidates(
  db: Db,
  options: Omit<LoadFilingCandidatesOptions, 'batch'>,
): Promise<number> {
  const formTypes = options.formTypes ?? DEFAULT_FORM_PREFIXES;
  const rows = await db
    .select({ total: sql<string>`count(*)` })
    .from(rawNewsItems)
    .innerJoin(newsSources, eq(newsSources.id, rawNewsItems.sourceId))
    .leftJoin(itemDocuments, eq(itemDocuments.itemId, rawNewsItems.id))
    .where(
      and(
        eq(newsSources.kind, 'sec_edgar'),
        isNotNull(rawNewsItems.url),
        formTypeMatches(formTypes),
        queuePredicate(options),
      ),
    );
  return Number(rows[0]?.total ?? 0);
}

/** Shared by the loader and the counter so "remaining" always matches the queue. */
function queuePredicate(options: {
  maxAttempts: number;
  includeStored?: boolean;
  onlyStale?: boolean;
}) {
  const retryable = and(
    eq(itemDocuments.status, 'failed'),
    lt(itemDocuments.attempts, options.maxAttempts),
  );
  if (options.includeStored !== true) {
    return or(sql`${itemDocuments.itemId} IS NULL`, retryable);
  }
  const stored =
    options.onlyStale === true
      ? and(
          eq(itemDocuments.status, 'ok'),
          eq(itemDocuments.truncated, true),
          lt(itemDocuments.fetcherVersion, EDGAR_FETCHER_VERSION),
        )
      : eq(itemDocuments.status, 'ok');
  return or(sql`${itemDocuments.itemId} IS NULL`, retryable, stored);
}

export interface RecordFilingDocumentInput {
  itemId: string;
  status: 'ok' | 'empty';
  docRef: string | null;
  charCount: number;
  documentCount: number;
  truncated: boolean;
  at: Date;
}

/** Terminal outcome. Attempts is left as-is: the item leaves the queue either way. */
export async function recordFilingDocument(
  db: Db,
  input: RecordFilingDocumentInput,
): Promise<void> {
  await db
    .insert(itemDocuments)
    .values({
      itemId: input.itemId,
      status: input.status,
      docRef: input.docRef,
      charCount: input.charCount,
      documentCount: input.documentCount,
      truncated: input.truncated,
      // Stamped, never taken from the caller: the row must record the fetcher
      // that produced it or staleness cannot be computed.
      fetcherVersion: EDGAR_FETCHER_VERSION,
      attempts: 1,
      lastError: null,
      fetchedAt: input.at,
    })
    .onConflictDoUpdate({
      target: itemDocuments.itemId,
      set: {
        status: input.status,
        docRef: input.docRef,
        charCount: input.charCount,
        documentCount: input.documentCount,
        truncated: input.truncated,
        fetcherVersion: EDGAR_FETCHER_VERSION,
        attempts: sql`${itemDocuments.attempts} + 1`,
        lastError: null,
        fetchedAt: input.at,
      },
    });
}

/** Retryable failure — attempts += 1, latest error wins (llm_attempts pattern). */
export async function recordFilingFailure(
  db: Db,
  input: { itemId: string; error: string; at: Date },
): Promise<void> {
  await db
    .insert(itemDocuments)
    .values({
      itemId: input.itemId,
      status: 'failed',
      docRef: null,
      attempts: 1,
      lastError: input.error.slice(0, 500),
      fetchedAt: input.at,
    })
    .onConflictDoUpdate({
      target: itemDocuments.itemId,
      set: {
        status: 'failed',
        docRef: null,
        attempts: sql`${itemDocuments.attempts} + 1`,
        lastError: input.error.slice(0, 500),
        fetchedAt: input.at,
      },
    });
}

/** doc_ref per item for the items in one prompt. Missing item = no document. */
export async function loadFilingDocumentRefs(
  db: Db,
  itemIds: string[],
): Promise<Map<string, string>> {
  if (itemIds.length === 0) return new Map();
  const rows = await db
    .select({ itemId: itemDocuments.itemId, docRef: itemDocuments.docRef })
    .from(itemDocuments)
    .where(and(eq(itemDocuments.status, 'ok'), inArray(itemDocuments.itemId, itemIds)));
  const refs = new Map<string, string>();
  for (const row of rows) {
    if (row.docRef !== null) refs.set(row.itemId, row.docRef);
  }
  return refs;
}

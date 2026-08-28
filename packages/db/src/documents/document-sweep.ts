import type { RawStore } from '@newstrader/core';

import type { Db } from '../client.js';
import { fetchFilingText, type FetchFilingTextOptions } from './edgar-documents.js';
import {
  countFilingFetchCandidates,
  filingDocumentKey,
  loadFilingFetchCandidates,
  recordFilingDocument,
  recordFilingFailure,
} from './document-repo.js';

/**
 * The EDGAR filing-document sweep — fetch 8-K bodies (and their press-release
 * exhibits) so the interpreter sees what the filing says instead of only its
 * form type and item codes.
 *
 * Runs as its own stage rather than inside the interpret sweep for three
 * reasons: a filing is fetched ONCE and reused by every prompt version and
 * every re-run; SEC's rate limit belongs nowhere near a loop that also calls an
 * LLM; and a fetch failure here must not degrade an interpretation silently.
 *
 * Failure policy mirrors the interpret sweep's split. A per-item failure is
 * recorded and the pass continues — one unreachable filing must not stall the
 * queue. There is no whole-pass abort: unlike LLM spend, a retried GET costs
 * nothing but a request.
 */

const DEFAULT_BATCH = 100;
const MAX_ATTEMPTS = 3;

export interface DocumentSweepDeps {
  /** Where flattened filing text is stored (FsRawStore locally, S3 deployed). */
  store: RawStore;
  /** SEC contact string — requests without one are 403'd. */
  userAgent: string;
  fetchImpl?: FetchFilingTextOptions['fetchImpl'];
  requestDelayMs?: number;
  sleep?: FetchFilingTextOptions['sleep'];
  now?: () => Date;
}

export interface DocumentSweepOptions {
  batch?: number;
  formTypes?: string[];
  /** Re-fetch items that already have text (extractor improved). */
  refetch?: boolean;
  /** With refetch, re-queue only filings an older fetcher version trimmed. */
  refetchStaleOnly?: boolean;
}

export interface DocumentSweepResult {
  examined: number;
  stored: number;
  empty: number;
  failed: number;
  charsStored: number;
  truncated: number;
  /** Candidates still queued after this pass. */
  remaining: number;
}

export async function documentSweep(
  db: Db,
  deps: DocumentSweepDeps,
  options?: DocumentSweepOptions,
): Promise<DocumentSweepResult> {
  const nowFn = deps.now ?? ((): Date => new Date());
  const batch = options?.batch ?? DEFAULT_BATCH;
  const queueOptions = {
    maxAttempts: MAX_ATTEMPTS,
    ...(options?.formTypes !== undefined ? { formTypes: options.formTypes } : {}),
    ...(options?.refetch === true ? { includeStored: true } : {}),
    ...(options?.refetchStaleOnly === true ? { onlyStale: true } : {}),
  };

  const candidates = await loadFilingFetchCandidates(db, { ...queueOptions, batch });
  const result: DocumentSweepResult = {
    examined: candidates.length,
    stored: 0,
    empty: 0,
    failed: 0,
    charsStored: 0,
    truncated: 0,
    remaining: 0,
  };

  for (const candidate of candidates) {
    try {
      const filing = await fetchFilingText(candidate.url, {
        userAgent: deps.userAgent,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.requestDelayMs !== undefined ? { requestDelayMs: deps.requestDelayMs } : {}),
        ...(deps.sleep !== undefined ? { sleep: deps.sleep } : {}),
      });

      if (filing.documents.length === 0) {
        await recordFilingDocument(db, {
          itemId: candidate.itemId,
          status: 'empty',
          docRef: null,
          charCount: 0,
          documentCount: 0,
          truncated: false,
          at: nowFn(),
        });
        result.empty += 1;
        continue;
      }

      const docRef = await deps.store.put(filingDocumentKey(candidate.itemId), {
        schemaVersion: 1,
        itemId: candidate.itemId,
        indexUrl: candidate.url,
        formType: candidate.formType,
        documents: filing.documents,
        text: filing.text,
        truncated: filing.truncated,
        fetchedAtIso: nowFn().toISOString(),
      });
      await recordFilingDocument(db, {
        itemId: candidate.itemId,
        status: 'ok',
        docRef,
        charCount: filing.text.length,
        documentCount: filing.documents.length,
        truncated: filing.truncated,
        at: nowFn(),
      });
      result.stored += 1;
      result.charsStored += filing.text.length;
      if (filing.truncated) result.truncated += 1;
    } catch (error) {
      await recordFilingFailure(db, {
        itemId: candidate.itemId,
        error: error instanceof Error ? error.message : String(error),
        at: nowFn(),
      });
      result.failed += 1;
    }
  }

  result.remaining = await countFilingFetchCandidates(db, queueOptions);
  logSweep(result);
  return result;
}

function logSweep(result: DocumentSweepResult): void {
  console.log(JSON.stringify({ level: 'info', msg: 'edgar_document_sweep', ...result }));
}

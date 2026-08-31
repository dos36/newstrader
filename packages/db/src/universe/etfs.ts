import { and, eq, inArray, isNull } from 'drizzle-orm';

import { newId } from '@newstrader/core';

import type { Db } from '../client.js';
import { indexMembership, instruments } from '../schema.js';

/**
 * Curated ETF universe — the macro path's tradeable instruments for events
 * that move a COUNTRY, SECTOR, COMMODITY, BOND CLASS, or CURRENCY rather than
 * a nameable company.
 *
 * Why this exists: the discovery candidate list was S&P 500 + crypto, so a
 * breaking story about one foreign economy had no honest pick — every company
 * actually exposed was outside the universe, and the model was (correctly)
 * forced to answer "none". A single-country ETF IS the direct expression of
 * exactly that judgment, listed on a US exchange with the same bars, sessions,
 * and sim-broker mechanics as any S&P name.
 *
 * Why CURATED, not "all ETFs" (or "all companies"): every candidate line is
 * prompt surface and every possible pick must be measurable, so the list is
 * limited to large, liquid, US-listed funds whose NAME states what they track
 * — the model picks from names, so a fund whose exposure is not legible from
 * its name would only invite mistakes. ~80 funds cover the transmission
 * channels the macro taxonomy names; obscure or levered products add risk and
 * prompt noise without adding coverage.
 *
 * Selection rules, applied to every entry:
 *   - US-listed (NYSE Arca / Nasdaq). Massive serves US-market bars, so a
 *     Toronto-only listing would produce signals nothing can measure; Canadian
 *     exposure rides on US listings (EWC, and the majors' NYSE tickers).
 *   - Listed and liquid before {@link ETF_VALID_FROM} — the membership rows
 *     below claim tradability from that date, and the claim must be true
 *     (invariant 5 is about honest membership intervals, not just the S&P).
 *   - Unlevered, long-only. Levered/inverse products decay by construction
 *     and would poison reaction measurement.
 *
 * assetClass is 'us_equity' deliberately: mechanically these ARE US-listed
 * equity-like instruments — same bars endpoints, same sessions, same
 * decimal-string accounting. sectorApprox is the literal tag 'ETF', which (a)
 * can never collide with a GICS-11 label, so the v1m sector fanout can never
 * sweep an ETF into a company basket, and (b) gives per-sector eval cuts an
 * honest ETF bucket.
 */
export const ETF_INDEX_CODE = 'ETF_CORE';

/**
 * Every fund below was listed before this date (the youngest, XLC, listed
 * 2018-06). One shared constant keeps the seed idempotent and auditable; if a
 * younger fund is ever added, give IT a per-entry validFrom rather than moving
 * this date forward for everyone.
 */
export const ETF_VALID_FROM = new Date('2020-01-01T00:00:00Z');

export interface CuratedEtf {
  symbol: string;
  name: string;
}

export const CURATED_ETFS: readonly CuratedEtf[] = [
  // --- single-country / regional equity ---
  { symbol: 'EWG', name: 'iShares MSCI Germany ETF' },
  { symbol: 'EWQ', name: 'iShares MSCI France ETF' },
  { symbol: 'EWU', name: 'iShares MSCI United Kingdom ETF' },
  { symbol: 'EWI', name: 'iShares MSCI Italy ETF' },
  { symbol: 'EWP', name: 'iShares MSCI Spain ETF' },
  { symbol: 'EWL', name: 'iShares MSCI Switzerland ETF' },
  { symbol: 'EWN', name: 'iShares MSCI Netherlands ETF' },
  { symbol: 'EWD', name: 'iShares MSCI Sweden ETF' },
  { symbol: 'EPOL', name: 'iShares MSCI Poland ETF' },
  { symbol: 'TUR', name: 'iShares MSCI Turkey ETF' },
  { symbol: 'EIS', name: 'iShares MSCI Israel ETF' },
  { symbol: 'KSA', name: 'iShares MSCI Saudi Arabia ETF' },
  { symbol: 'EZA', name: 'iShares MSCI South Africa ETF' },
  { symbol: 'EWJ', name: 'iShares MSCI Japan ETF' },
  { symbol: 'EWY', name: 'iShares MSCI South Korea ETF' },
  { symbol: 'EWT', name: 'iShares MSCI Taiwan ETF' },
  { symbol: 'MCHI', name: 'iShares MSCI China ETF' },
  { symbol: 'KWEB', name: 'KraneShares CSI China Internet ETF' },
  { symbol: 'INDA', name: 'iShares MSCI India ETF' },
  { symbol: 'EIDO', name: 'iShares MSCI Indonesia ETF' },
  { symbol: 'EWS', name: 'iShares MSCI Singapore ETF' },
  { symbol: 'EWH', name: 'iShares MSCI Hong Kong ETF' },
  { symbol: 'EWA', name: 'iShares MSCI Australia ETF' },
  { symbol: 'EWC', name: 'iShares MSCI Canada ETF' },
  { symbol: 'EWW', name: 'iShares MSCI Mexico ETF' },
  { symbol: 'EWZ', name: 'iShares MSCI Brazil ETF' },
  { symbol: 'ARGT', name: 'Global X MSCI Argentina ETF' },
  { symbol: 'ILF', name: 'iShares Latin America 40 ETF' },
  { symbol: 'VGK', name: 'Vanguard FTSE Europe ETF' },
  { symbol: 'EFA', name: 'iShares MSCI EAFE ETF (developed markets ex-US)' },
  { symbol: 'EEM', name: 'iShares MSCI Emerging Markets ETF' },
  // --- US sector (GICS-11 via SPDR) ---
  { symbol: 'XLE', name: 'Energy Select Sector SPDR Fund' },
  { symbol: 'XLF', name: 'Financial Select Sector SPDR Fund' },
  { symbol: 'XLK', name: 'Technology Select Sector SPDR Fund' },
  { symbol: 'XLV', name: 'Health Care Select Sector SPDR Fund' },
  { symbol: 'XLI', name: 'Industrial Select Sector SPDR Fund' },
  { symbol: 'XLB', name: 'Materials Select Sector SPDR Fund' },
  { symbol: 'XLP', name: 'Consumer Staples Select Sector SPDR Fund' },
  { symbol: 'XLY', name: 'Consumer Discretionary Select Sector SPDR Fund' },
  { symbol: 'XLU', name: 'Utilities Select Sector SPDR Fund' },
  { symbol: 'XLRE', name: 'Real Estate Select Sector SPDR Fund' },
  { symbol: 'XLC', name: 'Communication Services Select Sector SPDR Fund' },
  // --- industry ---
  { symbol: 'SMH', name: 'VanEck Semiconductor ETF' },
  { symbol: 'ITA', name: 'iShares U.S. Aerospace & Defense ETF' },
  { symbol: 'KRE', name: 'SPDR S&P Regional Banking ETF' },
  { symbol: 'XOP', name: 'SPDR S&P Oil & Gas Exploration & Production ETF' },
  { symbol: 'OIH', name: 'VanEck Oil Services ETF' },
  { symbol: 'XBI', name: 'SPDR S&P Biotech ETF' },
  { symbol: 'ITB', name: 'iShares U.S. Home Construction ETF' },
  { symbol: 'IYT', name: 'iShares U.S. Transportation ETF' },
  { symbol: 'JETS', name: 'U.S. Global Jets ETF (airlines)' },
  { symbol: 'TAN', name: 'Invesco Solar ETF' },
  { symbol: 'ICLN', name: 'iShares Global Clean Energy ETF' },
  { symbol: 'URA', name: 'Global X Uranium ETF' },
  { symbol: 'LIT', name: 'Global X Lithium & Battery Tech ETF' },
  { symbol: 'HACK', name: 'Amplify Cybersecurity ETF' },
  { symbol: 'REMX', name: 'VanEck Rare Earth and Strategic Metals ETF' },
  { symbol: 'COPX', name: 'Global X Copper Miners ETF' },
  { symbol: 'GDX', name: 'VanEck Gold Miners ETF' },
  { symbol: 'XME', name: 'SPDR S&P Metals & Mining ETF' },
  { symbol: 'MOO', name: 'VanEck Agribusiness ETF' },
  // --- commodity ---
  { symbol: 'GLD', name: 'SPDR Gold Shares' },
  { symbol: 'SLV', name: 'iShares Silver Trust' },
  { symbol: 'USO', name: 'United States Oil Fund (WTI crude)' },
  { symbol: 'BNO', name: 'United States Brent Oil Fund' },
  { symbol: 'UNG', name: 'United States Natural Gas Fund' },
  { symbol: 'DBA', name: 'Invesco DB Agriculture Fund' },
  { symbol: 'DBC', name: 'Invesco DB Commodity Index Tracking Fund' },
  { symbol: 'CPER', name: 'United States Copper Index Fund' },
  { symbol: 'WEAT', name: 'Teucrium Wheat Fund' },
  { symbol: 'CORN', name: 'Teucrium Corn Fund' },
  // --- rates / credit / currency ---
  { symbol: 'TLT', name: 'iShares 20+ Year Treasury Bond ETF' },
  { symbol: 'IEF', name: 'iShares 7-10 Year Treasury Bond ETF' },
  { symbol: 'SHY', name: 'iShares 1-3 Year Treasury Bond ETF' },
  { symbol: 'TIP', name: 'iShares TIPS Bond ETF (inflation-protected)' },
  { symbol: 'LQD', name: 'iShares iBoxx $ Investment Grade Corporate Bond ETF' },
  { symbol: 'HYG', name: 'iShares iBoxx $ High Yield Corporate Bond ETF' },
  { symbol: 'UUP', name: 'Invesco DB US Dollar Index Bullish Fund' },
  { symbol: 'FXE', name: 'Invesco CurrencyShares Euro Trust' },
  { symbol: 'FXY', name: 'Invesco CurrencyShares Japanese Yen Trust' },
] as const;

export interface SeedEtfCounts {
  instrumentsInserted: number;
  instrumentsExisting: number;
  membershipsInserted: number;
}

/**
 * Idempotent seed: upsert each curated ETF into `instruments` and give it an
 * open membership row under {@link ETF_INDEX_CODE}.
 *
 * Deliberately does NOT close memberships absent from the list — removing an
 * ETF from the curated set is a decision about the FUTURE universe and must be
 * made explicitly (set valid_to by hand), not implied by a code edit; closing
 * rows on sync is `universe:sync`'s S&P-scoped behavior, where the external
 * list is authoritative. Here the code IS the list.
 */
export async function seedEtfUniverse(db: Db): Promise<SeedEtfCounts> {
  const counts: SeedEtfCounts = {
    instrumentsInserted: 0,
    instrumentsExisting: 0,
    membershipsInserted: 0,
  };

  for (const etf of CURATED_ETFS) {
    const inserted = await db
      .insert(instruments)
      .values({
        id: newId(),
        symbol: etf.symbol,
        assetClass: 'us_equity',
        name: etf.name,
        sectorApprox: 'ETF',
      })
      .onConflictDoNothing({ target: [instruments.symbol, instruments.assetClass] })
      .returning({ id: instruments.id });

    let instrumentId = inserted[0]?.id;
    if (instrumentId === undefined) {
      counts.instrumentsExisting += 1;
      const existing = await db
        .select({ id: instruments.id })
        .from(instruments)
        .where(and(eq(instruments.symbol, etf.symbol), eq(instruments.assetClass, 'us_equity')));
      instrumentId = existing[0]?.id;
      if (instrumentId === undefined) {
        throw new Error(`seedEtfUniverse: upsert for ${etf.symbol} found no row`);
      }
    } else {
      counts.instrumentsInserted += 1;
    }

    const membership = await db
      .insert(indexMembership)
      .values({
        instrumentId,
        indexCode: ETF_INDEX_CODE,
        validFrom: ETF_VALID_FROM,
      })
      .onConflictDoNothing()
      .returning({ instrumentId: indexMembership.instrumentId });
    counts.membershipsInserted += membership.length;
  }

  return counts;
}

/** Open ETF_CORE memberships — used by tests and the seed command's report. */
export async function listEtfUniverse(db: Db): Promise<string[]> {
  const rows = await db
    .select({ symbol: instruments.symbol })
    .from(indexMembership)
    .innerJoin(instruments, eq(instruments.id, indexMembership.instrumentId))
    .where(
      and(
        eq(indexMembership.indexCode, ETF_INDEX_CODE),
        isNull(indexMembership.validTo),
        inArray(
          instruments.symbol,
          CURATED_ETFS.map((etf) => etf.symbol),
        ),
      ),
    )
    .orderBy(instruments.symbol);
  return rows.map((row) => row.symbol);
}

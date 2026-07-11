import { describe, expect, it } from 'vitest';
import {
  CONFIDENCE,
  resolveItem,
  RESOLVER_VERSION,
  type ResolvableItem,
  type ResolverDictionary,
} from './match.js';

/**
 * Pure-matcher tests — no network, no DB. The dictionary fixture deliberately
 * includes the pathological entries the false-positive guards exist for:
 * 1–2 char tickers (A, IT, V), name-collision companies (Target, Apple), a
 * generic stoplisted alias ("Company"), and a too-short name alias ("KO").
 */

const ID = {
  aapl: 'ins_aapl',
  ko: 'ins_ko',
  brkB: 'ins_brkb',
  agilent: 'ins_a',
  gartner: 'ins_it',
  target: 'ins_tgt',
  visa: 'ins_v',
  abc: 'ins_abc',
  btc: 'ins_btc',
  eth: 'ins_eth',
  sol: 'ins_sol',
} as const;

const dict: ResolverDictionary = {
  byCik: new Map([
    ['0000320193', ID.aapl],
    ['0000021344', ID.ko],
  ]),
  byTicker: new Map([
    ['AAPL', ID.aapl],
    ['KO', ID.ko],
    ['BRK.B', ID.brkB],
    ['A', ID.agilent],
    ['IT', ID.gartner],
    ['TGT', ID.target],
    ['V', ID.visa],
    ['ABC', ID.abc],
    ['BTC', ID.btc],
  ]),
  nameAliases: [
    { alias: 'Apple', instrumentId: ID.aapl, kind: 'name', assetClass: 'us_equity' },
    { alias: 'Coca-Cola', instrumentId: ID.ko, kind: 'name', assetClass: 'us_equity' },
    { alias: 'Target', instrumentId: ID.target, kind: 'name', assetClass: 'us_equity' },
    { alias: 'Visa', instrumentId: ID.visa, kind: 'name', assetClass: 'us_equity' },
    // Guard fodder: <4 chars, stoplisted, and an equity ticker as a scan entry.
    { alias: 'KO', instrumentId: ID.ko, kind: 'name', assetClass: 'us_equity' },
    { alias: 'Company', instrumentId: ID.aapl, kind: 'name', assetClass: 'us_equity' },
    { alias: 'AAPL', instrumentId: ID.aapl, kind: 'ticker', assetClass: 'us_equity' },
    // Crypto keywords.
    { alias: 'Bitcoin', instrumentId: ID.btc, kind: 'name', assetClass: 'crypto' },
    { alias: 'BTC', instrumentId: ID.btc, kind: 'ticker', assetClass: 'crypto' },
    { alias: 'Ethereum', instrumentId: ID.eth, kind: 'name', assetClass: 'crypto' },
    { alias: 'ETH', instrumentId: ID.eth, kind: 'ticker', assetClass: 'crypto' },
    { alias: 'Solana', instrumentId: ID.sol, kind: 'name', assetClass: 'crypto' },
    { alias: 'SOL', instrumentId: ID.sol, kind: 'ticker', assetClass: 'crypto' },
  ],
};

const item = (over: Partial<ResolvableItem>): ResolvableItem => ({
  headline: 'No entities here',
  symbolsHint: [],
  meta: {},
  ...over,
});

describe('resolver constants', () => {
  it('pins the r1 resolver version', () => {
    expect(RESOLVER_VERSION).toBe('r1');
  });
});

describe('resolveItem: EDGAR / cik_exact', () => {
  it('resolves an unpadded string CIK by zero-padding it', () => {
    const links = resolveItem(item({ meta: { cik: '320193' } }), dict);
    expect(links).toEqual([{ instrumentId: ID.aapl, method: 'cik_exact', confidence: 1 }]);
  });

  it('resolves a numeric CIK', () => {
    const links = resolveItem(item({ meta: { cik: 21344 } }), dict);
    expect(links).toEqual([{ instrumentId: ID.ko, method: 'cik_exact', confidence: 1 }]);
  });

  it('resolves an already-padded CIK', () => {
    const links = resolveItem(item({ meta: { cik: '0000320193' } }), dict);
    expect(links).toEqual([{ instrumentId: ID.aapl, method: 'cik_exact', confidence: 1 }]);
  });

  it('STOPS after CIK: never text-scans a filing, even with matchable text and hints', () => {
    const links = resolveItem(
      item({
        headline: '8-K - Apple Inc (0000320193) (Filer) — Coca-Cola supply deal (NASDAQ: AAPL)',
        body: 'Mentions Target, $KO and NYSE: TGT throughout.',
        symbolsHint: ['TGT', 'AAPL'],
        meta: { cik: '320193', itemCodes: ['1.01'] },
      }),
      dict,
    );
    expect(links).toEqual([{ instrumentId: ID.aapl, method: 'cik_exact', confidence: 1 }]);
  });

  it('returns nothing on a CIK miss — a filing outside the universe stays unresolved', () => {
    const links = resolveItem(
      item({ headline: 'Coca-Cola beats estimates', meta: { cik: '9999999999' } }),
      dict,
    );
    expect(links).toEqual([]);
  });

  it('returns nothing on a malformed CIK — presence of the key still means "filing"', () => {
    const links = resolveItem(
      item({ headline: 'Coca-Cola beats estimates', meta: { cik: 'not-a-cik' } }),
      dict,
    );
    expect(links).toEqual([]);
  });
});

describe('resolveItem: source_hint', () => {
  it('resolves vendor symbol hints at 0.95, ignoring unknown symbols', () => {
    const links = resolveItem(item({ symbolsHint: ['AAPL', 'ZZZZ'] }), dict);
    expect(links).toEqual([
      { instrumentId: ID.aapl, method: 'source_hint', confidence: CONFIDENCE.sourceHint },
    ]);
  });

  it('uppercases hints before lookup', () => {
    const links = resolveItem(item({ symbolsHint: ['aapl'] }), dict);
    expect(links[0]?.instrumentId).toBe(ID.aapl);
  });

  it('rejects 1–2 char tickers even as vendor hints (A, IT, V)', () => {
    const links = resolveItem(item({ symbolsHint: ['A', 'IT', 'V'] }), dict);
    expect(links).toEqual([]);
  });

  it('accepts 3-char hints (boundary of the short-ticker guard)', () => {
    const links = resolveItem(item({ symbolsHint: ['TGT'] }), dict);
    expect(links).toEqual([
      { instrumentId: ID.target, method: 'source_hint', confidence: CONFIDENCE.sourceHint },
    ]);
  });
});

describe('resolveItem: exchange-prefix ticker_exact (0.9)', () => {
  it.each([
    ['Shares jump after results (NASDAQ: AAPL)', ID.aapl],
    ['Shares jump after results (Nasdaq: AAPL)', ID.aapl],
    ['Beverage giant rallies (NYSE: KO)', ID.ko],
    ['Small cap soars (NYSE American: ABC)', ID.abc],
    ['ETF flows shift (NYSE Arca: ABC)', ID.abc],
  ])('matches %s', (headline, instrumentId) => {
    expect(resolveItem(item({ headline }), dict)).toEqual([
      { instrumentId, method: 'ticker_exact', confidence: CONFIDENCE.exchangePrefix },
    ]);
  });

  it('matches BRK.B-style dotted class tickers', () => {
    const links = resolveItem(item({ headline: 'Buffett annual letter (NYSE: BRK.B)' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.brkB, method: 'ticker_exact', confidence: CONFIDENCE.exchangePrefix },
    ]);
  });

  it('allows 1-char tickers in the exchange-prefix form', () => {
    const links = resolveItem(item({ headline: 'Agilent guidance (NYSE: A)' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.agilent, method: 'ticker_exact', confidence: CONFIDENCE.exchangePrefix },
    ]);
  });

  it('scans the body too', () => {
    const links = resolveItem(
      item({ headline: 'Quarterly results announced', body: 'The company (NYSE: KO) said…' }),
      dict,
    );
    expect(links).toEqual([
      { instrumentId: ID.ko, method: 'ticker_exact', confidence: CONFIDENCE.exchangePrefix },
    ]);
  });

  it('ignores unknown tickers in the exchange form', () => {
    expect(resolveItem(item({ headline: 'IPO pops (NYSE: ZZZZ)' }), dict)).toEqual([]);
  });
});

describe('resolveItem: cashtag ticker_exact (0.85)', () => {
  it('matches cashtags in headline and body', () => {
    const links = resolveItem(
      item({ headline: '$AAPL rallies into the close', body: 'Options flow on $TGT too.' }),
      dict,
    );
    expect(links).toEqual([
      { instrumentId: ID.aapl, method: 'ticker_exact', confidence: CONFIDENCE.cashtag },
      { instrumentId: ID.target, method: 'ticker_exact', confidence: CONFIDENCE.cashtag },
    ]);
  });

  it('allows 1–2 char tickers as cashtags — a $ prefix is a deliberate tag', () => {
    const links = resolveItem(item({ headline: 'Traders pile into $IT and $A' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.agilent, method: 'ticker_exact', confidence: CONFIDENCE.cashtag },
      { instrumentId: ID.gartner, method: 'ticker_exact', confidence: CONFIDENCE.cashtag },
    ]);
  });

  it('does not treat dollar amounts as cashtags', () => {
    expect(resolveItem(item({ headline: 'Deal valued at $5 billion' }), dict)).toEqual([]);
  });
});

describe('resolveItem: bare-token and short-ticker guards', () => {
  it('never matches bare ticker tokens in prose ("AAPL rises" is not a method)', () => {
    expect(resolveItem(item({ headline: 'AAPL rises after earnings beat' }), dict)).toEqual([]);
  });

  it('the words "A" and "IT" in prose must not match tickers A/IT', () => {
    const links = resolveItem(
      item({
        headline: 'A judge ruled that IT departments must upgrade',
        body: 'A big change for IT teams everywhere.',
      }),
      dict,
    );
    expect(links).toEqual([]);
  });
});

describe('resolveItem: alias_dict name scan (headline only)', () => {
  it('matches a name alias in the headline at 0.7', () => {
    const links = resolveItem(item({ headline: 'Coca-Cola beats estimates' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.ko, method: 'alias_dict', confidence: CONFIDENCE.nameAlias },
    ]);
  });

  it('matches case-insensitively', () => {
    const links = resolveItem(item({ headline: 'COCA-COLA BEATS ESTIMATES' }), dict);
    expect(links[0]?.instrumentId).toBe(ID.ko);
  });

  it('requires word boundaries ("Targeting" is not "Target")', () => {
    expect(resolveItem(item({ headline: 'Targeting new markets in 2027' }), dict)).toEqual([]);
  });

  it('never scans the body for name aliases (body prose is too noisy)', () => {
    const links = resolveItem(
      item({ headline: 'Quarterly results announced', body: 'Coca-Cola and Apple both fell.' }),
      dict,
    );
    expect(links).toEqual([]);
  });

  it('accepts 4-char real names like Visa', () => {
    const links = resolveItem(item({ headline: 'Visa expands tap-to-pay in Canada' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.visa, method: 'alias_dict', confidence: CONFIDENCE.nameAlias },
    ]);
  });

  it('accepts collision-prone real names (Target) at 0.7 — the documented tradeoff', () => {
    const links = resolveItem(item({ headline: 'Target beats estimates' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.target, method: 'alias_dict', confidence: CONFIDENCE.nameAlias },
    ]);
  });

  it('skips name aliases shorter than 4 chars ("KO" as a word)', () => {
    expect(resolveItem(item({ headline: 'KO wins court ruling' }), dict)).toEqual([]);
  });

  it('skips stoplisted generic aliases ("Company")', () => {
    expect(resolveItem(item({ headline: 'Company announces layoffs' }), dict)).toEqual([]);
  });

  it('never scans equity kind=ticker aliases as words', () => {
    // 'AAPL' exists in nameAliases as an equity ticker entry — must be inert.
    expect(resolveItem(item({ headline: 'AAPL AAPL AAPL' }), dict)).toEqual([]);
  });
});

describe('resolveItem: crypto keywords (0.8)', () => {
  it('resolves "Bitcoin slides 5%" to BTC via the crypto name alias', () => {
    const links = resolveItem(item({ headline: 'Bitcoin slides 5% as yields rise' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.btc, method: 'alias_dict', confidence: CONFIDENCE.cryptoKeyword },
    ]);
  });

  it('resolves uppercase crypto ticker keywords ("SOL outage")', () => {
    const links = resolveItem(item({ headline: 'SOL validators halt after outage' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.sol, method: 'alias_dict', confidence: CONFIDENCE.cryptoKeyword },
    ]);
  });

  it('crypto ticker keywords are case-sensitive ("sol"/"eth" prose does not match)', () => {
    const links = resolveItem(
      item({ headline: 'Un dia de sol: solar stocks rise, eth-ernet suppliers gain' }),
      dict,
    );
    expect(links).toEqual([]);
  });

  it('resolves multiple coins in one headline', () => {
    const links = resolveItem(
      item({ headline: 'Bitcoin and Ethereum diverge; Solana flat' }),
      dict,
    );
    expect(links.map((l) => l.instrumentId).sort()).toEqual([ID.btc, ID.eth, ID.sol].sort());
    expect(new Set(links.map((l) => l.confidence))).toEqual(new Set([CONFIDENCE.cryptoKeyword]));
  });
});

describe('resolveItem: dedupe and ordering', () => {
  it('keeps the single highest-confidence method per instrument (hint beats prefix)', () => {
    const links = resolveItem(
      item({ headline: 'Results out (NASDAQ: AAPL)', symbolsHint: ['AAPL'] }),
      dict,
    );
    expect(links).toEqual([
      { instrumentId: ID.aapl, method: 'source_hint', confidence: CONFIDENCE.sourceHint },
    ]);
  });

  it('prefix beats cashtag beats name alias for the same instrument', () => {
    const links = resolveItem(
      item({ headline: 'Apple unveils $AAPL buyback (NASDAQ: AAPL)' }),
      dict,
    );
    expect(links).toEqual([
      { instrumentId: ID.aapl, method: 'ticker_exact', confidence: CONFIDENCE.exchangePrefix },
    ]);
  });

  it('sorts multi-instrument results by confidence desc, then instrumentId', () => {
    const links = resolveItem(
      item({ headline: 'Coca-Cola rallies alongside $TGT and Bitcoin' }),
      dict,
    );
    expect(links).toEqual([
      { instrumentId: ID.target, method: 'ticker_exact', confidence: CONFIDENCE.cashtag },
      { instrumentId: ID.btc, method: 'alias_dict', confidence: CONFIDENCE.cryptoKeyword },
      { instrumentId: ID.ko, method: 'alias_dict', confidence: CONFIDENCE.nameAlias },
    ]);
  });

  it('resolves nothing on an empty/irrelevant item', () => {
    expect(resolveItem(item({}), dict)).toEqual([]);
  });
});

describe('resolveItem: review-fix regressions', () => {
  const item = (overrides: Partial<ResolvableItem>): ResolvableItem => ({
    headline: 'irrelevant',
    symbolsHint: [],
    meta: {},
    ...overrides,
  });

  it('treats itemCodes/formType meta as a filing even when the cik key is absent', () => {
    // EDGAR sets meta.cik only when its title regex matches; itemCodes is
    // unconditional. A filing whose title CIK failed to parse must NOT fall
    // through to the alias text scan and link a mentioned counterparty.
    const links = resolveItem(
      item({
        headline: '8-K - Unparseable Title Co announces agreement with Apple Inc.',
        meta: { itemCodes: ['1.01'] },
      }),
      dict,
    );
    expect(links).toEqual([]);
  });

  it('matches name aliases that end in punctuation ("Apple Inc." style)', () => {
    const punctDict: ResolverDictionary = {
      byCik: new Map(),
      byTicker: new Map(),
      nameAliases: [
        { alias: 'Apple Inc.', instrumentId: ID.aapl, kind: 'name', assetClass: 'us_equity' },
      ],
    };
    const links = resolveItem(
      item({ headline: 'Apple Inc. reports record quarterly earnings' }),
      punctDict,
    );
    expect(links).toEqual([
      { instrumentId: ID.aapl, method: 'alias_dict', confidence: CONFIDENCE.nameAlias },
    ]);
    // Word-boundary discipline survives the lookaround rewrite.
    expect(
      resolveItem(item({ headline: 'Pineapple Inc. reports record earnings' }), punctDict),
    ).toEqual([]);
  });

  it('captures dot-class cashtags ($BRK.B)', () => {
    const links = resolveItem(item({ headline: 'Berkshire buyback chatter lifts $BRK.B' }), dict);
    expect(links).toEqual([
      { instrumentId: ID.brkB, method: 'ticker_exact', confidence: CONFIDENCE.cashtag },
    ]);
  });

  it('matches short digit-bearing names ("3M") case-sensitively only', () => {
    const mmmDict: ResolverDictionary = {
      byCik: new Map(),
      byTicker: new Map(),
      nameAliases: [
        { alias: '3M', instrumentId: 'ins_mmm', kind: 'name', assetClass: 'us_equity' },
      ],
    };
    expect(resolveItem(item({ headline: '3M announces restructuring' }), mmmDict)).toEqual([
      { instrumentId: 'ins_mmm', method: 'alias_dict', confidence: CONFIDENCE.nameAlias },
    ]);
    // Lowercase prose ("a 3m drop") must not match the company.
    expect(resolveItem(item({ headline: 'Flood waters rose 3m overnight' }), mmmDict)).toEqual([]);
    // Pure-letter short aliases stay banned regardless of case.
    expect(resolveItem(item({ headline: 'KO for the challenger' }), dict)).toEqual([]);
  });
});

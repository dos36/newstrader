# Options data — how to get it

Status: **research only**. Nothing in the codebase reads options yet — no schema, no
adapter, no analysis. This documents what the existing account can already reach, so
that work does not start with a vendor evaluation.

## The vendor is the one you already pay

`polygon.io` now redirects to `massive.com` — Massive is Polygon rebranded. So the
`MASSIVE_API_KEY` and `MASSIVE_BASE_URL` already in `.env` are an options credential
too, and the `FetchLike` seam in `bars/massive-bars.ts` is the pattern to copy.

- Base URL: `MASSIVE_BASE_URL` (currently `https://api.polygon.io`)
- Auth: `Authorization: Bearer <MASSIVE_API_KEY>` — the same Bearer discipline the
  bars client uses, keeping the key out of URLs and logs.

## What the current key can and cannot do

Probed 2026-08-27 against the live key. **Historical options work today at no extra
cost; only the live chain snapshot is gated.**

| Endpoint                                               | Purpose                      | Result                 |
| ------------------------------------------------------ | ---------------------------- | ---------------------- |
| `GET /v3/reference/options/contracts`                  | list contracts (the chain)   | **200 OK**             |
| `GET /v2/aggs/ticker/O:.../range/1/day/{from}/{to}`    | daily bars per contract      | **200 OK**             |
| `GET /v2/aggs/ticker/O:.../range/1/minute/{from}/{to}` | minute bars per contract     | **200 OK**             |
| `GET /v3/snapshot/options/{underlying}`                | live chain snapshot + Greeks | **403 NOT_AUTHORIZED** |

The 403 does not block backtesting: a historical study needs contracts and aggregates,
both of which return data.

## Contract ticker format

`O:{UNDERLYING}{YYMMDD}{C|P}{strike × 1000, zero-padded to 8}`

`O:IBM260821P00290000` = IBM put, expiring 2026-08-21, strike $290.

## Listing a chain — the gotcha that cost an hour

Historical contracts have expired, so `expired=true` is required. But combining it with
`as_of` returns an empty set for recent dates, and without a sort the API hands back the
oldest contracts on record (2010 expiries). Filter on the expiry range instead:

```
/v3/reference/options/contracts
  ?underlying_ticker=IBM
  &contract_type=put
  &expired=true
  &expiration_date.gte=2026-07-17
  &expiration_date.lte=2026-08-22
  &limit=1000
```

`strike_price.gte` / `strike_price.lte` narrow it further. Sorting by `expiration_date`
descending is the quick way to see what the newest listed contracts are.

## Coverage observed

For IBM around its 2026-07-14 earnings crash, strikes ran from $115 to $490 with weekly
and monthly expiries. The near-money weekly put traded **2,171 contracts across 65
trades** on the news day; the monthly at the same strike traded 55. So liquidity is
adequate for a personal-size account on large caps, thin on the monthlies.

## Pricing, if a paid tier is ever needed

| Plan      | Price   | History  | Granularity                                      |
| --------- | ------- | -------- | ------------------------------------------------ |
| Basic     | $0      | 2 years  | end-of-day only, 5 calls/min                     |
| Starter   | $29/mo  | 2 years  | minute + second aggregates, snapshots, Greeks/IV |
| Developer | $79/mo  | 4 years  | adds trades                                      |
| Advanced  | $199/mo | 5+ years | real-time, adds quotes                           |

The current news corpus is six weeks old, inside every tier's window. Starter would add
the snapshot endpoint and real-time Greeks; nothing in a historical study needs them.

Alternatives, if Massive ever proves insufficient: **ThetaData** ($40/mo for 4 years at
1-minute, $80/mo for 8 years of tick including every OPRA NBBO quote) and **Databento**
(pay-per-use OPRA, $125 free credits — the architecture doc already names it as the
insurance option for equity bars).

## What to know before building on this

**Options only trade 09:30–16:00 ET.** Two thirds of the directional signals in this
system arrive outside that window, so for most of them the earliest executable price is
the next open — by which point the contract has already repriced. Measured on the IBM
case: the 290 put closed at $18.90, the 8-K landed at 07:02 ET, and the contract opened
at **$65**. The entire move happened where no trade was possible.

**Aggregates are trades, not quotes.** A minute bar's close is the last trade, not the
mid. On a thin contract the spread can be a large fraction of the premium, and the
current tier has no quote access to measure it — so any P&L computed from aggregates
alone is optimistic by an unknown amount.

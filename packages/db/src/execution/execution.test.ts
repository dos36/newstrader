/**
 * DB-backed execution tests — require a live Postgres and are skipped when
 * TEST_DATABASE_URL is unset.
 *
 * Run:
 *   docker compose up -d postgres
 *   TEST_DATABASE_URL=postgres://newstrader:newstrader@localhost:5433/newstrader \
 *     pnpm vitest run packages/db/src/execution
 *
 * Isolation: the suite creates and migrates its OWN database
 * (<dbname>_execution) and never touches the shared TEST_DATABASE_URL database
 * (mandatory pattern — see resolver/resolve-repo.test.ts header). SimBroker
 * derives positions from ALL venue='sim' fills, so tests additionally wipe the
 * trading tables before each case: within this private suite DB that is a full
 * per-test reset.
 */
import { clientOrderIdFor, newId } from '@newstrader/core';
import type { OrderIntent, RulesConfig } from '@newstrader/core';
import { eq, like } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../client.js';
import {
  decisions,
  fills,
  instruments,
  llmSignals,
  newsClusters,
  orderEvents,
  orders,
  priceBars1m,
  replayRuns,
  rulesVersions,
} from '../schema.js';
import { MAX_CLOSE_ATTEMPTS, evaluateOpenPositions } from './position-manager.js';
import type { ExitEvaluator, OpenPositionExitInput } from './position-manager.js';
import { NO_REFERENCE_PRICE, SimBrokerAdapter } from './sim-broker.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const T0 = new Date('2026-07-06T14:30:00.000Z');
const minutesAfter = (n: number) => new Date(T0.getTime() + n * 60_000);
const hoursAfter = (n: number) => new Date(T0.getTime() + n * 3_600_000);

/** Long-only test config; the exit evaluator itself is stubbed per test. */
const TEST_RULES: RulesConfig = {
  gates: {
    minConfidence: 0.6,
    rejectAlreadyExpected: true,
    rejectCalendarMatch: true,
    eventTypeWhitelist: ['earnings_surprise'],
    staleMoveMaxBps: 300,
    minMedianDollarVolume: 1_000_000,
    maxConcurrentPositions: 5,
    allowShorts: false,
  },
  sizing: {
    riskBpsOfEquity: 50,
    atrLookbackDays: 14,
    atrStopMultiple: 2,
    maxPositionNotionalPct: 0.1,
  },
  exits: {
    defaultTimeStopHorizon: '1d',
    stopAtrMultiple: 2,
    takeProfitAtrMultiple: null,
  },
};

describe.skipIf(!testDatabaseUrl)('execution (integration)', () => {
  let db: Db;
  let instrumentId: string;
  let rulesVersionId: string;
  let clock: Date;
  const now = () => clock;

  beforeAll(async () => {
    if (testDatabaseUrl === undefined)
      throw new Error('unreachable: suite is skipped without TEST_DATABASE_URL');
    const suiteUrl = await createSuiteDatabase(testDatabaseUrl);
    db = createDb(suiteUrl);
    await migrate(db, { migrationsFolder: new URL('../../migrations', import.meta.url).pathname });
  }, 60_000);

  afterAll(async () => {
    await wipeTradingTables();
    await db.$client.end();
  });

  beforeEach(async () => {
    await wipeTradingTables();
    clock = T0;
    instrumentId = newId();
    rulesVersionId = newId();
    await db.insert(instruments).values({
      id: instrumentId,
      symbol: 'SIMT',
      assetClass: 'us_equity',
      name: 'Sim Test Corp',
    });
    await db.insert(rulesVersions).values({
      id: rulesVersionId,
      versionLabel: `exec-test-${rulesVersionId}`,
      config: TEST_RULES as unknown as Record<string, unknown>,
      configHash: 'test-hash',
    });
  });

  /** FK-safe full wipe — this suite database belongs to this suite alone. */
  async function wipeTradingTables(): Promise<void> {
    await db.delete(fills);
    await db.delete(orderEvents);
    await db.delete(orders);
    await db.delete(decisions);
    await db.delete(llmSignals);
    await db.delete(newsClusters);
    await db.delete(replayRuns);
    await db.delete(rulesVersions);
    await db.delete(priceBars1m);
    await db.delete(instruments);
  }

  async function seedBar(input: { ts: Date; close: string; instrument?: string }): Promise<void> {
    await db.insert(priceBars1m).values({
      instrumentId: input.instrument ?? instrumentId,
      ts: input.ts,
      open: input.close,
      high: input.close,
      low: input.close,
      close: input.close,
      source: 'test',
    });
  }

  async function seedDecision(input: {
    key: string;
    action?: 'open_long' | 'open_short' | 'close' | 'skip';
    features?: Record<string, unknown>;
    signalId?: string;
    instrument?: string;
  }): Promise<string> {
    const id = newId();
    await db.insert(decisions).values({
      id,
      decisionKey: input.key,
      signalId: input.signalId ?? null,
      instrumentId: input.instrument ?? instrumentId,
      rulesVersionId,
      decidedAt: clock,
      action: input.action ?? 'open_long',
      features: input.features ?? {},
    });
    return id;
  }

  function intent(overrides: Partial<OrderIntent> & { decisionKey: string }): OrderIntent {
    return {
      clientOrderId: `co:${overrides.decisionKey}`,
      instrumentId,
      assetClass: 'us_equity',
      side: 'buy',
      qty: '10',
      orderType: 'market',
      tif: 'day',
      ...overrides,
    };
  }

  async function exitDecisionRows() {
    return db.select().from(decisions).where(like(decisions.decisionKey, 'exit:%'));
  }

  describe('SimBrokerAdapter.placeOrder', () => {
    it('place → fill → derive round trip with default slippage', async () => {
      const broker = new SimBrokerAdapter(db, { now });
      await seedBar({ ts: minutesAfter(-1), close: '100' });
      await seedDecision({ key: 'd-open:rv:live' });

      const ack = await broker.placeOrder(intent({ decisionKey: 'd-open:rv:live' }));
      expect(ack.status).toBe('accepted');

      const orderRows = await db.select().from(orders);
      expect(orderRows).toHaveLength(1);
      expect(orderRows[0]).toMatchObject({
        id: ack.brokerOrderId,
        brokerOrderId: ack.brokerOrderId,
        status: 'filled',
        venue: 'sim',
        side: 'buy',
        clientOrderId: 'co:d-open:rv:live',
      });

      const events = await db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.orderId, ack.brokerOrderId));
      expect(events.map((e) => e.event).sort()).toEqual(['filled', 'pending']);

      const fillRows = await db.select().from(fills);
      expect(fillRows).toHaveLength(1);
      // Column-scale strings straight from numeric: 5bps buy slippage on 100.
      expect(fillRows[0]).toMatchObject({
        fillPrice: '100.050000',
        fillQty: '10.00000000',
        fee: '0.000000',
        isSimulated: true,
      });

      expect(await broker.getPositions()).toEqual([
        { instrumentId, qty: '10', avgEntryPrice: '100.05' },
      ]);
    });

    it('a replayed intent returns the EXISTING ack — exactly one fills row', async () => {
      const broker = new SimBrokerAdapter(db, { now });
      await seedBar({ ts: minutesAfter(-1), close: '100' });
      await seedDecision({ key: 'd-open:rv:live' });
      const orderIntent = intent({ decisionKey: 'd-open:rv:live' });

      const first = await broker.placeOrder(orderIntent);
      clock = minutesAfter(5); // redelivery arrives later; ack must not change
      const replay = await broker.placeOrder(orderIntent);

      expect(replay).toEqual({ brokerOrderId: first.brokerOrderId, status: 'accepted' });
      expect(await db.select().from(orders)).toHaveLength(1);
      expect(await db.select().from(fills)).toHaveLength(1);
      expect(await broker.getPositions()).toEqual([
        { instrumentId, qty: '10', avgEntryPrice: '100.05' },
      ]);
    });

    it('rejects when no reference bar exists in the last 24h (and stays rejected on replay)', async () => {
      const broker = new SimBrokerAdapter(db, { now });
      await seedBar({ ts: hoursAfter(-25), close: '100' }); // too stale
      await seedDecision({ key: 'd-open:rv:live' });
      const orderIntent = intent({ decisionKey: 'd-open:rv:live' });

      const ack = await broker.placeOrder(orderIntent);
      expect(ack.status).toBe('rejected');
      expect(ack.reason).toBe(NO_REFERENCE_PRICE);

      const orderRows = await db.select().from(orders);
      expect(orderRows).toHaveLength(1);
      expect(orderRows[0]?.status).toBe('rejected');
      const rejectedEvents = await db
        .select()
        .from(orderEvents)
        .where(eq(orderEvents.event, 'rejected'));
      expect(rejectedEvents).toHaveLength(1);
      expect(rejectedEvents[0]?.payload).toEqual({ reason: NO_REFERENCE_PRICE });
      expect(await db.select().from(fills)).toHaveLength(0);
      expect(await broker.getPositions()).toEqual([]);

      const replay = await broker.placeOrder(orderIntent);
      expect(replay).toEqual({
        brokerOrderId: ack.brokerOrderId,
        status: 'rejected',
        reason: NO_REFERENCE_PRICE,
      });
      expect(await db.select().from(orders)).toHaveLength(1);
    });

    it('throws loudly when the decision behind the intent does not exist', async () => {
      const broker = new SimBrokerAdapter(db, { now });
      await expect(broker.placeOrder(intent({ decisionKey: 'no-such-key' }))).rejects.toThrow(
        /no decision found/,
      );
      expect(await db.select().from(orders)).toHaveLength(0);
    });

    it('throws when the decision behind the intent is a REPLAY row, not live', async () => {
      const broker = new SimBrokerAdapter(db, { now });
      await seedBar({ ts: minutesAfter(-1), close: '100' });
      const replayRunId = newId();
      await db.insert(replayRuns).values({ id: replayRunId, rulesVersionId });
      await db.insert(decisions).values({
        id: newId(),
        decisionKey: 'd-replay:rv:run1',
        signalId: null,
        instrumentId,
        rulesVersionId,
        replayRunId,
        decidedAt: clock,
        action: 'open_long',
        features: {},
      });

      await expect(broker.placeOrder(intent({ decisionKey: 'd-replay:rv:run1' }))).rejects.toThrow(
        /no decision found/,
      );
      expect(await db.select().from(orders)).toHaveLength(0);
    });
  });

  describe('SimBrokerAdapter — derived positions and account state', () => {
    it('partial close: buy 10 @100, sell 4 @110 → qty 6, correct realized cash/equity', async () => {
      // slippage 0 keeps the arithmetic exact and legible.
      const broker = new SimBrokerAdapter(db, { now, slippageBps: 0 });
      await seedBar({ ts: minutesAfter(-1), close: '100' });
      await seedDecision({ key: 'd-open:rv:live' });
      await broker.placeOrder(intent({ decisionKey: 'd-open:rv:live' }));

      clock = hoursAfter(2);
      await seedBar({ ts: hoursAfter(1), close: '110' });
      await seedDecision({ key: 'd-trim:rv:live', action: 'close' });
      await broker.placeOrder(intent({ decisionKey: 'd-trim:rv:live', side: 'sell', qty: '4' }));

      expect(await broker.getPositions()).toEqual([
        { instrumentId, qty: '6', avgEntryPrice: '100' },
      ]);
      // cash = 100000 − 1000 + 440; equity = cash + 6 × 110 (latest close).
      expect(await broker.getAccountState()).toEqual({
        cashUsd: '99440',
        equityUsd: '100100',
      });
    });

    it('equity subtracts fees and honors a custom starting cash', async () => {
      const broker = new SimBrokerAdapter(db, {
        now,
        slippageBps: 0,
        paperEquityUsd: '50000',
        feeBpsByAssetClass: { us_equity: 10 },
      });
      await seedBar({ ts: minutesAfter(-1), close: '200' });
      await seedDecision({ key: 'd-open:rv:live' });
      await broker.placeOrder(intent({ decisionKey: 'd-open:rv:live', qty: '5' }));

      // fee = 1000 × 0.001 = 1; cash = 50000 − 1000 − 1; equity = cash + 5×200.
      expect(await broker.getAccountState()).toEqual({
        cashUsd: '48999',
        equityUsd: '49999',
      });
    });
  });

  describe('evaluateOpenPositions', () => {
    /** Open a 10-share long at 100 (slippage 0) and return {broker, openOrderId}. */
    async function openPosition(entry?: { features?: Record<string, unknown>; signalId?: string }) {
      const broker = new SimBrokerAdapter(db, { now, slippageBps: 0 });
      await seedBar({ ts: minutesAfter(-1), close: '100' });
      await seedDecision({
        key: 'd-open:rv:live',
        features: entry?.features ?? { atr: '2.5' },
        ...(entry?.signalId !== undefined ? { signalId: entry.signalId } : {}),
      });
      const ack = await broker.placeOrder(intent({ decisionKey: 'd-open:rv:live' }));
      expect(ack.status).toBe('accepted');
      return { broker, openOrderId: ack.brokerOrderId };
    }

    const closeOn =
      (reason: string): ExitEvaluator =>
      () => ({ shouldClose: true, reason });
    const notHalted = async () => false;

    it('feeds the injected evaluator the full entry context (ATR, horizon, side, marks)', async () => {
      // Signal-backed entry: horizon must come from the llm_signals row.
      const clusterId = newId();
      await db.insert(newsClusters).values({
        id: clusterId,
        canonicalHeadline: 'Sim Test Corp beats',
        normalizedHeadline: 'sim test corp beats',
        firstItemId: newId(),
        firstSourceId: newId(),
        firstReceivedAt: minutesAfter(-30),
        lastItemAt: minutesAfter(-30),
      });
      const signalId = newId();
      await db.insert(llmSignals).values({
        id: signalId,
        signalKey: `sk-${signalId}`,
        clusterId,
        scope: 'company',
        instrumentId,
        eventType: 'earnings_surprise',
        direction: 'bullish',
        expectedMoveBps: 150,
        horizon: '3d',
        alreadyExpected: false,
        materiality: 0.8,
        confidence: 0.9,
        modelId: 'test-model',
        promptVersion: 'p1',
        analyzedAt: minutesAfter(-29),
      });
      const { broker } = await openPosition({ features: { atr: '2.5' }, signalId });

      clock = hoursAfter(30);
      await seedBar({ ts: hoursAfter(29), close: '104' });
      const seen: OpenPositionExitInput[] = [];
      const result = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: (input) => {
          seen.push(input);
          return { shouldClose: false, reason: null };
        },
        checkHalted: notHalted,
      });

      expect(result).toMatchObject({ evaluated: 1, closed: 0, suppressed: 0, skipped: 0 });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        instrumentId,
        side: 'long',
        qty: '10',
        avgEntryPrice: '100',
        horizon: '3d', // from the signal, not the config default
        atrAtEntry: '2.5',
        latestClose: '104.000000',
        now: clock,
        config: TEST_RULES,
      });
      expect(seen[0]?.entryDecidedAt.getTime()).toBe(T0.getTime());
      expect(await exitDecisionRows()).toHaveLength(0); // held → nothing recorded
    });

    it('time-stop close end-to-end: decision recorded, order placed, position flat', async () => {
      const { broker, openOrderId } = await openPosition();
      clock = hoursAfter(30);
      await seedBar({ ts: hoursAfter(29), close: '105' });

      const result = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(result).toMatchObject({ evaluated: 1, closed: 1, suppressed: 0, skipped: 0 });

      // REASON-INDEPENDENT key (fix: two evaluators with different verdicts
      // must never mint two orders) — the reason lives in features.exitReason.
      const expectedKey = `exit:${openOrderId}`;
      const exitDecisions = await exitDecisionRows();
      expect(exitDecisions).toHaveLength(1);
      expect(exitDecisions[0]).toMatchObject({
        decisionKey: expectedKey,
        action: 'close',
        suppressed: false,
        signalId: null,
        rulesVersionId,
        sizedQty: '10.00000000',
        sizedNotional: '1050.00',
      });
      expect(exitDecisions[0]?.features).toMatchObject({
        openingOrderId: openOrderId,
        horizon: '1d', // signal-less entry falls back to the config default
        atrAtEntry: '2.5',
        exitReason: 'time_stop',
      });
      expect(exitDecisions[0]?.quoteSnapshot).toMatchObject({
        price: '105.000000',
        source: 'price_bars_1m',
      });

      const [exitDecision] = exitDecisions;
      if (exitDecision === undefined) throw new Error('exit decision missing');
      const closeOrders = await db
        .select()
        .from(orders)
        .where(eq(orders.decisionId, exitDecision.id));
      expect(closeOrders).toHaveLength(1);
      expect(closeOrders[0]).toMatchObject({ side: 'sell', status: 'filled' });
      // clientOrderId shares the sha256 namespace entries use — attempt 1.
      expect(closeOrders[0]?.clientOrderId).toBe(clientOrderIdFor(`${expectedKey}:a1`));

      expect(await broker.getPositions()).toEqual([]);
      // Realized: bought 10@100, sold 10@105 → +50 on 100000.
      expect(await broker.getAccountState()).toEqual({
        cashUsd: '100050',
        equityUsd: '100050',
      });

      // Steady state: nothing left to evaluate, nothing new written.
      const again = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(again).toMatchObject({ evaluated: 0, closed: 0 });
      expect(await exitDecisionRows()).toHaveLength(1);
    });

    it('kill switch tripped: decision recorded suppressed=true, NO order; closes after clear', async () => {
      const { broker, openOrderId } = await openPosition();
      clock = hoursAfter(30);
      await seedBar({ ts: hoursAfter(29), close: '105' });

      const haltedRun = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: async () => true,
      });
      expect(haltedRun).toMatchObject({ evaluated: 1, closed: 0, suppressed: 1 });

      const suppressedKey = `exit:${openOrderId}:suppressed`;
      const afterHalt = await exitDecisionRows();
      expect(afterHalt).toHaveLength(1);
      expect(afterHalt[0]).toMatchObject({
        decisionKey: suppressedKey,
        action: 'close',
        suppressed: true,
      });
      // No order was emitted: only the opening order exists.
      expect(await db.select().from(orders)).toHaveLength(1);
      expect(await broker.getPositions()).toEqual([
        { instrumentId, qty: '10', avgEntryPrice: '100' },
      ]);

      // Still halted on the next run: no duplicate suppressed decisions.
      await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: async () => true,
      });
      expect(await exitDecisionRows()).toHaveLength(1);

      // Switch cleared: the live close records under the UNSUFFIXED key.
      const clearedRun = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(clearedRun).toMatchObject({ evaluated: 1, closed: 1, suppressed: 0 });
      const allExitDecisions = await exitDecisionRows();
      expect(allExitDecisions).toHaveLength(2);
      expect(await broker.getPositions()).toEqual([]);
    });

    it('an existing close decision short-circuits but recovers a missing order', async () => {
      const { broker, openOrderId } = await openPosition();
      clock = hoursAfter(30);
      await seedBar({ ts: hoursAfter(29), close: '105' });

      // Simulate a crash AFTER the decision insert but BEFORE order placement.
      const expectedKey = `exit:${openOrderId}`;
      const decisionId = await seedDecision({ key: expectedKey, action: 'close' });

      const result = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(result).toMatchObject({ evaluated: 1, closed: 1 });
      // No duplicate decision was written; the order landed exactly once.
      expect(await exitDecisionRows()).toHaveLength(1);
      expect(await db.select().from(orders).where(eq(orders.decisionId, decisionId))).toHaveLength(
        1,
      );
      expect(await broker.getPositions()).toEqual([]);
    });

    it('reason divergence: a pre-existing close decision under a DIFFERENT reason still short-circuits to ONE order', async () => {
      const { broker, openOrderId } = await openPosition();
      clock = hoursAfter(30);
      await seedBar({ ts: hoursAfter(29), close: '105' });

      // "Runner A" (stop_loss) already recorded the close decision but
      // crashed before placing the order — the reason-independent key is the
      // SAME one "runner B" (time_stop, below) will compute for this exit.
      const decisionKey = `exit:${openOrderId}`;
      const decisionId = await seedDecision({
        key: decisionKey,
        action: 'close',
        features: { exitReason: 'stop_loss' },
      });

      // "Runner B" evaluates the SAME position and computes a DIFFERENT reason.
      const result = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(result).toMatchObject({ evaluated: 1, closed: 1 });

      // Exactly one decision (runner A's, never overwritten) and one order.
      const rows = await exitDecisionRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ decisionKey, id: decisionId });
      expect(rows[0]?.features).toMatchObject({ exitReason: 'stop_loss' }); // the winning reason

      const closeOrders = await db.select().from(orders).where(eq(orders.decisionId, decisionId));
      expect(closeOrders).toHaveLength(1);
      expect(await broker.getPositions()).toEqual([]); // the position still closes
    });

    it('rejected close retries under a NEW attempt-suffixed order; the retry fills and closes the position', async () => {
      const { broker: openBroker, openOrderId } = await openPosition();

      clock = hoursAfter(30); // past the 1d time stop
      await seedBar({ ts: hoursAfter(29), close: '105' }); // fresh enough for the EXIT evaluation

      // A broker whose OWN clock sees this same bar as stale (>24h) — its
      // placeOrder rejects with NO_REFERENCE_PRICE even though the exit
      // evaluation (which reads the bar against `clock`) judged it fresh.
      // Simulates the narrow real-world race the retry logic exists for.
      const staleRefBroker = new SimBrokerAdapter(db, {
        now: () => hoursAfter(30 + 25),
        slippageBps: 0,
      });

      const attempt1 = await evaluateOpenPositions(db, {
        broker: staleRefBroker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(attempt1).toMatchObject({ evaluated: 1, closed: 0, skipped: 1 });
      expect(attempt1.details[0]).toMatchObject({
        outcome: 'close_rejected',
        reason: NO_REFERENCE_PRICE,
      });

      const decisionKey = `exit:${openOrderId}`;
      const afterAttempt1 = await exitDecisionRows();
      expect(afterAttempt1).toHaveLength(1); // the close decision IS recorded
      const [attempt1Decision] = afterAttempt1;
      if (attempt1Decision === undefined) throw new Error('exit decision missing');
      const decisionId = attempt1Decision.id;
      const rejectedOrders = await db
        .select()
        .from(orders)
        .where(eq(orders.decisionId, decisionId));
      expect(rejectedOrders).toHaveLength(1);
      expect(rejectedOrders[0]?.status).toBe('rejected');
      expect(rejectedOrders[0]?.clientOrderId).toBe(clientOrderIdFor(`${decisionKey}:a1`));

      // Position is still open — the rejected close did not consume the exit.
      expect(await openBroker.getPositions()).toEqual([
        { instrumentId, qty: '10', avgEntryPrice: '100' },
      ]);

      // Next run, with a broker whose clock agrees the bar is fresh: attempt
      // 2 places and fills, closing the position. Same decision, a 2nd order.
      const freshRefBroker = new SimBrokerAdapter(db, { now, slippageBps: 0 });
      const attempt2 = await evaluateOpenPositions(db, {
        broker: freshRefBroker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(attempt2).toMatchObject({ evaluated: 1, closed: 1 });

      const ordersForDecision = await db
        .select()
        .from(orders)
        .where(eq(orders.decisionId, decisionId));
      expect(ordersForDecision).toHaveLength(2);
      expect(ordersForDecision.map((o) => o.status).sort()).toEqual(['filled', 'rejected']);
      expect(ordersForDecision.find((o) => o.status === 'filled')?.clientOrderId).toBe(
        clientOrderIdFor(`${decisionKey}:a2`),
      );
      expect(await freshRefBroker.getPositions()).toEqual([]);
    });

    it('bounds retries at MAX_CLOSE_ATTEMPTS and then logs + skips without placing another order', async () => {
      await openPosition();

      clock = hoursAfter(30);
      await seedBar({ ts: hoursAfter(29), close: '105' });
      const staleRefBroker = new SimBrokerAdapter(db, {
        now: () => hoursAfter(30 + 25),
        slippageBps: 0,
      });

      for (let i = 0; i < MAX_CLOSE_ATTEMPTS; i++) {
        const run = await evaluateOpenPositions(db, {
          broker: staleRefBroker,
          rules: TEST_RULES,
          rulesVersionId,
          now: clock,
          evaluateExit: closeOn('time_stop'),
          checkHalted: notHalted,
        });
        expect(run.details[0]).toMatchObject({ outcome: 'close_rejected' });
      }
      const rows = await exitDecisionRows();
      const [exitDecision] = rows;
      if (exitDecision === undefined) throw new Error('exit decision missing');
      const decisionId = exitDecision.id;
      const rejectedSoFar = await db.select().from(orders).where(eq(orders.decisionId, decisionId));
      expect(rejectedSoFar).toHaveLength(MAX_CLOSE_ATTEMPTS);

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exhausted = await evaluateOpenPositions(db, {
        broker: staleRefBroker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(exhausted.details[0]).toMatchObject({
        outcome: 'close_rejected',
        reason: 'attempts_exhausted',
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('position_manager_close_attempts_exhausted'),
      );
      errorSpy.mockRestore();

      // No 4th order was placed.
      const ordersAfter = await db.select().from(orders).where(eq(orders.decisionId, decisionId));
      expect(ordersAfter).toHaveLength(MAX_CLOSE_ATTEMPTS);
    });

    it('skips (without wedging a decision key) when no fresh reference bar exists', async () => {
      const { broker } = await openPosition();
      clock = hoursAfter(30); // the only bar is now ~30h old → stale

      const result = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(result).toMatchObject({ evaluated: 1, closed: 0, suppressed: 0, skipped: 1 });
      expect(result.details[0]?.outcome).toBe('skipped_no_price');
      expect(await exitDecisionRows()).toHaveLength(0);

      // Bars arrive → the very next run closes normally.
      await seedBar({ ts: hoursAfter(29.5), close: '103' });
      const retry = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(retry).toMatchObject({ closed: 1 });
      expect(await broker.getPositions()).toEqual([]);
    });

    it('skips positions whose fills have no traceable opening decision', async () => {
      const broker = new SimBrokerAdapter(db, { now, slippageBps: 0 });
      // Hand-crafted fill whose decision is NOT an open action.
      const decisionId = await seedDecision({ key: 'd-manual:rv:live', action: 'skip' });
      const orderId = newId();
      await db.insert(orders).values({
        id: orderId,
        decisionId,
        instrumentId,
        side: 'buy',
        qty: '5',
        orderType: 'market',
        tif: 'day',
        venue: 'sim',
        clientOrderId: 'co:manual',
        status: 'filled',
        submittedAt: clock,
      });
      await db.insert(fills).values({
        id: newId(),
        orderId,
        fillQty: '5',
        fillPrice: '100',
        fee: '0',
        filledAt: clock,
        isSimulated: true,
      });
      await seedBar({ ts: minutesAfter(-1), close: '100' });

      const result = await evaluateOpenPositions(db, {
        broker,
        rules: TEST_RULES,
        rulesVersionId,
        now: clock,
        evaluateExit: closeOn('time_stop'),
        checkHalted: notHalted,
      });
      expect(result).toMatchObject({ evaluated: 1, skipped: 1, closed: 0 });
      expect(result.details[0]?.outcome).toBe('skipped_no_entry');
      expect(await exitDecisionRows()).toHaveLength(0);
    });
  });
});

// ------------------------------------------------------------------ helpers --

/**
 * Create (if missing) the suite's dedicated database next to the shared
 * TEST_DATABASE_URL one and return its URL. Idempotent across runs; mirrors
 * resolver/resolve-repo.test.ts / clustering-repo.test.ts.
 */
async function createSuiteDatabase(adminUrl: string): Promise<string> {
  const parsed = new URL(adminUrl);
  const baseName = parsed.pathname.replace(/^\//, '') || 'postgres';
  const suiteName = `${baseName}_execution`.replace(/[^a-zA-Z0-9_]/g, '_');

  const admin = createDb(adminUrl);
  try {
    await admin.$client.query(`create database "${suiteName}"`);
  } catch (error) {
    if (!isDuplicateDatabase(error)) throw error;
  } finally {
    await admin.$client.end();
  }

  const suiteUrl = new URL(adminUrl);
  suiteUrl.pathname = `/${suiteName}`;
  return suiteUrl.toString();
}

/** Postgres error 42P04: duplicate_database — the suite database already exists. */
function isDuplicateDatabase(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '42P04'
  );
}

DROP INDEX "fills_order_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "fills_order_id_unique" ON "fills" USING btree ("order_id");
--> statement-breakpoint
-- venue is SIM ONLY in v1 (architecture §0/§7) — no code path anywhere
-- constructs a BrokerAdapter for any other venue. Not expressible in the
-- drizzle schema (orders.venue is a bare text column so a future venue is
-- just a new string, not a migration); guarded here directly as a belt-and-
-- suspenders check against a bug that would otherwise write a real-money
-- order row silently. M7 (going live) DROPS this constraint at the same time
-- it adds the first non-sim BrokerAdapter.
ALTER TABLE "orders" ADD CONSTRAINT "orders_venue_sim_ck" CHECK (venue = 'sim');
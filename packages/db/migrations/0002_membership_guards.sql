CREATE UNIQUE INDEX "membership_open_uq" ON "index_membership" USING btree ("instrument_id","index_code") WHERE valid_to is null;--> statement-breakpoint
-- Interval sanity: a test-clock incident once wrote valid_to < valid_from,
-- making every "as of" query silently return nothing. Not expressible in the
-- drizzle schema; guarded here directly.
ALTER TABLE "index_membership" ADD CONSTRAINT "membership_interval_ck" CHECK (valid_to IS NULL OR valid_to > valid_from);

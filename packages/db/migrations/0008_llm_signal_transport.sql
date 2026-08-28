ALTER TABLE "llm_signals" ADD COLUMN "transport" text DEFAULT 'api' NOT NULL;--> statement-breakpoint
-- transport is a closed set: 'api' (SDK + key — honours the prompt version's
-- effort and max_tokens, replayable) or 'cli' (dev-only Claude Code CLI on a
-- subscription — honours neither, and its cost_usd carries ~25.7k tokens of
-- harness prompt per call). The enum lives in the drizzle column but drizzle
-- emits a bare text column, so a typo ('CLI', 'claude-cli') would silently
-- create a third class of row that every "exclude dev rows" filter misses.
-- Analysis queries trust this column to keep dev calls out of calibration.
ALTER TABLE "llm_signals" ADD CONSTRAINT "llm_signals_transport_ck" CHECK (transport IN ('api', 'cli'));

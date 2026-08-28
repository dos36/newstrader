CREATE TABLE "replay_run_metrics" (
	"replay_run_id" text PRIMARY KEY NOT NULL,
	"trades" bigint NOT NULL,
	"wins" bigint NOT NULL,
	"losses" bigint NOT NULL,
	"hit_rate" real,
	"avg_bps_per_trade" real,
	"profit_factor" real,
	"max_drawdown_pct" real,
	"exposure_adjusted_return_pct" real,
	"realized_usd" numeric(18, 2) NOT NULL,
	"fees_usd" numeric(18, 6) NOT NULL,
	"starting_cash_usd" numeric(18, 2) NOT NULL,
	"ending_equity_usd" numeric(18, 2) NOT NULL,
	"still_open" bigint NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "replay_run_metrics" ADD CONSTRAINT "replay_run_metrics_replay_run_id_replay_runs_id_fk" FOREIGN KEY ("replay_run_id") REFERENCES "public"."replay_runs"("id") ON DELETE no action ON UPDATE no action;
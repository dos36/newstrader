CREATE TABLE "price_bars_1d" (
	"instrument_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" numeric(18, 6) NOT NULL,
	"high" numeric(18, 6) NOT NULL,
	"low" numeric(18, 6) NOT NULL,
	"close" numeric(18, 6) NOT NULL,
	"volume" numeric(20, 4),
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_bars_1d_instrument_id_ts_pk" PRIMARY KEY("instrument_id","ts")
);
--> statement-breakpoint
CREATE TABLE "price_bars_1m" (
	"instrument_id" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" numeric(18, 6) NOT NULL,
	"high" numeric(18, 6) NOT NULL,
	"low" numeric(18, 6) NOT NULL,
	"close" numeric(18, 6) NOT NULL,
	"volume" numeric(20, 4),
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "price_bars_1m_instrument_id_ts_pk" PRIMARY KEY("instrument_id","ts")
);
--> statement-breakpoint
CREATE TABLE "reaction_measurements" (
	"cluster_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"horizon" text NOT NULL,
	"measurer_version" text NOT NULL,
	"anchor_ts" timestamp with time zone NOT NULL,
	"raw_return_bps" real NOT NULL,
	"abnormal_return_bps" real NOT NULL,
	"benchmark" text,
	"beta_used" real,
	"bars_source" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reaction_measurements_cluster_id_instrument_id_horizon_measurer_version_pk" PRIMARY KEY("cluster_id","instrument_id","horizon","measurer_version")
);
--> statement-breakpoint
CREATE TABLE "reaction_summary" (
	"cluster_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"measurer_version" text NOT NULL,
	"anchor_ts" timestamp with time zone NOT NULL,
	"peak_abnormal_move_bps" real NOT NULL,
	"time_to_peak_minutes" real NOT NULL,
	"time_to_half_of_1d_move_minutes" real,
	"direction_1d" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reaction_summary_cluster_id_instrument_id_measurer_version_pk" PRIMARY KEY("cluster_id","instrument_id","measurer_version")
);
--> statement-breakpoint
CREATE TABLE "recovery_measurements" (
	"cluster_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"measurer_version" text NOT NULL,
	"anchor_ts" timestamp with time zone NOT NULL,
	"trough_bps" real NOT NULL,
	"time_to_trough_hours" real NOT NULL,
	"time_to_half_reversion_hours" real,
	"time_to_full_reversion_hours" real,
	"window_days" real NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_measurements_cluster_id_instrument_id_measurer_version_pk" PRIMARY KEY("cluster_id","instrument_id","measurer_version")
);
--> statement-breakpoint
CREATE TABLE "scheduled_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"instrument_id" text,
	"scheduled_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_events_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
ALTER TABLE "price_bars_1d" ADD CONSTRAINT "price_bars_1d_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_bars_1m" ADD CONSTRAINT "price_bars_1m_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction_measurements" ADD CONSTRAINT "reaction_measurements_cluster_id_news_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."news_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction_measurements" ADD CONSTRAINT "reaction_measurements_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction_summary" ADD CONSTRAINT "reaction_summary_cluster_id_news_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."news_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reaction_summary" ADD CONSTRAINT "reaction_summary_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_measurements" ADD CONSTRAINT "recovery_measurements_cluster_id_news_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."news_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_measurements" ADD CONSTRAINT "recovery_measurements_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_events" ADD CONSTRAINT "scheduled_events_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bars_1m_ts_idx" ON "price_bars_1m" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "reaction_anchor_idx" ON "reaction_measurements" USING btree ("anchor_ts");--> statement-breakpoint
CREATE INDEX "scheduled_events_at_idx" ON "scheduled_events" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "scheduled_events_instrument_idx" ON "scheduled_events" USING btree ("instrument_id");
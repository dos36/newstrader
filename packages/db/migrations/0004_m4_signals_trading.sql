CREATE TABLE "decisions" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_key" text NOT NULL,
	"signal_id" text,
	"instrument_id" text NOT NULL,
	"rules_version_id" text NOT NULL,
	"replay_run_id" text,
	"decided_at" timestamp with time zone NOT NULL,
	"action" text NOT NULL,
	"skip_reason" text,
	"suppressed" boolean DEFAULT false NOT NULL,
	"gates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quote_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sized_qty" numeric(20, 8),
	"sized_notional" numeric(18, 2),
	CONSTRAINT "decisions_decision_key_unique" UNIQUE("decision_key")
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"fill_qty" numeric(20, 8) NOT NULL,
	"fill_price" numeric(18, 6) NOT NULL,
	"fee" numeric(18, 6) DEFAULT '0' NOT NULL,
	"filled_at" timestamp with time zone NOT NULL,
	"is_simulated" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"signal_key" text NOT NULL,
	"cluster_id" text NOT NULL,
	"scope" text NOT NULL,
	"instrument_id" text,
	"sector_code" text,
	"event_type" text NOT NULL,
	"direction" text NOT NULL,
	"expected_move_bps" real NOT NULL,
	"horizon" text NOT NULL,
	"already_expected" boolean NOT NULL,
	"materiality" real NOT NULL,
	"confidence" real NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_ref" text,
	"response_ref" text,
	"input_tokens" bigint,
	"output_tokens" bigint,
	"cost_usd" real,
	"latency_ms" bigint,
	"cluster_item_count_at_analysis" bigint,
	"analyzed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_signals_signal_key_unique" UNIQUE("signal_key")
);
--> statement-breakpoint
CREATE TABLE "order_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"decision_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"side" text NOT NULL,
	"qty" numeric(20, 8) NOT NULL,
	"order_type" text NOT NULL,
	"limit_price" numeric(18, 6),
	"tif" text NOT NULL,
	"venue" text NOT NULL,
	"client_order_id" text NOT NULL,
	"broker_order_id" text,
	"status" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "orders_client_order_id_unique" UNIQUE("client_order_id")
);
--> statement-breakpoint
CREATE TABLE "replay_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"rules_version_id" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"signals_from" timestamp with time zone,
	"signals_to" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"version_label" text NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"parent_version_id" text,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_versions_version_label_unique" UNIQUE("version_label")
);
--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_signal_id_llm_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."llm_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_rules_version_id_rules_versions_id_fk" FOREIGN KEY ("rules_version_id") REFERENCES "public"."rules_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_replay_run_id_replay_runs_id_fk" FOREIGN KEY ("replay_run_id") REFERENCES "public"."replay_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_signals" ADD CONSTRAINT "llm_signals_cluster_id_news_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."news_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_signals" ADD CONSTRAINT "llm_signals_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_decision_id_decisions_id_fk" FOREIGN KEY ("decision_id") REFERENCES "public"."decisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_rules_version_id_rules_versions_id_fk" FOREIGN KEY ("rules_version_id") REFERENCES "public"."rules_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "decisions_signal_idx" ON "decisions" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "decisions_decided_idx" ON "decisions" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "decisions_replay_idx" ON "decisions" USING btree ("replay_run_id");--> statement-breakpoint
CREATE INDEX "fills_order_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "signals_cluster_idx" ON "llm_signals" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "signals_analyzed_idx" ON "llm_signals" USING btree ("analyzed_at");--> statement-breakpoint
CREATE INDEX "signals_instrument_idx" ON "llm_signals" USING btree ("instrument_id");--> statement-breakpoint
CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_decision_idx" ON "orders" USING btree ("decision_id");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");
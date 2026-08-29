CREATE TABLE "item_triage" (
	"item_id" text NOT NULL,
	"triage_version" text NOT NULL,
	"model_id" text NOT NULL,
	"transport" text NOT NULL,
	"candidate_count" bigint NOT NULL,
	"relevant_count" bigint NOT NULL,
	"relevant_tickers" jsonb NOT NULL,
	"audit_ref" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cost_usd" real NOT NULL,
	"latency_ms" bigint NOT NULL,
	"triaged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "item_triage_item_id_triage_version_pk" PRIMARY KEY("item_id","triage_version")
);
--> statement-breakpoint
ALTER TABLE "item_triage" ADD CONSTRAINT "item_triage_item_id_raw_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."raw_news_items"("id") ON DELETE no action ON UPDATE no action;
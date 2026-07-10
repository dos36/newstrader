CREATE TABLE "index_membership" (
	"instrument_id" text NOT NULL,
	"index_code" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "index_membership_instrument_id_index_code_valid_from_pk" PRIMARY KEY("instrument_id","index_code","valid_from")
);
--> statement-breakpoint
CREATE TABLE "ingest_watermarks" (
	"source_id" text PRIMARY KEY NOT NULL,
	"cursor" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instrument_aliases" (
	"instrument_id" text NOT NULL,
	"alias" text NOT NULL,
	"alias_kind" text NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	CONSTRAINT "instrument_aliases_instrument_id_alias_alias_kind_valid_from_pk" PRIMARY KEY("instrument_id","alias","alias_kind","valid_from")
);
--> statement-breakpoint
CREATE TABLE "instruments" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"asset_class" text NOT NULL,
	"exchange" text,
	"cik" text,
	"name" text NOT NULL,
	"sector_approx" text,
	"first_listed_at" timestamp with time zone,
	"delisted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item_instrument_links" (
	"item_id" text NOT NULL,
	"instrument_id" text NOT NULL,
	"method" text NOT NULL,
	"confidence" real NOT NULL,
	"resolver_version" text NOT NULL,
	CONSTRAINT "item_instrument_links_item_id_instrument_id_resolver_version_pk" PRIMARY KEY("item_id","instrument_id","resolver_version")
);
--> statement-breakpoint
CREATE TABLE "news_cluster_items" (
	"cluster_id" text NOT NULL,
	"item_id" text NOT NULL,
	"similarity" real NOT NULL,
	"lag_from_first_ms" bigint NOT NULL,
	CONSTRAINT "news_cluster_items_cluster_id_item_id_pk" PRIMARY KEY("cluster_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "news_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_headline" text NOT NULL,
	"normalized_headline" text NOT NULL,
	"first_item_id" text NOT NULL,
	"first_source_id" text NOT NULL,
	"first_received_at" timestamp with time zone NOT NULL,
	"item_count" bigint DEFAULT 1 NOT NULL,
	"distinct_source_count" bigint DEFAULT 1 NOT NULL,
	"last_item_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"source_key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"handle_or_url" text,
	"base_trust" real DEFAULT 0.5 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_sources_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "raw_news_items" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"url" text,
	"headline" text NOT NULL,
	"payload_ref" text NOT NULL,
	"content_hash" text NOT NULL,
	"published_at" timestamp with time zone,
	"received_at" timestamp with time zone NOT NULL,
	"lang" text,
	"symbols_hint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ingest_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "index_membership" ADD CONSTRAINT "index_membership_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingest_watermarks" ADD CONSTRAINT "ingest_watermarks_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."news_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_aliases" ADD CONSTRAINT "instrument_aliases_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instrument_links" ADD CONSTRAINT "item_instrument_links_item_id_raw_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."raw_news_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_instrument_links" ADD CONSTRAINT "item_instrument_links_instrument_id_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_cluster_items" ADD CONSTRAINT "news_cluster_items_cluster_id_news_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."news_clusters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_cluster_items" ADD CONSTRAINT "news_cluster_items_item_id_raw_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."raw_news_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_news_items" ADD CONSTRAINT "raw_news_items_source_id_news_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."news_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aliases_alias_idx" ON "instrument_aliases" USING btree ("alias");--> statement-breakpoint
CREATE UNIQUE INDEX "instruments_symbol_class_uq" ON "instruments" USING btree ("symbol","asset_class");--> statement-breakpoint
CREATE INDEX "instruments_cik_idx" ON "instruments" USING btree ("cik");--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_items_item_uq" ON "news_cluster_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "clusters_first_received_idx" ON "news_clusters" USING btree ("first_received_at");--> statement-breakpoint
CREATE INDEX "clusters_status_idx" ON "news_clusters" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "raw_items_source_external_uq" ON "raw_news_items" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "raw_items_content_hash_idx" ON "raw_news_items" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "raw_items_received_at_idx" ON "raw_news_items" USING btree ("received_at");
CREATE TABLE "item_documents" (
	"item_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"doc_ref" text,
	"char_count" bigint,
	"document_count" bigint,
	"truncated" boolean DEFAULT false NOT NULL,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"last_error" text,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "item_documents" ADD CONSTRAINT "item_documents_item_id_raw_news_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."raw_news_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- status is a closed set and load-bearing: the fetch queue anti-joins on
-- status='ok' and treats 'empty' as permanent, so an unrecognized value would
-- make an item either re-fetch forever or silently vanish from the queue.
-- drizzle emits a bare text column for the enum, so the guard lives here.
ALTER TABLE "item_documents" ADD CONSTRAINT "item_documents_status_ck" CHECK (status IN ('ok', 'empty', 'failed'));
--> statement-breakpoint
-- doc_ref exists exactly when text was stored. Without this a status='ok' row
-- with a NULL ref would read as "fetched" and hand the prompt nothing.
ALTER TABLE "item_documents" ADD CONSTRAINT "item_documents_ok_has_ref_ck" CHECK ((status = 'ok') = (doc_ref IS NOT NULL));

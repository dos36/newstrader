CREATE TABLE "llm_attempts" (
	"signal_key" text PRIMARY KEY NOT NULL,
	"attempts" bigint NOT NULL,
	"last_error" text NOT NULL,
	"audit_ref" text,
	"last_attempt_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "llm_signals" ADD COLUMN "retrospective" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "llm_signals" ADD COLUMN "reasoning" text;
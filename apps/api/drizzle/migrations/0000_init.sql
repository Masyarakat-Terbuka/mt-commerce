CREATE TABLE IF NOT EXISTS "health_pings" (
	"id" text PRIMARY KEY NOT NULL,
	"pinged_at" timestamp with time zone DEFAULT now() NOT NULL
);

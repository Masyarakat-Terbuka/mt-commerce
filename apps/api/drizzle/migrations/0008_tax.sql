-- Tax module: tax_rates.
--
-- Hand-written rather than drizzle-kit-generated so the partial unique index
-- on `(currency) WHERE is_default = true AND archived_at IS NULL` stays
-- explicit. drizzle-kit does not natively express partial unique indexes,
-- and the "at most one default per currency" invariant is the load-bearing
-- constraint of this table — moving it to the application layer alone
-- would let a concurrent admin save race past the predicate.
--
-- Notes:
--   * `rate_basis_points` is `integer` (1100 = 11.00%). Rate-as-basis-points
--     keeps the value exact at integer level and lets the application convert
--     to a fraction (`bp / 10000`) at apply-time without float hazards.
--   * `currency` is denormalised onto each row because rates are
--     currency-scoped: a 5% USD sales tax and an 11% IDR PPN are distinct
--     rows. The `tax_rates_currency_idx` supports the `getDefaultRate(currency)`
--     hot path; the partial unique index above also helps.
--   * `archived_at IS NOT NULL` rows stay readable for audit/recompute but
--     never satisfy the `is_default` predicate.

CREATE TABLE IF NOT EXISTS "tax_rates" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"rate_basis_points" integer NOT NULL,
	"currency" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "tax_rates_code_unique" UNIQUE("code"),
	CONSTRAINT "tax_rates_basis_points_nonneg" CHECK ("rate_basis_points" >= 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tax_rates_currency_idx" ON "tax_rates" ("currency");
--> statement-breakpoint
-- Partial unique: at most one default per currency among non-archived rows.
-- Two concurrent admin saves trying to flip is_default=true for the same
-- currency will see the loser hit a 23505 unique-violation and the service
-- reclassifies it as a clean ConflictError.
CREATE UNIQUE INDEX IF NOT EXISTS "tax_rates_default_per_currency_unique_idx"
  ON "tax_rates" ("currency")
  WHERE "is_default" = true AND "archived_at" IS NULL;

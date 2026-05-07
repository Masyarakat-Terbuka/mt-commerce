/**
 * Shared shape for translatable JSONB columns.
 *
 * Per ADR-0010, translatable catalog rows carry a `translations` JSONB
 * column whose top-level keys are locale codes (`"id"`, `"en"`, ...) and
 * whose values are flat objects of translatable fields specific to the
 * row.
 *
 * The TypeScript shape is parameterized on the field union so each table
 * can pin the field set it expects:
 *
 *   type ProductTranslations = Translations<"title" | "description">;
 *   type VariantTranslations = Translations<"title">;
 *   type CategoryTranslations = Translations<"name">;
 *
 * Every locale entry is a `Partial<...>` because translations can be
 * incomplete — the resolver in `modules/catalog/i18n.ts` falls back to
 * the default locale (and ultimately to the empty string) when a field
 * is missing.
 */
export type Translations<F extends string> = Record<
  string,
  Partial<Record<F, string>>
>;

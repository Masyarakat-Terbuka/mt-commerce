/**
 * Supported WhatsApp locales for v0.1.
 *
 * Meta's `language.code` field carries a BCP-47 tag; we ship two:
 *   - `id` → Bahasa Indonesia (default, project-wide)
 *   - `en` → English (operators serving multilingual customers)
 *
 * Other locales are out of scope until a merchant asks. Unknown values
 * fall back to `id` rather than throw — a notification dispatch path
 * should not crash on a locale typo from upstream.
 */
export const WHATSAPP_LOCALES = ["id", "en"] as const;
export type WhatsappLocale = (typeof WHATSAPP_LOCALES)[number];
export const DEFAULT_WHATSAPP_LOCALE: WhatsappLocale = "id";

export function resolveLocale(input: string | undefined): WhatsappLocale {
  if (input === "en" || input === "id") return input;
  return DEFAULT_WHATSAPP_LOCALE;
}

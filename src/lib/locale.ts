// Must match SEO_LOCALES in v3/lib/seo/hreflang.ts — the source of truth for
// which languages the site publishes (NOT the `locales` table, which also
// carries inactive rows: hi, ja, za).
//
// `tr` added 2026-10-05. T74 launched Turkish as the 20th site locale on
// 2026-10-02 and this list was never updated, so `?locale=tr` fell through
// resolveLocale() and was served in ENGLISH — silently, because the fallback
// has no way to say it did not have the language asked for. The data was there
// all along: specs_catalog_translations carries 224 `tr` rows, exactly as many
// as every other locale.
export const SUPPORTED_LOCALES = [
  "en", "ro", "fr", "de", "es", "it", "sr", "hr", "pt", "pl",
  "cs", "sk", "hu", "no", "sv", "el", "bg", "da", "ar", "tr",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function resolveLocale(input: string | undefined): Locale {
  if (input && (SUPPORTED_LOCALES as readonly string[]).includes(input)) {
    return input as Locale;
  }
  return "en";
}

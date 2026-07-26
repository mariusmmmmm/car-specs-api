// Must match SEO_LOCALES in v3/lib/seo/hreflang.ts — the 19 languages the
// site actually supports. Keep in sync if that list changes.
export const SUPPORTED_LOCALES = [
  "en", "ro", "fr", "de", "es", "it", "sr", "hr", "pt", "pl",
  "cs", "sk", "hu", "no", "sv", "el", "bg", "da", "ar",
] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export function resolveLocale(input: string | undefined): Locale {
  if (input && (SUPPORTED_LOCALES as readonly string[]).includes(input)) {
    return input as Locale;
  }
  return "en";
}

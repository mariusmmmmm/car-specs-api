// Mirrors v3/lib/server/search.ts's unaccentLatin/normalizeLower/normalizeAlnum
// so JS-built LIKE patterns line up with the DB's f_unaccent_lower/f_unaccent_alnum
// indexed expressions. Kept as a small standalone copy since api/ is a separate
// repo/runtime from v3/ (Workers vs Next.js) — see BIZ-L2a "reuse existing
// query libs" note; this ports the matching logic, not the module itself.
function unaccentLatin(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss")
    .replace(/đ/g, "d")
    .replace(/ł/g, "l");
}

export function normalizeLower(input: string): string {
  return unaccentLatin(input).replace(/[^a-z0-9]+/g, " ").trim();
}

export function normalizeAlnum(input: string): string {
  return unaccentLatin(input).replace(/[^a-z0-9]+/g, "");
}

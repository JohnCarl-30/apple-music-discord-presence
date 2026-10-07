/**
 * Reduce a name to a comparison key: NFKD-decomposed, diacritics removed,
 * lower-cased, non-alphanumerics dropped. "Beyoncé" and "beyonce" collide;
 * "NIKI" and "NICKI NICOLE" do not.
 */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * True when two names plausibly denote the same thing. Substring in either
 * direction, because iTunes adds featured artists ("88rising & NIKI") and
 * release-type suffixes ("lowkey - Single") that Music.app does not.
 * An empty key never matches, so a missing album cannot match everything.
 */
export function looseMatch(a: string, b: string): boolean {
  const x = normalizeForMatch(a);
  const y = normalizeForMatch(b);
  if (x === "" || y === "") return false;
  return x.includes(y) || y.includes(x);
}

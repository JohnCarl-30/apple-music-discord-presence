import { describe, expect, it } from "vitest";
import { looseMatch, normalizeForMatch } from "../../src/artwork/normalize.js";

describe("normalizeForMatch", () => {
  it("case-folds and strips non-alphanumerics", () => {
    expect(normalizeForMatch("Hello, World!")).toBe("helloworld");
  });

  it("strips diacritics", () => {
    expect(normalizeForMatch("Beyoncé")).toBe("beyonce");
    expect(normalizeForMatch("Björk")).toBe("bjork");
  });

  it("collapses whitespace away entirely", () => {
    expect(normalizeForMatch("  A  B  ")).toBe("ab");
  });

  it("returns empty string for punctuation-only input", () => {
    expect(normalizeForMatch("!!!")).toBe("");
  });
});

describe("looseMatch", () => {
  it("matches identical strings after normalisation", () => {
    expect(looseMatch("NIKI", "niki")).toBe(true);
  });

  it("matches when one side contains the other", () => {
    // Music.app says "NIKI"; iTunes says "88rising & NIKI".
    expect(looseMatch("NIKI", "88rising & NIKI")).toBe(true);
    // iTunes appends " - Single" / " - EP" to collection names.
    expect(looseMatch("lowkey", "lowkey - Single")).toBe(true);
  });

  it("rejects the near-miss that a fuzzy search returns", () => {
    expect(looseMatch("NIKI", "NICKI NICOLE")).toBe(false);
  });

  it("rejects when either side normalises to empty", () => {
    expect(looseMatch("", "anything")).toBe(false);
    expect(looseMatch("!!!", "anything")).toBe(false);
  });
});

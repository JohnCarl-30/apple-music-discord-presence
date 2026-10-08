import { describe, expect, it, vi } from "vitest";
import { lookupArtwork, pickArtwork } from "../../src/artwork/itunes.js";

const art = (id: string): string =>
  `https://is1-ssl.mzstatic.com/image/thumb/${id}/100x100bb.jpg`;

/** Real response order for `term=NIKI Nicole&entity=album&limit=10`. */
const NIKI_RESULTS = [
  { artistName: "NICKI NICOLE", collectionName: "Ojos Verdes - Single", artworkUrl100: art("a") },
  { artistName: "Peso Pluma & NICKI NICOLE", collectionName: "Por las Noches (Remix) - Single", artworkUrl100: art("b") },
  { artistName: "Bizarrap & NICKI NICOLE", collectionName: "Nicki Nicole: Bzrp Music Sessions, Vol. 13 - Single", artworkUrl100: art("c") },
  { artistName: "NIKI", collectionName: "lowkey - Single", artworkUrl100: art("d") },
  { artistName: "NIKI", collectionName: "wanna take this downtown? - EP", artworkUrl100: art("e") },
  { artistName: "Los Ángeles Azules & NICKI NICOLE", collectionName: "Otra Noche - Single", artworkUrl100: art("f") },
  { artistName: "NIKI", collectionName: "Nicole", artworkUrl100: art("CORRECT") },
  { artistName: "Rochy RD, Myke Towers & NICKI NICOLE", collectionName: "Ella No Es Tuya (Remix) - Single", artworkUrl100: art("h") },
];

describe("pickArtwork", () => {
  it("skips the fuzzy top hit and picks the verified match", () => {
    expect(pickArtwork("NIKI", "Nicole", NIKI_RESULTS)).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/CORRECT/512x512bb.jpg",
    );
  });

  it("upgrades the artwork size to 512x512bb", () => {
    const url = pickArtwork("NIKI", "Nicole", NIKI_RESULTS);
    expect(url).toContain("512x512bb");
    expect(url).not.toContain("100x100bb");
  });

  it("returns null when no result matches both artist and album", () => {
    expect(pickArtwork("Radiohead", "Kid A", NIKI_RESULTS)).toBeNull();
  });

  it("rejects a result whose artist does not match even when the album does", () => {
    // "Nicole" matches result #7's collection, but Radiohead matches no artist.
    expect(pickArtwork("Radiohead", "Nicole", NIKI_RESULTS)).toBeNull();
  });

  it("accepts a same-artist near-album hit — the documented cost of substring matching", () => {
    // Spec mandates "substring match in either direction", which is what lets
    // "lowkey" match "lowkey - Single". The same rule means a short album name
    // can match inside a longer title by the same artist: here "nicole" sits
    // inside "nickinicolebzrpmusicsessions...". Both artist and album must still
    // match, so the worst case is cover art from a related release by that
    // artist, not an unrelated one. Pinned so the looseness is visible.
    expect(pickArtwork("NICKI NICOLE", "Nicole", NIKI_RESULTS)).toBe(
      "https://is1-ssl.mzstatic.com/image/thumb/c/512x512bb.jpg",
    );
  });

  it("ignores results missing the fields we need", () => {
    const partial = [
      { artistName: "NIKI", collectionName: "Nicole" },
      { collectionName: "Nicole", artworkUrl100: art("x") },
      { artistName: "NIKI", artworkUrl100: art("y") },
    ];
    expect(pickArtwork("NIKI", "Nicole", partial)).toBeNull();
  });

  it("returns null for an empty result list", () => {
    expect(pickArtwork("NIKI", "Nicole", [])).toBeNull();
  });
});

describe("lookupArtwork", () => {
  const okResponse = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body }) as unknown as Response;

  it("queries the search endpoint with the expected parameters", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ results: NIKI_RESULTS }));
    await lookupArtwork("NIKI", "Nicole", { fetchImpl: fetchImpl as unknown as typeof fetch });
    const url = new URL((fetchImpl.mock.calls[0]![0] as string));
    expect(url.origin + url.pathname).toBe("https://itunes.apple.com/search");
    expect(url.searchParams.get("term")).toBe("NIKI Nicole");
    expect(url.searchParams.get("entity")).toBe("album");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("resolves the verified artwork URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ results: NIKI_RESULTS }));
    await expect(
      lookupArtwork("NIKI", "Nicole", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toContain("CORRECT");
  });

  // Review Focus 2: streams have no album; never query for one.
  it("returns null without calling fetch when artist or album is empty", async () => {
    const fetchImpl = vi.fn();
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch };
    await expect(lookupArtwork("", "Nicole", deps)).resolves.toBeNull();
    await expect(lookupArtwork("NIKI", "", deps)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 } as Response);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      lookupArtwork("NIKI", "Nicole", { fetchImpl: fetchImpl as unknown as typeof fetch, logger }),
    ).resolves.toBeNull();
  });

  it("returns null when fetch rejects", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(
      lookupArtwork("NIKI", "Nicole", { fetchImpl: fetchImpl as unknown as typeof fetch, logger }),
    ).resolves.toBeNull();
  });

  it("returns null when the body is not the shape we expect", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ nope: true }));
    await expect(
      lookupArtwork("NIKI", "Nicole", { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull();
  });
});

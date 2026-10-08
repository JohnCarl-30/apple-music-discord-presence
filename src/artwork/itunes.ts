import { createLogger, type Logger } from "../log.js";
import { looseMatch } from "./normalize.js";

export const ITUNES_SEARCH_URL = "https://itunes.apple.com/search";
const SOURCE_SIZE = "100x100bb";
const TARGET_SIZE = "512x512bb";
const RESULT_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 5000;

export interface ITunesResult {
  artistName?: string;
  collectionName?: string;
  artworkUrl100?: string;
}

export interface LookupDeps {
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

/**
 * Choose the first result whose artist AND album both verify against what
 * Music.app reported. The API's relevance ranking is not trustworthy for
 * this: "NIKI"/"Nicole" ranks "NICKI NICOLE" first and the real album
 * seventh, so an unverified top hit would show the wrong cover art.
 */
export function pickArtwork(
  artist: string,
  album: string,
  results: readonly ITunesResult[],
): string | null {
  for (const r of results) {
    if (r.artistName === undefined || r.collectionName === undefined) continue;
    if (r.artworkUrl100 === undefined) continue;
    if (!looseMatch(artist, r.artistName)) continue;
    if (!looseMatch(album, r.collectionName)) continue;
    return r.artworkUrl100.replace(SOURCE_SIZE, TARGET_SIZE);
  }
  return null;
}

function isResultArray(value: unknown): value is ITunesResult[] {
  return Array.isArray(value);
}

/**
 * Resolve a public HTTPS album-art URL, or null. Never throws: artwork is
 * decoration, and a presence without a cover beats no presence at all.
 */
export async function lookupArtwork(
  artist: string,
  album: string,
  deps: LookupDeps = {},
): Promise<string | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger ?? createLogger("artwork");

  // A stream with no album would otherwise match arbitrary records.
  if (artist.trim() === "" || album.trim() === "") return null;

  const url = new URL(ITUNES_SEARCH_URL);
  url.searchParams.set("term", `${artist} ${album}`);
  url.searchParams.set("entity", "album");
  url.searchParams.set("limit", String(RESULT_LIMIT));

  try {
    const response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      logger.warn(`iTunes search returned ${response.status}`);
      return null;
    }
    const body: unknown = await response.json();
    const results = (body as { results?: unknown } | null)?.results;
    if (!isResultArray(results)) return null;
    return pickArtwork(artist, album, results);
  } catch (error) {
    logger.warn(`iTunes search failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

import { lookupArtwork } from "./itunes.js";
import { normalizeForMatch } from "./normalize.js";
import { FIELD_SEP } from "../music/script.js";

/** Resolves album art for a track, hiding caching and network concerns. */
export interface ArtworkProvider {
  get(artist: string, album: string): Promise<string | null>;
}

export type ArtworkLookup = (artist: string, album: string) => Promise<string | null>;

export interface CachingArtworkProviderOptions {
  lookup?: ArtworkLookup;
  ttlMs?: number;
  now?: () => number;
}

interface CacheEntry {
  url: string | null;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 86_400_000; // 24 hours

export class CachingArtworkProvider implements ArtworkProvider {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string | null>>();
  private readonly lookup: ArtworkLookup;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: CachingArtworkProviderOptions = {}) {
    this.lookup = options.lookup ?? ((artist, album) => lookupArtwork(artist, album));
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  async get(artist: string, album: string): Promise<string | null> {
    const key = `${normalizeForMatch(artist)}${FIELD_SEP}${normalizeForMatch(album)}`;

    const cached = this.entries.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) return cached.url;

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const request = this.lookup(artist, album)
      .then(
        (url) => {
          // A resolved null IS cached (negative caching), so a non-catalog
          // album is not re-queried on every track change.
          this.entries.set(key, { url, expiresAt: this.now() + this.ttlMs });
          return url;
        },
        () => {
          // A rejection is NOT cached: a transient outage must not blank this
          // album's art for the whole TTL.
          return null;
        },
      )
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, request);
    return request;
  }
}

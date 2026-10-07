import type { NowPlaying, PlayerState } from "../types.js";
import { FIELD_SEP, MISSING_VALUE, NOT_RUNNING, STOPPED } from "./script.js";

const FIELD_COUNT = 7;

/** Music.app reports scrubbing as its own state; for presence it is playing. */
function toPlayerState(raw: string): PlayerState | null {
  switch (raw) {
    case "playing":
    case "fast forwarding":
    case "rewinding":
      return "playing";
    case "paused":
      return "paused";
    default:
      return null;
  }
}

/** An unset or absent property reads as "unknown", which we model as 0. */
function toSeconds(raw: string): number | null {
  const t = raw.trim();
  if (t === "" || t === MISSING_VALUE) return 0;
  // Tolerate a comma decimal separator in case the script ever emits a real
  // under a non-English locale.
  const n = Number(t.replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n);
}

/** Never show AppleScript's "missing value" literal to the user. */
function toText(raw: string): string {
  return raw === MISSING_VALUE ? "" : raw;
}

/**
 * Parse one line of `NOW_PLAYING_SCRIPT` output.
 * Returns null whenever there is nothing to show — including malformed
 * output, which we prefer to clear the presence rather than guess at.
 */
export function parseNowPlaying(raw: string): NowPlaying | null {
  const line = raw.trim();
  if (line === "" || line === STOPPED || line === NOT_RUNNING) return null;

  const fields = line.split(FIELD_SEP);
  if (fields.length !== FIELD_COUNT) return null;

  const [stateRaw, persistentId, title, artist, album, durationRaw, positionRaw] =
    fields as [string, string, string, string, string, string, string];

  const state = toPlayerState(stateRaw);
  if (state === null) return null;

  const durationSec = toSeconds(durationRaw);
  const positionSec = toSeconds(positionRaw);
  if (durationSec === null || positionSec === null) return null;

  return {
    persistentId: toText(persistentId),
    title: toText(title),
    artist: toText(artist),
    album: toText(album),
    durationSec,
    positionSec,
    state,
  };
}

import type { NowPlaying, PlayerState } from "../types.js";
import { FIELD_SEP, NOT_RUNNING, STOPPED } from "./script.js";

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

function toSeconds(raw: string): number | null {
  if (raw.trim() === "") return 0;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n);
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

  return { persistentId, title, artist, album, durationSec, positionSec, state };
}

import type { Activity, NowPlaying } from "../types.js";

/** Discord truncates these fields server-side; we do it ourselves so the
 *  ellipsis lands somewhere sensible. */
export const MAX_FIELD_LENGTH = 128;

/** Discord activity types: Playing 0, Listening 2, Watching 3, Competing 5. */
export const ACTIVITY_TYPE_LISTENING = 2;

const PLACEHOLDER_ARTIST = "Unknown Artist";

/**
 * Trim to at most `max` code points. Array.from iterates by code point, so
 * an emoji or other astral character is never cut in half into U+FFFD.
 */
export function fitField(s: string, max: number = MAX_FIELD_LENGTH): string {
  const points = Array.from(s);
  if (points.length <= max) return s;
  return `${points.slice(0, max - 1).join("")}…`;
}

/** Discord rejects `details`/`state` shorter than 2 characters. */
export function padField(s: string): string {
  return s.length >= 2 ? s : `${s} `.padEnd(2, " ");
}

/**
 * Build the activity payload for one observation.
 *
 * `nowMs` is passed in rather than read from the clock so the mapping stays
 * pure and the timestamp arithmetic is testable.
 */
export function buildActivity(
  np: NowPlaying,
  artworkUrl: string | null,
  nowMs: number,
): Activity {
  const activity: Activity = {
    type: ACTIVITY_TYPE_LISTENING,
    details: padField(fitField(np.title)),
    state: padField(fitField(np.artist === "" ? PLACEHOLDER_ARTIST : np.artist)),
  };

  if (np.album !== "") activity.largeImageText = fitField(np.album);
  if (artworkUrl !== null) activity.largeImageKey = artworkUrl;

  if (np.state === "paused") {
    // A frozen progress bar is not expressible, so show no bar at all.
    activity.smallImageText = "Paused";
  } else if (np.durationSec > 0) {
    const startMs = Math.round(nowMs - np.positionSec * 1000);
    activity.startTimestamp = startMs;
    activity.endTimestamp = Math.round(startMs + np.durationSec * 1000);
  }

  return activity;
}

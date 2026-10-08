/** Music.app player state, normalised. Scrubbing states collapse to "playing". */
export type PlayerState = "playing" | "paused";

/** A single observation of what Music.app is playing. */
export interface NowPlaying {
  /** Music.app persistent ID; "" when unavailable (some stream sources). */
  persistentId: string;
  title: string;
  artist: string;
  /** "" for singles and live streams with no album. */
  album: string;
  /** Track length in seconds; 0 when unknown (live radio streams). */
  durationSec: number;
  /** Elapsed seconds into the track. */
  positionSec: number;
  state: PlayerState;
}

/** The subset of the Discord activity payload we populate. */
export interface Activity {
  type: number;
  details: string;
  state: string;
  largeImageKey?: string;
  largeImageText?: string;
  smallImageText?: string;
  startTimestamp?: number;
  endTimestamp?: number;
}

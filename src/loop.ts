import type { ArtworkProvider } from "./artwork/provider.js";
import { buildActivity } from "./discord/activity.js";
import { createLogger, type Logger } from "./log.js";
import { NotAuthorizedError, type MusicSource } from "./music/source.js";
import type { Activity, NowPlaying } from "./types.js";

/** Position drift beyond this means the user seeked, not that time passed. */
export const SEEK_TOLERANCE_SEC = 3;

export const DEFAULT_POLL_INTERVAL_MS = 2000;

/**
 * Should this sample be published?
 *
 * Steady playback deliberately returns false: the activity timestamps let
 * Discord animate the bar on its own, so re-publishing would spend the
 * 15-second rate-limit budget to tell Discord what it already knows.
 */
export function hasMeaningfulChange(
  prev: NowPlaying | null,
  next: NowPlaying | null,
  elapsedMs: number,
): boolean {
  if (prev === null || next === null) return prev !== next;
  if (prev.persistentId !== next.persistentId) return true;
  if (prev.state !== next.state) return true;
  if (prev.title !== next.title) return true;
  if (prev.artist !== next.artist) return true;
  if (prev.album !== next.album) return true;

  if (next.state === "playing") {
    const projected = prev.positionSec + elapsedMs / 1000;
    if (Math.abs(next.positionSec - projected) > SEEK_TOLERANCE_SEC) return true;
  }
  return false;
}

export interface PresenceLoopOptions {
  source: MusicSource;
  artwork: ArtworkProvider;
  /** null clears the presence. */
  submit: (activity: Activity | null) => void;
  logger?: Logger;
  pollIntervalMs?: number;
  now?: () => number;
}

export class PresenceLoop {
  private last: NowPlaying | null = null;
  private lastSampleAt: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly logger: Logger;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(private readonly options: PresenceLoopOptions) {
    this.logger = options.logger ?? createLogger("loop");
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = options.now ?? Date.now;
  }

  async tick(): Promise<void> {
    const sampledAt = this.now();

    let next: NowPlaying | null;
    try {
      next = await this.options.source.read();
    } catch (error) {
      // Permission is the one failure that will never fix itself.
      if (error instanceof NotAuthorizedError) throw error;
      this.logger.warn(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const elapsedMs = this.lastSampleAt === null ? 0 : sampledAt - this.lastSampleAt;
    const changed = hasMeaningfulChange(this.last, next, elapsedMs);
    this.last = next;
    this.lastSampleAt = sampledAt;

    if (!changed) return;

    if (next === null) {
      this.options.submit(null);
      return;
    }

    const artworkUrl = await this.resolveArtwork(next);
    this.options.submit(buildActivity(next, artworkUrl, this.now()));
  }

  private async resolveArtwork(np: NowPlaying): Promise<string | null> {
    if (np.album === "" || np.artist === "") return null;
    try {
      return await this.options.artwork.get(np.artist, np.album);
    } catch (error) {
      this.logger.warn(
        `artwork lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  start(): void {
    if (this.timer !== null) return;
    const run = (): void => {
      // Skip rather than overlap if a previous tick is still awaiting.
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((error: unknown) => {
          this.logger.error(error instanceof Error ? error.message : String(error));
          if (error instanceof NotAuthorizedError) {
            this.stop();
            process.exitCode = 1;
          }
        })
        .finally(() => {
          this.running = false;
        });
    };
    run();
    this.timer = setInterval(run, this.pollIntervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

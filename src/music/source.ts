import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NowPlaying } from "../types.js";
import { createLogger, type Logger } from "../log.js";
import { parseNowPlaying } from "./parse.js";
import { NOW_PLAYING_SCRIPT } from "./script.js";

const execFileAsync = promisify(execFile);

/** Reads what is playing. Returns null when there is nothing to show. */
export interface MusicSource {
  read(): Promise<NowPlaying | null>;
}

export type ScriptRunner = (script: string, timeoutMs: number) => Promise<string>;

/**
 * macOS automation permission has not been granted. Unlike every other
 * failure this is not transient, so it propagates instead of being absorbed.
 */
export class NotAuthorizedError extends Error {
  constructor() {
    super(
      "Not authorized to control Music.app. Grant permission in " +
        "System Settings → Privacy & Security → Automation, enable Music " +
        "for your terminal (or the launchd agent), then restart it.",
    );
    this.name = "NotAuthorizedError";
  }
}

export const runOsascript: ScriptRunner = async (script, timeoutMs) => {
  const { stdout } = await execFileAsync("osascript", ["-e", script], {
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

export interface AppleScriptMusicSourceOptions {
  run?: ScriptRunner;
  timeoutMs?: number;
  logger?: Logger;
}

export class AppleScriptMusicSource implements MusicSource {
  private readonly run: ScriptRunner;
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(options: AppleScriptMusicSourceOptions = {}) {
    this.run = options.run ?? runOsascript;
    this.timeoutMs = options.timeoutMs ?? 4000;
    this.logger = options.logger ?? createLogger("music");
  }

  async read(): Promise<NowPlaying | null> {
    let output: string;
    try {
      output = await this.run(NOW_PLAYING_SCRIPT, this.timeoutMs);
    } catch (error) {
      if (isNotAuthorized(error)) throw new NotAuthorizedError();
      // Music.app quitting, osascript timing out, machine asleep: all
      // transient. Treat as "nothing playing" and keep polling.
      this.logger.warn(`osascript failed: ${describe(error)}`);
      return null;
    }
    return parseNowPlaying(output);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNotAuthorized(error: unknown): boolean {
  return describe(error).includes("-1743");
}

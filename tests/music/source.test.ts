import { describe, expect, it, vi } from "vitest";
import {
  AppleScriptMusicSource,
  NotAuthorizedError,
} from "../../src/music/source.js";
import { FIELD_SEP } from "../../src/music/script.js";

const row = (...f: string[]): string => f.join(FIELD_SEP);
const okRow = row("playing", "ID1", "Title", "Artist", "Album", "200", "10");

describe("AppleScriptMusicSource", () => {
  it("returns the parsed track from the runner output", async () => {
    const run = vi.fn().mockResolvedValue(`${okRow}\n`);
    const source = new AppleScriptMusicSource({ run });
    await expect(source.read()).resolves.toMatchObject({
      persistentId: "ID1",
      title: "Title",
      state: "playing",
    });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes the script and timeout to the runner", async () => {
    const run = vi.fn().mockResolvedValue("STOPPED");
    await new AppleScriptMusicSource({ run, timeoutMs: 1234 }).read();
    const [script, timeout] = run.mock.calls[0]!;
    expect(script).toContain('tell application "Music"');
    expect(timeout).toBe(1234);
  });

  it("returns null when Music.app is not running", async () => {
    const run = vi.fn().mockResolvedValue("NOT_RUNNING");
    await expect(new AppleScriptMusicSource({ run }).read()).resolves.toBeNull();
  });

  // Review Focus 5: Music.app quitting mid-poll must not throw.
  it("returns null and logs when the runner rejects", async () => {
    const warn = vi.fn();
    const run = vi.fn().mockRejectedValue(new Error("Command failed: osascript"));
    const source = new AppleScriptMusicSource({
      run,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    await expect(source.read()).resolves.toBeNull();
    expect(warn).toHaveBeenCalledOnce();
  });

  it("returns null when the runner times out", async () => {
    const err = Object.assign(new Error("timeout"), { killed: true, signal: "SIGTERM" });
    const run = vi.fn().mockRejectedValue(err);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await expect(new AppleScriptMusicSource({ run, logger }).read()).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("throws NotAuthorizedError when automation permission is denied", async () => {
    const run = vi
      .fn()
      .mockRejectedValue(new Error("execution error: Not authorized to send Apple events to Music. (-1743)"));
    await expect(new AppleScriptMusicSource({ run }).read()).rejects.toBeInstanceOf(
      NotAuthorizedError,
    );
  });

  it("includes remediation guidance in the NotAuthorizedError message", async () => {
    const run = vi.fn().mockRejectedValue(new Error("error (-1743)"));
    await expect(new AppleScriptMusicSource({ run }).read()).rejects.toThrow(
      /System Settings/i,
    );
  });
});

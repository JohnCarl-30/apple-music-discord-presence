import { describe, expect, it } from "vitest";
import { parseNowPlaying } from "../../src/music/parse.js";
import { FIELD_SEP } from "../../src/music/script.js";

const row = (...f: string[]): string => f.join(FIELD_SEP);

describe("parseNowPlaying", () => {
  it("parses a real playing row", () => {
    const raw = row(
      "playing",
      "48E64B0428B5C5B7",
      "Oceans & Engines",
      "NIKI",
      "Nicole",
      "336.046997070312",
      "207.643005371094",
    );
    expect(parseNowPlaying(raw)).toEqual({
      persistentId: "48E64B0428B5C5B7",
      title: "Oceans & Engines",
      artist: "NIKI",
      album: "Nicole",
      durationSec: 336.046997070312,
      positionSec: 207.643005371094,
      state: "playing",
    });
  });

  it("tolerates the trailing newline osascript adds", () => {
    const raw = `${row("paused", "ID", "T", "A", "Al", "10", "1")}\n`;
    expect(parseNowPlaying(raw)?.state).toBe("paused");
  });

  it("collapses scrubbing states to playing", () => {
    for (const s of ["fast forwarding", "rewinding"]) {
      expect(parseNowPlaying(row(s, "ID", "T", "A", "Al", "10", "1"))?.state).toBe("playing");
    }
  });

  it("returns null for stopped, not-running, and empty output", () => {
    expect(parseNowPlaying("STOPPED")).toBeNull();
    expect(parseNowPlaying("NOT_RUNNING")).toBeNull();
    expect(parseNowPlaying("   ")).toBeNull();
  });

  // Review Focus 1: metadata must never desync the field count.
  it("returns null rather than misparsing when the field count is wrong", () => {
    expect(parseNowPlaying(row("playing", "ID", "T", "A"))).toBeNull();
    expect(parseNowPlaying(row("playing", "ID", "T", "A", "Al", "10", "1", "extra"))).toBeNull();
  });

  it("returns null for an unrecognised player state", () => {
    expect(parseNowPlaying(row("teleporting", "ID", "T", "A", "Al", "10", "1"))).toBeNull();
  });

  it("returns null when the numeric fields are not numbers", () => {
    expect(parseNowPlaying(row("playing", "ID", "T", "A", "Al", "abc", "1"))).toBeNull();
    expect(parseNowPlaying(row("playing", "ID", "T", "A", "Al", "10", "NaN"))).toBeNull();
  });

  // Review Focus 2: live radio streams report duration 0 and no album.
  it("accepts a zero duration and an empty album", () => {
    const np = parseNowPlaying(row("playing", "", "Some Stream", "Some Station", "", "0", "0"));
    expect(np).toEqual({
      persistentId: "",
      title: "Some Stream",
      artist: "Some Station",
      album: "",
      durationSec: 0,
      positionSec: 0,
      state: "playing",
    });
  });

  it("clamps negative numbers to zero", () => {
    const np = parseNowPlaying(row("playing", "ID", "T", "A", "Al", "-5", "-2"));
    expect(np?.durationSec).toBe(0);
    expect(np?.positionSec).toBe(0);
  });

  it("keeps titles that contain the characters the sanitiser targets", () => {
    // The AppleScript replaces these before we ever see them, but a title with
    // legitimate spaces and ampersands must survive untouched.
    const np = parseNowPlaying(row("playing", "ID", "A & B  C", "X", "Y", "1", "0"));
    expect(np?.title).toBe("A & B  C");
  });
});

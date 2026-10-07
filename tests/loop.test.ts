import { describe, expect, it, vi } from "vitest";
import { hasMeaningfulChange, PresenceLoop, SEEK_TOLERANCE_SEC } from "../src/loop.js";
import { NotAuthorizedError } from "../src/music/source.js";
import type { Activity, NowPlaying } from "../src/types.js";

const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  persistentId: "ID1",
  title: "Title",
  artist: "Artist",
  album: "Album",
  durationSec: 300,
  positionSec: 10,
  state: "playing",
  ...over,
});

describe("hasMeaningfulChange", () => {
  it("is false for two identical idle samples", () => {
    expect(hasMeaningfulChange(null, null, 2000)).toBe(false);
  });

  it("is true when playback starts", () => {
    expect(hasMeaningfulChange(null, track(), 2000)).toBe(true);
  });

  it("is true when playback stops", () => {
    expect(hasMeaningfulChange(track(), null, 2000)).toBe(true);
  });

  it("is false during steady playback", () => {
    const prev = track({ positionSec: 10 });
    const next = track({ positionSec: 12 });
    expect(hasMeaningfulChange(prev, next, 2000)).toBe(false);
  });

  it("is true when the track changes", () => {
    expect(hasMeaningfulChange(track(), track({ persistentId: "ID2" }), 2000)).toBe(true);
  });

  it("is true when the player state changes", () => {
    expect(hasMeaningfulChange(track(), track({ state: "paused" }), 2000)).toBe(true);
  });

  it("is true when metadata is edited in place", () => {
    expect(hasMeaningfulChange(track(), track({ title: "New" }), 2000)).toBe(true);
    expect(hasMeaningfulChange(track(), track({ artist: "New" }), 2000)).toBe(true);
    expect(hasMeaningfulChange(track(), track({ album: "New" }), 2000)).toBe(true);
  });

  it("is true when the user seeks forward beyond the tolerance", () => {
    const prev = track({ positionSec: 10 });
    const next = track({ positionSec: 10 + 2 + SEEK_TOLERANCE_SEC + 1 });
    expect(hasMeaningfulChange(prev, next, 2000)).toBe(true);
  });

  it("is true when the user seeks backward", () => {
    expect(hasMeaningfulChange(track({ positionSec: 100 }), track({ positionSec: 5 }), 2000)).toBe(true);
  });

  it("tolerates small drift from poll jitter", () => {
    const prev = track({ positionSec: 10 });
    const next = track({ positionSec: 14 });
    expect(hasMeaningfulChange(prev, next, 2000)).toBe(false);
  });

  it("ignores position drift while paused", () => {
    const prev = track({ state: "paused", positionSec: 10 });
    const next = track({ state: "paused", positionSec: 10 });
    expect(hasMeaningfulChange(prev, next, 60_000)).toBe(false);
  });

  it("detects a track repeating itself", () => {
    const prev = track({ positionSec: 299 });
    const next = track({ positionSec: 0 });
    expect(hasMeaningfulChange(prev, next, 2000)).toBe(true);
  });
});

describe("PresenceLoop.tick", () => {
  const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  function harness(reads: Array<NowPlaying | null>, artworkUrl: string | null = "https://art.jpg") {
    const submitted: Array<Activity | null> = [];
    let clock = 1_700_000_000_000;
    const loop = new PresenceLoop({
      source: { read: vi.fn().mockImplementation(async () => reads.shift() ?? null) },
      artwork: { get: vi.fn().mockResolvedValue(artworkUrl) },
      submit: (a) => submitted.push(a),
      logger: silent,
      now: () => (clock += 2000),
    });
    return { loop, submitted };
  }

  it("submits an activity when playback starts", async () => {
    const { loop, submitted } = harness([track()]);
    await loop.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ type: 2, details: "Title", state: "Artist" });
  });

  it("attaches resolved artwork", async () => {
    const { loop, submitted } = harness([track()], "https://art/512x512bb.jpg");
    await loop.tick();
    expect(submitted[0]).toMatchObject({ largeImageKey: "https://art/512x512bb.jpg" });
  });

  it("submits nothing on a steady second tick", async () => {
    const { loop, submitted } = harness([track({ positionSec: 10 }), track({ positionSec: 12 })]);
    await loop.tick();
    await loop.tick();
    expect(submitted).toHaveLength(1);
  });

  it("submits null to clear when playback stops", async () => {
    const { loop, submitted } = harness([track(), null]);
    await loop.tick();
    await loop.tick();
    expect(submitted).toEqual([expect.objectContaining({ type: 2 }), null]);
  });

  it("submits nothing when idle from the start", async () => {
    const { loop, submitted } = harness([null, null]);
    await loop.tick();
    await loop.tick();
    expect(submitted).toHaveLength(0);
  });

  // Review Focus 2: no artwork query for a stream with no album.
  it("skips the artwork lookup when there is no album", async () => {
    const artwork = { get: vi.fn().mockResolvedValue(null) };
    const submitted: Array<Activity | null> = [];
    const loop = new PresenceLoop({
      source: { read: vi.fn().mockResolvedValue(track({ album: "", durationSec: 0 })) },
      artwork,
      submit: (a) => submitted.push(a),
      logger: silent,
    });
    await loop.tick();
    expect(artwork.get).not.toHaveBeenCalled();
    expect(submitted[0]).toMatchObject({ type: 2 });
    expect(submitted[0]).not.toHaveProperty("startTimestamp");
  });

  // Review Focus 5: a source failure must not kill the loop.
  it("absorbs a source error and keeps the previous state", async () => {
    const submitted: Array<Activity | null> = [];
    const read = vi
      .fn()
      .mockResolvedValueOnce(track())
      .mockRejectedValueOnce(new Error("osascript died"))
      .mockResolvedValueOnce(track({ positionSec: 14 }));
    // A controlled clock, because this scenario is about elapsed time: the
    // loop must measure drift from the last SUCCESSFUL sample, so the 4s of
    // real time spanning the failed poll accounts for the 4s of position
    // advance and is not mistaken for a seek.
    let nowMs = 1_700_000_000_000;
    const loop = new PresenceLoop({
      source: { read },
      artwork: { get: vi.fn().mockResolvedValue(null) },
      submit: (a) => submitted.push(a),
      logger: silent,
      now: () => nowMs,
    });
    await loop.tick();
    nowMs += 2000;
    await expect(loop.tick()).resolves.toBeUndefined();
    nowMs += 2000;
    await loop.tick();
    expect(submitted).toHaveLength(1);
  });

  it("propagates NotAuthorizedError so the CLI can explain it", async () => {
    const loop = new PresenceLoop({
      source: { read: vi.fn().mockRejectedValue(new NotAuthorizedError()) },
      artwork: { get: vi.fn() },
      submit: () => {},
      logger: silent,
    });
    await expect(loop.tick()).rejects.toBeInstanceOf(NotAuthorizedError);
  });

  it("still submits when the artwork lookup fails", async () => {
    const submitted: Array<Activity | null> = [];
    const loop = new PresenceLoop({
      source: { read: vi.fn().mockResolvedValue(track()) },
      artwork: { get: vi.fn().mockRejectedValue(new Error("offline")) },
      submit: (a) => submitted.push(a),
      logger: silent,
    });
    await loop.tick();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).not.toHaveProperty("largeImageKey");
  });
});

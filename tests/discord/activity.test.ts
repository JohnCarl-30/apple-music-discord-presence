import { describe, expect, it } from "vitest";
import { buildActivity, fitField, padField } from "../../src/discord/activity.js";
import type { NowPlaying } from "../../src/types.js";

const NOW = 1_700_000_000_000;

const track = (over: Partial<NowPlaying> = {}): NowPlaying => ({
  persistentId: "ID1",
  title: "Oceans & Engines",
  artist: "NIKI",
  album: "Nicole",
  durationSec: 336,
  positionSec: 100,
  state: "playing",
  ...over,
});

describe("fitField", () => {
  it("leaves short strings untouched", () => {
    expect(fitField("Nicole")).toBe("Nicole");
  });

  it("leaves a string of exactly the limit untouched", () => {
    const s = "a".repeat(128);
    expect(fitField(s)).toBe(s);
  });

  it("truncates to the limit with an ellipsis", () => {
    const out = fitField("a".repeat(200));
    expect(Array.from(out)).toHaveLength(128);
    expect(out.endsWith("…")).toBe(true);
  });

  // Review Focus 3: never split a surrogate pair.
  it("counts code points, not UTF-16 units, and never splits emoji", () => {
    const out = fitField("🎵".repeat(200));
    expect(Array.from(out)).toHaveLength(128);
    expect(out).not.toContain("�");
    expect(Array.from(out).slice(0, -1).every((c) => c === "🎵")).toBe(true);
  });

  it("handles CJK text at the boundary", () => {
    const out = fitField("曲".repeat(130));
    expect(Array.from(out)).toHaveLength(128);
  });
});

describe("padField", () => {
  it("leaves strings of two or more characters alone", () => {
    expect(padField("ab")).toBe("ab");
  });

  it("pads a one-character value, which Discord would reject", () => {
    expect(Array.from(padField("4"))).toHaveLength(2);
    expect(padField("4").startsWith("4")).toBe(true);
  });

  it("pads an empty value", () => {
    expect(padField("").length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildActivity", () => {
  it("maps title, artist, and album to the Discord fields", () => {
    const a = buildActivity(track(), null, NOW);
    expect(a.type).toBe(2);
    expect(a.details).toBe("Oceans & Engines");
    expect(a.state).toBe("NIKI");
    expect(a.largeImageText).toBe("Nicole");
  });

  it("sets timestamps so Discord animates the bar from the current position", () => {
    const a = buildActivity(track({ positionSec: 100, durationSec: 336 }), null, NOW);
    expect(a.startTimestamp).toBe(NOW - 100_000);
    expect(a.endTimestamp).toBe(NOW - 100_000 + 336_000);
  });

  it("includes the artwork URL when resolved", () => {
    const a = buildActivity(track(), "https://art/512x512bb.jpg", NOW);
    expect(a.largeImageKey).toBe("https://art/512x512bb.jpg");
  });

  it("omits largeImageKey when artwork is unresolved", () => {
    expect(buildActivity(track(), null, NOW).largeImageKey).toBeUndefined();
  });

  it("omits largeImageText when there is no album", () => {
    expect(buildActivity(track({ album: "" }), null, NOW).largeImageText).toBeUndefined();
  });

  // Review Focus 2: a live stream has duration 0 — no bar, no epoch endpoint.
  it("omits both timestamps when the duration is unknown", () => {
    const a = buildActivity(track({ durationSec: 0, positionSec: 0 }), null, NOW);
    expect(a.startTimestamp).toBeUndefined();
    expect(a.endTimestamp).toBeUndefined();
  });

  it("marks a paused track and drops its timestamps", () => {
    const a = buildActivity(track({ state: "paused" }), null, NOW);
    expect(a.smallImageText).toBe("Paused");
    expect(a.startTimestamp).toBeUndefined();
    expect(a.endTimestamp).toBeUndefined();
  });

  it("does not mark a playing track as paused", () => {
    expect(buildActivity(track(), null, NOW).smallImageText).toBeUndefined();
  });

  it("substitutes a placeholder for a missing artist", () => {
    expect(buildActivity(track({ artist: "" }), null, NOW).state).toBe("Unknown Artist");
  });

  it("truncates an overlong title to the Discord limit", () => {
    const a = buildActivity(track({ title: "a".repeat(300) }), null, NOW);
    expect(Array.from(a.details)).toHaveLength(128);
  });

  it("truncates an overlong album", () => {
    const a = buildActivity(track({ album: "b".repeat(300) }), null, NOW);
    expect(Array.from(a.largeImageText!)).toHaveLength(128);
  });
});

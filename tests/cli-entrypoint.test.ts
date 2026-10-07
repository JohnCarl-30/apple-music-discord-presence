import { mkdtempSync, realpathSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isDirectRun } from "../src/cli.js";

/**
 * package.json `bin` is consumed as a symlink by `npm i -g` and npx, and the
 * install path may contain spaces. Both broke the previous naive comparison,
 * which made the installed CLI exit 0 doing nothing.
 */
describe("isDirectRun", () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "amdp-entry-")));

  it("is true when argv[1] is the module's own path", () => {
    const real = join(base, "cli.js");
    writeFileSync(real, "");
    expect(isDirectRun(real, pathToFileURL(real).href)).toBe(true);
  });

  it("is true when argv[1] is a symlink to the module (npm i -g / npx)", () => {
    const real = join(base, "target.js");
    const link = join(base, "linked-cli");
    writeFileSync(real, "");
    symlinkSync(real, link);
    // import.meta.url is the realpath; argv[1] is the symlink.
    expect(isDirectRun(link, pathToFileURL(real).href)).toBe(true);
  });

  it("is true when the install path contains a space", () => {
    const dir = join(base, "My Projects");
    mkdirSync(dir, { recursive: true });
    const real = join(dir, "cli.js");
    writeFileSync(real, "");
    // pathToFileURL percent-encodes the space; a template literal would not.
    expect(pathToFileURL(real).href).toContain("%20");
    expect(isDirectRun(real, pathToFileURL(real).href)).toBe(true);
  });

  it("is false when the module is merely imported by another entry point", () => {
    const real = join(base, "lib.js");
    const other = join(base, "other-entry.js");
    writeFileSync(real, "");
    writeFileSync(other, "");
    expect(isDirectRun(other, pathToFileURL(real).href)).toBe(false);
  });

  it("is false when argv[1] is absent", () => {
    expect(isDirectRun(undefined, pathToFileURL(join(base, "cli.js")).href)).toBe(false);
  });

  it("is false rather than throwing when argv[1] does not exist on disk", () => {
    expect(isDirectRun(join(base, "gone.js"), pathToFileURL(join(base, "cli.js")).href)).toBe(false);
  });
});

// --- C3: transport errors must not kill the daemon ---
describe("classifyRuntimeError", async () => {
  const { classifyRuntimeError } = await import("../src/cli.js");

  it("treats socket teardown errors as survivable", () => {
    for (const code of ["EPIPE", "ECONNRESET", "ENOTCONN", "ECONNREFUSED", "EPROTO"]) {
      expect(classifyRuntimeError(Object.assign(new Error(code), { code }))).toBe("continue");
    }
  });

  it("treats a programming error as fatal", () => {
    expect(classifyRuntimeError(new TypeError("x is not a function"))).toBe("fatal");
  });

  it("treats an unknown value as fatal", () => {
    expect(classifyRuntimeError("boom")).toBe("fatal");
  });
});


// --- I5: shutdown must not hang on a wedged Discord ---
describe("withTimeout", async () => {
  const { withTimeout } = await import("../src/cli.js");

  it("resolves with the work when it finishes in time", async () => {
    await expect(withTimeout(Promise.resolve("done"), 1000)).resolves.toBe("done");
  });

  it("gives up on work that never settles", async () => {
    // The library's own request timeout is 60s; a shutdown must not wait that long.
    await expect(withTimeout(new Promise(() => {}), 20)).resolves.toBeUndefined();
  });

  it("gives up rather than propagating a rejection", async () => {
    await expect(withTimeout(Promise.reject(new Error("EPIPE")), 1000)).resolves.toBeUndefined();
  });
});

// --- I8: --once must not report success for a run that published nothing ---
describe("main --once", async () => {
  const { main } = await import("../src/cli.js");
  const silentSink = (ok: boolean) => ({
    set: async () => ok,
    clear: async () => true,
    close: async () => {},
    reconnectIfNeeded: async () => {},
  });
  const playing = {
    persistentId: "ID1",
    title: "T",
    artist: "A",
    album: "",
    durationSec: 0,
    positionSec: 0,
    state: "playing" as const,
  };

  it("exits 0 when the single publish lands", async () => {
    await expect(
      main(["--client-id", "1", "--once"], {}, {
        sink: silentSink(true),
        source: { read: async () => playing },
        artwork: { get: async () => null },
      }),
    ).resolves.toBe(0);
  });

  it("exits non-zero when the publish did not land", async () => {
    await expect(
      main(["--client-id", "1", "--once"], {}, {
        sink: silentSink(false),
        source: { read: async () => playing },
        artwork: { get: async () => null },
      }),
    ).resolves.not.toBe(0);
  });

  it("exits 0 when there was nothing to publish", async () => {
    await expect(
      main(["--client-id", "1", "--once"], {}, {
        sink: silentSink(false),
        source: { read: async () => null },
        artwork: { get: async () => null },
      }),
    ).resolves.toBe(0);
  });
});

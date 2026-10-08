import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

/**
 * C3: @xhayper/discord-rpc's IPC transport removes its own socket `error`
 * listener once connected, so an EPIPE on a half-open socket arrives as an
 * uncaught exception. FR6 says that must not crash the daemon. Verified in a
 * real child process, because that is the only place `uncaughtException`
 * behaves like it does in production.
 */
async function runChild(script: string): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      timeout: 15_000,
    });
    return { code: 0, out: stdout + stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

describe("crash guards (child process)", () => {
  it("an uncaught EPIPE does not kill the process", async () => {
    const { code, out } = await runChild(`
      import { installCrashGuards } from "./dist/cli.js";
      installCrashGuards({ info() {}, warn() {}, error() {} });
      setTimeout(() => { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; }, 10);
      setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 300);
    `);
    expect(out).toContain("SURVIVED");
    expect(code).toBe(0);
  }, 20_000);

  it("without the guards the same EPIPE is fatal", async () => {
    const { code, out } = await runChild(`
      setTimeout(() => { const e = new Error("write EPIPE"); e.code = "EPIPE"; throw e; }, 10);
      setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 300);
    `);
    expect(out).not.toContain("SURVIVED");
    expect(code).not.toBe(0);
  }, 20_000);

  it("a programming error is still fatal with the guards installed", async () => {
    const { code } = await runChild(`
      import { installCrashGuards } from "./dist/cli.js";
      installCrashGuards({ info() {}, warn() {}, error() {} });
      setTimeout(() => { throw new TypeError("x is not a function"); }, 10);
      setTimeout(() => { console.log("SURVIVED"); process.exit(0); }, 300);
    `);
    expect(code).not.toBe(0);
  }, 20_000);
});

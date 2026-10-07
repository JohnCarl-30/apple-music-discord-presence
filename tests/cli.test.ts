import { describe, expect, it, vi } from "vitest";
import { main, parseOptions, UsageError } from "../src/cli.js";

describe("parseOptions", () => {
  it("reads the client id from a flag", () => {
    expect(parseOptions(["--client-id", "123"], {}).clientId).toBe("123");
  });

  it("reads the client id from the environment", () => {
    expect(parseOptions([], { DISCORD_CLIENT_ID: "456" }).clientId).toBe("456");
  });

  it("prefers the flag over the environment", () => {
    expect(parseOptions(["--client-id", "123"], { DISCORD_CLIENT_ID: "456" }).clientId).toBe("123");
  });

  it("throws a UsageError when no client id is supplied", () => {
    expect(() => parseOptions([], {})).toThrow(UsageError);
  });

  it("explains how to supply the client id", () => {
    expect(() => parseOptions([], {})).toThrow(/--client-id|DISCORD_CLIENT_ID/);
  });

  it("defaults the poll interval to 2000ms", () => {
    expect(parseOptions(["--client-id", "1"], {}).pollIntervalMs).toBe(2000);
  });

  it("accepts a custom poll interval", () => {
    expect(parseOptions(["--client-id", "1", "--poll-interval", "5000"], {}).pollIntervalMs).toBe(5000);
  });

  it("rejects a non-numeric poll interval", () => {
    expect(() => parseOptions(["--client-id", "1", "--poll-interval", "soon"], {})).toThrow(UsageError);
  });

  it("rejects an implausibly small poll interval", () => {
    expect(() => parseOptions(["--client-id", "1", "--poll-interval", "100"], {})).toThrow(UsageError);
  });

  it("defaults once to false and accepts the flag", () => {
    expect(parseOptions(["--client-id", "1"], {}).once).toBe(false);
    expect(parseOptions(["--client-id", "1", "--once"], {}).once).toBe(true);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseOptions(["--client-id", "1", "--turbo"], {})).toThrow(UsageError);
  });

  // USAGE documents --help, so it must work without a client id and must not
  // fall through into starting the daemon.
  it("reports help without requiring a client id", () => {
    expect(parseOptions(["--help"], {}).help).toBe(true);
  });

  it("reports help even when a client id is present", () => {
    expect(parseOptions(["--help", "--client-id", "123"], {}).help).toBe(true);
  });

  it("does not report help when it was not asked for", () => {
    expect(parseOptions(["--client-id", "1"], {}).help).toBe(false);
  });
});

describe("main", () => {
  it("prints usage to stdout and exits 0 for --help", async () => {
    const written: string[] = [];
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      });
    try {
      await expect(main(["--help"], {})).resolves.toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(written.join("")).toContain("--poll-interval");
  });

  it("exits 2 without a client id", async () => {
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await expect(main([], {})).resolves.toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});

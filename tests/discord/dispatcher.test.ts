import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoalescingDispatcher } from "../../src/discord/dispatcher.js";

describe("CoalescingDispatcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first submission immediately", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    new CoalescingDispatcher(send, 15_000).submit("a");
    await vi.advanceTimersByTimeAsync(0);
    // vitest 2.1 has no toHaveBeenCalledExactlyOnceWith; these two are equivalent.
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("a");
  });

  it("holds a second submission until the window opens", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new CoalescingDispatcher(send, 15_000);
    d.submit("a");
    await vi.advanceTimersByTimeAsync(0);
    d.submit("b");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("b");
  });

  // Review Focus 4: five skips inside one window must land on the fifth.
  it("coalesces a burst down to the newest payload", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new CoalescingDispatcher(send, 15_000);
    d.submit("t1");
    await vi.advanceTimersByTimeAsync(0);
    for (const t of ["t2", "t3", "t4", "t5"]) {
      d.submit(t);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("t5");
  });

  it("never drops the final state of a burst", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new CoalescingDispatcher(send, 15_000);
    for (let i = 0; i < 50; i += 1) d.submit(`v${i}`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenLastCalledWith("v49");
  });

  it("does not send anything when nothing was submitted", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    new CoalescingDispatcher(send, 15_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not overlap sends when one is slow", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const send = vi.fn().mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20_000));
      inFlight -= 1;
    });
    const d = new CoalescingDispatcher(send, 15_000);
    d.submit("a");
    await vi.advanceTimersByTimeAsync(0);
    d.submit("b");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(maxInFlight).toBe(1);
  });

  it("keeps running after a send rejects", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("EPIPE"))
      .mockResolvedValue(undefined);
    const d = new CoalescingDispatcher(send, 15_000);
    d.submit("a");
    await vi.advanceTimersByTimeAsync(0);
    d.submit("b");
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith("b");
  });

  it("flushNow bypasses the window for shutdown", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new CoalescingDispatcher(send, 15_000);
    d.submit("a");
    await vi.advanceTimersByTimeAsync(0);
    d.submit("final");
    await d.flushNow();
    expect(send).toHaveBeenLastCalledWith("final");
  });

  it("stop discards pending work and cancels the timer", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const d = new CoalescingDispatcher(send, 15_000);
    d.submit("a");
    await vi.advanceTimersByTimeAsync(0);
    d.submit("b");
    d.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  adaptRpcClient,
  backoffDelayMs,
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  RpcPresenceSink,
  type RpcClientLike,
} from "../../src/discord/client.js";
import type { Activity } from "../../src/types.js";

const activity: Activity = { type: 2, details: "Title", state: "Artist" };
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeClient(over: Partial<RpcClientLike> = {}): RpcClientLike {
  return {
    login: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setActivity: vi.fn().mockResolvedValue(undefined),
    clearActivity: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("backoffDelayMs", () => {
  const mid = (): number => 0.5;

  it("starts at the initial delay", () => {
    expect(backoffDelayMs(0, mid)).toBe(INITIAL_BACKOFF_MS);
  });

  it("doubles with each attempt", () => {
    expect(backoffDelayMs(1, mid)).toBe(2000);
    expect(backoffDelayMs(2, mid)).toBe(4000);
    expect(backoffDelayMs(3, mid)).toBe(8000);
  });

  it("caps the base delay", () => {
    expect(backoffDelayMs(50, mid)).toBe(MAX_BACKOFF_MS);
  });

  it("applies jitter within ±15%", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(850);
    expect(backoffDelayMs(0, () => 1)).toBe(1150);
  });

  it("never returns a negative delay", () => {
    for (const a of [0, 1, 5, 100]) {
      expect(backoffDelayMs(a, () => 0)).toBeGreaterThan(0);
    }
  });
});

// The real @xhayper/discord-rpc Client exposes setActivity/clearActivity on
// `client.user`, not on itself, and `user` is undefined until login resolves.
// These tests pin the adapter that bridges that gap; without it the sink would
// compile and then throw "client.setActivity is not a function" at runtime.
describe("adaptRpcClient", () => {
  it("delegates setActivity to client.user", async () => {
    const setActivity = vi.fn().mockResolvedValue({});
    const client = { login: vi.fn(), destroy: vi.fn(), user: { setActivity, clearActivity: vi.fn() } };
    await adaptRpcClient(client).setActivity(activity);
    expect(setActivity).toHaveBeenCalledWith(activity);
  });

  it("delegates clearActivity to client.user", async () => {
    const clearActivity = vi.fn().mockResolvedValue(undefined);
    const client = { login: vi.fn(), destroy: vi.fn(), user: { setActivity: vi.fn(), clearActivity } };
    await adaptRpcClient(client).clearActivity();
    expect(clearActivity).toHaveBeenCalledTimes(1);
  });

  it("delegates login and destroy to the client itself", async () => {
    const client = {
      login: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      user: undefined,
    };
    const adapted = adaptRpcClient(client);
    await adapted.login();
    await adapted.destroy();
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  it("rejects rather than crashing when user is not populated yet", async () => {
    const client = { login: vi.fn(), destroy: vi.fn(), user: undefined };
    await expect(adaptRpcClient(client).setActivity(activity)).rejects.toThrow(/user/i);
    await expect(adaptRpcClient(client).clearActivity()).rejects.toThrow(/user/i);
  });

  it("reads user at call time, not at adapt time", async () => {
    const setActivity = vi.fn().mockResolvedValue({});
    const client: { login: () => void; destroy: () => void; user?: { setActivity: typeof setActivity; clearActivity: () => Promise<void> } } = {
      login: vi.fn(),
      destroy: vi.fn(),
      user: undefined,
    };
    const adapted = adaptRpcClient(client);
    client.user = { setActivity, clearActivity: vi.fn() };
    await adapted.setActivity(activity);
    expect(setActivity).toHaveBeenCalledTimes(1);
  });
});

describe("RpcPresenceSink", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs in once and forwards the activity", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({
      clientId: "1",
      createClient: () => client,
      logger: silent,
    });
    await sink.set(activity);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.setActivity).toHaveBeenCalledWith(activity);
  });

  it("reuses the connection across updates", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.set(activity);
    await sink.set(activity);
    expect(client.login).toHaveBeenCalledTimes(1);
    expect(client.setActivity).toHaveBeenCalledTimes(2);
  });

  it("forwards clear", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.set(activity);
    await sink.clear();
    expect(client.clearActivity).toHaveBeenCalledTimes(1);
  });

  it("does not connect just to clear an unconnected sink", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.clear();
    expect(client.login).not.toHaveBeenCalled();
  });

  // Review Focus 5: Discord quitting must not crash the daemon.
  it("swallows a write failure and drops the dead connection", async () => {
    const client = fakeClient({
      setActivity: vi.fn().mockRejectedValue(new Error("write EPIPE")),
    });
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    // Swallows the failure AND reports that the write did not land.
    await expect(sink.set(activity)).resolves.toBe(false);
    expect(client.destroy).toHaveBeenCalled();
  });

  it("reconnects with a fresh client after a failure, once the backoff elapses", async () => {
    const dead = fakeClient({ setActivity: vi.fn().mockRejectedValue(new Error("EPIPE")) });
    const live = fakeClient();
    const clients = [dead, live];
    const sink = new RpcPresenceSink({
      clientId: "1",
      createClient: () => clients.shift() ?? live,
      logger: silent,
      random: () => 0.5,
    });
    await sink.set(activity);
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + 1);
    await sink.set(activity);
    expect(live.setActivity).toHaveBeenCalledWith(activity);
  });

  it("refuses to retry before the backoff window elapses", async () => {
    const dead = fakeClient({ setActivity: vi.fn().mockRejectedValue(new Error("EPIPE")) });
    const live = fakeClient();
    const clients = [dead, live];
    const sink = new RpcPresenceSink({
      clientId: "1",
      createClient: () => clients.shift() ?? live,
      logger: silent,
      random: () => 0.5,
    });
    await sink.set(activity);
    await sink.set(activity);
    expect(live.login).not.toHaveBeenCalled();
  });

  it("swallows a login failure", async () => {
    const client = fakeClient({ login: vi.fn().mockRejectedValue(new Error("ENOENT")) });
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await expect(sink.set(activity)).resolves.toBe(false);
  });

  it("close destroys the client and is safe to call twice", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.set(activity);
    await sink.close();
    await sink.close();
    expect(client.destroy).toHaveBeenCalledTimes(1);
  });

  // C2 / FR6: "republishes current state on reconnect". Without this the
  // presence stays dead until the track changes, which for a 5-minute track
  // means minutes of blank profile after Discord restarts.
  it("republishes the last activity once a reconnect succeeds", async () => {
    const dead = fakeClient({ setActivity: vi.fn().mockRejectedValue(new Error("EPIPE")) });
    const live = fakeClient();
    const clients = [dead, live];
    const sink = new RpcPresenceSink({
      clientId: "1",
      createClient: () => clients.shift() ?? live,
      logger: silent,
      random: () => 0.5,
    });
    await sink.set(activity);
    await vi.advanceTimersByTimeAsync(INITIAL_BACKOFF_MS + 1);
    // A bare clear-less reconnect attempt must restore the presence.
    await sink.reconnectIfNeeded();
    expect(live.setActivity).toHaveBeenCalledWith(activity);
  });

  it("does not republish when nothing was ever published", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.reconnectIfNeeded();
    expect(client.setActivity).not.toHaveBeenCalled();
  });

  it("forgets the last activity after a clear, so a reconnect does not resurrect it", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.set(activity);
    await sink.clear();
    (client.setActivity as ReturnType<typeof vi.fn>).mockClear();
    await sink.reconnectIfNeeded();
    expect(client.setActivity).not.toHaveBeenCalled();
  });

  // I8: --once must not report success for a run that published nothing.
  it("reports whether the write landed", async () => {
    const good = fakeClient();
    const okSink = new RpcPresenceSink({ clientId: "1", createClient: () => good, logger: silent });
    await expect(okSink.set(activity)).resolves.toBe(true);

    const bad = fakeClient({ setActivity: vi.fn().mockRejectedValue(new Error("EPIPE")) });
    const badSink = new RpcPresenceSink({ clientId: "1", createClient: () => bad, logger: silent });
    await expect(badSink.set(activity)).resolves.toBe(false);
  });

  it("reports false when it cannot even connect", async () => {
    const client = fakeClient({ login: vi.fn().mockRejectedValue(new Error("ENOENT")) });
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await expect(sink.set(activity)).resolves.toBe(false);
  });

  it("reports false while inside the backoff window", async () => {
    const dead = fakeClient({ setActivity: vi.fn().mockRejectedValue(new Error("EPIPE")) });
    const sink = new RpcPresenceSink({
      clientId: "1",
      createClient: () => dead,
      logger: silent,
      random: () => 0.5,
    });
    await sink.set(activity);
    await expect(sink.set(activity)).resolves.toBe(false);
  });

  it("ignores updates submitted after close", async () => {
    const client = fakeClient();
    const sink = new RpcPresenceSink({ clientId: "1", createClient: () => client, logger: silent });
    await sink.close();
    await sink.set(activity);
    expect(client.setActivity).not.toHaveBeenCalled();
  });
});

import { Client } from "@xhayper/discord-rpc";
import { createLogger, type Logger } from "../log.js";
import type { Activity } from "../types.js";

export const INITIAL_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;

/**
 * Where presence goes. Implementations must never throw; `set`/`clear` report
 * whether the write actually landed so callers can retry or exit non-zero.
 */
export interface PresenceSink {
  set(activity: Activity): Promise<boolean>;
  clear(): Promise<boolean>;
  close(): Promise<void>;
  /** Re-establish a dropped connection and restore the last activity. */
  reconnectIfNeeded(): Promise<void>;
}

/** The slice of the RPC client we use, so tests can substitute it. */
export interface RpcClientLike {
  login(): Promise<unknown>;
  destroy(): Promise<unknown>;
  setActivity(activity: Activity): Promise<unknown>;
  clearActivity(): Promise<unknown>;
}

/** The shape @xhayper/discord-rpc's Client actually presents. */
export interface RpcClientWithUser {
  login(options?: never): Promise<unknown>;
  destroy(): Promise<unknown>;
  user?: {
    setActivity(activity: never, pid?: number): Promise<unknown>;
    clearActivity(pid?: number): Promise<unknown>;
  } | undefined;
}

/**
 * Flatten the real client's API onto `RpcClientLike`.
 *
 * `setActivity`/`clearActivity` live on `client.user`, which is undefined
 * until login resolves — so `user` is read at call time, not captured here,
 * and a missing one rejects so the sink's retry path handles it rather than
 * the daemon crashing on `undefined`.
 */
export function adaptRpcClient(client: RpcClientWithUser): RpcClientLike {
  const requireUser = (): NonNullable<RpcClientWithUser["user"]> => {
    const user = client.user;
    if (user === undefined || user === null) {
      throw new Error("Discord client has no user yet; login has not completed");
    }
    return user;
  };
  return {
    login: () => Promise.resolve(client.login()),
    destroy: () => Promise.resolve(client.destroy()),
    setActivity: async (activity) => requireUser().setActivity(activity as never),
    clearActivity: async () => requireUser().clearActivity(),
  };
}

/**
 * Exponential backoff with ±15% jitter, so a Discord restart does not get a
 * thundering herd from several of these daemons at once.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** Math.max(0, attempt), MAX_BACKOFF_MS);
  return Math.round(base * (0.85 + 0.3 * random()));
}

export interface RpcPresenceSinkOptions {
  clientId: string;
  createClient?: () => RpcClientLike;
  logger?: Logger;
  random?: () => number;
}

export class RpcPresenceSink implements PresenceSink {
  private client: RpcClientLike | null = null;
  /** Retained so a reconnect can restore the presence (FR6). */
  private lastActivity: Activity | null = null;
  private attempt = 0;
  private nextAttemptAt = 0;
  private closed = false;
  private readonly createClient: () => RpcClientLike;
  private readonly logger: Logger;
  private readonly random: () => number;

  constructor(options: RpcPresenceSinkOptions) {
    this.logger = options.logger ?? createLogger("discord");
    this.random = options.random ?? Math.random;
    this.createClient =
      options.createClient ??
      (() => adaptRpcClient(new Client({ clientId: options.clientId }) as unknown as RpcClientWithUser));
  }

  async set(activity: Activity): Promise<boolean> {
    if (this.closed) return false;
    this.lastActivity = activity;
    const client = await this.connect();
    if (client === null) return false;
    try {
      await client.setActivity(activity);
      return true;
    } catch (error) {
      await this.handleFailure(error);
      return false;
    }
  }

  async clear(): Promise<boolean> {
    this.lastActivity = null;
    // Nothing to clear if we never connected; connecting just to clear would
    // briefly show a presence we are trying to remove. The desired state is
    // already achieved, so this counts as success.
    if (this.closed || this.client === null) return true;
    try {
      await this.client.clearActivity();
      return true;
    } catch (error) {
      await this.handleFailure(error);
      return false;
    }
  }

  /**
   * FR6: "republishes current state on reconnect."
   *
   * Driven on a watchdog interval so recovery does not depend on the user
   * happening to change track — steady playback produces no updates, so
   * without this the presence would stay blank until the track ended.
   */
  async reconnectIfNeeded(): Promise<void> {
    if (this.closed || this.client !== null || this.lastActivity === null) return;
    const client = await this.connect();
    if (client === null) return;
    try {
      await client.setActivity(this.lastActivity);
      this.logger.info("restored presence after reconnect");
    } catch (error) {
      await this.handleFailure(error);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.dropConnection();
  }

  private async connect(): Promise<RpcClientLike | null> {
    if (this.client !== null) return this.client;
    if (Date.now() < this.nextAttemptAt) {
      this.logger.info("skipping Discord update: inside backoff window");
      return null;
    }

    const client = this.createClient();
    try {
      await client.login();
      this.client = client;
      this.attempt = 0;
      this.logger.info("connected to Discord");
      return client;
    } catch (error) {
      this.scheduleRetry();
      this.logger.warn(
        `Discord login failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        await client.destroy();
      } catch {
        // Already dead; nothing to clean up.
      }
      return null;
    }
  }

  private async handleFailure(error: unknown): Promise<void> {
    this.logger.warn(
      `Discord write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await this.dropConnection();
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    const delay = backoffDelayMs(this.attempt, this.random);
    this.attempt += 1;
    this.nextAttemptAt = Date.now() + delay;
    this.logger.info(`retrying Discord in ${delay}ms`);
  }

  private async dropConnection(): Promise<void> {
    // Null the field BEFORE awaiting, so a second close() finds nothing and
    // destroy() is called exactly once.
    const client = this.client;
    this.client = null;
    if (client === null) return;
    try {
      await client.destroy();
    } catch {
      // The socket is already gone; that is the outcome we wanted.
    }
  }
}

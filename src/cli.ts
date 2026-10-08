#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { CachingArtworkProvider, type ArtworkProvider } from "./artwork/provider.js";
import { RpcPresenceSink, type PresenceSink } from "./discord/client.js";
import { CoalescingDispatcher } from "./discord/dispatcher.js";
import { createLogger, type Logger } from "./log.js";
import { DEFAULT_POLL_INTERVAL_MS, PresenceLoop } from "./loop.js";
import { AppleScriptMusicSource, NotAuthorizedError, type MusicSource } from "./music/source.js";
import type { Activity } from "./types.js";

/** How often to try restoring a dropped Discord connection. */
const RECONNECT_WATCHDOG_MS = 10_000;

/** Cap on how long shutdown waits for Discord before exiting anyway. */
const SHUTDOWN_TIMEOUT_MS = 2000;

/**
 * Is this module the process entry point?
 *
 * `package.json` exposes a `bin`, which npm and npx install as a SYMLINK, so
 * `argv[1]` is the link while `import.meta.url` is the realpath. Install paths
 * may also contain spaces, which a file URL percent-encodes. Comparing raw
 * strings fails both cases, and the symptom is the installed CLI exiting 0
 * having done nothing at all.
 */
export function isDirectRun(argvPath: string | undefined, moduleUrl: string): boolean {
  if (argvPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

/** Socket teardown is survivable for a daemon; a programming error is not. */
export function classifyRuntimeError(error: unknown): "continue" | "fatal" {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && ["EPIPE", "ECONNRESET", "ENOTCONN", "ECONNREFUSED", "EPROTO"].includes(code)) {
    return "continue";
  }
  return "fatal";
}

/** Resolve when `work` settles or `ms` elapses, whichever comes first. */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The @xhayper/discord-rpc IPC transport removes its own socket `error`
 * listener once connected, so an EPIPE on a half-open socket surfaces as an
 * uncaught exception and kills the daemon. FR6 forbids that.
 */
export function installCrashGuards(logger: Logger): void {
  const onError = (error: unknown): void => {
    if (classifyRuntimeError(error) === "continue") {
      logger.warn(`ignoring transport error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    logger.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  };
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
}

const MIN_POLL_INTERVAL_MS = 500;

export interface MainDeps {
  sink?: PresenceSink;
  source?: MusicSource;
  artwork?: ArtworkProvider;
}

export interface CliOptions {
  clientId: string;
  pollIntervalMs: number;
  once: boolean;
  help: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `apple-music-discord-presence

Mirror Apple Music's now-playing track into your Discord Rich Presence.

Options:
  --client-id <id>        Discord application ID (or set DISCORD_CLIENT_ID)
  --poll-interval <ms>    Poll interval, default ${DEFAULT_POLL_INTERVAL_MS}
  --once                  Poll and publish a single time, then exit
  --help                  Show this message
`;

export function parseOptions(
  argv: string[],
  env: Record<string, string | undefined>,
): CliOptions {
  let values: { "client-id"?: string; "poll-interval"?: string; once?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "client-id": { type: "string" },
        "poll-interval": { type: "string" },
        once: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  // --help is documented in USAGE, so it must short-circuit before the
  // client-id requirement and must never fall through into starting the daemon.
  if (values.help === true) {
    return { clientId: "", pollIntervalMs: DEFAULT_POLL_INTERVAL_MS, once: false, help: true };
  }

  const clientId = values["client-id"] ?? env.DISCORD_CLIENT_ID ?? "";
  if (clientId.trim() === "") {
    throw new UsageError(
      "A Discord application ID is required. Pass --client-id <id> or set DISCORD_CLIENT_ID. " +
        "Create an application at https://discord.com/developers/applications.",
    );
  }

  let pollIntervalMs = DEFAULT_POLL_INTERVAL_MS;
  const raw = values["poll-interval"];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new UsageError(`--poll-interval must be an integer number of milliseconds, got "${raw}"`);
    }
    if (parsed < MIN_POLL_INTERVAL_MS) {
      throw new UsageError(`--poll-interval must be at least ${MIN_POLL_INTERVAL_MS}ms`);
    }
    pollIntervalMs = parsed;
  }

  return { clientId, pollIntervalMs, once: values.once === true, help: false };
}

export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  deps: MainDeps = {},
): Promise<number> {
  const logger = createLogger("cli");

  let options: CliOptions;
  try {
    options = parseOptions(argv, env);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const sink: PresenceSink = deps.sink ?? new RpcPresenceSink({ clientId: options.clientId });

  let publishAttempted = false;
  let publishLanded = true;
  let loop: PresenceLoop;

  const dispatcher = new CoalescingDispatcher<Activity | null>(async (activity) => {
    const ok = activity === null ? await sink.clear() : await sink.set(activity);
    publishAttempted = true;
    publishLanded = ok;
    // A dropped write would otherwise never be retried: steady playback
    // produces no further updates, so re-offer current state next tick.
    if (!ok) loop.invalidate();
  });

  loop = new PresenceLoop({
    source: deps.source ?? new AppleScriptMusicSource(),
    artwork: deps.artwork ?? new CachingArtworkProvider(),
    submit: (activity) => dispatcher.submit(activity),
    pollIntervalMs: options.pollIntervalMs,
  });

  if (options.once) {
    try {
      await loop.tick();
      await dispatcher.flushNow();
    } catch (error) {
      if (error instanceof NotAuthorizedError) {
        logger.error(error.message);
        return 1;
      }
      throw error;
    } finally {
      dispatcher.stop();
      await sink.close();
    }
    // Nothing playing is not a failure; a publish that did not land is.
    return publishAttempted && !publishLanded ? 1 : 0;
  }

  installCrashGuards(logger);

  // Declared before the signal handlers so `shutdown` can never observe it
  // in its temporal dead zone.
  const watchdog = setInterval(() => {
    void sink.reconnectIfNeeded();
  }, RECONNECT_WATCHDOG_MS);
  watchdog.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      // They pressed it twice. Stop waiting on Discord and go.
      logger.warn(`received ${signal} again, exiting now`);
      process.exit(0);
    }
    shuttingDown = true;
    logger.info(`received ${signal}, clearing presence`);
    loop.stop();
    clearInterval(watchdog);
    dispatcher.stop();
    // Let an in-flight write finish before clearing, or it could land after
    // the clear and leave a stale presence behind. Bounded, because the RPC
    // library's own request timeout is 60s and a wedged Discord must not
    // hold the daemon hostage.
    await withTimeout(dispatcher.drain(), SHUTDOWN_TIMEOUT_MS);
    await withTimeout(sink.clear(), SHUTDOWN_TIMEOUT_MS);
    await withTimeout(sink.close(), SHUTDOWN_TIMEOUT_MS);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  logger.info(`polling Music.app every ${options.pollIntervalMs}ms`);
  loop.start();

  // Resolve only on signal; the interval keeps the process alive.
  await new Promise<void>(() => {});
  return 0;
}

if (isDirectRun(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}

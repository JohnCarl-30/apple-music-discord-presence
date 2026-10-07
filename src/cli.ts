#!/usr/bin/env node
import { parseArgs } from "node:util";
import { CachingArtworkProvider } from "./artwork/provider.js";
import { RpcPresenceSink, type PresenceSink } from "./discord/client.js";
import { CoalescingDispatcher } from "./discord/dispatcher.js";
import { createLogger } from "./log.js";
import { DEFAULT_POLL_INTERVAL_MS, PresenceLoop } from "./loop.js";
import { AppleScriptMusicSource, NotAuthorizedError } from "./music/source.js";
import type { Activity } from "./types.js";

const MIN_POLL_INTERVAL_MS = 500;

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

  const sink: PresenceSink = new RpcPresenceSink({ clientId: options.clientId });
  const dispatcher = new CoalescingDispatcher<Activity | null>(async (activity) => {
    if (activity === null) await sink.clear();
    else await sink.set(activity);
  });

  const loop = new PresenceLoop({
    source: new AppleScriptMusicSource(),
    artwork: new CachingArtworkProvider(),
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
    return 0;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`received ${signal}, clearing presence`);
    loop.stop();
    dispatcher.stop();
    await sink.clear();
    await sink.close();
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

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isDirectRun) {
  main(process.argv.slice(2), process.env)
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
}

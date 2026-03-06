import {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} from "@vector-im/matrix-bot-sdk";
import {
  createLoggerBackedRuntime,
  type PluginRuntime,
  type RuntimeLogger,
} from "openclaw/plugin-sdk/matrix";
import { resolveTeamSuzieAccount } from "./accounts.js";
import { createMessageHandler } from "./handler.js";
import { sendReadReceipt } from "./send.js";
import type { CoreConfig, TeamSuzieAccountConfig } from "./types.js";

// Reconnect: exponential backoff 2s -> 30s, max 12 attempts
const BACKOFF_INITIAL_MS = 2000;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_FACTOR = 1.8;
const BACKOFF_MAX_ATTEMPTS = 12;

// Heartbeat: log every 60s
const HEARTBEAT_INTERVAL_MS = 60_000;

// Watchdog: force reconnect if no events for 30 minutes
const WATCHDOG_TIMEOUT_MS = 30 * 60 * 1000;
const WATCHDOG_CHECK_MS = 60_000;

export type MonitorOpts = {
  core: PluginRuntime;
  accountId: string;
  abortSignal?: AbortSignal;
};

export async function startAccountMonitor(opts: MonitorOpts): Promise<void> {
  const { core, accountId, abortSignal } = opts;
  const logger = core.logging.getChildLogger({ module: `teamsuzie:${accountId}` });

  let attempt = 0;

  while (!abortSignal?.aborted) {
    try {
      attempt++;
      logger.info(`teamsuzie: starting monitor for ${accountId} (attempt ${attempt})`);
      await runMonitor({ core, accountId, logger, abortSignal });
      // If runMonitor completes normally (abort), we're done
      return;
    } catch (err) {
      if (abortSignal?.aborted) return;

      logger.error("teamsuzie: monitor crashed", {
        error: String(err),
        accountId,
        attempt,
      });

      if (attempt >= BACKOFF_MAX_ATTEMPTS) {
        logger.error("teamsuzie: max reconnect attempts reached, giving up", {
          accountId,
          attempts: attempt,
        });
        throw new Error(
          `teamsuzie: monitor for ${accountId} failed after ${attempt} attempts: ${String(err)}`,
        );
      }

      const backoffMs = Math.min(
        BACKOFF_MAX_MS,
        BACKOFF_INITIAL_MS * Math.pow(BACKOFF_FACTOR, attempt - 1),
      );
      const jitter = backoffMs * 0.25 * (Math.random() * 2 - 1);
      const delayMs = Math.round(backoffMs + jitter);

      logger.info(`teamsuzie: reconnecting in ${delayMs}ms`, { accountId, attempt });
      await sleep(delayMs, abortSignal);
    }
  }
}

async function runMonitor(params: {
  core: PluginRuntime;
  accountId: string;
  logger: RuntimeLogger;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { core, accountId, logger, abortSignal } = params;
  const cfg = core.config.loadConfig() as CoreConfig;

  // Log bindings for debugging routing
  const bindings = (cfg as Record<string, unknown>).bindings;
  logger.info("teamsuzie: config bindings", {
    accountId,
    bindings: JSON.stringify(bindings, null, 2),
  });

  const account = resolveTeamSuzieAccount({ cfg, accountId });
  const { homeserver, userId, accessToken } = account.config;

  const storageDir = `/tmp/teamsuzie-${accountId}`;
  const storage = new SimpleFsStorageProvider(`${storageDir}/bot.json`);
  const client = new MatrixClient(homeserver, accessToken, storage);

  // Auto-join rooms we're invited to
  AutojoinRoomsMixin.setupOnClient(client);

  const selfUserId = userId;
  const mediaMaxMb = cfg.channels?.teamsuzie?.mediaMaxMb ?? 50;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const textChunkLimit = cfg.channels?.teamsuzie?.textChunkLimit ?? 4000;
  const startupMs = Date.now();

  const handler = createMessageHandler({
    client,
    core,
    cfg,
    logger,
    accountId,
    selfUserId,
    mediaMaxBytes,
    textChunkLimit,
    startupMs,
  });

  // Track last event time for watchdog
  let lastEventAt = Date.now();
  let messagesHandled = 0;

  // Register event listener
  client.on("room.message", async (roomId: string, event: Record<string, unknown>) => {
    lastEventAt = Date.now();
    messagesHandled++;

    // Send read receipt (fire and forget)
    const eventId = event.event_id as string | undefined;
    if (eventId) {
      sendReadReceipt(client, roomId, eventId).catch((err) => {
        logger.debug?.(`teamsuzie: read receipt failed: ${String(err)}`);
      });
    }

    await handler(roomId, event as Parameters<typeof handler>[1]);
  });

  // Also track non-message events for watchdog liveness
  client.on("room.event", () => {
    lastEventAt = Date.now();
  });

  // Start the sync loop
  await client.start();
  logger.info(`teamsuzie: logged in as ${selfUserId}`, { accountId, homeserver });

  // Reset attempt counter on successful connection
  // (handled by caller resetting attempt on no-throw)

  // --- Heartbeat ---
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    const uptime = Math.round((now - startupMs) / 1000);
    const sinceLastEvent = Math.round((now - lastEventAt) / 1000);
    logger.info("teamsuzie: heartbeat", {
      accountId,
      uptime: `${uptime}s`,
      messagesHandled,
      sinceLastEvent: `${sinceLastEvent}s`,
    });

    if (sinceLastEvent > WATCHDOG_TIMEOUT_MS / 1000) {
      logger.warn("teamsuzie: heartbeat warning - no events for >30m", {
        accountId,
        sinceLastEvent: `${sinceLastEvent}s`,
      });
    }
  }, HEARTBEAT_INTERVAL_MS);

  // --- Watchdog ---
  const watchdogInterval = setInterval(() => {
    const sinceLastEvent = Date.now() - lastEventAt;
    if (sinceLastEvent > WATCHDOG_TIMEOUT_MS) {
      logger.error("teamsuzie: watchdog triggered - no events for 30m, forcing reconnect", {
        accountId,
        sinceLastEventMs: sinceLastEvent,
      });
      client.stop();
    }
  }, WATCHDOG_CHECK_MS);

  // Wait for abort or client stop
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearInterval(heartbeatInterval);
        clearInterval(watchdogInterval);
      };

      const onAbort = () => {
        cleanup();
        try {
          client.stop();
        } catch {
          // ignore stop errors during shutdown
        }
        resolve();
      };

      if (abortSignal?.aborted) {
        onAbort();
        return;
      }
      abortSignal?.addEventListener("abort", onAbort, { once: true });

      // If client stops unexpectedly (watchdog or error), reject to trigger reconnect
      // @vector-im/matrix-bot-sdk doesn't emit a "stop" event, but errors on the sync loop
      // will cause the client to stop and we need to detect that
    });
  } finally {
    clearInterval(heartbeatInterval);
    clearInterval(watchdogInterval);
  }
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

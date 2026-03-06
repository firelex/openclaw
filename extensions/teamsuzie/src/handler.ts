import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  logTypingFailure,
  type PluginRuntime,
  type RuntimeLogger,
} from "openclaw/plugin-sdk/matrix";
import { isDuplicate } from "./dedupe.js";
import { isSentEcho } from "./echo.js";
import { fetchRoomHistory, formatHistoryAsContext } from "./history.js";
import { downloadMedia } from "./media.js";
import { deliverReplies } from "./replies.js";
import { sendReaction, sendTyping } from "./send.js";
import type { CoreConfig } from "./types.js";

type RoomMessageEvent = {
  type?: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  unsigned?: { age?: number; redacted_because?: unknown };
  content?: Record<string, unknown>;
};

export type HandlerParams = {
  client: MatrixClient;
  core: PluginRuntime;
  cfg: CoreConfig;
  logger: RuntimeLogger;
  accountId: string;
  selfUserId: string;
  mediaMaxBytes: number;
  textChunkLimit: number;
  startupMs: number;
};

const STARTUP_GRACE_MS = 5000;

export function createMessageHandler(params: HandlerParams) {
  const {
    client,
    core,
    cfg,
    logger,
    accountId,
    selfUserId,
    mediaMaxBytes,
    textChunkLimit,
    startupMs,
  } = params;

  return async (roomId: string, event: RoomMessageEvent) => {
    try {
      await handleMessage(roomId, event);
    } catch (err) {
      logger.error("teamsuzie: handler failed", {
        error: String(err),
        roomId,
        eventId: event.event_id,
        accountId,
      });
    }
  };

  async function handleMessage(roomId: string, event: RoomMessageEvent) {
    // --- Filter invalid events ---
    const eventType = event.type;
    if (eventType !== "m.room.message") return;

    const eventId = event.event_id;
    if (!eventId) return;

    if (event.unsigned?.redacted_because) return;

    const senderId = event.sender;
    if (!senderId) return;
    if (senderId === selfUserId) return;

    // Skip edits
    const content = event.content;
    if (!content) return;
    const relatesTo = content["m.relates_to"] as Record<string, unknown> | undefined;
    if (relatesTo?.rel_type === "m.replace") return;

    // Skip old messages (startup grace)
    const eventTs = event.origin_server_ts;
    if (typeof eventTs === "number" && eventTs < startupMs - STARTUP_GRACE_MS) return;
    const eventAge = event.unsigned?.age;
    if (typeof eventTs !== "number" && typeof eventAge === "number" && eventAge > STARTUP_GRACE_MS)
      return;

    // --- Dedup & echo ---
    if (isDuplicate(eventId)) {
      logger.debug?.("teamsuzie: skipping duplicate event", { eventId, roomId });
      return;
    }
    if (isSentEcho(eventId)) {
      logger.debug?.("teamsuzie: skipping echo", { eventId, roomId });
      return;
    }

    logger.info("teamsuzie: inbound message", {
      roomId,
      eventId,
      senderId,
      accountId,
      msgtype: content.msgtype,
    });

    // --- Extract body & media ---
    const msgtype = content.msgtype as string | undefined;
    const rawBody = typeof content.body === "string" ? content.body.trim() : "";
    let media: { path: string; contentType?: string; placeholder: string } | null = null;

    const mediaUrl =
      (typeof content.url === "string" ? content.url : undefined) ??
      (content.file && typeof content.file === "object"
        ? ((content.file as Record<string, unknown>).url as string)
        : undefined);

    if (mediaUrl?.startsWith("mxc://")) {
      const contentInfo = content.info as Record<string, unknown> | undefined;
      try {
        media = await downloadMedia({
          client,
          core,
          mxcUrl: mediaUrl,
          contentType: contentInfo?.mimetype as string | undefined,
          sizeBytes: typeof contentInfo?.size === "number" ? contentInfo.size : undefined,
          maxBytes: mediaMaxBytes,
        });
      } catch (err) {
        logger.error("teamsuzie: media download failed", {
          error: String(err),
          mxcUrl: mediaUrl,
          roomId,
          eventId,
        });
      }
    }

    const bodyText = rawBody || media?.placeholder || "";
    if (!bodyText) return;

    // --- Routing: always DM, always main session ---
    const routeInput = {
      cfg,
      channel: "teamsuzie",
      accountId,
      peer: { kind: "direct" as const, id: senderId },
    };
    const route = core.channel.routing.resolveAgentRoute(routeInput);

    logger.info("teamsuzie: route resolved", {
      accountId,
      senderId,
      roomId,
      resolvedAgentId: route.agentId,
      sessionKey: route.sessionKey,
      mainSessionKey: route.mainSessionKey,
      matchedBy: route.matchedBy,
      routeAccountId: route.accountId,
    });

    const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
      agentId: route.agentId,
    });

    // --- History injection (P1): on first message of new session ---
    let threadStarterBody: string | undefined;
    const existingSession = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    if (existingSession === undefined) {
      try {
        const historyLimit =
          cfg.channels?.teamsuzie?.dmHistoryLimit ?? cfg.channels?.teamsuzie?.historyLimit ?? 20;
        const history = await fetchRoomHistory({
          client,
          roomId,
          selfUserId,
          limit: historyLimit,
          logger,
        });
        if (history.length > 0) {
          threadStarterBody = formatHistoryAsContext(history, core, cfg);
          logger.info("teamsuzie: injected history context", {
            messageCount: history.length,
            roomId,
            accountId,
          });
        }
      } catch (err) {
        logger.error("teamsuzie: history fetch failed", {
          error: String(err),
          roomId,
          accountId,
        });
      }
    }

    // --- Build context ---
    const senderName = await client
      .getUserProfile(senderId)
      .then((p) => p?.displayname || senderId)
      .catch(() => senderId);

    const previousTimestamp = core.channel.session.readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
    const body = core.channel.reply.formatInboundEnvelope({
      channel: "Matrix",
      from: senderName,
      timestamp: eventTs ?? undefined,
      previousTimestamp,
      envelope: envelopeOptions,
      body: `${bodyText}\n[matrix event id: ${eventId} room: ${roomId}]`,
      chatType: "direct",
      senderLabel: senderName,
    });

    const ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: body,
      BodyForAgent: bodyText,
      RawBody: bodyText,
      CommandBody: bodyText,
      From: `matrix:${senderId}`,
      To: `room:${roomId}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: "direct" as const,
      ConversationLabel: senderName,
      SenderName: senderName,
      SenderId: senderId,
      SenderUsername: senderId.replace(/@([^:]+):.*/, "$1"),
      Provider: "matrix" as const,
      Surface: "matrix" as const,
      MessageSid: eventId,
      Timestamp: eventTs ?? undefined,
      MediaPath: media?.path,
      MediaType: media?.contentType,
      MediaUrl: media?.path,
      CommandAuthorized: true,
      CommandSource: "text" as const,
      OriginatingChannel: "matrix" as const,
      OriginatingTo: `room:${roomId}`,
      ThreadStarterBody: threadStarterBody,
    });

    // --- Record session (always target mainSessionKey for /new routing) ---
    await core.channel.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      updateLastRoute: {
        sessionKey: route.mainSessionKey,
        channel: "teamsuzie",
        to: `room:${roomId}`,
        accountId: route.accountId,
      },
      onRecordError: (err) => {
        logger.warn("teamsuzie: session record failed", {
          error: String(err),
          sessionKey: route.sessionKey,
          storePath,
        });
      },
    });

    // --- Ack reaction ---
    const ackReaction = cfg.channels?.teamsuzie?.accounts?.[accountId]?.ackReaction?.trim();
    if (ackReaction) {
      sendReaction(client, roomId, eventId, ackReaction).catch((err) => {
        logger.warn("teamsuzie: ack reaction failed", {
          error: String(err),
          roomId,
          eventId,
        });
      });
    }

    // --- Dispatch reply ---
    const replyTarget = ctxPayload.To;
    if (!replyTarget) {
      throw new Error(`teamsuzie: missing reply target for event ${eventId} in room ${roomId}`);
    }

    let didSendReply = false;
    const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
      cfg,
      agentId: route.agentId,
      channel: "teamsuzie",
      accountId: route.accountId,
    });
    const typingCallbacks = createTypingCallbacks({
      start: () => sendTyping(client, roomId, true),
      stop: () => sendTyping(client, roomId, false),
      onStartError: (err) => {
        logTypingFailure({
          log: (msg) => logger.debug?.(msg),
          channel: "teamsuzie",
          action: "start",
          target: roomId,
          error: err,
        });
      },
      onStopError: (err) => {
        logTypingFailure({
          log: (msg) => logger.debug?.(msg),
          channel: "teamsuzie",
          action: "stop",
          target: roomId,
          error: err,
        });
      },
    });

    const { dispatcher, replyOptions, markDispatchIdle } =
      core.channel.reply.createReplyDispatcherWithTyping({
        ...prefixOptions,
        humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
        typingCallbacks,
        deliver: async (payload) => {
          await deliverReplies({
            replies: [payload],
            roomId,
            client,
            core,
            textChunkLimit,
            accountId: route.accountId,
          });
          didSendReply = true;
        },
        onError: (err, info) => {
          logger.error(`teamsuzie: ${info.kind} reply failed`, {
            error: String(err),
            roomId,
            accountId,
          });
        },
      });

    const { queuedFinal } = await core.channel.reply.withReplyDispatcher({
      dispatcher,
      onSettled: () => markDispatchIdle(),
      run: () =>
        core.channel.reply.dispatchReplyFromConfig({
          ctx: ctxPayload,
          cfg,
          dispatcher,
          replyOptions: { ...replyOptions, onModelSelected },
        }),
    });

    if (queuedFinal) {
      didSendReply = true;
    }

    if (didSendReply) {
      const previewText = bodyText.replace(/\s+/g, " ").slice(0, 160);
      core.system.enqueueSystemEvent(`TeamSuzie message from ${senderName}: ${previewText}`, {
        sessionKey: route.sessionKey,
        contextKey: `teamsuzie:message:${roomId}:${eventId}`,
      });
    }
  }
}

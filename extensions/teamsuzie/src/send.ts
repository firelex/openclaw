import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import { rememberSentEvent } from "./echo.js";

// --- Outbound content dedup ---
// When /hooks/agent creates an orphan session alongside the main session,
// the same agent response gets delivered twice through our outbound adapter.
// Both are genuine sends with different Matrix event IDs, so echo detection
// can't catch them. This dedupes on (roomId + content snippet) with a short TTL.
const SEND_DEDUP_TTL_MS = 15_000;
const SEND_DEDUP_MAX = 200;
const sendCache = new Map<string, number>();

function isSendDuplicate(roomId: string, content: string): boolean {
  const now = Date.now();
  // Prune expired
  for (const [k, ts] of sendCache) {
    if (ts < now - SEND_DEDUP_TTL_MS) sendCache.delete(k);
    else break;
  }
  const key = `${roomId}\0${content.slice(0, 300)}`;
  if (sendCache.has(key)) return true;
  if (sendCache.size >= SEND_DEDUP_MAX) {
    sendCache.delete(sendCache.keys().next().value!);
  }
  sendCache.set(key, now);
  return false;
}

export async function sendMessage(
  client: MatrixClient,
  roomId: string,
  text: string,
  replyToId?: string,
): Promise<string> {
  if (isSendDuplicate(roomId, text)) {
    return "dedup-skipped";
  }
  const content: Record<string, unknown> = {
    msgtype: "m.text",
    body: text,
  };
  if (replyToId) {
    content["m.relates_to"] = {
      "m.in_reply_to": { event_id: replyToId },
    };
  }
  const eventId: string = await client.sendMessage(roomId, content);
  rememberSentEvent(eventId);
  return eventId;
}

export async function sendMedia(
  client: MatrixClient,
  roomId: string,
  mediaBuffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
    caption?: string;
  },
): Promise<string> {
  const dedupKey = `media:${params.filename ?? ""}:${mediaBuffer.byteLength}`;
  if (isSendDuplicate(roomId, dedupKey)) {
    return "dedup-skipped";
  }
  const mxcUrl = await client.uploadContent(
    mediaBuffer,
    params.contentType ?? "application/octet-stream",
    params.filename,
  );
  const msgtype = resolveMsgType(params.contentType);
  const content: Record<string, unknown> = {
    msgtype,
    body: params.caption || params.filename || "(file)",
    url: mxcUrl,
    info: {
      mimetype: params.contentType,
      size: mediaBuffer.byteLength,
    },
  };
  const eventId: string = await client.sendMessage(roomId, content);
  rememberSentEvent(eventId);
  return eventId;
}

export async function sendReaction(
  client: MatrixClient,
  roomId: string,
  eventId: string,
  emoji: string,
): Promise<void> {
  await client.sendEvent(roomId, "m.reaction", {
    "m.relates_to": {
      rel_type: "m.annotation",
      event_id: eventId,
      key: emoji,
    },
  });
}

export async function sendTyping(
  client: MatrixClient,
  roomId: string,
  typing: boolean,
  timeoutMs = 30_000,
): Promise<void> {
  await client.setTyping(roomId, typing, timeoutMs);
}

export async function sendReadReceipt(
  client: MatrixClient,
  roomId: string,
  eventId: string,
): Promise<void> {
  await client.sendReadReceipt(roomId, eventId);
}

function resolveMsgType(contentType?: string): string {
  if (!contentType) return "m.file";
  if (contentType.startsWith("image/")) return "m.image";
  if (contentType.startsWith("video/")) return "m.video";
  if (contentType.startsWith("audio/")) return "m.audio";
  return "m.file";
}

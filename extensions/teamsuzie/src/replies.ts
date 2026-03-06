import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, ReplyPayload } from "openclaw/plugin-sdk/matrix";
import { sendMessage } from "./send.js";

const DEFAULT_CHUNK_LIMIT = 4000;
const TOKEN_HEARTBEAT_OK = /(?:\[\s*)?\bHEARTBEAT_OK\b(?:\s*\])?/gi;
const TOKEN_NO_REPLY = /(?:\[\s*)?\bNO_REPLY\b(?:\s*\])?/gi;

function sanitizeOutgoingText(raw: string): string {
  if (!raw) return "";
  return raw
    .replace(TOKEN_HEARTBEAT_OK, "")
    .replace(TOKEN_NO_REPLY, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function deliverReplies(params: {
  replies: ReplyPayload[];
  roomId: string;
  client: MatrixClient;
  core: PluginRuntime;
  textChunkLimit?: number;
  accountId?: string;
}): Promise<void> {
  const { replies, roomId, client, core } = params;
  const cfg = core.config.loadConfig();
  const chunkLimit = params.textChunkLimit ?? DEFAULT_CHUNK_LIMIT;
  const chunkMode = core.channel.text.resolveChunkMode(cfg, "teamsuzie", params.accountId);
  const tableMode = core.channel.text.resolveMarkdownTableMode({
    cfg,
    channel: "teamsuzie",
    accountId: params.accountId,
  });

  for (const reply of replies) {
    const hasMedia = Boolean(reply?.mediaUrl) || (reply?.mediaUrls?.length ?? 0) > 0;
    if (!reply?.text && !hasMedia) {
      continue;
    }

    const rawText = reply.text ?? "";
    const convertedText = core.channel.text.convertMarkdownTables(rawText, tableMode);
    const text = sanitizeOutgoingText(convertedText);

    const mediaList = reply.mediaUrls?.length
      ? reply.mediaUrls
      : reply.mediaUrl
        ? [reply.mediaUrl]
        : [];

    if (mediaList.length === 0) {
      if (!text) {
        continue;
      }
      const chunks = core.channel.text.chunkMarkdownTextWithMode(text, chunkLimit, chunkMode);
      for (const chunk of chunks) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        await sendMessage(client, roomId, trimmed);
      }
      continue;
    }

    // Media replies: send first media with caption, rest without
    let first = true;
    for (const mediaUrl of mediaList) {
      const maxBytes =
        (params.core.config.loadConfig().channels?.teamsuzie?.mediaMaxMb ?? 50) * 1024 * 1024;
      const media = await core.media.loadWebMedia(mediaUrl, maxBytes);
      const mxcUrl = await client.uploadContent(
        media.buffer,
        media.contentType ?? "application/octet-stream",
        media.fileName,
      );
      const msgtype = media.contentType?.startsWith("image/")
        ? "m.image"
        : media.contentType?.startsWith("video/")
          ? "m.video"
          : media.contentType?.startsWith("audio/")
            ? "m.audio"
            : "m.file";
      const fileName = media.fileName || "(file)";
      const content: Record<string, unknown> = {
        msgtype,
        body: fileName,
        filename: fileName,
        url: mxcUrl,
        info: {
          mimetype: media.contentType,
          size: media.buffer.byteLength,
        },
      };
      await client.sendMessage(roomId, content);
      if (first && text) {
        await sendMessage(client, roomId, text);
      }
      first = false;
    }
  }
}

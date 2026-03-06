import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/matrix";

const DEFAULT_HISTORY_LIMIT = 20;

type HistoryMessage = {
  sender: string;
  body: string;
  timestamp: number;
};

export async function fetchRoomHistory(params: {
  client: MatrixClient;
  roomId: string;
  selfUserId: string;
  limit?: number;
  logger: RuntimeLogger;
}): Promise<HistoryMessage[]> {
  const limit = params.limit ?? DEFAULT_HISTORY_LIMIT;
  const { client, roomId, selfUserId, logger } = params;

  // Use the Matrix client API to fetch recent messages
  // @vector-im/matrix-bot-sdk provides roomState and event fetching
  const events = await client.doRequest(
    "GET",
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
    { dir: "b", limit: String(limit), filter: JSON.stringify({ types: ["m.room.message"] }) },
  );

  const messages: HistoryMessage[] = [];
  const chunk = events?.chunk;
  if (!Array.isArray(chunk)) {
    logger.warn("teamsuzie: history fetch returned no chunk", { roomId });
    return [];
  }

  for (const event of chunk) {
    if (event.type !== "m.room.message") continue;
    const content = event.content;
    if (!content?.body || typeof content.body !== "string") continue;
    if (content["m.relates_to"]?.rel_type === "m.replace") continue;

    messages.push({
      sender: event.sender === selfUserId ? "assistant" : "user",
      body: content.body.trim(),
      timestamp: event.origin_server_ts ?? 0,
    });
  }

  // Reverse to chronological order (API returns newest first with dir=b)
  messages.reverse();
  return messages;
}

export function formatHistoryAsContext(
  messages: HistoryMessage[],
  core: PluginRuntime,
  cfg: unknown,
): string {
  if (messages.length === 0) return "";

  const lines: string[] = [];
  lines.push("[Previous conversation history]");
  for (const msg of messages) {
    const role = msg.sender === "assistant" ? "You" : "User";
    lines.push(`${role}: ${msg.body}`);
  }
  lines.push("[End of history]");

  return lines.join("\n");
}

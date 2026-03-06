import type { ChannelPlugin, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { emptyPluginConfigSchema, buildChannelConfigSchema } from "openclaw/plugin-sdk/matrix";
import {
  listTeamSuzieAccountIds,
  resolveTeamSuzieAccount,
  type ResolvedTeamSuzieAccount,
} from "./src/accounts.js";
import { TeamSuzieConfigSchema } from "./src/config-schema.js";
import { startAccountMonitor } from "./src/monitor.js";
import { deliverReplies } from "./src/replies.js";
import { sendMessage } from "./src/send.js";
import type { CoreConfig } from "./src/types.js";

let runtime: PluginRuntime | null = null;

function getRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("teamsuzie: plugin runtime not initialized");
  }
  return runtime;
}

function normalizeTeamSuzieMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("teamsuzie:")) {
    normalized = normalized.slice("teamsuzie:".length).trim();
  }
  if (lowered.startsWith("matrix:")) {
    normalized = normalized.slice("matrix:".length).trim();
  }
  const stripped = normalized.replace(/^(room|channel|user):/i, "").trim();
  return stripped || undefined;
}

const teamsuziePlugin: ChannelPlugin<ResolvedTeamSuzieAccount> = {
  id: "teamsuzie",
  meta: {
    label: "TeamSuzie",
    order: 71,
  },
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    reactions: true,
    polls: false,
    threads: false,
  },
  reload: { configPrefixes: ["channels.teamsuzie"] },
  configSchema: buildChannelConfigSchema(TeamSuzieConfigSchema),

  config: {
    listAccountIds: (cfg) => listTeamSuzieAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) =>
      resolveTeamSuzieAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => {
      const ids = listTeamSuzieAccountIds(cfg as CoreConfig);
      return ids[0] ?? "default";
    },
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.config.homeserver,
    }),
  },

  messaging: {
    normalizeTarget: normalizeTeamSuzieMessagingTarget,
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^(teamsuzie:|matrix:)?[!#@]/i.test(trimmed)) {
          return true;
        }
        const lowered = trimmed.toLowerCase();
        if (
          lowered.startsWith("room:") ||
          lowered.startsWith("channel:") ||
          lowered.startsWith("user:")
        ) {
          return true;
        }
        return trimmed.includes(":");
      },
      hint: "<room|alias|user>",
    },
  },

  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getRuntime().channel.text.chunkMarkdownText(text, limit),
    chunkerMode: "markdown",
    textChunkLimit: 4000,

    sendText: async ({ cfg, to, text, accountId }) => {
      const core = getRuntime();
      const config = cfg as CoreConfig;
      const resolvedAccountId = accountId ?? listTeamSuzieAccountIds(config)[0];
      if (!resolvedAccountId) {
        throw new Error("teamsuzie: no account available for sendText");
      }
      // For outbound we'd need a running client; this path is used by /new and webchat routing
      // The gateway handles the actual Matrix client lifecycle
      // Use the HTTP API directly for outbound-only sends
      const account = resolveTeamSuzieAccount({ cfg: config, accountId: resolvedAccountId });
      const { MatrixClient, SimpleFsStorageProvider } = await import("@vector-im/matrix-bot-sdk");
      const storage = new SimpleFsStorageProvider(
        `/tmp/teamsuzie-outbound-${resolvedAccountId}.json`,
      );
      const client = new MatrixClient(
        account.config.homeserver,
        account.config.accessToken,
        storage,
      );
      const roomId = to.replace(/^room:/, "");
      const eventId = await sendMessage(client, roomId, text);
      return { channel: "teamsuzie", messageId: eventId, roomId: "room:" + roomId };
    },

    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const core = getRuntime();
      const config = cfg as CoreConfig;
      const resolvedAccountId = accountId ?? listTeamSuzieAccountIds(config)[0];
      if (!resolvedAccountId) {
        throw new Error("teamsuzie: no account available for sendMedia");
      }
      const account = resolveTeamSuzieAccount({ cfg: config, accountId: resolvedAccountId });
      const { MatrixClient, SimpleFsStorageProvider } = await import("@vector-im/matrix-bot-sdk");
      const storage = new SimpleFsStorageProvider(
        `/tmp/teamsuzie-outbound-${resolvedAccountId}.json`,
      );
      const client = new MatrixClient(
        account.config.homeserver,
        account.config.accessToken,
        storage,
      );
      const roomId = to.replace(/^room:/, "");
      if (mediaUrl) {
        const maxBytes = (config.channels?.teamsuzie?.mediaMaxMb ?? 50) * 1024 * 1024;
        const media = await core.media.loadWebMedia(mediaUrl, maxBytes);
        const mxcUrl = await client.uploadContent(
          media.buffer,
          media.contentType ?? "application/octet-stream",
          media.fileName,
        );
        const msgtype = media.contentType?.startsWith("image/") ? "m.image" : "m.file";
        const fileName = media.fileName || "(file)";
        await client.sendMessage(roomId, {
          msgtype,
          body: fileName,
          filename: fileName,
          url: mxcUrl,
          info: { mimetype: media.contentType, size: media.buffer.byteLength },
        });
        if (text?.trim()) {
          await sendMessage(client, roomId, text.trim());
        }
      } else if (text) {
        await sendMessage(client, roomId, text);
      }
      return { channel: "teamsuzie", messageId: "outbound", roomId: "room:" + roomId };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const core = getRuntime();
      const account = ctx.account as ResolvedTeamSuzieAccount;
      if (!account.enabled) {
        core.logging
          .getChildLogger({ module: "teamsuzie" })
          .info(`teamsuzie: account ${account.accountId} is disabled, skipping`);
        return;
      }
      await startAccountMonitor({
        core,
        accountId: account.accountId,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};

const plugin = {
  id: "teamsuzie",
  name: "TeamSuzie",
  description: "TeamSuzie Matrix DM channel plugin (1:1 rooms only)",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    runtime = api.runtime;
    api.registerChannel({ plugin: teamsuziePlugin });
  },
};

export default plugin;

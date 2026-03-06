import type { OpenClawConfig } from "openclaw/plugin-sdk/matrix";

export type TeamSuzieAccountConfig = {
  enabled?: boolean;
  homeserver?: string;
  userId?: string;
  accessToken?: string;
  ackReaction?: string;
};

export type TeamSuzieConfig = {
  enabled?: boolean;
  homeserver?: string;
  historyLimit?: number;
  dmHistoryLimit?: number;
  mediaMaxMb?: number;
  textChunkLimit?: number;
  accounts: Record<string, TeamSuzieAccountConfig>;
};

export type CoreConfig = OpenClawConfig & {
  channels?: {
    teamsuzie?: TeamSuzieConfig;
  };
};

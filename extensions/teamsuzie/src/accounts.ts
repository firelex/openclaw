import type { CoreConfig, TeamSuzieAccountConfig } from "./types.js";

export type ResolvedTeamSuzieAccount = {
  accountId: string;
  config: TeamSuzieAccountConfig;
  configured: boolean;
  enabled: boolean;
};

export function listTeamSuzieAccountIds(cfg: CoreConfig): string[] {
  const accounts = cfg.channels?.teamsuzie?.accounts;
  if (!accounts) {
    return [];
  }
  return Object.keys(accounts);
}

export function resolveTeamSuzieAccount(params: {
  cfg: CoreConfig;
  accountId: string;
}): ResolvedTeamSuzieAccount {
  const accounts = params.cfg.channels?.teamsuzie?.accounts;
  if (!accounts) {
    throw new Error(`teamsuzie: no accounts configured`);
  }
  const config = accounts[params.accountId];
  if (!config) {
    throw new Error(
      `teamsuzie: account "${params.accountId}" not found. Available: ${Object.keys(accounts).join(", ")}`,
    );
  }
  const enabled = config.enabled !== false;
  const configured = Boolean(config.homeserver && config.userId && config.accessToken);
  if (enabled && !configured) {
    throw new Error(
      `teamsuzie: account "${params.accountId}" is enabled but missing required fields (homeserver, userId, accessToken)`,
    );
  }
  return {
    accountId: params.accountId,
    config,
    configured,
    enabled,
  };
}

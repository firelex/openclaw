import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveAgentIdFromSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { normalizeAccountId } from "../../utils/account-id.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";

function normalizeTargetKey(value?: string): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/^(room|channel|group|chat):/i, "");
}

function collectEntryAccountCandidates(entry: {
  deliveryContext?: { accountId?: string | null };
  lastAccountId?: string | null;
  origin?: { accountId?: string | null };
}): string[] {
  const candidates = [
    entry.deliveryContext?.accountId,
    entry.lastAccountId,
    entry.origin?.accountId,
  ];
  const resolved: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeAccountId(candidate ?? undefined);
    if (normalized) {
      resolved.push(normalized);
    }
  }
  return resolved;
}

export function resolveSessionStoredAccountId(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  channel?: string;
}): string | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const entry = store[sessionKey];
  if (!entry) {
    return undefined;
  }

  const expectedChannel = normalizeMessageChannel(params.channel);
  const entryChannel = normalizeMessageChannel(
    entry.deliveryContext?.channel ?? entry.lastChannel ?? entry.channel ?? entry.origin?.provider,
  );
  if (expectedChannel && entryChannel && expectedChannel !== entryChannel) {
    return undefined;
  }

  const candidates = collectEntryAccountCandidates(entry);
  for (const candidate of candidates) {
    return candidate;
  }
  return undefined;
}

export function resolveSessionStoredAccountIdByTarget(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  channel?: string;
  target?: string;
}): string | undefined {
  const expectedChannel = normalizeMessageChannel(params.channel);
  const targetKey = normalizeTargetKey(params.target);
  if (!expectedChannel || !targetKey) {
    return undefined;
  }

  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  const store = loadSessionStore(storePath);
  const matchedAccounts = new Set<string>();

  for (const entry of Object.values(store)) {
    const entryChannel = normalizeMessageChannel(
      entry.deliveryContext?.channel ??
        entry.lastChannel ??
        entry.channel ??
        entry.origin?.provider,
    );
    if (!entryChannel || entryChannel !== expectedChannel) {
      continue;
    }
    const entryTargets = [
      normalizeTargetKey(entry.deliveryContext?.to),
      normalizeTargetKey(entry.lastTo),
      normalizeTargetKey(entry.origin?.to),
      normalizeTargetKey(entry.groupId),
    ];
    if (!entryTargets.some((candidate) => candidate === targetKey)) {
      continue;
    }
    const candidates = collectEntryAccountCandidates(entry);
    for (const candidate of candidates) {
      matchedAccounts.add(candidate);
    }
  }

  if (matchedAccounts.size !== 1) {
    return undefined;
  }
  return Array.from(matchedAccounts)[0];
}

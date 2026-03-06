import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import {
  resolveSessionStoredAccountId,
  resolveSessionStoredAccountIdByTarget,
} from "./session-account-fallback.js";

const mocks = vi.hoisted(() => ({
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
  loadSessionStore: vi.fn(() => ({})),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveStorePath: mocks.resolveStorePath,
  loadSessionStore: mocks.loadSessionStore,
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
}));

describe("resolveSessionStoredAccountId", () => {
  it("returns deliveryContext.accountId first", () => {
    mocks.loadSessionStore.mockReturnValueOnce({
      "agent:suzie-nice:main": {
        deliveryContext: { channel: "matrix", accountId: "suzie-nice" },
        lastAccountId: "wrong",
      } satisfies Partial<SessionEntry>,
    });

    const accountId = resolveSessionStoredAccountId({
      cfg: {} as never,
      sessionKey: "agent:suzie-nice:main",
      channel: "matrix",
    });

    expect(accountId).toBe("suzie-nice");
  });

  it("uses lastAccountId when deliveryContext.accountId is missing", () => {
    mocks.loadSessionStore.mockReturnValueOnce({
      "agent:suzie-nice:main": {
        deliveryContext: { channel: "matrix" },
        lastAccountId: "suzie-nice",
      } satisfies Partial<SessionEntry>,
    });

    const accountId = resolveSessionStoredAccountId({
      cfg: {} as never,
      sessionKey: "agent:suzie-nice:main",
      channel: "matrix",
    });

    expect(accountId).toBe("suzie-nice");
  });

  it("returns undefined when requested channel and session channel conflict", () => {
    mocks.loadSessionStore.mockReturnValueOnce({
      "agent:suzie-nice:main": {
        deliveryContext: { channel: "matrix", accountId: "suzie-nice" },
      } satisfies Partial<SessionEntry>,
    });

    const accountId = resolveSessionStoredAccountId({
      cfg: {} as never,
      sessionKey: "agent:suzie-nice:main",
      channel: "telegram",
    });

    expect(accountId).toBeUndefined();
  });
});

describe("resolveSessionStoredAccountIdByTarget", () => {
  it("returns the unique account id matching channel+target", () => {
    mocks.loadSessionStore.mockReturnValueOnce({
      "agent:suzie-nice:main": {
        deliveryContext: {
          channel: "matrix",
          to: "room:!itQiSmhzzwdOFleDjL:teamsuzie.local",
          accountId: "suzie-nice",
        },
      } satisfies Partial<SessionEntry>,
      "agent:mike-lawley:main": {
        deliveryContext: {
          channel: "matrix",
          to: "room:!other:teamsuzie.local",
          accountId: "mike-lawley",
        },
      } satisfies Partial<SessionEntry>,
    });

    const accountId = resolveSessionStoredAccountIdByTarget({
      cfg: {} as never,
      sessionKey: "agent:suzie-nice:main",
      channel: "matrix",
      target: "room:!itQiSmhzzwdOFleDjL:teamsuzie.local",
    });

    expect(accountId).toBe("suzie-nice");
  });

  it("returns undefined when multiple account ids match the same channel+target", () => {
    mocks.loadSessionStore.mockReturnValueOnce({
      "agent:suzie-nice:main": {
        deliveryContext: {
          channel: "matrix",
          to: "room:!itQiSmhzzwdOFleDjL:teamsuzie.local",
          accountId: "suzie-nice",
        },
      } satisfies Partial<SessionEntry>,
      "agent:mike-lawley:main": {
        deliveryContext: {
          channel: "matrix",
          to: "room:!itQiSmhzzwdOFleDjL:teamsuzie.local",
          accountId: "mike-lawley",
        },
      } satisfies Partial<SessionEntry>,
    });

    const accountId = resolveSessionStoredAccountIdByTarget({
      cfg: {} as never,
      sessionKey: "agent:suzie-nice:main",
      channel: "matrix",
      target: "room:!itQiSmhzzwdOFleDjL:teamsuzie.local",
    });

    expect(accountId).toBeUndefined();
  });
});

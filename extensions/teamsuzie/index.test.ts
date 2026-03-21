import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../test-utils/start-account-context.js";
import type { ResolvedTeamSuzieAccount } from "./src/accounts.js";

const hoisted = vi.hoisted(() => ({
  startAccountMonitor: vi.fn(),
}));

vi.mock("./src/monitor.js", () => ({
  startAccountMonitor: hoisted.startAccountMonitor,
}));

import plugin from "./index.js";

function buildAccount(overrides: Partial<ResolvedTeamSuzieAccount> = {}): ResolvedTeamSuzieAccount {
  return {
    accountId: "jake-mercer",
    enabled: true,
    configured: true,
    config: {
      enabled: true,
      homeserver: "http://matrix.example.test",
      userId: "@jake:example.test",
      accessToken: "token",
    },
    ...overrides,
  };
}

describe("teamsuzie gateway.startAccount", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("passes the gateway status sink into the monitor", async () => {
    const registerChannel = vi.fn();
    plugin.register({
      runtime: {
        logging: {
          getChildLogger: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
          }),
        },
      },
      registerChannel,
    } as never);

    const channel = registerChannel.mock.calls[0]?.[0]?.plugin;
    expect(channel?.gateway?.startAccount).toBeTypeOf("function");

    const abort = new AbortController();
    const statusPatchSink = vi.fn();
    const ctx = createStartAccountContext({
      account: buildAccount(),
      abortSignal: abort.signal,
      statusPatchSink,
    });

    await channel.gateway.startAccount(ctx);

    expect(hoisted.startAccountMonitor).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "jake-mercer",
        abortSignal: abort.signal,
        setStatus: ctx.setStatus,
      }),
    );
  });
});

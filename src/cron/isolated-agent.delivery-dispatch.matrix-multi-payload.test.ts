import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { deliverOutboundPayloads } from "../infra/outbound/deliver.js";
import { dispatchCronDelivery } from "./isolated-agent/delivery-dispatch.js";

vi.mock("../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn().mockResolvedValue(true),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: vi.fn().mockResolvedValue([{ channel: "matrix", messageId: "mx-1" }]),
}));

vi.mock("../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue(undefined),
}));

describe("dispatchCronDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses direct delivery for matrix when multiple payloads are present", async () => {
    const result = await dispatchCronDelivery({
      cfg: {} as never,
      cfgWithAgentDefaults: {} as never,
      deps: {} as never,
      job: {
        id: "job-1",
        name: "job-1",
        payload: { kind: "agentTurn", message: "run" },
      } as never,
      agentId: "main",
      agentSessionKey: "agent:main:cron:job-1",
      runSessionId: "run-1",
      runStartedAt: Date.now(),
      runEndedAt: Date.now(),
      timeoutMs: 5_000,
      resolvedDelivery: {
        ok: true,
        mode: "explicit",
        channel: "matrix",
        to: "room:!abc:test.local",
        accountId: "main",
      } as never,
      deliveryRequested: true,
      skipHeartbeatDelivery: false,
      skipMessagingToolDelivery: false,
      deliveryBestEffort: false,
      deliveryPayloadHasStructuredContent: false,
      deliveryPayloads: [{ text: "first bubble" }, { text: "second bubble" }],
      synthesizedText: "second bubble",
      summary: "second bubble",
      outputText: "second bubble",
      telemetry: {},
      isAborted: () => false,
      abortReason: () => "aborted",
      withRunSession: (state) => ({ ...state, sessionId: "s", sessionKey: "k" }) as never,
    });

    expect(result.delivered).toBe(true);
    expect(deliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "matrix",
        payloads: [{ text: "first bubble" }, { text: "second bubble" }],
      }),
    );
    expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
  });
});

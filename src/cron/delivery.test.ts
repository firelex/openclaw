import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan } from "./delivery.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  };
}

describe("resolveCronDeliveryPlan", () => {
  it("defaults to announce when delivery object has no mode", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { channel: "telegram", to: "123", mode: undefined as never },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
  });

  it("respects legacy payload deliver=false", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: undefined,
        payload: { kind: "agentTurn", message: "hello", deliver: false },
      }),
    );
    expect(plan.mode).toBe("none");
    expect(plan.requested).toBe(false);
  });

  it("resolves webhook mode without channel routing", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      }),
    );
    expect(plan.mode).toBe("webhook");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("https://example.invalid/cron");
  });

  it("derives accountId from job.agentId for payload-sourced plans", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        agentId: "mike-lawley",
        delivery: undefined,
        payload: {
          kind: "agentTurn",
          message: "hello",
          deliver: true,
          channel: "matrix",
          to: "room:!abc:example.com",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.source).toBe("payload");
    expect(plan.accountId).toBe("mike-lawley");
  });

  it("does not set accountId when job has no agentId (payload source)", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        agentId: undefined,
        delivery: undefined,
        payload: {
          kind: "agentTurn",
          message: "hello",
          deliver: true,
          channel: "matrix",
          to: "room:!abc:example.com",
        },
      }),
    );
    expect(plan.source).toBe("payload");
    expect(plan.accountId).toBeUndefined();
  });

  it("threads delivery.accountId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          accountId: " bot-a ",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
    expect(plan.accountId).toBe("bot-a");
  });
});

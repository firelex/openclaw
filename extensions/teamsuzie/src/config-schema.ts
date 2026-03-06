import { z } from "zod";

const accountSchema = z.object({
  enabled: z.boolean().optional(),
  homeserver: z.string(),
  userId: z.string(),
  accessToken: z.string(),
  ackReaction: z.string().optional(),
});

export const TeamSuzieConfigSchema = z.object({
  enabled: z.boolean().optional(),
  homeserver: z.string().optional(),
  historyLimit: z.number().optional(),
  dmHistoryLimit: z.number().optional(),
  mediaMaxMb: z.number().optional(),
  textChunkLimit: z.number().optional(),
  accounts: z.record(z.string(), accountSchema),
});

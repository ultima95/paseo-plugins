import { z } from "zod";

export const MAX_TEXT_LENGTH = 10_000;
export const MAX_HORIZON_MS = 30 * 24 * 60 * 60 * 1000;
export const PAST_GRACE_MS = 5 * 60 * 1000;
export const MIN_LEAD_MS = 60 * 1000;
export const HISTORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
/** How long past fireAt a failing agent lookup (daemon/bridge outage) keeps being retried before the item fails. */
export const INFRA_RETRY_WINDOW_MS = 12 * 60 * 60 * 1000;
/** Delay after failed attempt n (1-based). The fifth failure is final, so it has no delay. */
export const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

export const scheduleStatusSchema = z.enum(["pending", "sent", "failed", "canceled"]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduledMessageSchema = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  text: z.string().min(1).max(MAX_TEXT_LENGTH),
  fireAt: z.number().int(),
  createdAt: z.number().int(),
  status: scheduleStatusSchema,
  attempts: z.number().int().min(0),
  nextAttemptAt: z.number().int().optional(),
  lastError: z.string().optional(),
  sentAt: z.number().int().optional(),
  finishedAt: z.number().int().optional(),
});
export type ScheduledMessage = z.infer<typeof scheduledMessageSchema>;

export const queueFileSchema = z.object({
  version: z.literal(1),
  items: z.array(scheduledMessageSchema),
});

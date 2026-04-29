import { z } from "zod";

import { normalizeCronTimezone } from "./cron-timezone.js";

function isCanonicalIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

const IsoTimestampSchema = z.string().refine(isCanonicalIsoTimestamp, "must be a canonical ISO-8601 timestamp");
const TimezoneSchema = z.string().refine((value) => normalizeCronTimezone(value) !== undefined, "must be a valid IANA timezone");

export const CronJobIdSchema = z.string().regex(/^[a-f0-9]{8}$/, "cron id must be 8-char lowercase hex");

export const CronSessionModeSchema = z.enum(["reuse", "new_per_run"]);
export const CronLocaleSchema = z.enum(["zh", "en"]);

export const CronRunHistoryEntrySchema = z.object({
  ranAt: IsoTimestampSchema,
  success: z.boolean(),
  error: z.string().max(2000).optional(),
});

export const CronJobRecordSchema = z.object({
  id: CronJobIdSchema,
  chatId: z.number().int(),
  userId: z.number().int(),
  chatType: z.string().min(1).default("private"),
  locale: CronLocaleSchema.optional(),
  cronExpr: z.string().min(1).max(120),
  timezone: TimezoneSchema.optional(),
  prompt: z.string().min(1).max(4000),
  description: z.string().max(200).optional(),
  enabled: z.boolean().default(true),
  runOnce: z.boolean().default(false),
  targetAt: IsoTimestampSchema.optional(),
  sessionMode: CronSessionModeSchema.default("reuse"),
  mute: z.boolean().default(false),
  silent: z.boolean().default(false),
  timeoutMins: z.number().int().min(0).max(24 * 60).default(30),
  maxFailures: z.number().int().min(1).max(100).default(3),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  lastRunAt: IsoTimestampSchema.optional(),
  lastSuccessAt: IsoTimestampSchema.optional(),
  lastError: z.string().max(2000).optional(),
  failureCount: z.number().int().min(0).default(0),
  runHistory: z.array(CronRunHistoryEntrySchema).max(10).default([]),
});

export const CronStoreStateSchema = z.object({
  schemaVersion: z.number().int().optional(),
  jobs: z.array(CronJobRecordSchema).default([]),
});

export type CronJobRecordInput = z.input<typeof CronJobRecordSchema>;
export type CronJobRecord = z.output<typeof CronJobRecordSchema>;
export type CronSessionMode = z.output<typeof CronSessionModeSchema>;
export type CronLocale = z.output<typeof CronLocaleSchema>;

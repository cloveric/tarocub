import { z } from "zod";

export const MiniBusPeerRecordSchema = z.object({
  name: z.string().min(1),
  chatId: z.number(),
  messageThreadId: z.number().optional(),
  conversationKey: z.string().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
}).passthrough();

export const MiniBusGroupRecordSchema = z.object({
  peers: z.array(MiniBusPeerRecordSchema).optional(),
  parallel: z.array(z.string()).optional(),
  chain: z.array(z.string()).optional(),
  verifier: z.string().optional(),
  roles: z.record(z.string(), z.string()).optional(),
  crew: z.object({
    maxResearchQuestions: z.number().optional(),
    maxRevisionRounds: z.number().optional(),
  }).passthrough().optional(),
}).passthrough();

export const MiniBusStoreStateSchema = z.object({
  groups: z.record(z.string(), MiniBusGroupRecordSchema).optional(),
}).passthrough();

export type MiniBusPeerRecord = z.infer<typeof MiniBusPeerRecordSchema>;
export type MiniBusGroupRecord = {
  peers: MiniBusPeerRecord[];
  parallel: string[];
  chain: string[];
  verifier?: string;
  roles: Partial<Record<MiniBusCrewRole, string>>;
  crew: {
    maxResearchQuestions: number;
    maxRevisionRounds: number;
  };
};
export type MiniBusStoreState = {
  groups: Record<string, MiniBusGroupRecord>;
};
export type MiniBusCrewRole = "researcher" | "analyst" | "writer" | "reviewer";

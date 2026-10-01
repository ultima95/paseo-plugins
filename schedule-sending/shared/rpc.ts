import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MAX_TEXT_LENGTH, scheduledMessageSchema } from "./model";

export const addScheduleRpc = defineRpc({
  name: "schedule.add",
  input: z.object({
    agentId: z.string().min(1),
    text: z.string().min(1).max(MAX_TEXT_LENGTH),
    fireAt: z.number().int(),
  }),
  output: z.object({ item: scheduledMessageSchema }),
});

export const listScheduleRpc = defineRpc({
  name: "schedule.list",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ items: z.array(scheduledMessageSchema) }),
});

export const cancelScheduleRpc = defineRpc({
  name: "schedule.cancel",
  input: z.object({ id: z.string().min(1) }),
  output: z.object({ item: scheduledMessageSchema.nullable() }),
});

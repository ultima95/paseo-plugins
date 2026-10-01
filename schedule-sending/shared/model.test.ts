import { describe, expect, it } from "vitest";
import { MAX_TEXT_LENGTH, queueFileSchema, scheduledMessageSchema } from "./model";

const valid = {
  id: "a",
  agentId: "agent-1",
  text: "hello",
  fireAt: 1_000,
  createdAt: 500,
  status: "pending",
  attempts: 0,
} as const;

describe("scheduledMessageSchema", () => {
  it("accepts a minimal pending item", () => {
    expect(scheduledMessageSchema.parse(valid)).toEqual(valid);
  });

  it("rejects empty text", () => {
    expect(scheduledMessageSchema.safeParse({ ...valid, text: "" }).success).toBe(false);
  });

  it("rejects text over the limit", () => {
    const text = "x".repeat(MAX_TEXT_LENGTH + 1);
    expect(scheduledMessageSchema.safeParse({ ...valid, text }).success).toBe(false);
  });

  it("accepts text exactly at the limit", () => {
    const text = "x".repeat(MAX_TEXT_LENGTH);
    expect(scheduledMessageSchema.safeParse({ ...valid, text }).success).toBe(true);
  });

  it("rejects an unknown status", () => {
    expect(scheduledMessageSchema.safeParse({ ...valid, status: "paused" }).success).toBe(false);
  });

  it("rejects a non-integer fireAt", () => {
    expect(scheduledMessageSchema.safeParse({ ...valid, fireAt: 1.5 }).success).toBe(false);
  });
});

describe("queueFileSchema", () => {
  it("accepts an empty version 1 queue", () => {
    expect(queueFileSchema.safeParse({ version: 1, items: [] }).success).toBe(true);
  });

  it("rejects any other version", () => {
    expect(queueFileSchema.safeParse({ version: 2, items: [] }).success).toBe(false);
  });

  it("rejects a queue containing an invalid item", () => {
    const broken = { ...valid, agentId: undefined };
    expect(queueFileSchema.safeParse({ version: 1, items: [broken] }).success).toBe(false);
  });
});

import type { PluginButtonRegistration } from "@getpaseo/plugin/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createPillRegistry } from "./pill-registry";

let added: Array<{ agentId: string; workspaceId: string }>;
let removed: string[];

function addPill(agentId: string, workspaceId: string): PluginButtonRegistration {
  added.push({ agentId, workspaceId });
  const label = `${agentId}@${workspaceId}`;
  return {
    update() {},
    remove() {
      removed.push(label);
    },
  };
}

beforeEach(() => {
  added = [];
  removed = [];
});

describe("pill registry", () => {
  it("adds one pill per agent", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.upsert({ id: "b", workspaceId: "w1" });
    expect(added).toEqual([
      { agentId: "a", workspaceId: "w1" },
      { agentId: "b", workspaceId: "w1" },
    ]);
  });

  it("keeps the mounted pill when the same agent is upserted again (status/title updates)", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.upsert({ id: "a", workspaceId: "w1" });
    expect(added).toHaveLength(1);
    expect(removed).toEqual([]);
  });

  it("replaces the pill when the agent moves to another workspace", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.upsert({ id: "a", workspaceId: "w2" });
    expect(removed).toEqual(["a@w1"]);
    expect(added).toEqual([
      { agentId: "a", workspaceId: "w1" },
      { agentId: "a", workspaceId: "w2" },
    ]);
  });

  it("ignores agents that have no workspace", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: null });
    registry.upsert({ id: "b" });
    expect(added).toEqual([]);
  });

  it("removes a pill and adds a fresh one if the agent returns", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.remove("a");
    expect(removed).toEqual(["a@w1"]);
    registry.upsert({ id: "a", workspaceId: "w1" });
    expect(added).toHaveLength(2);
  });

  it("removing an unknown agent is a no-op", () => {
    const registry = createPillRegistry(addPill);
    registry.remove("nope");
    expect(removed).toEqual([]);
  });

  it("replaceAll keeps unchanged pills, drops missing agents and adds new ones", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.upsert({ id: "b", workspaceId: "w1" });
    added = [];

    registry.replaceAll([
      { id: "a", workspaceId: "w1" },
      { id: "c", workspaceId: "w2" },
    ]);

    expect(removed).toEqual(["b@w1"]);
    expect(added).toEqual([{ agentId: "c", workspaceId: "w2" }]);
  });

  it("clear removes every pill", () => {
    const registry = createPillRegistry(addPill);
    registry.upsert({ id: "a", workspaceId: "w1" });
    registry.upsert({ id: "b", workspaceId: "w2" });
    registry.clear();
    expect(removed.sort()).toEqual(["a@w1", "b@w2"]);
    registry.clear();
    expect(removed).toHaveLength(2);
  });
});

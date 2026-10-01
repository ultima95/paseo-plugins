import { describe, expect, it } from "vitest";
import { createPaseoGateway, type AgentHandleLike, type PaseoLike } from "./gateway";

function paseoWith(handle: Partial<AgentHandleLike>, refs: string[] = []): PaseoLike {
  const full: AgentHandleLike = {
    refresh: async () => ({}),
    send: async () => undefined,
    archivedAt: null,
    activeTurn: null,
    status: "idle",
    ...handle,
  };
  return {
    agents: {
      ref: (agentId) => {
        refs.push(agentId);
        return full;
      },
    },
  };
}

describe("createPaseoGateway.inspect", () => {
  it("reports an idle agent", async () => {
    expect(await createPaseoGateway(paseoWith({})).inspect("a")).toBe("idle");
  });

  it("reports busy when a turn is in flight", async () => {
    const paseo = paseoWith({ activeTurn: { turnId: "t1", startedAt: "now" } });
    expect(await createPaseoGateway(paseo).inspect("a")).toBe("busy");
  });

  it.each(["running", "initializing"])("reports busy for status %s", async (status) => {
    expect(await createPaseoGateway(paseoWith({ status })).inspect("a")).toBe("busy");
  });

  it("reports archived, ahead of busy", async () => {
    const paseo = paseoWith({ archivedAt: "2026-09-30T00:00:00Z", activeTurn: { turnId: "t" } });
    expect(await createPaseoGateway(paseo).inspect("a")).toBe("archived");
  });

  it("reports missing when refresh returns null", async () => {
    expect(await createPaseoGateway(paseoWith({ refresh: async () => null })).inspect("a")).toBe("missing");
  });

  it("reports missing when refresh throws the daemon's not-found error", async () => {
    const paseo = paseoWith({
      refresh: async () => {
        throw new Error("Agent not found: does-not-exist");
      },
    });
    expect(await createPaseoGateway(paseo).inspect("a")).toBe("missing");
  });

  it("rethrows other refresh errors", async () => {
    const paseo = paseoWith({
      refresh: async () => {
        throw new Error("socket closed");
      },
    });
    await expect(createPaseoGateway(paseo).inspect("a")).rejects.toThrow("socket closed");
  });
});

describe("createPaseoGateway.send", () => {
  it("sends the text to the referenced agent", async () => {
    const refs: string[] = [];
    const sent: string[] = [];
    const paseo = paseoWith(
      {
        send: async (text) => {
          sent.push(text);
        },
      },
      refs,
    );
    await createPaseoGateway(paseo).send("agent-9", "hello there");
    expect(refs).toEqual(["agent-9"]);
    expect(sent).toEqual(["hello there"]);
  });
});

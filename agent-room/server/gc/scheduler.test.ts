import { afterEach, describe, expect, it, vi } from "vitest";

import { GC_INTERVAL_MS, createTickGate, startScheduler } from "./scheduler";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("startScheduler", () => {
  it("drops a tick that arrives while one is running", async () => {
    vi.useFakeTimers();
    let running = 0;
    let maxConcurrent = 0;
    const run = vi.fn(async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 5000));
      running -= 1;
    });
    const stop = startScheduler({ intervalMs: 1000, runTick: run });
    await vi.advanceTimersByTimeAsync(3500);
    stop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
  });

  it("clears its timer when stopped", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const stop = startScheduler({ intervalMs: 1000, runTick: run });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("leaves no timer behind, so a reload cannot accumulate intervals", async () => {
    vi.useFakeTimers();
    const first = vi.fn(async () => {});
    const stopFirst = startScheduler({ intervalMs: 1000, runTick: first });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first).toHaveBeenCalledTimes(1);

    // A reload: the old contribution's cleanup runs, the new one starts its own.
    stopFirst();
    expect(vi.getTimerCount()).toBe(0);

    const second = vi.fn(async () => {});
    const stopSecond = startScheduler({ intervalMs: 1000, runTick: second });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);

    // Exactly one interval is live, and only the new one fired.
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    stopSecond();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is idempotent: a second cleanup does not disturb anything", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const stop = startScheduler({ intervalMs: 1000, runTick: run });
    stop();
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a tick that rejects never escapes into the interval", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      throw new Error("the process phase exploded");
    });
    const stop = startScheduler({ intervalMs: 1000, runTick: run });

    // `advanceTimersByTimeAsync` drains the microtask queue the same way a real
    // interval would; an unhandled rejection would fail this test's run.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);

    // …and the mutex is released, so the next interval still gets its tick.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reports a dropped overlap without throwing when the reporter itself throws", async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5000));
    });
    const onSkip = vi.fn(() => {
      throw new Error("a broken log sink");
    });
    const stop = startScheduler({ intervalMs: 1000, runTick: run, onSkip });
    await vi.advanceTimersByTimeAsync(2500);
    stop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("defaults to the reference's 60 s interval", () => {
    expect(GC_INTERVAL_MS).toBe(60_000);
  });
});

describe("createTickGate — the one mutex both tick paths share", () => {
  it("refuses a second caller while the first is in flight", async () => {
    const gate = createTickGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;

    const first = gate.runExclusive(async () => {
      entered += 1;
      await blocked;
      return "the scheduled tick";
    });
    // The flag is set in the synchronous prefix, before `runExclusive` awaits.
    expect(gate.running).toBe(true);

    const second = await gate.runExclusive(async () => {
      entered += 1;
      return "the rpc";
    });

    // Refused, not queued: the second task never ran.
    expect(second).toEqual({ ran: false });
    expect(entered).toBe(1);
    expect(gate.running).toBe(true);

    release();
    await expect(first).resolves.toEqual({ ran: true, value: "the scheduled tick" });
    expect(gate.running).toBe(false);
    expect(entered).toBe(1);
  });

  it("releases the gate when the task rejects, so one failure cannot block every later tick", async () => {
    const gate = createTickGate();

    await expect(
      gate.runExclusive(async () => {
        throw new Error("the process phase exploded");
      }),
    ).rejects.toThrow("the process phase exploded");

    expect(gate.running).toBe(false);
    await expect(gate.runExclusive(async () => "second")).resolves.toEqual({
      ran: true,
      value: "second",
    });
  });

  it("makes an outside caller (the gc.run RPC) unable to overlap a scheduled tick", async () => {
    vi.useFakeTimers();
    const gate = createTickGate();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onSkip = vi.fn();
    const run = vi.fn(async () => {
      await blocked;
    });

    const stop = startScheduler({ intervalMs: 1000, runTick: run, gate, onSkip });
    await vi.advanceTimersByTimeAsync(1500);
    expect(run).toHaveBeenCalledTimes(1);

    // What index.server.ts's handler does: the RPC runs through the same gate.
    const rpc = await gate.runExclusive(async () => "a second acting phase");
    expect(rpc).toEqual({ ran: false });

    // …and the interval's own tick is dropped, not queued, for the same reason.
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onSkip).toHaveBeenCalledTimes(1);

    release();
    await vi.advanceTimersByTimeAsync(0);
    stop();
  });
});

import { describe, expect, it } from "vitest";

import type { FeedEvent } from "../shared/room";
import {
  acceptanceClaims,
  auditAcceptance,
  evidenceTokens,
  hasFreshEvidence,
  hasUnresolvedVerdict,
  humanAccepted,
  verdictsIn,
  verdictUpgrades,
} from "./record";

const feedEvent = (over: Partial<FeedEvent> & { text: string }): FeedEvent => ({
  id: `e-${over.text}`,
  roomId: "S1",
  at: "2026-11-07T10:00:00.000Z",
  kind: "message",
  from: null,
  to: "S1",
  label: "task",
  ...over,
});

describe("verdictsIn", () => {
  it("reads the shapes a verification record takes", () => {
    expect(verdictsIn("invoice rounding: FAIL")).toEqual([
      { work: "invoice rounding", verdict: "FAIL" },
    ]);
    expect(verdictsIn("| invoice rounding | FAIL | evidence |")).toEqual([
      { work: "invoice rounding", verdict: "FAIL" },
    ]);
    expect(verdictsIn("FAIL: invoice rounding")).toEqual([
      { work: "invoice rounding", verdict: "FAIL" },
    ]);
    expect(verdictsIn("**token store** — BLOCKED")).toEqual([
      { work: "token store", verdict: "BLOCKED" },
    ]);
  });

  it("keeps the last row for a work item", () => {
    expect(verdictsIn("invoice: FAIL\ninvoice: PASS")).toEqual([
      { work: "invoice", verdict: "PASS" },
    ]);
  });

  it("ignores prose and rows with no verdict", () => {
    expect(verdictsIn("the invoice rounding looks fine\n| work | verdict |")).toEqual([]);
    expect(verdictsIn("PASS")).toEqual([]);
  });
});

describe("acceptanceClaims", () => {
  it("reads an owner-accepted claim before or after its work item", () => {
    expect(acceptanceClaims("**invoice rounding**: owner-accepted")).toEqual([
      {
        disposition: "owner-accepted",
        work: "invoice rounding",
        raw: "**invoice rounding**: owner-accepted",
      },
    ]);
    expect(acceptanceClaims("owner-accepted: invoice rounding")[0]).toMatchObject({
      disposition: "owner-accepted",
      work: "invoice rounding",
    });
  });

  it("distinguishes a role attribution from the owner", () => {
    expect(acceptanceClaims("invoice: accepted-by-supervisor")[0]).toMatchObject({
      disposition: "accepted-by-supervisor",
      work: "invoice",
    });
    expect(acceptanceClaims("invoice: accepted-by-owner")[0]?.disposition).toBe("owner-accepted");
  });
});

describe("auditAcceptance", () => {
  it("does not let an owner-accepted claim vouch for itself", () => {
    const audit = auditAcceptance({
      text: "DONE\n**invoice rounding**: owner-accepted",
      feed: [],
      role: "lead",
    });
    expect(audit).toEqual([
      {
        disposition: "owner-accepted",
        work: "invoice rounding",
        verified: false,
        recorded: "accepted-by-lead",
      },
    ]);
  });

  it("verifies a claim against a recorded Human turn naming the work", () => {
    const audit = auditAcceptance({
      text: "DONE\ninvoice rounding: owner-accepted",
      feed: [feedEvent({ text: "I accept invoice rounding, ship it" })],
      role: "lead",
    });
    expect(audit[0]).toMatchObject({ verified: true, recorded: "owner-accepted" });
  });

  it("rejects a Human acceptance that never names the work", () => {
    expect(humanAccepted([feedEvent({ text: "ship it" })], "invoice rounding")).toBe(false);
    expect(humanAccepted([feedEvent({ text: "I accept invoice rounding, ship it" })], "invoice rounding")).toBe(
      true,
    );
  });

  it("needs a Human turn, not another agent's message", () => {
    const audit = auditAcceptance({
      text: "invoice: owner-accepted",
      feed: [feedEvent({ from: "L1", label: "reply", text: "I accept invoice, owner-accepted" })],
      role: "supervisor",
    });
    expect(audit[0]).toMatchObject({ verified: false, recorded: "accepted-by-supervisor" });
  });
});

describe("verdictUpgrades", () => {
  it("flags a FAIL that becomes PASS with no new candidate", () => {
    expect(verdictUpgrades("invoice: FAIL", "invoice: PASS")).toEqual([
      { work: "invoice", from: "FAIL", to: "PASS" },
    ]);
  });

  it("stays quiet when the later turn cites a new commit", () => {
    expect(verdictUpgrades("invoice: FAIL", "invoice: PASS\ncommit abc1234")).toEqual([]);
  });

  it("stays quiet when the later turn cites a new walk", () => {
    expect(verdictUpgrades("invoice: FAIL", "invoice: PASS\nwalk run-42")).toEqual([]);
  });

  it("does not flag an unchanged verdict", () => {
    expect(verdictUpgrades("invoice: PASS", "invoice: PASS")).toEqual([]);
    expect(verdictUpgrades("invoice: FAIL", "invoice: BLOCKED")).toEqual([]);
  });
});

describe("evidenceTokens", () => {
  it("reads commits, numbers and run ids", () => {
    const tokens = evidenceTokens("commit abc1234, PR #42, run 7");
    expect(tokens.has("abc1234")).toBe(true);
    expect(tokens.has("num-42")).toBe(true);
    expect(tokens.has("ref-7")).toBe(true);
  });

  it("compares two turns", () => {
    expect(hasFreshEvidence("abc1234", "abc1234")).toBe(false);
    expect(hasFreshEvidence("abc1234", "deadbee")).toBe(true);
  });
});

describe("hasUnresolvedVerdict", () => {
  it("treats a FAIL or BLOCKED row as unresolved", () => {
    expect(hasUnresolvedVerdict("DONE\ninvoice: FAIL")).toBe(true);
    expect(hasUnresolvedVerdict("DONE\ninvoice: BLOCKED")).toBe(true);
    expect(hasUnresolvedVerdict("DONE\ninvoice: PASS")).toBe(false);
  });
});

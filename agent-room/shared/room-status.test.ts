import { describe, expect, it } from "vitest";

import {
  parseRoomStatusMessage,
  roomStatusLine,
  roomStatusSchema,
  stripRoomStatusFence,
} from "./room-status";

const FENCE = "```";

function message(...lines: string[]): string {
  return lines.join("\n");
}

function fenced(...body: string[]): string[] {
  return [`${FENCE}room-status`, ...body, FENCE];
}

describe("parseRoomStatusMessage", () => {
  it("ignores a message without a status fence", () => {
    expect(parseRoomStatusMessage("Done. **auth** — `running` is all.")).toBeNull();
  });

  it("keeps the prose around the block", () => {
    const text = message(
      "This is the way.",
      "",
      ...fenced("**auth refactor** — `running`"),
      "",
      "and that is all.",
    );
    expect(parseRoomStatusMessage(text)).toMatchObject({
      before: "This is the way.",
      after: "and that is all.",
    });
  });

  it("reads one card per Lead with detail, peers and the wait target", () => {
    const text = message(
      ...fenced(
        "**auth refactor** — `running`",
        "  reviewing token store diff · peers: token store, token store diff",
        "",
        "**billing export** — `STATUS: waiting on CI`",
        "  peers: csv writer (permission pending) · waiting on csv writer · ~2m",
      ),
    );
    expect(parseRoomStatusMessage(text)).toEqual({
      before: "",
      after: "",
      cards: [
        {
          name: "auth refactor",
          state: "running",
          detail: "reviewing token store diff",
          peers: ["token store", "token store diff"],
        },
        {
          name: "billing export",
          state: "STATUS: waiting on CI",
          peers: ["csv writer (permission pending)"],
          waitingOn: "csv writer",
          elapsed: "~2m",
        },
      ],
      terminal: null,
    });
  });

  it("reads a done row as the whole block", () => {
    const text = message(...fenced("**✅ Done** — committed on feat/auth, 14 tests pass"));
    expect(parseRoomStatusMessage(text)).toEqual({
      before: "",
      after: "",
      cards: [],
      terminal: { kind: "done", text: "committed on feat/auth, 14 tests pass" },
    });
  });

  it("reads a waiting row as the whole block", () => {
    const text = message(...fenced("**❓ Waiting on you** — push, or leave it local?"));
    expect(parseRoomStatusMessage(text)?.terminal).toEqual({
      kind: "waiting",
      text: "push, or leave it local?",
    });
  });

  it("takes the last fence when the message carries more than one", () => {
    const text = message(
      ...fenced("**first** — `running`"),
      "",
      "then",
      "",
      ...fenced("**second** — `idle`"),
    );
    const parsed = parseRoomStatusMessage(text);
    expect(parsed?.cards.map((card) => card.name)).toEqual(["second"]);
    expect(parsed?.before).toContain("**first**");
  });

  it("returns null for a body that is not a status block", () => {
    expect(parseRoomStatusMessage(message(...fenced("just some code")))).toBeNull();
  });

  it("returns null when a terminal row and cards are mixed", () => {
    const text = message(
      ...fenced("**✅ Done** — done", "**auth** — `running`"),
    );
    expect(parseRoomStatusMessage(text)).toBeNull();
  });

  it("round-trips through the renderer's schema", () => {
    const info = parseRoomStatusMessage(message(...fenced("**auth** — `running`")));
    expect(info).not.toBeNull();
    const stored = JSON.parse(JSON.stringify(info));
    expect(roomStatusSchema.parse(stored)).toEqual(stored);
  });
});

describe("stripRoomStatusFence", () => {
  it("leaves the rows and drops the fence markers", () => {
    const text = message("before", ...fenced("**auth** — `running`"), "after");
    expect(stripRoomStatusFence(text)).toBe(message("before", "**auth** — `running`", "after"));
  });

  it("leaves other fences alone", () => {
    const text = message(`${FENCE}ts`, "x", FENCE);
    expect(stripRoomStatusFence(text)).toBe(text);
  });
});

describe("roomStatusLine", () => {
  it("joins the card into one plain line", () => {
    expect(
      roomStatusLine({
        name: "billing export",
        state: "STATUS: waiting on CI",
        detail: "records recorded",
        peers: ["csv writer"],
        waitingOn: "csv writer",
        elapsed: "~2m",
      }),
    ).toBe("billing export · STATUS: waiting on CI · records recorded · peers: csv writer · waiting on csv writer · ~2m");
  });

  it("omits what the card does not have", () => {
    expect(roomStatusLine({ name: "auth", state: "running", peers: [] })).toBe(
      "auth · running",
    );
  });
});

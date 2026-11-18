import { beforeEach, describe, expect, it } from "vitest";
import { PANEL_DEFAULT_WIDTH } from "./preview-size";
import {
  forgetPreviewWidth,
  readPreviewWidth,
  rememberPreviewWidth,
  subscribePreviewWidth,
} from "./preview-width-store";

describe("remembered preview width", () => {
  beforeEach(() => forgetPreviewWidth());

  it("starts at the default width", () => {
    expect(readPreviewWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });

  it("hands back the last width dragged to", () => {
    rememberPreviewWidth(680);
    expect(readPreviewWidth()).toBe(680);
  });

  it("keeps the newest width when it changes again", () => {
    rememberPreviewWidth(680);
    rememberPreviewWidth(410);
    expect(readPreviewWidth()).toBe(410);
  });

  it("tells mounted boards when the width changes", () => {
    let notified = 0;
    const stop = subscribePreviewWidth(() => (notified += 1));
    rememberPreviewWidth(500);
    rememberPreviewWidth(560);
    stop();
    expect(notified).toBe(2);
  });

  it("stays quiet when written the width it already holds", () => {
    rememberPreviewWidth(680);
    let notified = 0;
    const stop = subscribePreviewWidth(() => (notified += 1));
    rememberPreviewWidth(680);
    stop();
    expect(notified).toBe(0);
  });

  it("stops notifying a board that unmounted", () => {
    let notified = 0;
    const stop = subscribePreviewWidth(() => (notified += 1));
    stop();
    rememberPreviewWidth(500);
    expect(notified).toBe(0);
  });

  it("forgets back to the default", () => {
    rememberPreviewWidth(680);
    forgetPreviewWidth();
    expect(readPreviewWidth()).toBe(PANEL_DEFAULT_WIDTH);
  });
});

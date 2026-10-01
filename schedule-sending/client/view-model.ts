import { MAX_ATTEMPTS, type ScheduledMessage } from "../shared/model";
import { formatDelta, formatFireTime } from "./format";
import type { ParseWhenResult } from "./parse-when";

export type RowTone = "muted" | "success" | "warning" | "danger";

export interface ItemRow {
  id: string;
  preview: string;
  detail: string;
  tone: RowTone;
  cancellable: boolean;
}

const PREVIEW_MAX = 120;

export function previewText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

export function describeItem(item: ScheduledMessage, now: number): ItemRow {
  const base = { id: item.id, preview: previewText(item.text) };
  switch (item.status) {
    case "pending":
      if (item.attempts > 0) {
        const reason = item.lastError ?? "send failed";
        return { ...base, detail: `Retry ${item.attempts}/${MAX_ATTEMPTS} · ${reason}`, tone: "warning", cancellable: true };
      }
      if (item.fireAt <= now) {
        const why = item.lastError === undefined ? "" : ` · ${item.lastError}`;
        return { ...base, detail: `Due · waiting to send${why}`, tone: "warning", cancellable: true };
      }
      return { ...base, detail: formatFireTime(item.fireAt, now), tone: "muted", cancellable: true };
    case "sent":
      return { ...base, detail: `Sent ${formatFireTime(item.sentAt ?? item.fireAt, now)}`, tone: "success", cancellable: false };
    case "failed":
      return { ...base, detail: `Failed · ${item.lastError ?? "unknown error"}`, tone: "danger", cancellable: false };
    case "canceled":
      return { ...base, detail: "Canceled", tone: "muted", cancellable: false };
  }
}

export function previewLine(
  when: string,
  parsed: ParseWhenResult,
  now: number,
): { text: string; isError: boolean } {
  if (when.trim() === "") return { text: "e.g. 3am, 15:30 or in 5h", isError: false };
  if (!parsed.ok) return { text: parsed.error, isError: true };
  return {
    text: `Fires ${formatFireTime(parsed.fireAt, now)} · in ${formatDelta(parsed.fireAt - now)}`,
    isError: false,
  };
}

export function canSchedule(text: string, parsed: ParseWhenResult): boolean {
  return text.trim().length > 0 && parsed.ok;
}

/**
 * Pure helpers for the scholar Messages surface (app/messages.tsx +
 * components/messages/*) and the Workshop board's conversation cards
 * (app/meta.tsx). The server shapes live in convex/scholarMessages.ts; the
 * web twin is the scholar MessageWorkspace. Kept framework-free so the copy
 * and ordering rules are unit-testable without a simulator.
 */
import type { FunctionReturnType } from "convex/server";

import type { api, Id } from "@/lib/convex";

// Derived from the typed API (convex/scholarMessages.ts is the source of
// truth) so native never hand-copies a server shape.
export type ScholarThreadSummary = FunctionReturnType<
  typeof api.scholarMessages.listThreads
>["threads"][number];
export type ScholarThreadKind = ScholarThreadSummary["kind"];
export type ScholarThreadDetail = NonNullable<
  FunctionReturnType<typeof api.scholarMessages.getThread>
>;
export type ScholarThreadMessage = ScholarThreadDetail["messages"][number];
export type ScholarThreadAttachment = FunctionReturnType<
  typeof api.scholarMessages.getThreadAttachments
>[number];

/** Section eyebrows — identical to the web Messages list. */
export const MENTORS_EYEBROW = "Mentors";
export const WORKSHOP_EYEBROW = "Workshop";

/** The reply composer's placeholder — the web scholar thread's string
 *  (components/messaging/MessageThread.tsx, scholar viewer), for every kind. */
export const REPLY_PLACEHOLDER = "Write a reply…";

/** Shown instead of the composer when the server says the caller can't post
 *  (web parity). */
export const REPLIES_CLOSED = "Replies are closed for this conversation.";

/** The thread header's subtitle. Mentor: just "Mentor" (no invented role
 *  label). Workshop: the idea it's about, when there is one. */
export function threadSubtitle(detail: {
  kind: ScholarThreadKind;
  suggestion: { title: string } | null;
}): string | null {
  if (detail.kind === "mentor") return "Mentor";
  return detail.suggestion?.title ?? null;
}

/** "<Author>: <body>" — the one-line preview under a thread or idea card.
 *  The author is "You" for the caller's own message (the server already says
 *  so for thread summaries). Empty when there is nothing to preview. */
export function previewLine(
  authorName: string | null | undefined,
  body: string,
): string {
  const text = body.replace(/\s+/g, " ").trim();
  if (!text) return "";
  return authorName ? `${authorName}: ${text}` : text;
}

/** listMine's `lastMessage` → the idea card's preview line. */
export function ideaPreview(
  lastMessage:
    | { authorName: string; body: string; mine: boolean }
    | null
    | undefined,
): string {
  if (!lastMessage) return "";
  return previewLine(lastMessage.mine ? "You" : lastMessage.authorName, lastMessage.body);
}

/** The list's kind filter (`?kind=` — the Workshop's way in is
 *  `kind=workshop`). Web parity: components/ScholarMessages.tsx. */
export type KindFilter = "all" | "mentor" | "workshop";

export function kindFilterFrom(value: string | null | undefined): KindFilter {
  return value === "mentor" || value === "workshop" ? value : "all";
}

/** Mentor threads first (they're about the kid's own work), then Workshop.
 *  Each section keeps the server's newest-first order. */
export function splitThreadSections(threads: readonly ScholarThreadSummary[]): {
  mentors: ScholarThreadSummary[];
  workshop: ScholarThreadSummary[];
} {
  return {
    mentors: threads.filter((t) => t.kind === "mentor"),
    workshop: threads.filter((t) => t.kind === "workshop"),
  };
}

/** The list row's headline. Mentor: the counterpart. Workshop: the idea, or
 *  (team-started) the opening topic, else the counterpart. */
export function threadHeadline(thread: ScholarThreadSummary): string {
  if (thread.kind === "mentor") return thread.title;
  return thread.suggestionTitle ?? thread.topic ?? thread.title;
}

/** Team-started Workshop threads (no idea behind them) — the Workshop board's
 *  zone above My ideas. */
export function teamStartedWorkshopThreads(
  threads: readonly ScholarThreadSummary[] | undefined,
): ScholarThreadSummary[] {
  return (threads ?? []).filter(
    (t) => t.kind === "workshop" && t.startedByStaff && !t.suggestionId,
  );
}

/** The team-started card's byline: who opened it, else the team. Web parity
 *  (components/WorkshopView.tsx TeamThreadCard). */
export function teamStarterLine(startedByName: string | null | undefined): string {
  const name = startedByName?.trim();
  return name ? `From ${name}` : "From the Rabbithole team";
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return (mimeType ?? "").toLowerCase().startsWith("image/");
}

/** Attachments grouped under the message that carries them (server order). */
export function attachmentsByMessage(
  attachments: readonly ScholarThreadAttachment[] | undefined,
): Map<Id<"parentMessages">, ScholarThreadAttachment[]> {
  const map = new Map<Id<"parentMessages">, ScholarThreadAttachment[]>();
  for (const attachment of attachments ?? []) {
    const list = map.get(attachment.messageId);
    if (list) list.push(attachment);
    else map.set(attachment.messageId, [attachment]);
  }
  return map;
}

/** A picker asset's upload name. Camera shots arrive without one, and a
 *  library pick can carry a HEIC name after iOS already transcoded the bytes
 *  to JPEG — the extension must match the mime the server will see. */
export function pickedPhotoFileName(
  fileName: string | null | undefined,
  mimeType: string,
  now: number,
): string {
  const ext =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/gif"
        ? "gif"
        : mimeType === "image/webp"
          ? "webp"
          : mimeType === "image/heic" || mimeType === "image/heif"
            ? "heic"
            : "jpg";
  const base = (fileName ?? "").replace(/\.[a-z0-9]+$/i, "").trim();
  return `${base || `photo-${now}`}.${ext}`;
}

/** Short relative time for a message or a list row (native has no date-fns). */
export function relativeTime(ts: number, now: number): string {
  const secs = Math.max(0, Math.floor((now - ts) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

/**
 * Stub. The Chat surface (the Curriculum Assistant) lives in the parent
 * layout (`app/teacher/(dashboard)/chat/layout.tsx`) so it doesn't remount
 * as the `/<chatId>` segment changes — that's what keeps the active
 * stream alive when switching threads. This optional catch-all just makes
 * `/teacher/chat` and `/teacher/chat/<chatId>` resolve to a route.
 */
import type { Metadata } from "next";

// The tab title for this route (the surface itself renders from the layout).
export const metadata: Metadata = { title: "Chat" };

export default function ChatStubPage() {
  return null;
}

/**
 * Stub. The Chat surface (the Curriculum Assistant) lives in the parent
 * layout (`app/teacher/(dashboard)/chat/layout.tsx`) so it doesn't remount
 * as the `/<chatId>` segment changes — that's what keeps the active
 * stream alive when switching threads. This optional catch-all just makes
 * `/teacher/chat` and `/teacher/chat/<chatId>` resolve to a route.
 */
export default function ChatStubPage() {
  return null;
}

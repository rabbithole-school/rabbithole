import { withInstitutionScope } from "@/lib/institutionLinks";

/**
 * The full-screen staff chat surface (`/teacher/chat`, `/teacher/chat/<chatId>`).
 *
 * Chat is deliberately NOT a top-level nav tab. The Robot in the staff header
 * opens/closes the docked chat on every normal staff surface, and the dock
 * header's labelled "All chats" link is the one door to this route — the thread
 * library / maximized view. Two controls, one for the tool and one for its
 * archive, instead of a tab that duplicated the Robot's destination.
 *
 * The path and its query lens live here so the dock's anchor `href` and the
 * soft-nav `router.push` behind it are built from the same rule and can't drift.
 */
export const TEACHER_CHAT_PATH = "/teacher/chat";

/**
 * The dock header's "All chats" URL, carrying the active institution lens
 * (`?inst=`) so the school in view survives the hop.
 *
 * An ordinary dock thread (global / scholar / practice) deep-links itself
 * (`/teacher/chat/<chatId>`) — the thread is the context worth preserving, and
 * the full-screen surface reads its active thread from that path segment.
 *
 * A UNIT-scoped dock thread deliberately does NOT: it opens the bare route,
 * which is the thread library. That route is the generic chat surface — it has
 * no `unitContext`, so a send there would go through the generic path and lose
 * the unit tools/prompt and the `unitId` attribution. Unit-design chats belong
 * to their unit (`curriculumAssistant.listSessionsForUnit` is their history and
 * the unit designer is where they continue), so the dock's escape hatch offers
 * the library rather than a thread the destination cannot own.
 */
export function teacherChatHref({
  sessionId,
  scopeParam,
  unitScoped = false,
}: {
  /** The dock's active thread, if any. */
  sessionId: string | null | undefined;
  /** The active institution lens: "", "all", or an institution slug. */
  scopeParam: string | null | undefined;
  /** True when the dock is the unit-designer's Curriculum Bot. */
  unitScoped?: boolean;
}): string {
  const deepLink = sessionId && !unitScoped;
  const path = deepLink ? `${TEACHER_CHAT_PATH}/${sessionId}` : TEACHER_CHAT_PATH;
  return withInstitutionScope(path, scopeParam);
}

/**
 * True on the full-screen chat route — and only there, never on a sibling path
 * that merely shares the prefix. The docked chat is suppressed here: the
 * full-screen assistant IS the maximized chat, so docking one beside it would
 * render the same thread twice.
 */
export function isTeacherChatPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return (
    pathname === TEACHER_CHAT_PATH || pathname.startsWith(`${TEACHER_CHAT_PATH}/`)
  );
}

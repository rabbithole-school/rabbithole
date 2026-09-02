"use client";

import { useCallback } from "react";
import { usePathname, useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { Box } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import { isTeacherChatPath } from "@/lib/teacherChat";
import { useAideDock } from "./AideDockProvider";
import { AideDockShell } from "./AideDockShell";

// One chat body for EVERY scope (global / scholar / practice / unit) — the
// slim "dock" layout of the curriculum assistant. Browser-only (owns a
// StreamRegistry), so ssr:false — matching how the full-screen chat route
// imports it.
const CurriculumAssistant = dynamic(() => import("@/components/CurriculumAssistant"), {
  ssr: false,
});

/**
 * The single teacher aide dock — rendered ONCE per staff shell (the teacher
 * dashboard layout and the school shell) as a flex sibling of the body, so
 * opening it PUSHES the body (never covers it). Its contents are chosen by the
 * current route's scope (published via `useSetAideScope`). Closed → renders
 * nothing (body takes full width).
 *
 * Suppressed on the full-screen chat route: there the full-screen
 * `CurriculumAssistant` IS the maximized chat, so a second docked copy would be
 * redundant.
 */
export function AideDock() {
  const {
    open,
    scope,
    setOpen,
    pendingSend,
    consumePendingSend,
    dockSessionId,
    setDockSessionId,
    pendingComposerSeed,
    consumeComposerSeed,
  } = useAideDock();
  const pathname = usePathname();
  const router = useRouter();

  // "All chats" — leave the dock for the full-screen chat route. The dock
  // bodies are self-contained, so this just follows the link the header
  // rendered (already carrying the institution lens, plus the active thread
  // when it is one that route can own) and closes the now-redundant dock.
  const onOpenAllChats = useCallback(
    (href: string) => {
      setOpen(false);
      router.push(href);
    },
    [router, setOpen],
  );

  // The full-screen chat route is the maximized placement — don't dock a duplicate.
  if (isTeacherChatPath(pathname) || !open) return null;

  return (
    <AideDockShell>
      <AideDockBody
        scope={scope}
        onClose={() => setOpen(false)}
        onOpenAllChats={onOpenAllChats}
        dockSessionId={dockSessionId}
        setDockSessionId={setDockSessionId}
        pendingComposerSeed={pendingComposerSeed}
        consumeComposerSeed={consumeComposerSeed}
        pendingSend={pendingSend}
        consumePendingSend={consumePendingSend}
      />
    </AideDockShell>
  );
}

function AideDockBody({
  scope,
  onClose,
  onOpenAllChats,
  dockSessionId,
  setDockSessionId,
  pendingComposerSeed,
  consumeComposerSeed,
  pendingSend,
  consumePendingSend,
}: {
  scope: ReturnType<typeof useAideDock>["scope"];
  onClose: () => void;
  onOpenAllChats: (href: string) => void;
  dockSessionId: string | null;
  setDockSessionId: (id: string | null) => void;
  pendingComposerSeed: ReturnType<typeof useAideDock>["pendingComposerSeed"];
  consumeComposerSeed: () => void;
  pendingSend: ReturnType<typeof useAideDock>["pendingSend"];
  consumePendingSend: () => void;
}) {
  if (scope.kind === "unit") {
    // Unit scope is a distinct design tool (its own unit-editing tools +
    // test-drive context). It gets its OWN thread, keyed by unit so navigating
    // between units unmounts/remounts a fresh per-unit chat (and so it does NOT
    // share the lifted dockSessionId that global/scholar/practice ride). The
    // outline selection (lesson/activity) is soft context — changing it updates
    // `unitContext` without dropping the active chat. The provider's imperative
    // `send()` is forwarded as `pendingSend`; the body auto-sends when it
    // targets this unit.
    return (
      <Box flex={1} minH={0} display="flex" flexDirection="column" overflow="hidden">
        <CurriculumAssistant
          key={`unit:${String(scope.unitId)}`}
          compact
          onClose={onClose}
          onOpenAllChats={onOpenAllChats}
          unitContext={{
            unitId: scope.unitId as Id<"units">,
            selectedLessonId: scope.lessonId ?? null,
            selectedActivityId: scope.activityId ?? null,
          }}
          pendingSend={pendingSend}
          onConsumePendingSend={consumePendingSend}
        />
      </Box>
    );
  }

  // Global AND scholar scope share ONE persistent CurriculumAssistant. It is
  // deliberately NOT keyed by scope, so navigating between scholars (or between
  // global and a scholar) keeps the SAME thread mounted — the chat persists and
  // just re-contextualizes via `focusScholarId` (an ephemeral "currently
  // viewing" hint sent per-message, never binding the thread). A fresh thread
  // comes only from the "New chat" button. (Unit scope is the one exception: a
  // distinct design tool with its own unit-editing tools, above.)
  const focusScholarId =
    scope.kind === "scholar" ? (scope.scholarId as Id<"users">) : null;
  // Practice studio (Skills tab) rides the SAME persistent thread as global /
  // scholar; its on-screen domain/node is an ephemeral per-message hint, so the
  // aide resolves "this node" / "these" without the teacher restating it.
  const practiceContext =
    scope.kind === "practice"
      ? {
          domain: scope.domain,
          domainLabel: scope.domainLabel ?? null,
          nodeKey: scope.nodeKey ?? null,
          nodeLabel: scope.nodeLabel ?? null,
        }
      : null;
  return (
    <Box flex={1} minH={0} display="flex" flexDirection="column" overflow="hidden">
      <CurriculumAssistant
        compact
        onClose={onClose}
        onOpenAllChats={onOpenAllChats}
        focusScholarId={focusScholarId}
        practiceContext={practiceContext}
        dockSessionId={dockSessionId}
        onDockSessionChange={setDockSessionId}
        pendingComposerSeed={pendingComposerSeed}
        onConsumeComposerSeed={consumeComposerSeed}
      />
    </Box>
  );
}

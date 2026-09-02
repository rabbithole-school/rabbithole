"use client";

import { Suspense, useCallback } from "react";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { RemoteLink } from "@/components/RemoteLink";
import { useEffect, useState, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { useSignOut } from "@/hooks/useSignOut";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useLearnerContext } from "@/hooks/useLearnerContext";
import { isTeacherRole } from "@/convex/lib/roles";
import { teacherHomePath } from "@/lib/teacherHome";
import { useScholarFont } from "@/hooks/useScholarFont";
import { useRemote } from "@/hooks/useRemote";
import { useEdgeSwipeOpen, useSwipeDismiss } from "@/hooks/useSwipeGesture";
import { haptic } from "@/lib/native";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";
import {
  Box,
  Drawer,
  Flex,
  VStack,
  HStack,
  Text,
  Button,
  IconButton,
  Portal,
  Spinner,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import { toaster } from "@/lib/toaster";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import {
  Plus,
  SignOut,
  Trash,
  X,
  House,
} from "@phosphor-icons/react";
import { SessionInterface } from "@/components/SessionInterface";
import { WorkbenchSurface } from "@/components/workbench/WorkbenchSurface";
import { VibecodeWorkshop } from "@/components/vibecode/VibecodeWorkshop";
import { ManualRehearsalBanner } from "@/components/ManualRehearsalBanner";
import { AppLogo } from "@/components/AppLogo";
import { UnitPickerDialog } from "@/components/UnitPickerDialog";
import { SetPasswordDialog } from "@/components/SetPasswordDialog";

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export default function ScholarSessionPage() {
  return (
    <Suspense fallback={<Flex minH="100vh" bg="gray.50" align="center" justify="center"><Spinner size="xl" color="violet.500" /></Flex>}>
      <ScholarSessionInner />
    </Suspense>
  );
}

function ScholarSessionInner() {
  const { user, isLoading: isUserLoading } = useCurrentUser();
  const [signOut, isSigningOut] = useSignOut();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { stamp } = useRemote();
  const { hasLearnerContext, isLearnerContextLoading } =
    useLearnerContext(!!user);
  const params = useParams<{ sessionId: string }>();
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const newSessionCreatedRef = useRef(false);

  const sessionId = params.sessionId; // Convex ID, "new", or the legacy "me" alias
  const isNewSession = sessionId === "new";
  // /scholar/me is not a session — it's the adjacent personal portrait route,
  // which lives at /me. Links/bookmarks that hit /scholar/me by mistake would
  // otherwise send "me" into the session view as an invalid Convex ID and crash
  // its error boundary. Bounce it to the real route (handled by the effect below).
  const isMeAlias = sessionId === "me";

  // Remote mode: teacher viewing as a scholar
  const remoteUserId = searchParams.get("remote");
  const isRemoteMode = !!(remoteUserId && user && isTeacherRole(user.role));
  const isTestMode =
    isRemoteMode ||
    !!(user && isTeacherRole(user.role) && !hasLearnerContext);

  // Touch: swipe right from the left screen edge opens the sidebar (iPadOS
  // convention — the hamburger stays as the visible affordance); swipe left
  // on the open sidebar closes it.
  useEdgeSwipeOpen(
    () => {
      haptic("light");
      setIsSidebarOpen(true);
    },
    { enabled: !isRemoteMode && !isSidebarOpen },
  );
  const sidebarSwipeClose = useSwipeDismiss(
    () => setIsSidebarOpen(false),
    "left",
  );

  // Unit/lesson/activity params from URL (for pre-setting on new projects).
  // `activity` lets a scholar-scoped task open as a project with no
  // unit/lesson context — see IS refactor.
  const urlUnit = searchParams.get("unit");
  const urlLesson = searchParams.get("lesson");
  const urlActivity = searchParams.get("activity");
  const hasDimensionParams = !!urlUnit || !!urlActivity;

  // Fetch projects reactively via Convex
  const sessionsResult = useQuery(
    api.sessions.list,
    isRemoteMode
      ? { userId: remoteUserId as Id<"users"> }
      : { asLearner: !isTestMode },
  );
  // Manual rehearsals are deliberately absent from `sessions.list`, so resolve the
  // active row directly before choosing chat vs. Workbench vs. Vibecode.
  const currentSession = useQuery(
    api.sessions.get,
    !isNewSession && !isMeAlias && sessionId
      ? { id: sessionId as Id<"sessions"> }
      : "skip",
  );
  // Until the list resolves we don't know a session's mode, so the render
  // branch below waits on `sessionsResult === undefined` instead of guessing a
  // surface — otherwise a vibecode/workbench session would transiently mount
  // the chat SessionInterface, whose kickoff effect fires an unwanted opener.
  const sessions = sessionsResult ?? [];

  // Fetch unit list for resolving URL param slug to ID
  const units =
    useQuery(api.units.list, {
      asLearner: !isTestMode && !isRemoteMode,
    }) ?? [];

  // Fetch scholar info for remote mode banner
  const remoteUser = useQuery(
    api.users.getUser,
    isRemoteMode && remoteUserId ? { userId: remoteUserId as Id<"users"> } : "skip"
  );

  const createSession = useMutation(api.sessions.create);
  const archiveSession = useMutation(api.sessions.archive);

  // World Workbench predicate: a world session is the SAME session, a different
  // renderer (plan §7.2). `getBench` returns an object for a world bench and a
  // cheap null otherwise; the session row's `sessionMode` is the entry trigger
  // before the bench aggregate is first ensured (WorkbenchSurface ensures it).
  const benchProbe = useQuery(
    api.simulatorBenches.getBench,
    !isNewSession && !isMeAlias && sessionId
      ? { sessionId: sessionId as Id<"sessions"> }
      : "skip",
  );

  // Resolve URL param slug to unit ID
  const resolvedUnitId = (() => {
    if (urlUnit) {
      const match = units.find((u) => u.slug === urlUnit);
      if (match) return match._id;
    }
    return undefined;
  })();

  const isDemoMode = searchParams.get("demo") === "1";

  // Unit picker dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [isCreatingViaDialog, setIsCreatingViaDialog] = useState(false);

  // Legacy alias: bounce /scholar/me → /me before any session query runs.
  useEffect(() => {
    if (isMeAlias) router.replace("/me");
  }, [isMeAlias, router]);

  // Redirect logic
  useEffect(() => {
    if (isUserLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    // Bounce teachers/admins back to /teacher only if they're at /scholar/new
    // with nothing to do — i.e., no dimension params (preview/demo), no remote
    // mode, no demo flag. When they have a real sessionId in the URL we let
    // them through: it's either a remote-mode session, a manual rehearsal of an
    // activity, or just inspecting a scholar's project.
    //
    // Note: this widens what teachers can see — before manual rehearsal, this redirect
    // bounced ANY /scholar/[realId] visit unless they had ?remote= or
    // dimension params. Now a teacher who lands on a scholar's project URL
    // (copy-paste, autocomplete, stale bookmark) will load it as themselves
    // with no remote-mode breadcrumb. `getWithMessages` already grants
    // teachers read access to any project, so this isn't a privilege
    // escalation — just removes a low-value reflexive redirect.
    if (
      isTeacherRole(user.role) &&
      !isLearnerContextLoading &&
      !hasLearnerContext &&
      isNewSession &&
      !remoteUserId &&
      !hasDimensionParams &&
      !isDemoMode
    ) {
      router.replace(teacherHomePath(user.role));
      return;
    }
  }, [
    user,
    isUserLoading,
    router,
    isNewSession,
    remoteUserId,
    hasDimensionParams,
    isDemoMode,
    hasLearnerContext,
    isLearnerContextLoading,
  ]);

  // Auto-create a session when sessionId is "new" (URL-based creation from teacher links)
  useEffect(() => {
    if (!isNewSession || newSessionCreatedRef.current) return;
    // Wait for unit list to load if we have a unit param
    if (urlUnit && units.length === 0) return;

    // Join-don't-duplicate: if scholar already has an open project for
    // the same target, route to it instead of spawning a new one.
    // Crucially: prefer an in-progress project. A completed project
    // (activityCompletedAt set) is NOT a candidate — otherwise
    // clicking 'New Project' on a focus the scholar already finished
    // drags them back into the finished session. Falling through to
    // the create path below spawns a fresh attempt.
    if (sessions.length > 0) {
      const matchesTarget = (p: (typeof sessions)[number]) =>
        urlActivity
          ? String(p.activityId ?? "") === urlActivity
          : resolvedUnitId && urlLesson
            ? p.unitId === resolvedUnitId &&
              String(p.lessonId ?? "") === urlLesson
            : resolvedUnitId
              ? p.unitId === resolvedUnitId
              : false;
      const candidates = sessions.filter(matchesTarget);
      const existing =
        candidates.find((p) => !p.activityCompletedAt) ?? null;
      if (existing) {
        newSessionCreatedRef.current = true;
        router.replace(stamp(`/scholar/${existing.id}`));
        return;
      }
    }

    newSessionCreatedRef.current = true;

    const createArgs: Record<string, unknown> = {};
    if (isRemoteMode && remoteUserId) {
      createArgs.userId = remoteUserId as Id<"users">;
    }
    if (resolvedUnitId) createArgs.unitId = resolvedUnitId;
    if (urlLesson) createArgs.lessonId = urlLesson as Id<"lessons">;
    if (urlActivity) createArgs.activityId = urlActivity as Id<"activities">;

    createSession(createArgs as Parameters<typeof createSession>[0])
      .then((result) => {
        if (result) {
          // `demo=1` is a non-`remote` param — append explicitly,
          // then let stamp() add `remote=` if needed.
          const base = `/scholar/${result.id}`;
          const withDemo = hasDimensionParams ? `${base}?demo=1` : base;
          router.replace(stamp(withDemo));
        }
      })
      .catch((error) => {
        console.error("Error creating session:", error);
        toaster.error({ title: "Failed to create session", description: "Please try again." });
        newSessionCreatedRef.current = false;
      });
  }, [isNewSession, hasDimensionParams, units, resolvedUnitId, createSession, router, remoteUserId, isRemoteMode, sessions]); // eslint-disable-line react-hooks/exhaustive-deps

  // Open unit picker dialog for new project
  const handleNewSession = useCallback(() => {
    setDialogOpen(true);
  }, []);

  // Create project after unit+lesson+activity selection from dialog
  const handleUnitSelected = useCallback(async (sel: { unitId: string | null; lessonId: string | null; activityId: string | null }) => {
    setIsCreatingViaDialog(true);
    const createArgs: Record<string, unknown> = {};
    if (isRemoteMode && remoteUserId) {
      createArgs.userId = remoteUserId as Id<"users">;
    }
    if (sel.unitId) {
      createArgs.unitId = sel.unitId as Id<"units">;
    }
    if (sel.lessonId) {
      createArgs.lessonId = sel.lessonId as Id<"lessons">;
    }
    if (sel.activityId) {
      createArgs.activityId = sel.activityId as Id<"activities">;
    }
    try {
      const result = await createSession(createArgs as Parameters<typeof createSession>[0]);
      if (result) {
        router.push(stamp(`/scholar/${result.id}`));
      }
    } catch (error) {
      console.error("Error creating session:", error);
      toaster.error({ title: "Failed to create session", description: "Please try again." });
    } finally {
      setIsCreatingViaDialog(false);
      setDialogOpen(false);
    }
  }, [createSession, router, remoteUserId, isRemoteMode, stamp]);

  // Archive project
  const handleArchiveSession = async (id: string) => {
    try {
      await archiveSession({ id: id as Id<"sessions"> });
      if (sessionId === id) {
        // Navigate to another project or welcome
        const remaining = sessions.filter((c) => c._id !== id);
        if (remaining.length > 0) {
          router.replace(stamp(`/scholar/${remaining[0]._id}`));
        } else {
          router.replace(stamp(`/scholar/new`));
        }
      }
    } catch (error) {
      console.error("Error archiving session:", error);
      toaster.error({ title: "Failed to archive session" });
    }
  };

  useScholarFont(user?.preferredFont as "andika" | "opendyslexic" | undefined, isRemoteMode);

  // Show a spinner (not the session view) while the /scholar/me → /me redirect
  // above resolves, so "me" never mounts SessionInterface as an invalid ID.
  if (isMeAlias || isUserLoading || sessions === undefined) {
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  // Header always shows the logged-in user, not the remote scholar
  const displayName = user?.name || "Scholar";
  const displayImage = user?.image || undefined;

  // Show spinner while "new" project is being created
  const showSession = !isNewSession && sessionId;

  const isWorkbench =
    currentSession?.sessionMode === "workbench" || benchProbe != null;
  const isVibecode = currentSession?.sessionMode === "vibecode";

  return (
    <Flex
      h={VIEWPORT_SHELL_HEIGHT}
      bg="gray.50"
    >
      {/* Sidebar Drawer */}
      <Drawer.Root
        open={isSidebarOpen}
        onOpenChange={(e) => setIsSidebarOpen(e.open)}
        placement="start"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            {/* Portaled overlays are position:fixed, so the body's
                env(safe-area-inset-top) padding doesn't reach them — pad
                the drawer so its header clears the iPad status bar. env()
                is 0 on the web, so this is a no-op outside the shell. */}
            <Drawer.Content
              bg="white"
              maxW="300px"
              pt="env(safe-area-inset-top)"
              pb="env(safe-area-inset-bottom)"
              {...sidebarSwipeClose}
            >
              {/* Sidebar Header */}
              <Flex
                p={4}
                borderBottom="1px solid"
                borderColor="gray.200"
                justify="space-between"
                align="center"
              >
                <AppLogo variant="dark" />
                <Drawer.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close sidebar"
                    size="sm"
                    variant="ghost"
                    color="charcoal.500"
                    _hover={{ bg: "gray.100" }}
                  >
                    <X />
                  </IconButton>
                </Drawer.CloseTrigger>
              </Flex>

              {/* Home */}
              <Box px={3} pt={3}>
                <RemoteLink
                  href={`/scholar`}
                  style={{ textDecoration: "none", display: "block" }}
                  onClick={() => setIsSidebarOpen(false)}
                >
                  <Button
                    asChild
                    w="full"
                    size="md"
                    variant="ghost"
                    color="navy.500"
                    fontFamily="heading"
                    justifyContent="flex-start"
                    _hover={{ bg: "gray.100" }}
                  >
                    <span>
                      <House style={{ marginRight: "8px" }} />
                      Home
                    </span>
                  </Button>
                </RemoteLink>
              </Box>

              {/* Projects header + New Project */}
              <HStack px={4} pt={4} pb={1} justify="space-between" align="center">
                <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="charcoal.400" textTransform="uppercase" letterSpacing="wider">
                  Sessions
                </Text>
                <Button
                  size="xs"
                  variant="outline"
                  color="violet.500"
                  borderColor="violet.300"
                  fontFamily="heading"
                  _hover={{ bg: "violet.50" }}
                  onClick={() => {
                    handleNewSession();
                    setIsSidebarOpen(false);
                  }}
                >
                  <Plus style={{ marginRight: "4px" }} />
                  New Session
                </Button>
              </HStack>

              {/* Projects List */}
              <VStack
                flex={1}
                overflowY="auto"
                p={2}
                gap={1}
                align="stretch"
              >
                {sessions.map((conv) => (
                  <RemoteLink
                    key={conv._id}
                    href={`/scholar/${conv._id}`}
                    style={{ textDecoration: "none", color: "inherit", display: "contents" }}
                    onClick={() => setIsSidebarOpen(false)}
                  >
                    <HStack
                      p={3}
                      borderRadius="lg"
                      cursor="pointer"
                      bg={sessionId === conv._id ? "violet.50" : "transparent"}
                      _hover={{ bg: sessionId === conv._id ? "violet.50" : "gray.100" }}
                      css={{ "& .archive-btn": { opacity: 0 }, "&:hover .archive-btn": { opacity: 0.5 } }}
                      justify="space-between"
                    >
                      <VStack gap={0} flex={1} overflow="hidden" align="start">
                        <Text
                          color="navy.500"
                          fontSize="sm"
                          fontFamily="heading"
                          overflow="hidden"
                          textOverflow="ellipsis"
                          whiteSpace="nowrap"
                          w="full"
                        >
                          {conv.title}
                        </Text>
                        <Text
                          color="charcoal.300"
                          fontSize="xs"
                          fontFamily="heading"
                        >
                          {timeAgo(conv.updatedAt)}
                        </Text>
                      </VStack>
                      <IconButton
                        className="archive-btn"
                        aria-label="Archive"
                        size="xs"
                        variant="ghost"
                        color="charcoal.400"
                        _hover={{ opacity: 1, bg: "gray.200" }}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleArchiveSession(conv._id);
                        }}
                      >
                        <Trash />
                      </IconButton>
                    </HStack>
                  </RemoteLink>
                ))}
                {sessions.length === 0 && (
                  <Text
                    color="charcoal.300"
                    fontSize="sm"
                    fontFamily="heading"
                    textAlign="center"
                    py={4}
                  >
                    No sessions yet
                  </Text>
                )}
              </VStack>

              {/* User Section */}
              <Box p={3} borderTop="1px solid" borderColor="gray.200">
                <HStack justify="space-between">
                  <HStack gap={3}>
                    <Avatar
                      size="sm"
                      name={displayName}
                      src={displayImage}
                      colorKey={user?._id}
                    />
                    <VStack gap={0} align="start">
                      <Text
                        color="navy.500"
                        fontSize="sm"
                        fontFamily="heading"
                        fontWeight="500"
                      >
                        {displayName}
                      </Text>
                      <Text color="charcoal.400" fontSize="xs" fontFamily="heading">
                        {isRemoteMode ? "Scholar (Remote)" : "Scholar"}
                      </Text>
                    </VStack>
                  </HStack>
                  {!isRemoteMode && (
                    <Button
                      size="sm"
                      variant="ghost"
                      color="charcoal.500"
                      fontFamily="heading"
                      fontWeight="500"
                      _hover={{ bg: "gray.100" }}
                      onClick={() => { void signOut(); }}
                      loading={isSigningOut}
                      loadingText="Signing out..."
                      disabled={isSigningOut}
                    >
                      <SignOut />
                      Sign out
                    </Button>
                  )}
                </HStack>
              </Box>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      {/* Main Project Area */}
      <Flex flex={1} flexDir="column" overflow="hidden">
        {currentSession?.isTestDrive && (isWorkbench || isVibecode) && (
          <ManualRehearsalBanner session={currentSession} />
        )}
        {showSession ? (
          sessionsResult === undefined || currentSession === undefined ? (
            <Flex flex={1} align="center" justify="center">
              <Spinner size="xl" color="violet.500" />
            </Flex>
          ) : isWorkbench ? (
            <ErrorBoundary fallbackMessage="Something went wrong in the Workbench">
              <WorkbenchSurface
                sessionId={sessionId as Id<"sessions">}
                onOpenSidebar={isRemoteMode ? undefined : () => setIsSidebarOpen(true)}
              />
            </ErrorBoundary>
          ) : isVibecode ? (
            <ErrorBoundary fallbackMessage="Something went wrong in the workshop">
              <VibecodeWorkshop
                sessionId={sessionId as Id<"sessions">}
                onOpenSidebar={isRemoteMode ? undefined : () => setIsSidebarOpen(true)}
              />
            </ErrorBoundary>
          ) : (
            <ErrorBoundary fallbackMessage="Something went wrong in the project view">
              <SessionInterface
                sessionId={sessionId}
                onSessionUpdate={() => {}}
                onOpenSidebar={isRemoteMode ? undefined : () => setIsSidebarOpen(true)}
                onSignOut={signOut}
                onNewSession={isRemoteMode ? undefined : handleNewSession}
                isTestMode={isTestMode}
                isRemoteMode={isRemoteMode}
                scholarName={isRemoteMode ? remoteUser?.name ?? null : null}
                scholarImage={isRemoteMode ? remoteUser?.image ?? null : null}
                remoteUserId={remoteUserId}
                onBack={() => {
                  if (window.history.length > 1) router.back();
                  else router.push(stamp("/scholar"));
                }}
              />
            </ErrorBoundary>
          )
        ) : (
          <Flex
            flex={1}
            align="center"
            justify="center"
            flexDir="column"
            gap={4}
            p={8}
          >
            <Box
              w={24}
              h={24}
              borderRadius="full"
              bg="linear-gradient(135deg, #AD60BF 0%, #222656 100%)"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Text
                fontSize="4xl"
                fontWeight="bold"
                color="white"
                fontFamily="heading"
              >
                M
              </Text>
            </Box>
            <VStack gap={2}>
              <Text
                fontSize="2xl"
                fontWeight="600"
                fontFamily="heading"
                color="navy.500"
              >
                {isNewSession ? "Creating session..." : "Welcome"}
              </Text>
              {isNewSession ? (
                <Spinner size="lg" color="violet.500" mt={4} />
              ) : (
                <>
                  <Text
                    color="charcoal.400"
                    fontFamily="body"
                    textAlign="center"
                    maxW="md"
                  >
                    Your AI learning companion. Start a new session to explore
                    ideas, ask questions, and dive deep into any topic that sparks
                    your curiosity.
                  </Text>
                  <Button
                    size="lg"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.700" }}
                    fontFamily="heading"
                    onClick={handleNewSession}
                    mt={2}
                  >
                    <Plus style={{ marginRight: "8px" }} />
                    Start a Session
                  </Button>
                </>
              )}
            </VStack>
          </Flex>
        )}
      </Flex>

      {/* Unit Picker Dialog */}
      <UnitPickerDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSelect={handleUnitSelected}
        units={units.map((u) => ({
          id: u._id,
          title: u.title,
          emoji: u.emoji,
          description: u.description,
          subject: u.subject,
        }))}
        isCreating={isCreatingViaDialog}
      />

      {/* Forced password reset */}
      {user?.mustResetPassword && user.username && (
        <SetPasswordDialog
          open={true}
          onClose={() => {}}
          requireCurrentPassword={false}
        />
      )}
    </Flex>
  );
}

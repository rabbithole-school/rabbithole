"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { Box, HStack, Text, Button, Menu } from "@chakra-ui/react";
import {
  SignOut,
  Gear,
  User,
  Eye,
  EyeSlash,
  Medal,
  Users,
  ArrowLeft,
  Check,
  Wrench,
  Plugs,
  Bug,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlatformAdminRole, isStaffRole, type Role } from "@/convex/lib/roles";
import { useViewingContext } from "@/hooks/useViewingContext";
import { Avatar } from "./Avatar";
import { InstitutionMark } from "./InstitutionMark";
import { ProfileEditModal } from "./ProfileEditModal";
import { BugReportDialog } from "./BugReportDialog";
import { capturePageScreenshot } from "@/lib/capturePageScreenshot";

// ── Persona / context switcher ────────────────────────────────────────────
// A user holds many MEMBERSHIPS (one per (role, institution) context). The
// switcher lets a multi-hat person — e.g. Sloane (operations staff @ Moli + parent),
// Avery (platform admin + parent) — choose which hat they're wearing. It writes the URL
// (the route prefix carries the role; the page then infers the active context),
// so contexts stay shareable and there's no hidden global mode. The active
// institution lens (?inst=<slug>) lets a multi-institution teacher switch
// schools without a hidden global mode.
type SwitcherMembership = {
  _id: string;
  role: string;
  institutionId: string | null;
  institutionName: string | null;
  institutionSlug: string | null;
  institutionKind: "school" | "guest" | "community" | null;
  institutionIsPrimary: boolean;
  institutionEmoji: string | null;
};

const CTX_META: Record<
  string,
  { emoji: string; label: string; href: string; surface: "staff" | "parent" | "scholar" }
> = {
  platform_admin: { emoji: "🛠️", label: "Platform admin", href: "/teacher", surface: "staff" },
  school_admin: { emoji: "🏫", label: "School admin", href: "/teacher", surface: "staff" },
  teacher: { emoji: "🌺", label: "Teacher", href: "/teacher", surface: "staff" },
  staff: { emoji: "🗂️", label: "Staff", href: "/teacher", surface: "staff" },
  curriculum_designer: { emoji: "📚", label: "Curriculum designer", href: "/teacher", surface: "staff" },
  parent: { emoji: "👨‍👧", label: "Parent", href: "/parent", surface: "parent" },
  scholar: { emoji: "🎒", label: "Scholar", href: "/scholar", surface: "scholar" },
};

function buildContexts(
  memberships: SwitcherMembership[],
  pathname: string,
  activeInstitutionSlug: string | null | undefined,
  homeInstitutionSlug: string | null | undefined,
) {
  const onParent = pathname.startsWith("/parent");
  const onScholar = pathname.startsWith("/scholar") || pathname === "/me";
  const onStaff = pathname.startsWith("/teacher") || pathname.startsWith("/admin");
  // When already inside the teacher dashboard, an institution switch should
  // keep the current TAB (e.g. /teacher/scholars) and only swap ?inst=, rather
  // than bouncing to /teacher (the Chat tab). Preserve the surface + first
  // sub-segment; deeper scholar/sub-tab segments + institution-scoped query
  // (?group,?obs) are dropped because they may not exist in the target
  // institution. From /admin or a non-staff surface, fall back to the role's
  // default landing (meta.href).
  const onTeacher = pathname.startsWith("/teacher");
  const teacherTab = onTeacher
    ? "/" + pathname.split("/").filter(Boolean).slice(0, 2).join("/")
    : null;
  const staffInstitutionMemberships = memberships.filter((m) => {
    const meta = CTX_META[m.role];
    return meta?.surface === "staff" && !!m.institutionSlug;
  });
  const homeSlug =
    homeInstitutionSlug ??
    staffInstitutionMemberships.find((m) => m.institutionIsPrimary)?.institutionSlug ??
    staffInstitutionMemberships[0]?.institutionSlug ??
    null;
  const seen = new Set<string>();
  const out: {
    key: string;
    href: string;
    emoji: string;
    label: string;
    isActive: boolean;
  }[] = [];
  for (const m of memberships) {
    const meta = CTX_META[m.role];
    if (!meta) continue;
    const key = `${m.role}:${m.institutionId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Show the institution next to staff and learner contexts. Platform admins
    // remain global and therefore have no single institution label.
    const withInst =
      (meta.surface === "scholar" ||
        (meta.surface === "staff" &&
          !isPlatformAdminRole(m.role as Role))) &&
      !!m.institutionName;
    const staffSlug = withInst ? m.institutionSlug : null;
    const contextLabel =
      m.role === "scholar" && m.institutionKind === "community"
        ? "Learner"
        : meta.label;
    const activeStaffSlug = activeInstitutionSlug ?? homeSlug;
    // Staff contexts: keep the current teacher tab when we're already on it, so
    // switching institution stays put (only ?inst= changes). "" clears ?inst=
    // (the home institution's view). Non-staff or cross-surface → meta.href.
    const staffBase = teacherTab ?? meta.href;
    const targetInstScope = staffSlug && staffSlug !== homeSlug ? staffSlug : "";
    out.push({
      key,
      href:
        meta.surface === "staff"
          ? withInstitutionScope(staffBase, targetInstScope)
          : meta.href,
      emoji: withInst && m.institutionEmoji ? m.institutionEmoji : meta.emoji,
      label: withInst
        ? `${contextLabel} · ${m.institutionName}`
        : contextLabel,
      isActive:
        meta.surface === "parent"
          ? onParent
          : meta.surface === "scholar"
            ? onScholar
            : staffSlug && staffInstitutionMemberships.length > 1
              ? onStaff && activeStaffSlug === staffSlug
              : onStaff,
    });
  }
  // Stable order: staff first, then parent, then scholar.
  const rank = (k: string) => (k.startsWith("parent") ? 1 : k.startsWith("scholar") ? 2 : 0);
  out.sort((a, b) => rank(a.key) - rank(b.key));
  return out;
}

interface AccountMenuProps {
  onSignOut: () => void;
}

/**
 * Resolve once the SPECIFIC account-menu content node has left the DOM, and
 * report whether it actually did (`true`) or the cap was hit while it was still
 * connected (`false`). Ark keeps a menu mounted through its close/exit
 * animation, so we poll the exact node — not a global menu selector, which
 * could match an unrelated menu — and only report "gone" once it's disconnected.
 * The single paint-settle for the whole capture flow lives here (two stable
 * frames after the node unmounts); the capture helper adds none. Capped so it
 * never hangs and stays inside the transient-activation window a following
 * getDisplayMedia needs. A `false` return means the caller must SKIP capture and
 * open a screenshot-less dialog (the menu would otherwise be in the shot).
 */
function waitForAccountMenuGone(
  getContent: () => HTMLElement | null,
  signal: AbortSignal,
  maxMs = 700,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") {
      resolve(true);
      return;
    }
    const now = () =>
      typeof performance !== "undefined" ? performance.now() : Date.now();
    const start = now();
    const gone = () => {
      const el = getContent();
      return !el || !el.isConnected;
    };
    const tick = () => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      if (gone()) {
        // Two stable frames so the removal has painted before we capture — the
        // one and only paint-settle in the capture flow.
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        return;
      }
      if (now() - start >= maxMs) {
        resolve(false);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function AccountMenu({
  onSignOut,
}: AccountMenuProps) {
  const { user } = useCurrentUser();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { activeInstitution, scopeParam } = useActiveInstitution(!!user);

  const [showProfile, setShowProfile] = useState(false);
  const [showBugReport, setShowBugReport] = useState(false);
  // The auto-captured page screenshot, handed to the dialog as its initial
  // staged shot. Cleared on close AND on successful submit so the retained
  // File bytes are released and the next open re-captures.
  const [capturedShot, setCapturedShot] = useState<File | null>(null);
  const openingReportRef = useRef(false);
  // The account menu's content DOM node, so we can watch THIS menu (not any
  // menu) leave the DOM before capturing.
  const menuContentRef = useRef<HTMLDivElement>(null);
  // Owns the in-flight capture's cancellation: aborted on unmount or a
  // superseding open, cleared once the capture settles.
  const captureAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      captureAbortRef.current?.abort();
    },
    [],
  );

  // Clicking "Report a bug" is the required user gesture: fire the capture from
  // within it (transient activation survives the wait for the menu to close).
  // We wait for THIS menu's content node to leave the DOM before grabbing the
  // frame; if it hasn't gone by the cap we SKIP capture and open a
  // screenshot-less dialog rather than shoot the still-open menu.
  const openBugReport = useCallback(async () => {
    if (openingReportRef.current) return;
    openingReportRef.current = true;
    const controller = new AbortController();
    captureAbortRef.current?.abort();
    captureAbortRef.current = controller;
    try {
      const menuGone = await waitForAccountMenuGone(
        () => menuContentRef.current,
        controller.signal,
      );
      const shot = menuGone
        ? await capturePageScreenshot({ signal: controller.signal })
        : null;
      if (controller.signal.aborted) return;
      setCapturedShot(shot);
      setShowBugReport(true);
    } finally {
      if (captureAbortRef.current === controller) captureAbortRef.current = null;
      openingReportRef.current = false;
    }
  }, []);

  const role = user?.role;
  const isScholar = role === "scholar";
  // Platform admins gate the "Admin Tools" entry to the platform console.
  // School admins are NOT platform admins.
  const isAdmin = isPlatformAdminRole(role as Role | undefined);
  const isParentRole = role === "parent";
  // Gates the staff-only "Connect an AI assistant" entry.
  const isStaff = role === "staff" || isStaffRole(role as Role | undefined);
  const userName = user?.name ?? "User";
  const userUsername = user?.username;
  const userImage = user?.image;

  // Parent CONTEXT: a guardian (any role) can hop to the parent view. Hidden
  // for parent-role accounts (already there) and non-guardians.
  const hasParentContext =
    useQuery(api.parents.hasParentContext, user ? {} : "skip") ?? false;
  const isOnParentPage = pathname?.startsWith("/parent");
  const showParentEntry = hasParentContext && !isParentRole && !isOnParentPage;
  const showExitParent = hasParentContext && !isParentRole && isOnParentPage;

  // Persona/context switcher: the user's (role, institution) memberships. Shown
  // when they wear ≥2 hats (e.g. operations staff + parent). When present it supersedes
  // the standalone parent-view entries below (parent is one of its contexts).
  const membershipsRaw = useQuery(api.memberships.myMemberships, user ? {} : "skip");
  const memberships = useMemo(
    () => (membershipsRaw ?? []) as SwitcherMembership[],
    [membershipsRaw],
  );
  const contexts = useMemo(
    () =>
      buildContexts(
        memberships,
        pathname ?? "",
        activeInstitution?.scope === "institution"
          ? activeInstitution.institutionSlug
          : null,
        activeInstitution?.homeInstitutionSlug ?? null,
      ),
    [memberships, pathname, activeInstitution],
  );
  const showContextSwitcher = contexts.length >= 2;

  // Institution LENS (platform admins only). The School shell also renders a
  // convenient selector above its navigation rail; both controls write the same
  // ?inst= state and therefore stay synchronized. Non-admin staff switch institution
  // via their (role · institution) memberships in "Switch context" above; a
  // platform admin has no per-institution membership, so they get an explicit
  // lens here — every institution + "All institutions" — writing ?inst= while
  // KEEPING the current tab.
  const onInstitutionLensSurface =
    !!pathname &&
    (pathname.startsWith("/teacher") || pathname.startsWith("/school"));
  const adminInstitutionsRaw = useQuery(
    api.institutions.list,
    user && isAdmin && onInstitutionLensSurface ? {} : "skip",
  );
  const adminInstitutions = useMemo(
    () =>
      (adminInstitutionsRaw ?? []) as {
        _id: string;
        slug: string;
        name: string;
        emoji: string | null;
        logoUrl: string | null;
        isPrimary: boolean;
        scholarCount: number;
      }[],
    [adminInstitutionsRaw],
  );
  const institutionLens = useMemo(() => {
    if (!isAdmin || !onInstitutionLensSurface || adminInstitutions.length < 2) return null;
    // School routes are already stable leaf destinations, so preserve the exact
    // page. Teacher detail routes keep their established section-level base.
    const base = pathname?.startsWith("/school")
      ? pathname
      : "/" + (pathname ?? "/teacher").split("/").filter(Boolean).slice(0, 2).join("/");
    const activeSlug =
      activeInstitution?.scope === "institution"
        ? activeInstitution.institutionSlug
        : null;
    const isAll = scopeParam === "all";
    return {
      rows: adminInstitutions.map((inst) => ({
        key: inst.slug,
        href: withInstitutionScope(base, inst.slug),
        emoji: inst.emoji,
        logoUrl: inst.logoUrl,
        name: inst.name,
        count: inst.scholarCount,
        isActive: !isAll && activeSlug === inst.slug,
      })),
      allHref: withInstitutionScope(base, "all"),
      allActive: isAll,
      showAll: !pathname?.startsWith("/school"),
      totalScholars: adminInstitutions.reduce((n, i) => n + i.scholarCount, 0),
    };
  }, [isAdmin, onInstitutionLensSurface, adminInstitutions, pathname, activeInstitution, scopeParam]);

  // Remote-mode awareness — when a teacher's looking at a scholar's
  // surface via `?remote=<scholarId>`, the avatar chip swaps to the
  // remote scholar and the menu grows a "Viewing as / Exit" affordance.
  const remoteParam = searchParams?.get("remote") ?? null;
  const { mode: viewingMode, impersonation } = useViewingContext({
    remoteUserId: remoteParam,
    pathname,
  });
  const isRemoteMode = viewingMode === "inspect";
  const remoteScholar = useQuery(
    api.users.getUser,
    isRemoteMode ? { userId: remoteParam as Id<"users"> } : "skip",
  );
  const scholarName = remoteScholar?.name ?? "scholar";
  const scholarImage = remoteScholar?.image ?? undefined;

  const handleExitRemote = () => {
    // Prefer router.back() so the teacher returns to whichever tab they entered
    // remote mode from. Falls back to /teacher/curriculum if there's no in-app
    // history (deep link / new tab).
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/teacher/curriculum");
    }
  };

  // Impersonation ("View as user") awareness. Unlike remote-mode, currentUser
  // IS the target here (the overlay swapped identity), so the menu shows the
  // target as "you" + an orange pill + a "Signed in as <admin>" note + Exit.
  const isImpersonating = viewingMode === "actAs";
  const stopImpersonation = useMutation(api.impersonation.stopImpersonation);
  const [exitingImpersonation, setExitingImpersonation] = useState(false);
  const handleExitImpersonation = async () => {
    if (exitingImpersonation) return;
    setExitingImpersonation(true);
    try {
      await stopImpersonation({});
    } finally {
      // Full-document nav so every query re-resolves as the real admin.
      if (typeof window !== "undefined") {
        window.location.assign(new URL("/admin", window.location.origin).href);
      }
    }
  };

  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button
          aria-label={`Account menu for ${userName}`}
          variant="ghost"
          size="sm"
          px={2}
          h="auto"
          py={1}
          _hover={{ bg: "gray.100" }}
          flexShrink={0}
        >
          <HStack gap={2}>
            {/* Teacher avatar (always — anchors "who is signed in") */}
            <Box position="relative" display="inline-flex">
              <Avatar size="xs" name={userName} src={userImage} colorKey={user?._id} />
            </Box>
            {/* Remote-mode pill: "Viewing as [scholarAvatar] scholarName" */}
            {isRemoteMode && (
              <HStack
                gap={1.5}
                pl={2}
                pr={2.5}
                py={1}
                borderRadius="full"
                bg="violet.50"
                color="violet.700"
              >
                <Eye size={11} />
                <Text fontFamily="heading" fontWeight="600" fontSize="xs">
                  Viewing as
                </Text>
                <Avatar size="xs" name={scholarName} src={scholarImage} colorKey={remoteParam ?? undefined} />
                <Text fontFamily="heading" fontWeight="700" fontSize="xs" color="violet.700">
                  {scholarName}
                </Text>
              </HStack>
            )}
            {/* Impersonation pill: 🕵️ Viewing as <target> (orange = caution;
                you're seeing the target's data, read-only). */}
            {isImpersonating && (
              <HStack
                gap={1.5}
                pl={2}
                pr={2.5}
                py={1}
                borderRadius="full"
                bg="orange.100"
                color="orange.800"
              >
                <Text as="span" fontSize="xs">🕵️</Text>
                <Text fontFamily="heading" fontWeight="700" fontSize="xs">
                  Viewing as {impersonation?.targetName ?? userName}
                </Text>
              </HStack>
            )}
          </HStack>
        </Button>
      </Menu.Trigger>
      <Menu.Positioner>
        <Menu.Content ref={menuContentRef} minW="180px">
          <Box px={3} py={2}>
            {(isRemoteMode || isImpersonating) && (
              <Text
                fontFamily="heading"
                fontSize="2xs"
                fontWeight="700"
                color={isImpersonating ? "orange.700" : "violet.600"}
                textTransform="uppercase"
                letterSpacing="0.05em"
                mb={1}
              >
                {isImpersonating ? "🕵️ Viewing as" : "Viewing as"}
              </Text>
            )}
            <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.500">
              {isImpersonating
                ? impersonation?.targetName ?? userName
                : isRemoteMode
                  ? scholarName
                  : userName}
            </Text>
            {!isRemoteMode && !isImpersonating && userUsername && (
              <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                @{userUsername}
              </Text>
            )}
            {isRemoteMode && (
              <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                Signed in as {userName}
              </Text>
            )}
            {isImpersonating && (
              <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
                Signed in as {impersonation?.adminName ?? "admin"} · read-only
              </Text>
            )}
          </Box>
          {showContextSwitcher && (
            <>
              <Menu.Separator />
              <Box px={3} pt={1.5} pb={0.5}>
                <Text
                  fontFamily="heading"
                  fontSize="2xs"
                  fontWeight="700"
                  color="violet.600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Switch context
                </Text>
              </Box>
              {contexts.map((c) => (
                <Menu.Item key={c.key} value={`ctx:${c.key}`} cursor="pointer" asChild>
                  <Link href={c.href} style={{ textDecoration: "none", color: "inherit" }}>
                    <HStack w="full" gap={2}>
                      <Text as="span">{c.emoji}</Text>
                      <Text as="span" flex={1} lineClamp={1}>
                        {c.label}
                      </Text>
                      {c.isActive && <Check />}
                    </HStack>
                  </Link>
                </Menu.Item>
              ))}
            </>
          )}
          {institutionLens && (
            <>
              <Menu.Separator />
              <Box px={3} pt={1.5} pb={0.5}>
                <Text
                  fontFamily="heading"
                  fontSize="2xs"
                  fontWeight="700"
                  color="violet.600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Institution
                </Text>
              </Box>
              {institutionLens.rows.map((r) => (
                <Menu.Item key={`inst:${r.key}`} value={`inst:${r.key}`} cursor="pointer" asChild>
                  <Link href={r.href} style={{ textDecoration: "none", color: "inherit" }}>
                    <HStack w="full" gap={2}>
                      <InstitutionMark
                        logoUrl={r.logoUrl}
                        emoji={r.emoji}
                        name={r.name}
                        size={18}
                      />
                      <Text as="span" flex={1} lineClamp={1}>
                        {r.name}
                      </Text>
                      <Text as="span" fontSize="2xs" color="charcoal.300">
                        {r.count}
                      </Text>
                      {r.isActive && <Check />}
                    </HStack>
                  </Link>
                </Menu.Item>
              ))}
              {institutionLens.showAll && (
                <Menu.Item value="inst:all" cursor="pointer" asChild>
                  <Link href={institutionLens.allHref} style={{ textDecoration: "none", color: "inherit" }}>
                    <HStack w="full" gap={2}>
                      <Text as="span">🎒</Text>
                      <Text as="span" flex={1}>
                        All institutions
                      </Text>
                      <Text as="span" fontSize="2xs" color="charcoal.300">
                        {institutionLens.totalScholars}
                      </Text>
                      {institutionLens.allActive && <Check />}
                    </HStack>
                  </Link>
                </Menu.Item>
              )}
            </>
          )}
          {isRemoteMode && (
            <>
              <Menu.Separator />
              <Menu.Item
                value="exit-remote"
                cursor="pointer"
                onClick={handleExitRemote}
              >
                <EyeSlash />
                Exit remote view
              </Menu.Item>
            </>
          )}
          {isImpersonating && (
            <>
              <Menu.Separator />
              <Menu.Item
                value="exit-impersonation"
                cursor="pointer"
                color="orange.700"
                fontWeight="600"
                disabled={exitingImpersonation}
                onClick={() => { void handleExitImpersonation(); }}
              >
                <EyeSlash />
                Exit — back to {impersonation?.adminName ?? "my account"}
              </Menu.Item>
            </>
          )}
          <Menu.Separator />
          {/* The scholar's one self-view: My Learning (/me) — identity,
              badges, strengths, growth, next adventures. Absorbed the old
              "/scholar/profile" profile-and-badges page. Not a toggle — the
              /me header names it and its logo is Back. */}
          {isScholar && (
            <Menu.Item value="my-learning" cursor="pointer" asChild>
              <Link href="/me" style={{ textDecoration: "none", color: "inherit" }}>
                <Medal />
                My Learning
              </Link>
            </Menu.Item>
          )}
          {/* The Workshop — the scholar's ideas for Rabbithole itself, a
              STANDING place reachable anytime (not only during Scholar's
              Prep). Opens the board directly. Scholar surfaces only; no
              badge/count (the no-inbox rule). */}
          {isScholar && (
            <Menu.Item value="workshop" cursor="pointer" asChild>
              <Link href="/scholar/workshop" style={{ textDecoration: "none", color: "inherit" }}>
                <Wrench />
                The Workshop
              </Link>
            </Menu.Item>
          )}
          {/* Scholars reach How it works through The Workshop. Adult audiences
              keep their direct, audience-aware transparency entry. */}
          {!isScholar && (
            <Menu.Item value="how-it-works" cursor="pointer" asChild>
              <Link href="/how-it-works" style={{ textDecoration: "none", color: "inherit" }}>
                <Eye />
                How it works
              </Link>
            </Menu.Item>
          )}
          {showParentEntry && !showContextSwitcher && (
            <Menu.Item value="parent-view" cursor="pointer" asChild>
              <Link href="/parent" style={{ textDecoration: "none", color: "inherit" }}>
                <Users />
                Parent view
              </Link>
            </Menu.Item>
          )}
          {showExitParent && !showContextSwitcher && (
            <Menu.Item value="exit-parent" cursor="pointer" asChild>
              <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>
                <ArrowLeft />
                Back to my dashboard
              </Link>
            </Menu.Item>
          )}
          {isAdmin && (
            <Menu.Item value="admin" cursor="pointer" asChild>
              <Link href="/admin/accounts" style={{ textDecoration: "none", color: "inherit" }}>
                <Gear />
                Admin tools
              </Link>
            </Menu.Item>
          )}
          {/* School (the staff school shell, /school) is no longer an account-menu
              entry — it is a top-level destination in the staff nav strip
              (`components/TeacherNavTabs.tsx`), the same as every other staff
              surface. */}
          {isStaff && (
            <>
              <Menu.Separator />
              <Menu.Item value="connect-ai" cursor="pointer" asChild>
                <Link href="/connect" style={{ textDecoration: "none", color: "inherit" }}>
                  <Plugs />
                  Connect an AI assistant
                </Link>
              </Menu.Item>
            </>
          )}
          {/* Report a bug — one entry for every signed-in role. Stays visible
              during view-as (impersonation/remote): that state is exactly what
              a report should capture, and the backend allows this write. */}
          <Menu.Item
            value="report-bug"
            cursor="pointer"
            onClick={() => {
              void openBugReport();
            }}
          >
            <Bug />
            Report a bug
          </Menu.Item>
          <Menu.Item
            value="account"
            cursor="pointer"
            onClick={() => setShowProfile(true)}
          >
            <User />
            Account details
          </Menu.Item>
          <Menu.Item
            value="sign-out"
            cursor="pointer"
            onClick={() => { void onSignOut(); }}
          >
            <SignOut />
            Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Positioner>
      {user && (
        <ProfileEditModal
          open={showProfile}
          onClose={() => setShowProfile(false)}
          user={user}
        />
      )}
      <BugReportDialog
        open={showBugReport}
        initialCapture={capturedShot}
        onScreenshotDiscarded={() => setCapturedShot(null)}
        onClose={() => {
          setShowBugReport(false);
          setCapturedShot(null);
        }}
      />
    </Menu.Root>
  );
}

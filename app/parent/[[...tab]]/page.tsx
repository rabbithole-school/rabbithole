"use client";

import { Fragment, Suspense, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "convex/react";
import { useSignOut } from "@/hooks/useSignOut";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Box, Flex, HStack, Spinner, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { isTeacherRole, type Role } from "@/convex/lib/roles";
import { AppLogo } from "@/components/AppLogo";
import { AppHeader } from "@/components/AppHeader";
import { AccountMenu } from "@/components/AccountMenu";
import { BotIconButton } from "@/components/BotIconButton";
import { ParentDashboard } from "@/components/ParentDashboard";
import { ParentAideDock } from "@/components/parent/ParentAideDock";
import {
  ParentChildSwitcher,
  ParentNavTabs,
} from "@/components/parent/ParentNav";
import {
  APPLICANT_PORTAL_MARKER,
  parentPortalMode,
  parentSignInHref,
  parentTabFromPath,
} from "@/components/parent/parentTabs";
import { PRIMARY_INSTITUTION_BRAND } from "@/lib/primaryInstitutionBrand";
import {
  AideDockProvider,
  useAideDock,
} from "@/components/aide/AideDockProvider";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

export default function ParentPage() {
  return (
    <Suspense
      fallback={
        <Flex minH="100vh" bg="gray.50" align="center" justify="center">
          <Spinner size="xl" color="violet.500" />
        </Flex>
      }
    >
      <ParentView />
    </Suspense>
  );
}

/**
 * The parent portal — for any GUARDIAN (the parent CONTEXT), not just
 * `parent`-role accounts. A staff/admin user who is also a guardian of their
 * own child reaches this via the account menu's "Parent view"; parent-role
 * accounts land here by default. Access is gated on having a parent context
 * (≥1 guardianship), so a non-guardian is bounced to their own home.
 *
 * TEACHER PREVIEW — `/parent?remote=<scholarId>` ("View as parent" on the
 * teacher dashboard, the twin of `/scholar?remote=`): a teacher stays
 * themselves and renders this same portal for ONE scholar whose learning
 * record they can already read, so they see what that family sees. The preview is read-only and
 * non-sensitive by construction: the backend reads accept staff-with-access
 * (`requireGuardianOrStaffPreview`), while the family-only surfaces (health
 * forms, library card, messages, the parent chat) stay guardian-gated and
 * render placeholders here.
 */
function ParentView() {
  const { user, isLoading } = useCurrentUser();
  const [signOut] = useSignOut();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Staff preview ("View as parent"). Only a teacher role may preview (the
  // backend gate is teacher-membership access, never operations-only staff);
  // anyone else with a stray `?remote=` gets the ordinary guardian portal.
  const remoteParam = searchParams.get("remote");
  const isPreview = !!(
    remoteParam && user && isTeacherRole(user.role as Role | undefined)
  );
  const hasParentContext = useQuery(
    api.parents.hasParentContext,
    user && !isPreview ? {} : "skip",
  );
  // Applicant-only mode is decided on the server (parents.applicantContext):
  // a parent with no linked child whose family applied to the primary
  // institution. They see only Admissions.
  const applicantContext = useQuery(
    api.parents.applicantContext,
    user && !isPreview ? {} : "skip",
  );
  const applicantOnly = !isPreview && applicantContext?.applicantOnly === true;
  const ownChildren = useQuery(
    api.parents.listMyChildren,
    user && !isPreview ? {} : "skip",
  );
  const previewChild = useQuery(
    api.parents.previewChildForStaff,
    isPreview ? { scholarId: remoteParam } : "skip",
  );
  const threads = useQuery(
    api.parentMessages.listMyGuardianThreads,
    user && !isPreview ? {} : "skip",
  );
  const children = isPreview
    ? previewChild === undefined
      ? undefined
      : previewChild
        ? [previewChild]
        : []
    : ownChildren;
  const currentQuery = searchParams.toString();
  const currentPath = `${pathname}${currentQuery ? `?${currentQuery}` : ""}`;
  const requestedChild = searchParams.get("child");
  const activeChildRecord =
    children?.find((child) => child._id === requestedChild) ??
    children?.[0] ??
    null;
  const activeChild = activeChildRecord?._id ?? null;
  const programGuest =
    activeChildRecord?.enrollmentStanding === "program_guest";
  const mode = parentPortalMode({ applicantOnly, programGuest });
  const activeTab = parentTabFromPath(pathname, mode);
  // Portfolio's third segment is a course: a scholarGroup id, or "other" for
  // the work that isn't filed to one. Every other tab ignores it.
  const courseSegment = pathname.split("/")[3] ?? null;
  const activeCourseId = activeTab === "portfolio" ? courseSegment : null;
  // In preview every in-portal navigation carries the remote scholar so the
  // tabs keep rendering the same family's view.
  const childQuery = isPreview
    ? `?remote=${remoteParam}`
    : activeChild
      ? `?child=${activeChild}`
      : "";

  // Remember applicant mode for this tab, so an expired session sends the
  // family back to the school-branded sign-in (see parentSignInHref).
  useEffect(() => {
    if (isPreview || applicantContext === undefined) return;
    try {
      if (applicantContext.applicantOnly) {
        window.sessionStorage.setItem(APPLICANT_PORTAL_MARKER, "1");
      } else {
        window.sessionStorage.removeItem(APPLICANT_PORTAL_MARKER);
      }
    } catch {
      // Storage blocked: the /parent/admissions path rule still applies.
    }
  }, [applicantContext, isPreview]);


  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      let applicantSeen = false;
      try {
        applicantSeen =
          window.sessionStorage.getItem(APPLICANT_PORTAL_MARKER) === "1";
      } catch {
        applicantSeen = false;
      }
      router.replace(parentSignInHref(currentPath, applicantSeen));
      return;
    }
    if (isPreview) return; // staff preview: access is per-scholar, checked below
    // Wait for the guardianship check before deciding.
    if (hasParentContext === false) {
      router.replace("/"); // not a guardian → their own home
    }
  }, [user, isLoading, isPreview, hasParentContext, router, currentPath]);

  if (
    isLoading ||
    !user ||
    (!isPreview &&
      (hasParentContext === undefined ||
        hasParentContext === false ||
        applicantContext === undefined)) ||
    children === undefined
  ) {
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  if (isPreview && children.length === 0) {
    // The remote id isn't a scholar this staff member can reach — say so
    // rather than rendering an empty family portal.
    return (
      <Flex minH="100vh" bg="gray.50" align="center" justify="center" p={6}>
        <Text fontFamily="body" color="charcoal.500" textAlign="center">
          That scholar isn&apos;t in your school context, so there&apos;s no
          parent view to preview.
        </Text>
      </Flex>
    );
  }

  // No aide dock in a staff preview: the parent chat streams AS a guardian,
  // and without the provider the Math tab's "ask the bot" chips (which seed
  // that composer) stay hidden too. An applicant has no child to ask about,
  // so they get no dock either.
  const showAide = !programGuest && !isPreview && !applicantOnly;
  const Shell = isPreview || applicantOnly ? Fragment : AideDockProvider;

  return (
    <Shell>
      <Flex h={VIEWPORT_SHELL_HEIGHT} bg="gray.50" flexDir="column">
        <AppHeader>
          {applicantOnly ? (
            <ApplicantBrand href={`/parent${childQuery}`} />
          ) : (
          <Box mr={6} display={{ base: "none", lg: "block" }}>
            <Link
              href={`/parent${childQuery}`}
              aria-label="Home"
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <AppLogo variant="dark" size={28} />
            </Link>
          </Box>
          )}
          <ParentNavTabs
            activeKey={activeTab}
            messagesUnread={(threads ?? []).some((thread) => thread.hasUnread)}
            mode={mode}
            childId={activeChild}
            hrefQuery={childQuery}
            onNavigate={(tab) =>
              router.push(`/parent/${tab}${childQuery}`, { scroll: false })
            }
            onHomeNavigate={() => router.push(`/parent${childQuery}`)}
          />
          <HStack ml="auto" gap={1}>
            {/* The parent chat streams AS a guardian — not part of a staff
                preview. The account menu carries the "Viewing as / Exit"
                pill for the preview, the same as the scholar remote view. */}
            {showAide && <ParentAideToggle />}
            <ParentChildSwitcher
              childOptions={children}
              activeChild={activeChild}
              onSelect={(childId) =>
                router.replace(`${pathname}?child=${childId}`, {
                  scroll: false,
                })
              }
            />
            <AccountMenu onSignOut={signOut} applicantMode={applicantOnly} />
          </HStack>
        </AppHeader>
        {isPreview && activeChildRecord && (
          <Box
            bg="amber.50"
            borderBottomWidth="1px"
            borderColor="amber.200"
            px={4}
            py={2}
          >
            <Text
              fontFamily="body"
              fontSize="sm"
              color="charcoal.600"
              textAlign="center"
            >
              Previewing the parent view for {activeChildRecord.name}. This is
              what {activeChildRecord.name}&apos;s family sees. Family-only
              surfaces (health forms, library card, messages, chat) aren&apos;t
              shown.
            </Text>
          </Box>
        )}
        {/* Body + docked aide as a flex row (the teacher dashboard's idiom):
            opening the aide PUSHES the body rather than covering it; closed,
            the dock renders nothing and the body takes the full width. The
            body keeps definite height + minH={0} so it stays the scroll
            container (minH=100vh would grow with content and never scroll). */}
        <Flex flex={1} minH={0} overflow="hidden">
          <Box
            flex={1}
            minW={0}
            overflow={activeTab === "messages" ? "hidden" : "auto"}
          >
            <ParentDashboard
              childOptions={children}
              activeChild={activeChild}
              tab={activeTab}
              courseId={activeCourseId}
              hrefQuery={childQuery}
              preview={isPreview}
              applicantOnly={applicantOnly}
            />
          </Box>
          {showAide && <ParentAideDock activeChildId={activeChild} />}
        </Flex>
      </Flex>
    </Shell>
  );
}

/** The header Robot — the single toggle for the parent's docked aide, the
 *  same affordance (and canonical <BotIconButton>) as the teacher header. */
function ParentAideToggle() {
  const { open, toggle } = useAideDock();
  return (
    <BotIconButton
      onClick={toggle}
      active={open}
      ariaLabel="Chat"
      tooltipText={open ? "Hide chat" : "Ask about your child's learning"}
    />
  );
}

/** Applicant-mode header: the school's crest and name, with "Admissions"
 *  beside it, in place of the Rabbithole logo. */
function ApplicantBrand({ href }: { href: string }) {
  return (
    <Link
      href={href}
      aria-label={`${PRIMARY_INSTITUTION_BRAND.schoolName} admissions home`}
      style={{ display: "inline-flex", alignItems: "center", marginRight: 24 }}
    >
      <HStack gap={2.5}>
        {PRIMARY_INSTITUTION_BRAND.logoSrc && (
          // eslint-disable-next-line @next/next/no-img-element -- static crest from /public; next/image adds nothing here
          <img
            src={PRIMARY_INSTITUTION_BRAND.logoSrc}
            alt=""
            width={32}
            height={32}
            style={{ display: "block" }}
          />
        )}
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="lg"
          color="navy.500"
          whiteSpace="nowrap"
        >
          {PRIMARY_INSTITUTION_BRAND.schoolName}
        </Text>
        <Text
          fontFamily="heading"
          fontSize="lg"
          color="charcoal.400"
          whiteSpace="nowrap"
        >
          Admissions
        </Text>
      </HStack>
    </Link>
  );
}

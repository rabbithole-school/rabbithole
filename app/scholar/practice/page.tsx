"use client";

import { Suspense } from "react";
import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { useConvex, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";
import { resolvePracticeDomainSlug } from "@/convex/lib/practice/domains";
import { PracticeSession } from "@/components/practice/PracticeSession";
import { createRehearseGrader } from "@/components/practice/rehearseGrader";
import { isStaffSelfRehearsal } from "@/components/practice/rehearseZeroWrite";
import { resolveTargetedPractice } from "@/components/practice/targetedPractice";
import { QUICK_FACTS_PROBE_SEED, quickFactsEntryVerdict } from "./quickFactsEntry";
import { FAST_MATH_NAME_INLINE } from "@/shared/fastMathName";
import { Box, Flex, HStack, Text } from "@chakra-ui/react";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

type PracticeScopeSource = "math_plan" | "legacy_standing" | "open_default";

function Loading({ msg = "Loading…" }: { msg?: string }) {
  return (
    <Flex minH="100vh" align="center" justify="center" bg="#f6f4ef">
      <Text color="#65706a">{msg}</Text>
    </Flex>
  );
}

function PracticeError({ message }: { message: string }) {
  return (
    <Flex minH="100vh" align="center" justify="center" bg="#f6f4ef" px={6}>
      <Box maxW="420px" textAlign="center">
        <Text fontSize="lg" fontWeight="700" color="#2f3833">
          Practice couldn’t start
        </Text>
        <Text mt={2} color="#65706a">
          {message}
        </Text>
        <Link href="/scholar/map?view=tree" style={{ color: "#1d4ed8", display: "inline-block", marginTop: 16 }}>
          Back to your map
        </Link>
      </Box>
    </Flex>
  );
}

function PracticeInner() {
  const { user, isLoading } = useCurrentUser();
  const searchParams = useSearchParams();
  const activityId = searchParams.get("activity") as Id<"activities"> | null;
  const skillKey = searchParams.get("skill")?.trim() || null;
  const domainParam = searchParams.get("domain");
  // Resolve the raw ?domain= to a REGISTERED slug (accepting natural aliases like
  // "fractions" → "fraction-arithmetic"). An UNKNOWN value resolves to null and is
  // then treated exactly like no ?domain= at all — so a bad/guessed domain falls
  // to the scholar's normal auto-blend instead of silently defaulting to
  // whole-number arithmetic and restarting its placement.
  const resolvedDomain = resolvePracticeDomainSlug(domainParam);
  const choiceDomain = resolvePracticeDomainSlug(searchParams.get("choiceDomain"));
  const choiceStrand = searchParams.get("choiceStrand");
  // PR2 Surface 1/2 revives the standalone check-in as an opt-IN accelerator:
  // `?checkin=all` (the Home CTA's link) requests the full multi-domain
  // orchestrator instead of Option D's ambient `· mapping` playlist band. Any
  // other value (or its absence) keeps the default folded-mapping path.
  const checkInAllRequested = searchParams.get("checkin") === "all";
  // Stretch-tile entry: `?stretch=1` routes here from PlaylistCard's stretch
  // href — wires stretchHint into practiceSession (reviews-first + challenge
  // tail). Mirrors native's practice.tsx stretchHint param handling.
  const isStretchEntry = searchParams.get("stretch") === "1";
  // `?blend=1` marks a `?domain=` that PlaylistCard DERIVED from the scholar's
  // own daily blend (or their header switcher pick) rather than a deep link or
  // a teacher's pin. Home previews that entry with the `· mapping` band folded
  // in, so the run must fold it too or preview and serve disagree. Exactly
  // native's contract (native/src/lib/practiceDeepLinkParams.ts
  // `foldsMappingBand`), which was written to mirror the decision this page
  // used to be able to make on its own — before Home started resolving the
  // blend's single domain client-side to honor a switcher pick.
  const isBlendEntry = searchParams.get("blend") === "1";
  // Quick-facts entry: `?quickFacts=1` is the scholar Math tab's Calculator
  // license card action. It runs the DEDICATED backend contract
  // (`startQuickFactsPractice`) — a direct Fast math round from the canonical
  // fact generator — not an ordinary practice run with an opportunistic Sprint
  // band. The page resolves availability HERE so an unavailable round gets the
  // page's honest "couldn't start" treatment instead of silently falling
  // through into a normal session while claiming to be fast math.
  const quickFactsRequested = searchParams.get("quickFacts") === "1";
  const remoteSlug = searchParams.get("remote");
  const isTeacher = !!user && isTeacherRole(user.role);
  const remoteScholar = useQuery(
    api.scholars.resolveSlug,
    isTeacher && remoteSlug ? { slug: remoteSlug } : "skip",
  );
  // ── REHEARSE MODE — a ROUTE INVARIANT, not an optional parameter ──────────
  // Any STAFF member (teacher, curriculum designer, admin, operations staff — every
  // non-scholar role) practicing as THEMSELVES can only ever REHEARSE: a real
  // submit from this surface would mint practiceMastery / spaced-repetition rows
  // under a staff account (the traced defect). So the moment the signed-in user
  // is staff and there is no `?remote=` scholar (i.e. scholarId is their OWN id),
  // the session is zero-write — **param or no param**. `?rehearse=1` on the
  // teacher link is now only how that link EXPRESSES intent; it is not the thing
  // that protects the data, so an old bookmark, a hand-edited URL, or a
  // curriculum designer (whom the Content surface admits but `isTeacherRole`
  // rejected) can no longer fall through to the real submitAnswer path.
  //
  // The `?remote=` teacher-drives-a-scholar flow is deliberately NOT rehearsal
  // (it writes to that scholar's own record); it is excluded here by
  // `!remoteScholar`.
  const convex = useConvex();
  const rehearseActive = isStaffSelfRehearsal(user?.role, !!remoteScholar);
  const rehearseGrader = useMemo(
    () =>
      rehearseActive
        ? createRehearseGrader((args) =>
            convex.query(api.practiceSkills.rehearseGradeItem, args),
          )
        : undefined,
    [rehearseActive, convex],
  );
  const skillNode = useQuery(
    api.nodeNeighbourhood.neighbourhood,
    user && skillKey ? { nodeKey: skillKey } : "skip",
  );
  const targetedPractice = resolveTargetedPractice(skillKey, skillNode);

  // Resolve a problem-set activity to its target skills (scoped practice).
  const problemSet = useQuery(
    api.practiceSkills.problemSetSkills,
    activityId && !skillKey ? { activityId } : "skip",
  );

  const scholarIdForStanding = remoteScholar?.id ?? user?._id ?? null;
  // An authored Math plan is the current source of truth for serving. Wait for
  // it before considering the legacy standing row, so an older pin cannot mount
  // a session for one render while the plan subscription is still resolving.
  const mathPlan = useQuery(
    api.mathPlans.myPlan,
    !activityId && !skillKey && !resolvedDomain && !quickFactsRequested && scholarIdForStanding
      ? {}
      : "skip",
  ) as { scopeSource: PracticeScopeSource } | undefined;
  // A FIXED probe seed: this query only asks whether a Quick-facts round exists
  // for this scholar, and availability is a property of their fact ledger, not
  // of the seed (the seed only shuffles equal-priority facts and their operand
  // rendering). The run's own seed is rolled inside PracticeSession when it
  // serves — keeping render pure and the probe result stable across re-renders.
  const quickFacts = useQuery(
    api.practiceSkills.startQuickFactsPractice,
    quickFactsRequested && scholarIdForStanding
      ? { scholarId: scholarIdForStanding, seed: QUICK_FACTS_PROBE_SEED }
      : "skip",
  );
  // A standing (open-ended) practice assignment picks the domain + a pinned
  // strand hint — skipped entirely for problem-set-scoped practice (?activity=
  // is a more specific mode), for the quick-facts entry, or when a valid domain
  // is already given in the URL.
  const standing = useQuery(
    api.standingPractice.myActiveStanding,
    !activityId && !skillKey && !resolvedDomain && !quickFactsRequested && scholarIdForStanding
      ? { scholarId: scholarIdForStanding }
      : "skip",
  );
  const hasExplicitMathPlan = mathPlan?.scopeSource === "math_plan";
  const effectiveStanding = hasExplicitMathPlan ? null : standing;

  // Auto-blend: with NO teacher-pinned assignment (and no valid ?domain= /
  // problem set), a scholar's playlist blends every domain they've STARTED into
  // one interleaved mixed-domain session — so practice isn't stuck on
  // whole-number arithmetic forever. Only queried once we know there's no
  // standing assignment to honor (standing === null).
  const wantsAutoBlend =
    !activityId &&
    !skillKey &&
    !resolvedDomain &&
    !quickFactsRequested &&
    mathPlan !== undefined &&
    effectiveStanding === null;
  const domainsInfo = useQuery(
    api.practiceSkills.domainsForScholar,
    wantsAutoBlend && scholarIdForStanding ? { scholarId: scholarIdForStanding } : "skip",
  );

  if (isLoading) return <Loading />;
  if (!user) return <Loading msg="Please sign in to practice." />;
  if (remoteSlug && !isTeacher) {
    return <Loading msg="Remote practice is teacher-only." />;
  }
  if (remoteSlug && remoteScholar === undefined) {
    return <Loading msg="Loading scholar practice…" />;
  }
  if (remoteSlug && remoteScholar === null) {
    return <Loading msg="No scholar found for remote practice." />;
  }
  if (skillKey && targetedPractice === undefined) return <Loading msg="Loading that skill…" />;
  if (targetedPractice && "error" in targetedPractice) {
    return <PracticeError message={targetedPractice.error} />;
  }
  if (activityId && !skillKey && problemSet === undefined) {
    return <Loading msg="Loading your problem set…" />;
  }
  // ── Quick-facts entry (`?quickFacts=1`) ───────────────────────────────────
  // Its own mode, resolved before every playlist gate below: it neither reads a
  // standing assignment nor blends domains. The direct contract's own
  // `available` verdict decides whether a round exists — an unavailable one gets
  // the page's ordinary "couldn't start" screen, never a substitute session.
  if (quickFactsRequested) {
    const verdict = quickFactsEntryVerdict({
      rehearsing: rehearseActive,
      run: quickFacts,
    });
    if (verdict.kind === "loading")
      return <Loading msg={`Loading ${FAST_MATH_NAME_INLINE}…`} />;
    if (verdict.kind === "error") {
      return <PracticeError message={verdict.message} />;
    }
  }
  // Wait for the standing-assignment query to resolve before mounting the
  // session. Otherwise, while `standing` is still `undefined`, this falls through
  // to the auto-blend branch with an UNRESOLVED domain, mounting PracticeSession
  // once with empty session inputs and then again once the domain settles. That
  // transient first mount serves (and its loadSession clears) against the wrong
  // inputKey — which silently discards a persisted in-progress run before the
  // real inputs can restore it (re-entry durability, pilot #1). Gating here means
  // PracticeSession mounts a single time with settled inputs.
  if (
    !activityId &&
    !skillKey &&
    !resolvedDomain &&
    !quickFactsRequested &&
    scholarIdForStanding &&
    standing === undefined &&
    mathPlan?.scopeSource !== "math_plan"
  ) {
    return <Loading msg="Loading your practice…" />;
  }
  if (
    !activityId &&
    !skillKey &&
    !resolvedDomain &&
    !quickFactsRequested &&
    scholarIdForStanding &&
    mathPlan === undefined
  ) {
    return <Loading msg="Loading your practice…" />;
  }
  if (wantsAutoBlend && domainsInfo === undefined) return <Loading msg="Loading your playlist…" />;

  const scholarId = remoteScholar?.id ?? user._id;
  // Domain precedence: a valid resolved ?domain= wins; then a problem-set
  // activity's own domain (so probability skillKeys load against the probability
  // graph, not the default whole-number one); then the scholar's standing
  // assignment; then (no assignment at all) an auto-blend of every domain they've
  // started. An unresolved ?domain= (resolvedDomain === null) counts as "no
  // domain" here, so it flows into the standing/auto-blend path.
  //
  // `domains` (a SET) drives a MIXED playlist — several domains interleaved. It's
  // set only when there are ≥2 domains to blend; otherwise `domain` alone drives
  // the ordinary single-domain session (fully back-compatible).
  let domain: string | undefined;
  let domains: string[] | undefined;
  // The DEFAULT (no-pin) entry runs the MIXED multi-domain check-in for an
  // unplaced scholar (see PracticeSession) — set only in the auto-blend branch.
  let checkInAllDomains = false;
  // Option D: fold the `· mapping` band into the default playlist entry (and a
  // deliberate unmapped-domain pick), replacing the standalone check-in gate.
  let includeMapping = false;
  if (quickFactsRequested && quickFacts?.available) {
    // The direct Fast math round is whole-number arithmetic by contract; the
    // serve itself comes from `startQuickFactsPractice` inside the session.
    domain = quickFacts.domain;
  } else if (targetedPractice && "skillKeys" in targetedPractice) {
    domain = targetedPractice.domain;
  } else if (resolvedDomain) {
    domain = resolvedDomain;
    // Option D (F1): a You Pick EXPLICIT-domain entry (`?choiceDomain=` matching
    // this `?domain=` — an out-of-set tile, mirroring native's out-of-set route)
    // folds the `· mapping` band SCOPED to this domain, exactly as `choicePreview`
    // previews it — instead of routing to the retired standalone placement gate
    // (`<Placement>` via `needsPlacement`, which `includeMapping` suppresses). A
    // A bare `?domain=` (a standing pin, a direct/deep link) keeps its own path,
    // while `?blend=1` (Home's own derived blend, or its switcher pick) folds
    // the band in — that is exactly the composition the Home preview showed.
    if (isBlendEntry || (choiceDomain && choiceDomain === resolvedDomain)) {
      includeMapping = true;
    }
  } else if (activityId) {
    domain = problemSet?.domain;
  } else if (effectiveStanding) {
    // A standing assignment is the teacher's pin — honor it exactly (a pinned set
    // of ≥2 → mixed; a single pinned domain → single, no auto-blend override).
    domains =
      effectiveStanding.domains && effectiveStanding.domains.length > 1
        ? effectiveStanding.domains
        : undefined;
    domain = effectiveStanding.domain;
  } else {
    // No pin: blend the scholar's started domains. A whole-number-only scholar
    // blends to just whole-number (single, no regression). An unplaced scholar
    // takes the mixed check-in first (folding in every unreached domain).
    const started = (domainsInfo ?? []).filter((d) => d.started).map((d) => d.domain);
    if (choiceDomain && !started.includes(choiceDomain)) {
      // A "You Pick" tile for a domain OUTSIDE the scholar's started/blended
      // set — Option D deliberate entry (Q6): serve NOW, recomposing the
      // playlist to LEAD with the picked domain's `· mapping` band (practiceSession
      // leads with the resolved `domain` when it's still unmapped). Reuses the
      // exact single-domain tile machinery — no separate placement screen.
      domain = choiceDomain;
      includeMapping = true;
    } else {
      domains = started.length > 1 ? started : undefined;
      domain = started[0];
      // Option D (OPTION_D_RULINGS) retired the STANDING gate — the default
      // no-pin entry ordinarily folds mapping items into the playlist
      // (`includeMapping`) rather than routing to the separate placement
      // screen. PR2 Surface 1/2 REVIVES that placement screen as an opt-IN
      // accelerator: `?checkin=all` (the Home CTA's link — see
      // components/practice/CheckInHomeCard.tsx) explicitly requests the full
      // multi-domain check-in instead of the ambient mapping band.
      checkInAllDomains = checkInAllRequested;
      includeMapping = !checkInAllRequested;
    }
  }
  const isMixedSession = !!(domains && domains.length > 1);
  // An explicit bounded-choice link wins over a standing assignment's pin. The
  // domain travels with the strand so mixed sessions apply it only to its queue.
  const standingPinnedStrand =
    !activityId && !isMixedSession ? effectiveStanding?.pinnedStrands?.[0] : undefined;
  const choiceHint =
    choiceDomain && choiceStrand
      ? { domain: choiceDomain, strand: choiceStrand }
      : standingPinnedStrand && domain
        ? { domain, strand: standingPinnedStrand }
        : undefined;
  // A standing assignment's off-limits strands — never served (enforced in
  // practiceSession → the scheduler). Skipped for problem-set-scoped practice
  // and for a mixed playlist because exclusions are not domain-qualified.
  const excludedStrands =
    !activityId && !isMixedSession ? effectiveStanding?.excludedStrands : undefined;

  return (
    // The app shell locks body scroll (globals.css: body overflow:hidden), so
    // this view owns its own vertical scroll — otherwise a tall state (a long
    // pad, or the session-complete screen with the re-probe offer) is clipped
    // and unreachable. A definite height + overflowY makes it scroll on web + the iPad shell.
    <Box h={VIEWPORT_SHELL_HEIGHT} overflowY="auto" bg="#f6f4ef">
      {remoteScholar && (
        <HStack
          justify="space-between"
          px={4}
          py={3}
          borderBottom="1px solid #e2dccf"
          bg="#fffdfa"
          fontSize="14px"
          color="#5a655d"
        >
          <Text fontWeight="600">
            Rehearsing as @{remoteScholar.username ?? remoteScholar.id}
          </Text>
          <Link
            href={`/teacher/scholars/${remoteScholar.username ?? remoteScholar.id}/skills`}
            style={{ color: "#1d4ed8", textDecoration: "none" }}
          >
            Back to Math skills →
          </Link>
        </HStack>
      )}
      <PracticeSession
        // Key by MODE (and scholar) so a URL transition can NEVER convert a live
        // run into a read-only one — or vice versa — in place: React remounts,
        // discarding the old run's state and callbacks, whenever the mode flips.
        // The quick-facts entry is its own mode for the same reason: it must
        // never continue an ordinary playlist run in place.
        key={`${rehearseActive ? "rehearse" : "live"}${quickFactsRequested ? ":quickfacts" : ""}:${scholarId}`}
        scholarId={scholarId}
        skillKeys={
          quickFactsRequested
            ? undefined
            : targetedPractice && "skillKeys" in targetedPractice
              ? targetedPractice.skillKeys
              : problemSet?.targetSkillKeys
        }
        problemSetActivityId={
          quickFactsRequested ? undefined : problemSet ? activityId ?? undefined : undefined
        }
        activityTitle={quickFactsRequested ? undefined : problemSet?.title}
        domain={domain}
        domains={quickFactsRequested ? undefined : domains}
        choiceHint={quickFactsRequested ? undefined : choiceHint}
        excludedStrands={quickFactsRequested ? undefined : excludedStrands}
        isRemote={!!remoteScholar}
        checkInAllDomains={!quickFactsRequested && checkInAllDomains}
        stretchHint={(!quickFactsRequested && isStretchEntry) || undefined}
        includeMapping={!quickFactsRequested && includeMapping}
        quickFacts={quickFactsRequested || undefined}
        rehearseGrader={rehearseGrader}
      />
    </Box>
  );
}

export default function PracticePage() {
  return (
    <Suspense fallback={<Loading />}>
      <PracticeInner />
    </Suspense>
  );
}

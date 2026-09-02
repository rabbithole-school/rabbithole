"use client";

/**
 * SummitHandoff — the scholar-facing "you've climbed a whole domain" moment
 * (Stage 2 / roadmap D5). Rendered when the practice
 * queue is empty, it reads the scholar's per-domain progress and picks one of
 * three honest states:
 *   • domain EXHAUSTED (every skill demonstrated) → a summit celebration, optional
 *     Go Deeper work in-domain when available, and a switcher for already-started domains.
 *   • access-complete but not exhausted → a quiet "placed through" handoff.
 *   • merely caught up (unlocked frontier cleared, locked skills remain) → the
 *     gentle "check back later" copy, still with a switcher to any other domain
 *     they've already started.
 *
 * Backed by `api.practiceSkills.domainsForScholar` (every seeded registered
 * domain, tagged started/exhausted). Navigation routes to
 * `/scholar?highlightDomain=…` — the scholar-home CHOOSER with that domain's
 * tile preselected, never straight into practice (raise-the-ceiling
 * consolidation, f7: the summit hand-off is a REDIRECT into the existing
 * "You Pick" chooser, not its own destination) — preserving the current query
 * string (notably `?remote=` for teacher rehearsal) and dropping the
 * more-specific `?activity=` scope.
 *
 * ⚠️ KID-FACING COPY (Andy/Opus review-gated): the celebration + invitation
 * wording below is a first pass pending the plan's copy-review gate. It aims
 * for "you climbed the whole mountain" pride + a curiosity pull to the next
 * domain — never a deficit/leaderboard framing.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Box, Button, Flex, Heading, Text, VStack } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { selectSummitHandoff, selectMixedSummitHandoff, type SummitDomain } from "@/shared/practiceSummit";

/** Build a `/scholar?highlightDomain=…` href that preserves the current query
 *  string (e.g. `?remote=` for teacher rehearsal) and drops the narrower
 *  `?activity=` scope. Routes to the scholar-home CHOOSER with the domain's
 *  tile preselected — never straight into practice — so the summit hand-off
 *  reuses the SAME "You Pick" surface every other scholar choice does
 *  (raise-the-ceiling consolidation, f7: no net-new standing destination). */
function useDomainHref() {
  const params = useSearchParams();
  return useMemo(() => {
    const base = new URLSearchParams(params?.toString() ?? "");
    base.delete("activity");
    return (domain: string) => {
      const q = new URLSearchParams(base);
      q.set("highlightDomain", domain);
      return `/scholar?${q.toString()}`;
    };
  }, [params]);
}

export function SummitHandoff({
  scholarId,
  domain,
  domains: domainSet,
}: {
  scholarId: Id<"users">;
  /** The session's effective domain (undefined ⇒ the default, first-listed). */
  domain: string | undefined;
  /** A MIXED playlist's blended domain set (≥2). When present, the empty queue
   *  means EVERY blended domain is caught-up/summited, so we render the
   *  playlist-level handoff instead of the single-domain one. */
  domains?: string[];
}) {
  const domains = useQuery(api.practiceSkills.domainsForScholar, { scholarId });
  const hrefFor = useDomainHref();

  // Until the read resolves, keep the original gentle empty-state copy so there
  // is no celebratory flash before we know whether this is a real summit.
  if (domains === undefined) {
    return <CaughtUpFallback />;
  }

  // ── MIXED playlist: the queue emptied across a blend of domains. ──
  if (domainSet && domainSet.length > 1) {
    const { domainsInSet, allExhausted, allPlacedThrough, switchable } = selectMixedSummitHandoff(
      domains,
      domainSet,
    );
    return (
      <VStack gap={5} maxW="440px">
        {allExhausted ? (
          <VStack gap={3}>
            <Heading size="md" textAlign="center">
              🏔️ You&apos;ve topped out every subject in this playlist!
            </Heading>
            <Text color="#65706a" textAlign="center">
              {domainsInSet.map((d) => d.label).join(" · ")} — all fluent.
              {" "}If more Go Deeper problems are available, you can keep
              exploring here. Your teacher will choose when it&apos;s time for a
              new primary domain.
            </Text>
          </VStack>
        ) : allPlacedThrough ? (
          <VStack gap={3}>
            <Heading size="md" textAlign="center">
              Placed through every subject in this playlist 🗺️
            </Heading>
            <Text color="#65706a" textAlign="center">
              Every subject now grants access, through practice or placement.
              Nothing&apos;s due right now. Reviews will bring placed skills back a
              few at a time.
            </Text>
          </VStack>
        ) : (
          <CaughtUpFallback />
        )}
        {switchable.length > 0 && <SwitchRow domains={switchable} hrefFor={hrefFor} />}
      </VStack>
    );
  }

  const { current, switchable, isSummit, placedThrough } = selectSummitHandoff(
    domains,
    domain,
  );

  return (
    <VStack gap={5} maxW="440px">
      {isSummit ? (
        <VStack gap={3}>
          <Heading size="md" textAlign="center">
            🏔️ You&apos;ve reached the summit of {current!.label}!
          </Heading>
          <Text color="#65706a" textAlign="center">
            Every skill here is fluent — you&apos;ve climbed the whole mountain.
            {" "}If more Go Deeper problems are available, you can keep
            exploring here. Your teacher will choose when it&apos;s time for a
            new primary domain.
          </Text>
        </VStack>
      ) : placedThrough ? (
        <VStack gap={3}>
          <Heading size="md" textAlign="center">
            Placed through all of {current!.label} 🗺️
          </Heading>
          <Text color="#65706a" textAlign="center">
            Nothing&apos;s due right now. Skills marked as placed become fluent
            as you demonstrate them in practice. Reviews will bring them back a
            few at a time.
          </Text>
        </VStack>
      ) : (
        <CaughtUpFallback />
      )}

      {switchable.length > 0 && <SwitchRow domains={switchable} hrefFor={hrefFor} />}
    </VStack>
  );
}

/** The original "nothing unlocked right now" message — a caught-up state that
 *  is NOT a summit (locked skills remain behind not-yet-fluent prereqs). */
function CaughtUpFallback() {
  return (
    <VStack gap={3}>
      <Heading size="md">Nothing to practice right now 🎉</Heading>
      <Text color="#65706a" textAlign="center" maxW="380px">
        You&apos;re caught up on everything that&apos;s unlocked. Check back
        later as new skills open up.
      </Text>
    </VStack>
  );
}

/** A modest "switch focus" row — one pill per other domain the scholar can move
 *  into. Deliberately quiet: it never gates or dims the current climb. */
function SwitchRow({
  domains,
  hrefFor,
}: {
  domains: SummitDomain[];
  hrefFor: (domain: string) => string;
}) {
  return (
    <Box
      w="100%"
      borderTop="1px solid #e2dccf"
      pt={4}
      mt={1}
    >
      <Text
        fontSize="12px"
        color="#8a9088"
        textTransform="uppercase"
        letterSpacing="0.05em"
        mb={2}
        textAlign="center"
      >
        Switch focus
      </Text>
      <Flex wrap="wrap" gap={2} justify="center">
        {domains.map((d) => (
          <Button
            key={d.domain}
            asChild
            size="xs"
            variant="outline"
            colorPalette="gray"
          >
            <Link href={hrefFor(d.domain)}>
              {d.label}
              {d.exhausted ? " ✓" : ""}
            </Link>
          </Button>
        ))}
      </Flex>
    </Box>
  );
}

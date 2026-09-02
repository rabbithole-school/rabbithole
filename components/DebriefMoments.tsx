"use client";

/**
 * The substantive half of Debrief — the curriculum (cohort-AGNOSTIC) design
 * read. After cohorts run an activity this surfaces the most interesting
 * real moments across EVERY run (mastery breakthroughs, flagged
 * misconceptions, strong signals, cross-domain insights), scored and triaged
 * keep / dismiss. Saved moments are where the teacher acts on the DESIGN:
 * log a private observation, steer a tutor, or hand the moment to the
 * Curriculum Bot to talk through a fix.
 *
 * Two horizons, kept distinct from the per-run, act-now read (that lives on
 * the Assignments Run page's Debrief tab, scoped to one cohort):
 *  1. CATCH + ACTION — the deck of moments, triaged, with per-moment moves.
 *  2. IMPROVE THE DESIGN — carry what the runs taught you into the next
 *     cohort (ask the bot for revisions, revise in Edit, add a follow-up),
 *     plus a pointer DOWN to where each live run is acted on.
 *
 * Deliberately NOT a swipe deck (per Andy) — a calm review list. Lives
 * inside the activity's Debrief tab, scoped to one activity.
 */
import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Spinner,
  Stack,
  Text,
  Textarea,
} from "@chakra-ui/react";
import {
  ArrowRight,
  Check,
  PencilSimpleLine,
  Robot,
  ThumbsDown,
  ThumbsUp,
} from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { formatRelative } from "@/lib/relativeTime";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import {
  designFixPrompt,
  reviseActivityPrompt,
} from "@/lib/curriculumBotPrompts";

type Source = "mastery" | "signal" | "connection";
type Kind = "misconception" | "breakthrough" | "mastery" | "signal" | "insight";

const KIND_STYLE: Record<Kind, { label: string; bg: string; color: string }> = {
  misconception: { label: "Misconception", bg: "red.100", color: "red.700" },
  breakthrough: { label: "Breakthrough", bg: "green.100", color: "green.700" },
  mastery: { label: "Mastery", bg: "teal.100", color: "teal.700" },
  signal: { label: "Signal", bg: "blue.100", color: "blue.700" },
  insight: { label: "Insight", bg: "violet.100", color: "violet.700" },
};

// A moment's natural observation type when a teacher logs it.
const OBS_TYPE: Record<Kind, "praise" | "concern" | "suggestion"> = {
  misconception: "concern",
  breakthrough: "praise",
  mastery: "praise",
  signal: "suggestion",
  insight: "praise",
};

type Moment = {
  source: Source;
  sourceId: string;
  kind: Kind;
  score: number;
  scholarId: Id<"users">;
  scholarName: string;
  sessionId: Id<"sessions">;
  label: string;
  excerpt: string;
  domain: string | null;
};

export function DebriefMoments({
  activityId,
  askAi,
}: {
  activityId: Id<"activities">;
  /** Hands a canned prompt to the Curriculum Bot pane (heavyweight moves). */
  askAi?: (prompt: string) => void;
}) {
  const deck = useQuery(api.keyMoments.forActivity, { activityId });
  const activity = useQuery(api.activities.get, { id: activityId });
  const runs = useQuery(api.keyMoments.runsForActivity, { activityId });
  const triage = useMutation(api.keyMoments.triage);

  if (deck === undefined) {
    return (
      <Flex justify="center" py={6}>
        <Spinner size="sm" color="violet.500" />
      </Flex>
    );
  }

  const activityTitle = activity?.title ?? "this activity";
  const setVerdict = (m: Moment, verdict: "kept" | "dismissed") =>
    void triage({ activityId, source: m.source, sourceId: m.sourceId, verdict });

  return (
    <Stack gap={6}>
      <Box>
        <Flex align="baseline" justify="space-between" mb={1}>
          <Text fontFamily="heading" fontWeight="700" color="navy.500">
            Key Moments
          </Text>
          <Text fontSize="2xs" color="charcoal.400">
            {deck.sessionCount} real session{deck.sessionCount === 1 ? "" : "s"} ·{" "}
            {deck.totalMoments} moment{deck.totalMoments === 1 ? "" : "s"}
            {runs && runs.length > 0
              ? ` · ${runs.length} run${runs.length === 1 ? "" : "s"}`
              : ""}
          </Text>
        </Flex>
        <Text fontSize="xs" color="charcoal.400" mb={3} lineHeight="1.5">
          Pulled from every cohort that&apos;s run this activity — patterns here
          are design signals for next time. To act on one run with named
          scholars, open it in Assignments.
        </Text>

        {deck.pending.length === 0 && deck.kept.length === 0 ? (
          <EmptyMoments hasSessions={deck.sessionCount > 0} />
        ) : (
          <Stack gap={2}>
            {deck.pending.map((m) => (
              <MomentCard key={`${m.source}:${m.sourceId}`} m={m}>
                <Button
                  size="2xs"
                  variant="outline"
                  colorPalette="green"
                  onClick={() => setVerdict(m, "kept")}
                >
                  <ThumbsUp /> Save for action
                </Button>
                <Button
                  size="2xs"
                  variant="ghost"
                  color="charcoal.400"
                  onClick={() => setVerdict(m, "dismissed")}
                >
                  <ThumbsDown /> Dismiss
                </Button>
              </MomentCard>
            ))}
          </Stack>
        )}
      </Box>

      {deck.kept.length > 0 && (
        <Box>
          <Text fontFamily="heading" fontWeight="700" color="navy.500" mb={2}>
            Saved — act on these
          </Text>
          <Stack gap={2}>
            {deck.kept.map((m) => (
              <SavedMoment
                key={`${m.source}:${m.sourceId}`}
                m={m}
                activityTitle={activityTitle}
                askAi={askAi}
                onUnsave={() => setVerdict(m, "dismissed")}
              />
            ))}
          </Stack>
        </Box>
      )}

      <DesignMoves
        activityTitle={activityTitle}
        lessonId={activity?.lessonId ?? null}
        askAi={askAi}
      />

      {runs && runs.length > 0 && <LiveRuns runs={runs} />}
    </Stack>
  );
}

function MomentCard({ m, children }: { m: Moment; children: React.ReactNode }) {
  const style = KIND_STYLE[m.kind] ?? KIND_STYLE.signal;
  return (
    <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={3}>
      <Stack gap={1} minW={0}>
        <Text fontSize="sm" fontWeight="600" color="charcoal.600">
          {m.label}
        </Text>
        <HStack gap={2} flexWrap="wrap" align="center">
          <Badge bg={style.bg} color={style.color} fontFamily="heading" fontSize="2xs" flexShrink={0}>
            {style.label}
          </Badge>
          <Text fontSize="2xs" color="charcoal.400">
            {m.scholarName}
            {m.domain ? ` · ${m.domain}` : ""}
          </Text>
        </HStack>
        <Text fontSize="xs" color="charcoal.500">
          {m.excerpt}
        </Text>
        <HStack gap={2} pt={1} flexWrap="wrap">
          {children}
        </HStack>
      </Stack>
    </Box>
  );
}

function SavedMoment({
  m,
  activityTitle,
  askAi,
  onUnsave,
}: {
  m: Moment;
  activityTitle: string;
  askAi?: (prompt: string) => void;
  onUnsave: () => void;
}) {
  const addObservation = useMutation(api.observations.add);
  const upsertDirective = useMutation(api.teacherDirectives.upsertByTeacher);
  const [logged, setLogged] = useState(false);
  const [directiveOpen, setDirectiveOpen] = useState(false);
  const [directive, setDirective] = useState("");
  const [busy, setBusy] = useState(false);

  const logObservation = async () => {
    if (busy || logged) return;
    setBusy(true);
    try {
      await addObservation({
        scholarId: m.scholarId,
        sessionId: m.sessionId,
        note: `${m.label} — ${m.excerpt}`,
        type: OBS_TYPE[m.kind] ?? "suggestion",
      });
      setLogged(true);
      toaster.success({ title: `Observation logged for ${m.scholarName}` });
    } catch {
      toaster.error({ title: "Couldn't log — try again." });
    } finally {
      setBusy(false);
    }
  };

  const saveDirective = async () => {
    const content = directive.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      await upsertDirective({
        scholarId: m.scholarId,
        label: m.label.slice(0, 60),
        content,
      });
      setDirectiveOpen(false);
      setDirective("");
      toaster.success({ title: `Directive added for ${m.scholarName}` });
    } catch {
      toaster.error({ title: "Couldn't add directive — try again." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <MomentCard m={m}>
      <Button
        size="2xs"
        variant={logged ? "ghost" : "outline"}
        colorPalette="violet"
        onClick={logObservation}
        disabled={logged || busy}
      >
        {logged ? <><Check /> Logged</> : "Log observation"}
      </Button>
      <Button
        size="2xs"
        variant="ghost"
        color="charcoal.500"
        onClick={() => setDirectiveOpen((v) => !v)}
      >
        Steer tutor
      </Button>
      {askAi && (
        <Button
          size="2xs"
          variant="ghost"
          color="violet.600"
          onClick={() =>
            askAi(designFixPrompt(activityTitle, m.label, m.excerpt))
          }
        >
          <Robot /> Ask the bot
        </Button>
      )}
      <Button size="2xs" variant="ghost" color="charcoal.300" onClick={onUnsave}>
        Remove
      </Button>
      {directiveOpen && (
        <Box w="full" pt={1}>
          <Textarea
            size="sm"
            rows={2}
            value={directive}
            placeholder={`A standing instruction to ${m.scholarName}'s tutor (e.g. "revisit ${m.label} with a concrete example")`}
            onChange={(e) => setDirective(e.target.value)}
          />
          <HStack justify="flex-end" pt={1}>
            <Button size="2xs" variant="ghost" onClick={() => setDirectiveOpen(false)}>
              Cancel
            </Button>
            <Button size="2xs" colorPalette="violet" onClick={saveDirective} disabled={!directive.trim() || busy}>
              Add directive
            </Button>
          </HStack>
        </Box>
      )}
    </MomentCard>
  );
}

// "Improve the design" — the cohort-agnostic, next-generation horizon.
// Replaces the old free-text "Curriculum reflection" journal box: the moves
// here DO something (talk it through with the bot, revise the activity, add a
// follow-up) rather than ask the teacher to write a note.
function DesignMoves({
  activityTitle,
  lessonId,
  askAi,
}: {
  activityTitle: string;
  lessonId: Id<"lessons"> | null;
  askAi?: (prompt: string) => void;
}) {
  const createActivity = useMutation(api.activities.create);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [adding, setAdding] = useState(false);

  const reviseInEdit = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "edit");
    router.push(`${pathname}?${params.toString()}`);
  };

  // Close the loop the other way: add a follow-up activity to the same
  // lesson (the "add to the next part of the unit" half of debrief), then
  // drop the teacher into the editor on the new draft.
  const addFollowUp = async () => {
    if (!lessonId || adding) return;
    setAdding(true);
    try {
      const newId = await createActivity({
        lessonId,
        title: "Follow-up (from debrief)",
        kind: "offline",
      });
      const params = new URLSearchParams(searchParams.toString());
      params.set("activity", newId);
      params.set("tab", "edit");
      router.push(`${pathname}?${params.toString()}`);
    } catch {
      toaster.error({ title: "Couldn't add — try again." });
      setAdding(false);
    }
  };

  return (
    <Box borderTopWidth="1px" borderColor="gray.100" pt={5}>
      <SectionEyebrow>Improve the design</SectionEyebrow>
      <Text fontSize="xs" color="charcoal.400" mt={1} mb={3} lineHeight="1.5">
        Carry what these runs taught you into the next cohort.
      </Text>
      <Flex gap={2} flexWrap="wrap">
        {askAi && (
          <Button
            size="xs"
            variant="outline"
            borderColor="violet.300"
            color="violet.700"
            _hover={{ bg: "violet.50" }}
            fontFamily="heading"
            onClick={() => askAi(reviseActivityPrompt(activityTitle))}
          >
            <Robot style={{ marginRight: 4 }} /> Ask the bot for revisions
          </Button>
        )}
        <Button size="xs" variant="ghost" color="charcoal.600" onClick={reviseInEdit}>
          <PencilSimpleLine /> Revise in Edit →
        </Button>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.600"
          onClick={addFollowUp}
          loading={adding}
          disabled={!lessonId}
        >
          + Follow-up activity →
        </Button>
      </Flex>
    </Box>
  );
}

// "Where it's live" — the pointer DOWN to the per-run, act-now reads. Each
// run is one cohort's pass; its named-scholar moves live on the Assignments
// Run page (this Curriculum surface stays cohort-agnostic).
function LiveRuns({
  runs,
}: {
  runs: {
    assignmentId: Id<"assignments">;
    title: string;
    startedAt: number;
    scholarCount: number;
    doneCount: number;
  }[];
}) {
  return (
    <Box borderTopWidth="1px" borderColor="gray.100" pt={5}>
      <SectionEyebrow>Where it&apos;s live</SectionEyebrow>
      <Text fontSize="xs" color="charcoal.400" mt={1} mb={3} lineHeight="1.5">
        Act on a specific cohort — named scholars, warm-ups, Share-Backs — on
        each Run page.
      </Text>
      <Stack gap={0}>
        {runs.map((r, i) => (
          <Link key={String(r.assignmentId)} href={`/teacher/schedule/${r.assignmentId}`}>
            <Flex
              align="center"
              justify="space-between"
              gap={3}
              py={2.5}
              borderTopWidth={i === 0 ? "0" : "1px"}
              borderColor="gray.100"
              _hover={{ bg: "gray.50" }}
              px={1}
              borderRadius="sm"
            >
              <Box minW={0}>
                <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500" truncate>
                  {r.title}
                </Text>
                <Text fontSize="2xs" color="charcoal.400">
                  {r.doneCount} of {r.scholarCount} done · started{" "}
                  {formatRelative(r.startedAt)}
                </Text>
              </Box>
              <ArrowRight size={14} color="var(--chakra-colors-charcoal-300)" style={{ flexShrink: 0 }} />
            </Flex>
          </Link>
        ))}
      </Stack>
    </Box>
  );
}

function EmptyMoments({ hasSessions }: { hasSessions: boolean }) {
  return (
    <Box
      bg="white"
      borderWidth="1px"
      borderColor="gray.200"
      borderStyle="dashed"
      borderRadius="lg"
      py={8}
      px={6}
      textAlign="center"
    >
      <Text fontSize="sm" color="charcoal.400" maxW="420px" mx="auto">
        {hasSessions
          ? "No moments surfaced yet — they appear once the observer has analyzed this activity's real sessions (mastery, misconceptions, signals, cross-domain insights)."
          : "No real sessions on this activity yet. Once a class works through it, the observer's most interesting moments show up here to review and act on."}
      </Text>
    </Box>
  );
}

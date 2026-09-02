"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Input,
  Spinner,
  Stack,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { Check, Flag, Plant, Plus, Sparkle } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";

/**
 * MyWeeklyGoalsCard — the scholar's own weekly-goal surface (the learner-owned
 * SRL loop). A small, visible weekly commitment the kid sets for themselves:
 * they set it (it's ACTIVE at once — no teacher approval gate), track it, and at
 * week's end mark "Did it" / "Not yet" with a one-line reflection — the whole
 * loop is in their own hands. (A teacher can also SUGGEST a goal, which the
 * scholar chooses whether to take on, and can quietly close one after the fact.)
 *
 * Growth-mindset rules, enforced throughout: this is PRIVATE (just the scholar
 * + staff), plain, and quiet — no confetti, no streaks, no scores, no peer
 * comparison. "Not yet" is framed as fine, never as failure or shame. The
 * mark-done moment and the practice-movement "look at this" nudge are both
 * portrait-voiced, never a trophy.
 *
 * DISTINCT from MyGoalsCard (the long-term goals). See DRAFT-NOTES.md.
 */

// Enriched by the query with a per-goal `movement` field (null unless an active
// goal's subject shows demonstrated practice movement).
type WeeklyGoal = NonNullable<
  ReturnType<typeof useQuery<typeof api.weeklyGoals.myGoals>>
>["current"][number];

const STATUS_META: Record<
  WeeklyGoal["status"],
  { label: string; palette: string }
> = {
  proposed: { label: "Waiting to start", palette: "gray" },
  active: { label: "This week", palette: "purple" },
  met: { label: "Did it", palette: "green" },
  not_yet: { label: "Not yet — that's okay", palette: "blue" },
  archived: { label: "Archived", palette: "gray" },
};

export default function MyWeeklyGoalsCard() {
  const data = useQuery(api.weeklyGoals.myGoals, {});
  const [showForm, setShowForm] = useState(false);

  const current = data?.current ?? [];
  const atCap = current.length >= 3;

  return (
    <Box bg="white" borderRadius="xl" borderWidth="1px" borderColor="gray.200" p={6} shadow="xs">
      <Flex justify="space-between" align="center" mb={4}>
        <HStack gap={2}>
          <Flag color="#AD60BF" size={18} weight="fill" />
          <Heading size="sm" color="navy.500" fontFamily="heading">
            My goals this week
          </Heading>
        </HStack>
        {!showForm && !atCap && (
          <Button
            size="xs"
            variant="ghost"
            color="violet.600"
            fontFamily="heading"
            fontWeight="600"
            _hover={{ bg: "violet.50" }}
            onClick={() => setShowForm(true)}
          >
            <Plus style={{ marginRight: "4px" }} /> set a goal
          </Button>
        )}
      </Flex>

      {data === undefined ? (
        <Flex justify="center" py={6}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      ) : (
        <VStack align="stretch" gap={3}>
          {current.length === 0 && !showForm && (
            <Text fontFamily="body" fontSize="sm" color="charcoal.300" py={2}>
              Nothing set yet. What&rsquo;s one thing you want to get better at this week?
            </Text>
          )}

          {showForm && (
            <NewGoalForm
              onDone={() => setShowForm(false)}
              onCancel={() => setShowForm(false)}
            />
          )}

          {current.map((goal) => (
            <WeeklyGoalRow key={goal._id} goal={goal} />
          ))}

          {atCap && !showForm && (
            <Text fontFamily="heading" fontSize="2xs" color="charcoal.300">
              That&rsquo;s three goals — plenty for one week.
            </Text>
          )}
        </VStack>
      )}
    </Box>
  );
}

function NewGoalForm({
  onDone,
  onCancel,
}: {
  onDone: () => void;
  onCancel: () => void;
}) {
  const create = useMutation(api.weeklyGoals.create);
  const [text, setText] = useState("");
  const [strategy, setStrategy] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await create({ text: trimmed, strategy: strategy.trim() || undefined });
      setText("");
      setStrategy("");
      onDone();
      toaster.success({
        title: "Goal set",
        description: "It's yours for the week. Come back and mark it when you've done it.",
      });
    } catch (err) {
      console.error("Error setting weekly goal:", err);
      toaster.error({
        title: "Couldn't save that",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box borderWidth="1px" borderColor="violet.200" borderRadius="lg" p={4} bg="violet.50">
      <VStack align="stretch" gap={2}>
        <Text fontFamily="heading" fontWeight="600" fontSize="xs" color="violet.700">
          What do you want to get better at this week?
        </Text>
        <Textarea
          size="sm"
          placeholder="e.g. Get better at estimating before I calculate"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          bg="white"
          fontFamily="body"
          fontSize="sm"
          autoFocus
        />
        <Text fontFamily="heading" fontWeight="600" fontSize="2xs" color="charcoal.400" mt={1}>
          How will you try? (optional)
        </Text>
        <Input
          size="sm"
          placeholder="e.g. check my answer is sensible every time"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          bg="white"
          fontFamily="body"
          fontSize="sm"
        />
        <HStack gap={2} mt={1}>
          <Button
            size="xs"
            bg="violet.500"
            color="white"
            _hover={{ bg: "violet.600" }}
            fontFamily="heading"
            fontWeight="600"
            onClick={handleSave}
            disabled={saving || !text.trim()}
          >
            {saving ? "Saving…" : "Set this goal"}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            fontFamily="heading"
            onClick={onCancel}
            disabled={saving}
          >
            Cancel
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
}

function WeeklyGoalRow({ goal }: { goal: WeeklyGoal }) {
  const accept = useMutation(api.weeklyGoals.accept);
  const setOutcome = useMutation(api.weeklyGoals.setOutcome);
  const [reflection, setReflection] = useState("");
  const [busy, setBusy] = useState(false);

  const meta = STATUS_META[goal.status];
  const teacherSuggested = goal.source === "teacher";

  const handleAccept = async () => {
    setBusy(true);
    try {
      await accept({ goalId: goal._id });
    } catch (err) {
      toaster.error({
        title: "Couldn't accept that",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleOutcome = async (outcome: "met" | "not_yet") => {
    setBusy(true);
    try {
      await setOutcome({
        goalId: goal._id,
        outcome,
        reflection: reflection.trim() || undefined,
      });
      setReflection("");
      // A quiet, portrait-voiced moment when the scholar marks their own goal
      // done — no confetti, no streak, no score. They set it; they saw it through.
      if (outcome === "met") {
        toaster.success({
          title: "You did it",
          description: "You set this goal yourself and saw it through. That's yours to keep.",
        });
      }
    } catch (err) {
      toaster.error({
        title: "Couldn't save that",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
      <HStack gap={2.5} align="start" justify="space-between">
        <Stack gap={1} flex={1} minW={0}>
          <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
            {goal.text}
          </Text>
          {goal.strategy && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.400">
              My plan: {goal.strategy}
            </Text>
          )}
        </Stack>
        <Badge colorPalette={meta.palette} variant="subtle" fontFamily="heading" flexShrink={0}>
          {meta.label}
        </Badge>
      </HStack>

      {/* A teacher-suggested goal waits for the scholar to accept it. */}
      {goal.status === "proposed" && teacherSuggested && (
        <VStack align="stretch" gap={2} mt={3}>
          {goal.teacherNote && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.500" fontStyle="italic">
              &ldquo;{goal.teacherNote}&rdquo; — your teacher
            </Text>
          )}
          <HStack gap={2}>
            <Button
              size="xs"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              fontWeight="600"
              onClick={handleAccept}
              disabled={busy}
            >
              <Check style={{ marginRight: "4px" }} /> I&rsquo;ll take it on
            </Button>
          </HStack>
        </VStack>
      )}

      {/* An active goal can be closed out with a plain Did it / Not yet. */}
      {goal.status === "active" && (
        <VStack align="stretch" gap={2} mt={3}>
          {goal.movement && goal.movement.skills.length > 0 && (
            <Box
              borderWidth="1px"
              borderColor="violet.200"
              bg="violet.50"
              borderRadius="lg"
              p={3}
            >
              <HStack gap={2} align="start">
                <Box color="violet.500" mt="1px" flexShrink={0}>
                  <Sparkle size={15} weight="fill" />
                </Box>
                <Text fontFamily="body" fontSize="sm" color="charcoal.600" lineHeight="1.45">
                  Something to notice: your practice shows real movement in{" "}
                  {formatSkillList(goal.movement.skills)}. If that feels like this
                  goal, you can mark it done.
                </Text>
              </HStack>
            </Box>
          )}
          <Input
            size="sm"
            placeholder="How did it go? (optional, one line)"
            value={reflection}
            onChange={(e) => setReflection(e.target.value)}
            bg="gray.50"
            fontFamily="body"
            fontSize="sm"
          />
          <HStack gap={2}>
            <Button
              size="xs"
              bg="green.500"
              color="white"
              _hover={{ bg: "green.600" }}
              fontFamily="heading"
              fontWeight="600"
              onClick={() => handleOutcome("met")}
              disabled={busy}
            >
              Did it
            </Button>
            <Button
              size="xs"
              variant="outline"
              colorPalette="blue"
              fontFamily="heading"
              fontWeight="600"
              onClick={() => handleOutcome("not_yet")}
              disabled={busy}
            >
              Not yet
            </Button>
          </HStack>
        </VStack>
      )}

      {/* A goal the scholar marked done gets a quiet, portrait-voiced moment —
          no confetti, no streak, no score. Just: you set this and you did it. */}
      {goal.status === "met" && (
        <HStack
          gap={2}
          align="start"
          mt={3}
          borderWidth="1px"
          borderColor="green.200"
          bg="green.50"
          borderRadius="lg"
          p={3}
        >
          <Box color="green.500" mt="1px" flexShrink={0}>
            <Sparkle size={15} weight="fill" />
          </Box>
          <Text fontFamily="body" fontSize="sm" color="charcoal.600" lineHeight="1.45">
            You set this goal yourself and saw it through. That&rsquo;s yours to keep.
          </Text>
        </HStack>
      )}

      {/* Closed-out goals show the scholar's own reflection back, no scoring. */}
      {(goal.status === "met" || goal.status === "not_yet") && goal.reflection && (
        <HStack gap={1.5} align="start" mt={2}>
          <Box color="violet.400" mt="2px" flexShrink={0}>
            <Plant size={13} weight="fill" />
          </Box>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500" fontStyle="italic">
            {goal.reflection}
          </Text>
        </HStack>
      )}
    </Box>
  );
}

/** Join skill labels into a gentle phrase: "A", "A and B", "A, B, and C". */
function formatSkillList(skills: string[]): string {
  if (skills.length === 1) return skills[0];
  if (skills.length === 2) return `${skills[0]} and ${skills[1]}`;
  return `${skills.slice(0, -1).join(", ")}, and ${skills[skills.length - 1]}`;
}

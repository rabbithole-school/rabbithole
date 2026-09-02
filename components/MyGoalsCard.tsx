"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Flex,
  HStack,
  Heading,
  Spinner,
  Stack,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import {
  ArrowsClockwise,
  BookOpenText,
  Compass,
  Heart,
  Palette,
  Plus,
  Sparkle,
} from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";
import { formatRelative } from "@/lib/relativeTime";

/**
 * MyGoalsCard — the scholar's own "My goals" surface (review/assessment-and-
 * goals-plan.html §9). A goal is the thread the year hangs on: longer-lived
 * than a quest, teacher/scholar-authored (never model), and shown here in
 * the kid's own words.
 *
 * Growth-mindset rules, enforced throughout: progress reads as "moments
 * logged" — never a grade, score, or percent. A tutor-noticed moment is
 * framed as process praise, not evaluation. There's no bar, no completion
 * pressure — just a growing log of "I did this."
 */

type GoalRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.scholarGoals.listByScholar>>
>[number];

const KIND_META: Record<
  GoalRow["kind"],
  { icon: React.ReactNode; label: string }
> = {
  academic: { icon: <BookOpenText size={16} weight="fill" />, label: "Academic" },
  personal: { icon: <Heart size={16} weight="fill" />, label: "Personal" },
  habit: { icon: <ArrowsClockwise size={16} weight="fill" />, label: "Habit" },
  hobby: { icon: <Palette size={16} weight="fill" />, label: "Hobby" },
};

export default function MyGoalsCard({ scholarId }: { scholarId: Id<"users"> }) {
  const goals = useQuery(api.scholarGoals.listByScholar, {
    scholarId,
    status: "active",
  });

  return (
    <Box bg="white" borderRadius="xl" borderWidth="1px" borderColor="gray.200" p={6} shadow="xs">
      <HStack gap={2} mb={4}>
        <Compass color="#AD60BF" size={18} weight="fill" />
        <Heading size="sm" color="navy.500" fontFamily="heading">
          My goals
        </Heading>
      </HStack>

      {goals === undefined ? (
        <Flex justify="center" py={6}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      ) : goals.length === 0 ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.300" py={2}>
          No goals set yet — your teacher can help you set one.
        </Text>
      ) : (
        <VStack align="stretch" gap={3}>
          {goals.map((goal) => (
            <GoalCard key={goal._id} goal={goal} />
          ))}
        </VStack>
      )}
    </Box>
  );
}

function GoalCard({ goal }: { goal: GoalRow }) {
  const addCheckin = useMutation(api.scholarGoals.addCheckin);
  const [showForm, setShowForm] = useState(false);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const kindMeta = KIND_META[goal.kind];
  const setWithTeacher = goal.origin !== "scholar";

  const handleLog = async () => {
    const trimmed = note.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await addCheckin({ goalId: goal._id, note: trimmed });
      setNote("");
      setShowForm(false);
      toaster.success({
        title: "Logged!",
        description: "That's on the record now.",
      });
    } catch (err) {
      console.error("Error logging goal check-in:", err);
      toaster.error({
        title: "Couldn't log that",
        description: "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  const momentsLine =
    goal.checkinCount === 0
      ? "No moments logged yet — you could be the first."
      : `${goal.checkinCount} ${goal.checkinCount === 1 ? "moment" : "moments"} logged`;

  const latest = goal.latestCheckin;
  const latestLabel =
    latest?.authorType === "scholar"
      ? "You said"
      : latest?.authorType === "teacher"
        ? "Your teacher noticed"
        : "Your tutor noticed";

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
      <HStack gap={2.5} align="start">
        <Box color="violet.500" mt="2px" flexShrink={0}>
          {kindMeta.icon}
        </Box>
        <Stack gap={0.5} flex={1} minW={0}>
          <Text fontFamily="heading" fontWeight="700" color="navy.500" fontSize="sm">
            {goal.title}
          </Text>
          <Text
            fontFamily="heading"
            fontSize="2xs"
            color="charcoal.300"
            textTransform="uppercase"
            letterSpacing="0.05em"
          >
            {kindMeta.label} · {setWithTeacher ? "set with your teacher" : "set by you"}
          </Text>
        </Stack>
      </HStack>

      {goal.description && (
        <Text fontFamily="body" fontSize="sm" color="charcoal.500" mt={2} lineHeight="1.5">
          {goal.description}
        </Text>
      )}

      <Text fontFamily="heading" fontWeight="600" fontSize="xs" color="violet.600" mt={3}>
        {momentsLine}
      </Text>

      {latest && (
        <Box
          bg="violet.50"
          borderRadius="md"
          px={3}
          py={2}
          mt={2}
          borderLeftWidth="3px"
          borderColor="violet.300"
        >
          <HStack gap={1} mb={0.5}>
            <Text
              fontFamily="heading"
              fontSize="2xs"
              color="violet.600"
              textTransform="uppercase"
              letterSpacing="0.05em"
            >
              {latestLabel}
            </Text>
            {latest.authorType !== "scholar" && <Sparkle size={11} weight="fill" color="#AD60BF" />}
          </HStack>
          <Text fontFamily="body" fontSize="sm" color="charcoal.600" fontStyle="italic" lineHeight="1.5">
            &ldquo;{latest.note}&rdquo;
          </Text>
          <Text fontFamily="heading" fontSize="2xs" color="charcoal.300" mt={1}>
            {formatRelative(latest._creationTime)}
          </Text>
        </Box>
      )}

      {showForm ? (
        <VStack align="stretch" gap={2} mt={3}>
          <Textarea
            size="sm"
            placeholder="What did you do?"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            bg="gray.50"
            fontFamily="body"
            fontSize="sm"
            autoFocus
          />
          <HStack gap={2}>
            <Button
              size="xs"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              fontWeight="600"
              onClick={handleLog}
              disabled={saving || !note.trim()}
            >
              {saving ? "Logging…" : "Log it"}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              fontFamily="heading"
              onClick={() => {
                setShowForm(false);
                setNote("");
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          </HStack>
        </VStack>
      ) : (
        <Button
          size="xs"
          variant="ghost"
          color="violet.600"
          fontFamily="heading"
          fontWeight="600"
          mt={3}
          px={2}
          _hover={{ bg: "violet.50" }}
          onClick={() => setShowForm(true)}
        >
          <Plus style={{ marginRight: "4px" }} /> I did something for this
        </Button>
      )}
    </Box>
  );
}

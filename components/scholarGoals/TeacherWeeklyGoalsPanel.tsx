"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import {
  Badge,
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Spinner,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import { PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";

/**
 * TeacherWeeklyGoalsPanel — the teacher's window onto a scholar's WEEKLY goals
 * (the learner-owned SRL loop). The scholar owns the loop end-to-end: their own
 * goals are already ACTIVE, so the teacher's role here is VISIBILITY + VETO, not
 * approval-to-activate. A teacher can see every goal, edit its text, leave a
 * private note, quietly close one (archive — the after-the-fact veto), or SUGGEST
 * a goal for the scholar to take on. Nothing here is a score — a goal not met is
 * data, never a grade.
 *
 * DISTINCT from TeacherGoalsPanel (the long-term goals). See DRAFT-NOTES.md.
 */

type WeeklyGoal = Doc<"weeklyGoals">;

const STATUS_META: Record<WeeklyGoal["status"], { label: string; palette: string }> = {
  proposed: { label: "Proposed", palette: "orange" },
  active: { label: "Active", palette: "purple" },
  met: { label: "Met", palette: "green" },
  not_yet: { label: "Not yet", palette: "blue" },
  archived: { label: "Archived", palette: "gray" },
};

export default function TeacherWeeklyGoalsPanel({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const goals = useQuery(api.weeklyGoals.listForScholar, { scholarId });
  const [showSuggest, setShowSuggest] = useState(false);

  if (goals === undefined) {
    return (
      <Flex justify="center" py={6}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  // Group by week (newest week first — the query already sorts).
  const byWeek: { weekOf: string; rows: WeeklyGoal[] }[] = [];
  for (const g of goals) {
    const bucket = byWeek.find((b) => b.weekOf === g.weekOf);
    if (bucket) bucket.rows.push(g);
    else byWeek.push({ weekOf: g.weekOf, rows: [g] });
  }

  return (
    <VStack align="stretch" gap={4}>
      <Flex justify="flex-end">
        {!showSuggest && (
          <Button
            size="xs"
            variant="ghost"
            color="violet.600"
            fontFamily="heading"
            fontWeight="600"
            _hover={{ bg: "violet.50" }}
            onClick={() => setShowSuggest(true)}
          >
            <Plus style={{ marginRight: "4px" }} /> Suggest a goal
          </Button>
        )}
      </Flex>

      {showSuggest && (
        <SuggestGoalForm
          scholarId={scholarId}
          onDone={() => setShowSuggest(false)}
          onCancel={() => setShowSuggest(false)}
        />
      )}

      {goals.length === 0 && !showSuggest && (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          No weekly goals yet. Suggest one, or the scholar can set their own.
        </Text>
      )}

      {byWeek.map((week) => (
        <Box key={week.weekOf}>
          <Text
            fontFamily="heading"
            fontSize="2xs"
            color="charcoal.300"
            textTransform="uppercase"
            letterSpacing="0.05em"
            mb={2}
          >
            Week of {week.weekOf}
          </Text>
          <VStack align="stretch" gap={2}>
            {week.rows.map((goal) => (
              <TeacherWeeklyGoalRow key={goal._id} goal={goal} />
            ))}
          </VStack>
        </Box>
      ))}
    </VStack>
  );
}

function SuggestGoalForm({
  scholarId,
  onDone,
  onCancel,
}: {
  scholarId: Id<"users">;
  onDone: () => void;
  onCancel: () => void;
}) {
  const suggest = useMutation(api.weeklyGoals.suggest);
  const [text, setText] = useState("");
  const [strategy, setStrategy] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await suggest({
        scholarId,
        text: trimmed,
        strategy: strategy.trim() || undefined,
        teacherNote: note.trim() || undefined,
      });
      onDone();
      toaster.success({
        title: "Suggested",
        description: "The scholar decides whether to take it on.",
      });
    } catch (err) {
      toaster.error({
        title: "Couldn't suggest that",
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box borderWidth="1px" borderColor="violet.200" borderRadius="lg" p={4} bg="violet.50">
      <VStack align="stretch" gap={2}>
        <Textarea
          size="sm"
          placeholder="Goal to suggest…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          bg="white"
          fontFamily="body"
          fontSize="sm"
          autoFocus
        />
        <Input
          size="sm"
          placeholder="A strategy to suggest (optional)"
          value={strategy}
          onChange={(e) => setStrategy(e.target.value)}
          bg="white"
          fontFamily="body"
          fontSize="sm"
        />
        <Input
          size="sm"
          placeholder="A private note for the scholar (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          bg="white"
          fontFamily="body"
          fontSize="sm"
        />
        <HStack gap={2}>
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
            {saving ? "Saving…" : "Suggest it"}
          </Button>
          <Button size="xs" variant="ghost" fontFamily="heading" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
}

function TeacherWeeklyGoalRow({ goal }: { goal: WeeklyGoal }) {
  const annotate = useMutation(api.weeklyGoals.annotate);
  const archive = useMutation(api.weeklyGoals.archive);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(goal.text);
  const [note, setNote] = useState(goal.teacherNote ?? "");
  const [busy, setBusy] = useState(false);

  const meta = STATUS_META[goal.status];

  const run = async (fn: () => Promise<unknown>, failTitle: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toaster.error({
        title: failTitle,
        description: err instanceof Error ? err.message : "Please try again.",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveEdit = () =>
    run(async () => {
      await annotate({ goalId: goal._id, text: text.trim(), teacherNote: note.trim() });
      setEditing(false);
    }, "Couldn't save");

  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={3}>
      <Flex justify="space-between" align="start" gap={2}>
        <Box flex={1} minW={0}>
          {editing ? (
            <Textarea
              size="sm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              bg="gray.50"
              fontFamily="body"
              fontSize="sm"
            />
          ) : (
            <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.500">
              {goal.text}
            </Text>
          )}
          {goal.strategy && !editing && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.400" mt={0.5}>
              Plan: {goal.strategy}
            </Text>
          )}
          <HStack gap={1.5} mt={1}>
            <Text fontFamily="heading" fontSize="2xs" color="charcoal.300">
              {goal.source === "teacher" ? "you suggested" : "scholar set"}
            </Text>
          </HStack>
        </Box>
        <Badge colorPalette={meta.palette} variant="subtle" fontFamily="heading" flexShrink={0}>
          {meta.label}
        </Badge>
      </Flex>

      {editing ? (
        <VStack align="stretch" gap={2} mt={2}>
          <Input
            size="sm"
            placeholder="Private note for the scholar (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            bg="gray.50"
            fontFamily="body"
            fontSize="sm"
          />
          <HStack gap={2}>
            <Button
              size="xs"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              onClick={handleSaveEdit}
              disabled={busy || !text.trim()}
            >
              Save
            </Button>
            <Button
              size="xs"
              variant="ghost"
              fontFamily="heading"
              onClick={() => {
                setEditing(false);
                setText(goal.text);
                setNote(goal.teacherNote ?? "");
              }}
              disabled={busy}
            >
              Cancel
            </Button>
          </HStack>
        </VStack>
      ) : (
        <>
          {goal.teacherNote && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.500" fontStyle="italic" mt={1}>
              Note: {goal.teacherNote}
            </Text>
          )}
          {goal.reflection && (goal.status === "met" || goal.status === "not_yet") && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.500" mt={1}>
              Reflection: &ldquo;{goal.reflection}&rdquo;
            </Text>
          )}
          {/* A scholar's own goal is already live — the teacher doesn't gate it.
              A teacher-suggested proposal is the scholar's to accept. */}
          {goal.status === "proposed" && goal.source === "teacher" && (
            <Text fontFamily="body" fontSize="xs" color="charcoal.400" fontStyle="italic" mt={1}>
              Waiting for the scholar to take this on.
            </Text>
          )}
          <HStack gap={2} mt={2}>
            <Button
              size="xs"
              variant="ghost"
              fontFamily="heading"
              onClick={() => setEditing(true)}
              disabled={busy}
            >
              <PencilSimple style={{ marginRight: "4px" }} /> Edit / note
            </Button>
            {goal.status !== "archived" && (
              <Button
                size="xs"
                variant="ghost"
                colorPalette="red"
                fontFamily="heading"
                onClick={() => run(() => archive({ goalId: goal._id }), "Couldn't close")}
                disabled={busy}
              >
                <Trash style={{ marginRight: "4px" }} /> Close
              </Button>
            )}
          </HStack>
        </>
      )}
    </Box>
  );
}

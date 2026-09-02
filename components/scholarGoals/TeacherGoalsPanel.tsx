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
  IconButton,
  Input,
  Spinner,
  Switch,
  Text,
  Textarea,
  VStack,
  Dialog,
  Portal,
} from "@chakra-ui/react";
import {
  ArrowsClockwise,
  BookOpenText,
  CaretDown,
  CaretRight,
  CheckCircle,
  Heart,
  Palette,
  PencilSimple,
  Plus,
  Sparkle,
  Trash,
} from "@phosphor-icons/react";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { formatRelative } from "@/lib/relativeTime";

/**
 * TeacherGoalsPanel — the teacher-facing counterpart to MyGoalsCard (review/
 * assessment-and-goals-plan.html §9). This is where a goal's authorship is
 * governed: a teacher creates goals live (active, feeding the tutor by
 * default), approves scholar-proposed goals before they go live, and moves a
 * goal through its lifecycle (active → achieved / retired). Nothing here
 * shows the child's rubric numbers — a goal is a thread, not a score.
 */

type GoalRow = NonNullable<
  ReturnType<typeof useQuery<typeof api.scholarGoals.listByScholar>>
>[number];
type GoalKind = GoalRow["kind"];
type GoalStatus = GoalRow["status"];

const KIND_META: Record<GoalKind, { icon: React.ReactNode; label: string }> = {
  academic: { icon: <BookOpenText size={14} weight="fill" />, label: "Academic" },
  personal: { icon: <Heart size={14} weight="fill" />, label: "Personal" },
  habit: { icon: <ArrowsClockwise size={14} weight="fill" />, label: "Habit" },
  hobby: { icon: <Palette size={14} weight="fill" />, label: "Hobby" },
};

const STATUS_ORDER: GoalStatus[] = ["proposed", "active", "achieved", "retired"];
const STATUS_META: Record<GoalStatus, { label: string; hint: string }> = {
  proposed: {
    label: "Awaiting approval",
    hint: "The scholar proposed this — approve it to go live and feed the tutor.",
  },
  active: {
    label: "Active",
    hint: "Live now. Goals with \u201cfeeds tutor\u201d on are injected into the tutor's prompt.",
  },
  achieved: { label: "Achieved", hint: "Celebrated — kept on the record." },
  retired: { label: "Retired", hint: "No longer being pursued." },
};

interface TeacherGoalsPanelProps {
  scholarId: Id<"users">;
}

export default function TeacherGoalsPanel({ scholarId }: TeacherGoalsPanelProps) {
  const goals = useQuery(api.scholarGoals.listByScholar, { scholarId });
  const [showCreate, setShowCreate] = useState(false);

  if (goals === undefined) {
    return (
      <Flex justify="center" py={8}>
        <Spinner size="md" color="violet.500" />
      </Flex>
    );
  }

  const byStatus: Record<GoalStatus, GoalRow[]> = {
    proposed: [],
    active: [],
    achieved: [],
    retired: [],
  };
  for (const g of goals) byStatus[g.status].push(g);

  return (
    <VStack gap={4} align="stretch" maxW="720px">
      <HStack justify="space-between">
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
          Goals
        </Text>
        <Button
          size="xs"
          variant="ghost"
          color="violet.500"
          fontFamily="heading"
          _hover={{ bg: "violet.50" }}
          onClick={() => setShowCreate((v) => !v)}
        >
          {showCreate ? (
            "Cancel"
          ) : (
            <>
              <Plus style={{ marginRight: "3px" }} /> New goal
            </>
          )}
        </Button>
      </HStack>

      <Text fontSize="xs" color="charcoal.400" fontFamily="body">
        The thread the year hangs on — longer-lived than a quest. A goal you set here goes live
        immediately; a scholar-proposed goal waits below for your approval.
      </Text>

      {showCreate && <CreateGoalForm scholarId={scholarId} onDone={() => setShowCreate(false)} />}

      {STATUS_ORDER.map((status) => {
        const rows = byStatus[status];
        if (rows.length === 0) return null;
        return (
          <Box key={status}>
            <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="charcoal.400" mb={0.5}>
              {STATUS_META[status].label} ({rows.length})
            </Text>
            <Text fontSize="xs" fontFamily="body" color="charcoal.300" mb={2}>
              {STATUS_META[status].hint}
            </Text>
            <VStack gap={2} align="stretch">
              {rows.map((g) => (
                <GoalCard key={g._id} goal={g} />
              ))}
            </VStack>
          </Box>
        );
      })}

      {goals.length === 0 && !showCreate && (
        <Text fontSize="sm" color="charcoal.300" fontFamily="heading" textAlign="center" py={8}>
          No goals yet. Add one to set a long-term thread for this scholar&apos;s year.
        </Text>
      )}
    </VStack>
  );
}

// ─── Create Goal Form ────────────────────────────────────────────────

function CreateGoalForm({
  scholarId,
  onDone,
}: {
  scholarId: Id<"users">;
  onDone: () => void;
}) {
  const create = useMutation(api.scholarGoals.create);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<GoalKind>("academic");
  const [isSaving, setIsSaving] = useState(false);

  const handleCreate = async () => {
    if (!title.trim()) return;
    setIsSaving(true);
    try {
      await create({
        scholarId,
        title: title.trim(),
        description: description.trim() || undefined,
        kind,
      });
      toaster.success({ title: "Goal set", description: "It's live and ready to feed the tutor." });
      onDone();
    } catch (err) {
      console.error("Error creating goal:", err);
      toaster.error({ title: "Couldn't create that goal", description: "Please try again." });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Box bg="white" borderRadius="md" p={3} border="1px solid" borderColor="violet.200">
      <Text fontSize="xs" fontWeight="600" fontFamily="heading" color="navy.500" mb={2}>
        New goal
      </Text>
      <VStack gap={2} align="stretch">
        <HStack gap={2}>
          <Input
            size="sm"
            placeholder="Title (e.g., Ask my own research question)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            bg="gray.50"
            fontFamily="heading"
            flex={1}
          />
          <FieldSelect
            w="140px"
            size="sm"
            value={kind}
            onChange={(v) => setKind(v as GoalKind)}
            fieldProps={{ "aria-label": "Goal kind" }}
          >
            <option value="academic">Academic</option>
            <option value="personal">Personal</option>
            <option value="habit">Habit</option>
            <option value="hobby">Hobby</option>
          </FieldSelect>
        </HStack>
        <Textarea
          size="sm"
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
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
            onClick={handleCreate}
            disabled={isSaving || !title.trim()}
          >
            Save
          </Button>
          <Button size="xs" variant="ghost" fontFamily="heading" onClick={onDone} disabled={isSaving}>
            Cancel
          </Button>
        </HStack>
      </VStack>
    </Box>
  );
}

// ─── Goal Card ────────────────────────────────────────────────────────

function GoalCard({ goal }: { goal: GoalRow }) {
  const approve = useMutation(api.scholarGoals.approve);
  const setStatus = useMutation(api.scholarGoals.setStatus);
  const setFeedsTutor = useMutation(api.scholarGoals.setFeedsTutor);
  const update = useMutation(api.scholarGoals.update);
  const remove = useMutation(api.scholarGoals.remove);

  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(goal.title);
  const [draftDescription, setDraftDescription] = useState(goal.description ?? "");
  const [draftKind, setDraftKind] = useState<GoalKind>(goal.kind);
  const [isSaving, setIsSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const kindMeta = KIND_META[goal.kind];

  const handleEditStart = () => {
    setDraftTitle(goal.title);
    setDraftDescription(goal.description ?? "");
    setDraftKind(goal.kind);
    setIsEditing(true);
  };

  const handleEditCancel = () => setIsEditing(false);

  const handleEditSave = async () => {
    if (!draftTitle.trim()) return;
    setIsSaving(true);
    try {
      await update({
        goalId: goal._id,
        title: draftTitle.trim(),
        description: draftDescription.trim() || undefined,
        kind: draftKind,
      });
      setIsEditing(false);
    } catch (err) {
      console.error("Error updating goal:", err);
      toaster.error({ title: "Couldn't save that edit", description: "Please try again." });
    } finally {
      setIsSaving(false);
    }
  };

  const handleApprove = async () => {
    try {
      await approve({ goalId: goal._id });
      toaster.success({ title: "Approved", description: "This goal is live and feeding the tutor." });
    } catch (err) {
      console.error("Error approving goal:", err);
      toaster.error({ title: "Couldn't approve that goal", description: "Please try again." });
    }
  };

  const handleSetStatus = async (status: GoalStatus) => {
    try {
      await setStatus({ goalId: goal._id, status });
    } catch (err) {
      console.error("Error updating goal status:", err);
      toaster.error({ title: "Couldn't update that goal", description: "Please try again." });
    }
  };

  const handleToggleFeedsTutor = async (checked: boolean) => {
    try {
      await setFeedsTutor({ goalId: goal._id, feedsTutor: checked });
    } catch (err) {
      console.error("Error toggling feedsTutor:", err);
      toaster.error({ title: "Couldn't update that goal", description: "Please try again." });
    }
  };

  const handleDelete = async () => {
    try {
      await remove({ goalId: goal._id });
      setShowDeleteConfirm(false);
    } catch (err) {
      console.error("Error deleting goal:", err);
      toaster.error({ title: "Couldn't delete that goal", description: "Please try again." });
    }
  };

  const muted = goal.status === "retired";

  return (
    <Box
      bg="white"
      borderRadius="md"
      p={3}
      borderWidth="1px"
      borderColor={goal.status === "proposed" ? "orange.400" : muted ? "gray.300" : "violet.200"}
      opacity={muted ? 0.7 : 1}
    >
      <HStack justify="space-between" align="start" mb={1} gap={2}>
        <HStack gap={2} flex={1} minW={0} align="start">
          <Box color="violet.500" mt="2px" flexShrink={0}>
            {kindMeta.icon}
          </Box>
          <Box minW={0}>
            <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
              {goal.title}
            </Text>
            <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" textTransform="uppercase" letterSpacing="0.05em">
              {kindMeta.label} · {goal.origin === "scholar" ? "proposed by scholar" : `set by ${goal.origin}`}
            </Text>
          </Box>
        </HStack>
        <HStack gap={1} flexShrink={0}>
          {!isEditing && (
            <IconButton
              aria-label="Edit goal"
              size="xs"
              variant="ghost"
              color="violet.500"
              _hover={{ bg: "violet.50" }}
              onClick={handleEditStart}
            >
              <PencilSimple />
            </IconButton>
          )}
          <IconButton
            aria-label="Delete goal"
            size="xs"
            variant="ghost"
            color="red.400"
            _hover={{ bg: "red.50", color: "red.600" }}
            onClick={() => setShowDeleteConfirm(true)}
          >
            <Trash />
          </IconButton>
        </HStack>
      </HStack>

      {isEditing ? (
        <VStack align="stretch" gap={2} mt={2}>
          <HStack gap={2}>
            <Input
              size="sm"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              bg="gray.50"
              fontFamily="heading"
              flex={1}
              autoFocus
            />
            <FieldSelect
              w="140px"
              size="sm"
              value={draftKind}
              onChange={(v) => setDraftKind(v as GoalKind)}
              fieldProps={{ "aria-label": "Goal kind" }}
            >
              <option value="academic">Academic</option>
              <option value="personal">Personal</option>
              <option value="habit">Habit</option>
              <option value="hobby">Hobby</option>
            </FieldSelect>
          </HStack>
          <Textarea
            size="sm"
            value={draftDescription}
            onChange={(e) => setDraftDescription(e.target.value)}
            rows={2}
            bg="gray.50"
            fontFamily="body"
            fontSize="sm"
            placeholder="Description (optional)"
          />
          <HStack gap={2}>
            <Button
              size="xs"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              onClick={handleEditSave}
              disabled={isSaving || !draftTitle.trim()}
            >
              Save
            </Button>
            <Button size="xs" variant="ghost" fontFamily="heading" onClick={handleEditCancel} disabled={isSaving}>
              Cancel
            </Button>
          </HStack>
        </VStack>
      ) : (
        goal.description && (
          <Text fontSize="sm" color="charcoal.600" fontFamily="body" lineHeight="1.5" mt={1}>
            {goal.description}
          </Text>
        )
      )}

      {/* ── Lifecycle actions ─────────────────────────────────────── */}
      <HStack gap={2} mt={3} wrap="wrap">
        {goal.status === "proposed" && (
          <Button
            size="xs"
            bg="green.500"
            color="white"
            _hover={{ bg: "green.600" }}
            fontFamily="heading"
            onClick={handleApprove}
          >
            <CheckCircle style={{ marginRight: "4px" }} /> Approve
          </Button>
        )}
        {goal.status === "active" && (
          <>
            <Button size="xs" variant="outline" fontFamily="heading" onClick={() => handleSetStatus("achieved")}>
              Mark achieved
            </Button>
            <Button size="xs" variant="outline" fontFamily="heading" onClick={() => handleSetStatus("retired")}>
              Retire
            </Button>
          </>
        )}
        {(goal.status === "achieved" || goal.status === "retired") && (
          <Button size="xs" variant="ghost" fontFamily="heading" color="violet.600" onClick={() => handleSetStatus("active")}>
            Reactivate
          </Button>
        )}
      </HStack>

      {/* ── Feeds tutor ───────────────────────────────────────────── */}
      <HStack justify="space-between" mt={3} pt={2} borderTopWidth="1px" borderColor="gray.100">
        <HStack gap={2}>
          <Switch.Root
            size="sm"
            checked={goal.feedsTutor}
            onCheckedChange={(e) => handleToggleFeedsTutor(e.checked)}
            disabled={goal.status === "proposed"}
          >
            <Switch.HiddenInput />
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Root>
          <Text fontSize="xs" fontFamily="heading" color={goal.feedsTutor ? "violet.600" : "charcoal.400"}>
            {goal.feedsTutor ? "Feeds tutor" : "Doesn't feed tutor"}
          </Text>
        </HStack>
        {goal.status !== "active" && goal.feedsTutor && (
          <Text fontSize="2xs" fontFamily="body" color="charcoal.300">
            Only active goals actually reach the tutor prompt.
          </Text>
        )}
      </HStack>

      {/* ── Check-in history ──────────────────────────────────────── */}
      <Box mt={2}>
        <Button
          size="xs"
          variant="ghost"
          fontFamily="heading"
          color="charcoal.400"
          px={1}
          _hover={{ bg: "gray.50" }}
          onClick={() => setShowHistory((v) => !v)}
        >
          {showHistory ? <CaretDown /> : <CaretRight />}
          <Text ml={1}>
            {goal.checkinCount} {goal.checkinCount === 1 ? "check-in" : "check-ins"}
          </Text>
        </Button>
        {showHistory && <CheckinHistory goalId={goal._id} />}
      </Box>

      {/* Delete confirmation */}
      <Dialog.Root open={showDeleteConfirm} onOpenChange={(e) => setShowDeleteConfirm(e.open)} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Delete Goal
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  Delete goal <strong>{goal.title}</strong> and its {goal.checkinCount}{" "}
                  {goal.checkinCount === 1 ? "check-in" : "check-ins"}? This cannot be undone.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button size="sm" variant="ghost" fontFamily="heading" onClick={() => setShowDeleteConfirm(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={handleDelete}
                >
                  Delete
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}

// ─── Check-in history (lazy — only queried once expanded) ────────────

function CheckinHistory({ goalId }: { goalId: Id<"scholarGoals"> }) {
  const checkins = useQuery(api.scholarGoals.listCheckins, { goalId });

  if (checkins === undefined) {
    return (
      <Flex justify="center" py={2}>
        <Spinner size="xs" color="violet.400" />
      </Flex>
    );
  }
  if (checkins.length === 0) {
    return (
      <Text fontSize="xs" color="charcoal.300" fontFamily="body" mt={1} ml={5}>
        No check-ins logged yet.
      </Text>
    );
  }

  return (
    <VStack align="stretch" gap={1.5} mt={1.5} ml={5}>
      {checkins.map((c, i) => (
        <Box key={i} bg="gray.50" borderRadius="md" px={2.5} py={1.5}>
          <HStack gap={1} justify="space-between">
            <HStack gap={1}>
              <Text fontSize="2xs" fontFamily="heading" fontWeight="600" color="charcoal.400" textTransform="capitalize">
                {c.authorType}
              </Text>
              {c.authorType === "observer" && <Sparkle size={10} weight="fill" color="#AD60BF" />}
            </HStack>
            <Text fontSize="2xs" fontFamily="heading" color="charcoal.300">
              {formatRelative(c._creationTime)}
            </Text>
          </HStack>
          <Text fontSize="xs" fontFamily="body" color="charcoal.600" mt={0.5}>
            {c.note}
          </Text>
        </Box>
      ))}
    </VStack>
  );
}

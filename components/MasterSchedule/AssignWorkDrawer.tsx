"use client";

/**
 * AssignWorkDrawer — the ONE "Assign work" verb, one drawer, two entry points
 * (review/now-view-redesign.html §6). The surface supplies the default target:
 *
 *   • Schedule (Now / Day / Week) → a GROUP in a block. Writes a
 *     `schedulePlacements` row via `masterSchedule.placeClass` (optionally
 *     linking a curriculum activity). "Assign this to Group A in Block B."
 *   • Scholars (roster row / multi-select, or an empty target picked here) → a
 *     LEARNER, right now or queued. One "What to assign" selector, three kinds,
 *     all under the one verb:
 *       – Curriculum → assign an EXISTING activity from a unit via
 *         `assignments.assignWork` (+ `pushActivity` when starting now). This is
 *         the teacher pulling something from the Curriculum library onto one
 *         scholar on the spot — no re-authoring.
 *       – New activity → improvise a one-scholar activity on the spot via
 *         `assignments.dispatchActivity` (free-text prompt, "make one up now").
 *       – Quest → a scholar-owned independent study via
 *         `units.createAndOfferQuestForScholar` ("offer a quest they can
 *         run in their own time").
 *     Naming the three kinds explicitly (rather than a blurry "Activity")
 *     stops "assign existing" and "invent new" from hiding behind one word.
 *
 * When the surface supplies no scholar (e.g. the Schedule > Now "Assign to a
 * scholar" button), the drawer shows an inline ScholarPicker so the teacher can
 * choose the child right here.
 *
 * Both flows converge on the same confirmation shape — target · work · timing ·
 * mode — so Assign and "Dispatch" are one concept, not competing products. The
 * bot (dispatch_activity / place_class tools) is the text/voice twin of this
 * GUI; the "Ask the bot instead" door hands the same intent to the aide, which
 * is also the accessibility path.
 */
import { useMemo, useState } from "react";
import {
  Box,
  Button,
  Drawer,
  Flex,
  HStack,
  Input,
  Portal,
  Text,
  Textarea,
  VStack,
  chakra,
} from "@chakra-ui/react";
import { CaretLeft, CaretRight, Robot, X } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { useAideDock } from "@/components/aide/AideDockProvider";
import { ScholarPicker } from "@/components/ScholarPicker";
import { useScholarRoster } from "@/hooks/useScholarRoster";

export type AssignMode = "classFocus" | "homework";

/** Three ways to hand a learner work — all under the one "Assign work" verb.
 *  Curriculum → assign an existing activity from a unit; New activity → an
 *  ad-hoc dispatch improvised on the spot; Quest → an offered independent
 *  study. Named explicitly so "assign existing" and "invent new" don't blur. */
export type WorkKind = "curriculum" | "adhoc" | "quest";

/** The default target — supplied by whichever surface opened the drawer. */
export type AssignTarget =
  | {
      kind: "group";
      periodId: Id<"reportingPeriods">;
      groupId: Id<"scholarGroups">;
      groupLabel: string;
      /** When present, the placement lands in this block/day; otherwise shelf. */
      blockId?: Id<"scheduleBlocks">;
      weekday?: number;
      slotLabel?: string;
      defaultTeacherId?: Id<"users">;
    }
  | {
      kind: "learner";
      /** Zero, one, or many scholars. Empty → the drawer shows a picker so the
       *  teacher can choose the child here (e.g. the Now-view entry point). */
      scholars: { id: Id<"users">; name: string }[];
      /** Framing preset — advances / supports / enriches; all one verb. */
      intent?: LearnerIntent;
      /** Open straight into a given kind. Defaults to Curriculum. */
      defaultKind?: WorkKind;
    };

export type LearnerIntent = "next" | "scaffold" | "extension" | "custom";

const INTENT_COPY: Record<
  LearnerIntent,
  { heading: string; hint: string; placeholder: string }
> = {
  next: {
    heading: "Assign the next step",
    hint: "Advance an on-track scholar to what comes next.",
    placeholder: "e.g. Extend the number-line model to negative values",
  },
  scaffold: {
    heading: "Offer a supporting step",
    hint: "A gentler way in for a scholar who's stuck — not a deficit label.",
    placeholder: "e.g. Try the same idea with a concrete fraction model",
  },
  extension: {
    heading: "Hand off an extension",
    hint: "Enrichment for a scholar who finished the core prompt.",
    placeholder: "e.g. Explore how this applies to musical rhythm",
  },
  custom: {
    heading: "Assign work",
    hint: "Give this scholar something to explore, right now or queued.",
    placeholder: "e.g. Explore taxation methods in Copenhagen",
  },
};

export function AssignWorkDrawer({
  open,
  onClose,
  target,
}: {
  open: boolean;
  onClose: () => void;
  target: AssignTarget | null;
}) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(d) => {
        if (!d.open) onClose();
      }}
      placement="end"
      size="sm"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            display="flex"
            flexDirection="column"
            bg="white"
            shadow="lg"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            {target && (
              <AssignWorkForm key={targetKey(target)} target={target} onClose={onClose} />
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function targetKey(t: AssignTarget): string {
  return t.kind === "group"
    ? `group:${t.groupId}:${t.blockId ?? "shelf"}:${t.weekday ?? "-"}`
    : `learner:${t.scholars.map((s) => s.id).join(",")}:${t.intent ?? "custom"}`;
}

function AssignWorkForm({
  target,
  onClose,
}: {
  target: AssignTarget;
  onClose: () => void;
}) {
  const placeClass = useMutation(api.masterSchedule.placeClass);
  const dispatchActivity = useMutation(api.assignments.dispatchActivity);
  const offerQuest = useMutation(api.units.createAndOfferQuestForScholar);
  const assignWork = useMutation(api.assignments.assignWork);
  const pushActivity = useMutation(api.assignments.pushActivity);
  const aide = useAideDock();
  const { scholars: roster } = useScholarRoster();

  const intent: LearnerIntent = target.kind === "learner" ? target.intent ?? "custom" : "custom";
  const copy = INTENT_COPY[intent];

  const [title, setTitle] = useState("");
  const [guidance, setGuidance] = useState("");
  const [mode, setMode] = useState<AssignMode>("classFocus");
  const [timing, setTiming] = useState<"now" | "queue">("now");
  const [kind, setKind] = useState<WorkKind>(
    target.kind === "learner" ? target.defaultKind ?? "curriculum" : "curriculum",
  );
  // The existing curriculum activity chosen for the "Curriculum" kind.
  const [curSel, setCurSel] = useState<{
    unitId: Id<"units">;
    unitTitle: string;
    activityId: Id<"activities">;
    activityTitle: string;
  } | null>(null);
  // Set when the teacher chooses a scholar in-drawer (empty learner target).
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The scholars this assignment lands on: the ones the surface supplied, or the
  // single one picked here. Names resolve from the roster for toasts/dispatch.
  const scholars = useMemo<{ id: Id<"users">; name: string }[]>(() => {
    if (target.kind !== "learner") return [];
    if (target.scholars.length > 0) return target.scholars;
    if (!pickedId) return [];
    const found = roster.find((s) => s.id === pickedId);
    return [{ id: pickedId as Id<"users">, name: found?.name ?? "Scholar" }];
  }, [target, pickedId, roster]);

  // The learner target arrived without a scholar → let the teacher pick one.
  const needsScholarPick = target.kind === "learner" && target.scholars.length === 0;
  const isLearner = target.kind === "learner";
  const isCurriculum = isLearner && kind === "curriculum";
  const isQuest = isLearner && kind === "quest";

  const titleLabel =
    target.kind === "group"
      ? "Subject / class name"
      : isQuest
        ? "Quest topic"
        : "What should they explore?";
  const titlePlaceholder =
    target.kind === "group"
      ? "e.g. Fraction Sense"
      : isQuest
        ? "e.g. Build a working barometer"
        : copy.placeholder;

  const contextLine = useMemo(() => {
    if (target.kind === "group") {
      return target.slotLabel
        ? `${target.groupLabel} · ${target.slotLabel}`
        : `${target.groupLabel} · shelf (schedule later)`;
    }
    if (scholars.length === 0) return "Choose a scholar";
    return scholars.length === 1 ? scholars[0].name : `${scholars.length} scholars`;
  }, [target, scholars]);

  const canSubmit =
    !saving &&
    (target.kind === "group"
      ? title.trim().length > 0
      : scholars.length > 0 &&
        (isCurriculum ? curSel !== null : title.trim().length > 0));

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      if (target.kind === "group") {
        await placeClass({
          periodId: target.periodId,
          groupId: target.groupId,
          subject: title.trim(),
          mode,
          ...(target.defaultTeacherId ? { teacherId: target.defaultTeacherId } : {}),
          ...(target.weekday != null ? { weekday: target.weekday } : {}),
          ...(target.blockId ? { blockId: target.blockId } : {}),
        });
        toaster.create({
          title: "Added to the schedule",
          description: `${title.trim()} · ${target.groupLabel}`,
          type: "success",
        });
      } else if (isCurriculum && curSel) {
        // Assign an EXISTING curriculum activity to each scholar. assignWork
        // find-or-creates the assignment and PLANS the activity; when starting
        // now we follow with pushActivity to make it live immediately.
        const now = Date.now();
        const endsAt = mode === "classFocus" ? now + 3_600_000 : undefined;
        for (const s of scholars) {
          const assignmentId = await assignWork({
            unitId: curSel.unitId,
            scholarIds: [s.id],
            startsAt: now,
            target: {
              kind: "activity",
              activityId: curSel.activityId,
              mode,
              ...(endsAt ? { endsAt } : {}),
            },
          });
          if (timing === "now") {
            await pushActivity({
              assignmentId,
              activityId: curSel.activityId,
              mode,
              ...(endsAt ? { endsAt } : {}),
            });
          }
        }
        toaster.create({
          title: timing === "now" ? "Assigned now" : "Added to queue",
          description: `${curSel.activityTitle} · ${contextLine}`,
          type: "success",
        });
      } else if (isQuest) {
        // Offer a quest — a scholar-owned independent study they can run in
        // their own time. Same verb, different primitive from a dispatch.
        for (const s of scholars) {
          await offerQuest({
            scholarId: s.id,
            title: title.trim(),
            ...(guidance.trim() ? { description: guidance.trim() } : {}),
          });
        }
        toaster.create({
          title: "Quest offered",
          description: `${title.trim()} · ${contextLine}`,
          type: "success",
        });
      } else {
        // Ad-hoc dispatch — improvise a new one-scholar activity on the spot.
        for (const s of scholars) {
          await dispatchActivity({
            scholarId: s.id,
            title: title.trim(),
            ...(guidance.trim() ? { systemPrompt: guidance.trim() } : {}),
            mode,
            live: timing === "now",
          });
        }
        toaster.create({
          title: timing === "now" ? "Dispatched now" : "Added to queue",
          description: `${title.trim()} · ${contextLine}`,
          type: "success",
        });
      }
      onClose();
    } catch (err) {
      toaster.create({ title: "Couldn't assign", description: String(err), type: "error" });
    } finally {
      setSaving(false);
    }
  }

  function askBot() {
    const learnerNames =
      target.kind === "learner" ? scholars.map((s) => s.name).join(", ") : "";
    const text =
      target.kind === "group"
        ? `Help me assign work to ${target.groupLabel}${target.slotLabel ? ` in ${target.slotLabel}` : ""}: `
        : isQuest
          ? `Offer ${learnerNames || "a scholar"} a quest${title.trim() ? ` about ${title.trim()}` : ": "}`
          : isCurriculum
            ? `Assign ${learnerNames || "a scholar"} the activity${curSel ? ` "${curSel.activityTitle}"` : ": "}`
            : `Dispatch ${learnerNames || "a scholar"} a new activity${title.trim() ? ` to ${title.trim()}` : ": "}`;
    aide.seedComposer(text);
    onClose();
  }

  return (
    <>
      {/* Header */}
      <Flex
        align="center"
        justify="space-between"
        px={5}
        py={4}
        borderBottom="1px solid"
        borderColor="gray.100"
      >
        <Box>
          <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.700">
            {target.kind === "group"
              ? "Assign work"
              : isQuest
                ? "Offer a quest"
                : isCurriculum
                  ? "Assign an activity"
                  : copy.heading}
          </Text>
          <Text fontSize="xs" color="charcoal.400" lineClamp={1}>
            {contextLine}
          </Text>
        </Box>
        <chakra.button
          type="button"
          cursor="pointer"
          onClick={onClose}
          aria-label="Close"
          color="charcoal.400"
          _hover={{ color: "charcoal.600" }}
          p={1}
        >
          <X size={18} />
        </chakra.button>
      </Flex>

      {/* Body */}
      <VStack align="stretch" gap={5} px={5} py={5} flex={1} overflowY="auto">
        {needsScholarPick && (
          <Field label="Scholar">
            <Box borderWidth="1px" borderColor="gray.100" borderRadius="lg" p={1}>
              <ScholarPicker
                mode="single"
                selected={pickedId}
                onChange={setPickedId}
                searchable
                autoFocusSearch
                showGroups
                maxH="220px"
              />
            </Box>
          </Field>
        )}

        {target.kind === "learner" && (
          <Field label="What to assign">
            <Segmented
              fitted
              options={[
                { value: "curriculum", label: "Curriculum" },
                { value: "adhoc", label: "New activity" },
                { value: "quest", label: "Quest" },
              ]}
              value={kind}
              onChange={(v) => {
                setKind(v as WorkKind);
                setCurSel(null);
              }}
            />
            <Text fontSize="2xs" color="charcoal.300" mt={1.5}>
              {isCurriculum
                ? "Pull an existing activity from the Curriculum library onto this scholar."
                : isQuest
                  ? "A scholar-owned independent study — offered for them to run in their own time."
                  : "Improvise a brand-new one-scholar activity on the spot."}
            </Text>
          </Field>
        )}

        {isCurriculum && (
          <Field label="Activity">
            {curSel ? (
              <Flex
                align="center"
                justify="space-between"
                gap={2}
                borderWidth="1px"
                borderColor="violet.200"
                bg="violet.50"
                borderRadius="lg"
                px={3}
                py={2.5}
              >
                <Box minW={0}>
                  <Text fontSize="sm" color="navy.700" fontWeight="600" lineClamp={1}>
                    {curSel.activityTitle}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400" lineClamp={1}>
                    {curSel.unitTitle}
                  </Text>
                </Box>
                <chakra.button
                  type="button"
                  cursor="pointer"
                  onClick={() => setCurSel(null)}
                  color="violet.600"
                  fontSize="xs"
                  fontWeight="600"
                  flexShrink={0}
                >
                  Change
                </chakra.button>
              </Flex>
            ) : (
              <CurriculumActivityPicker onPick={setCurSel} />
            )}
          </Field>
        )}

        {!isCurriculum && (
          <Field label={titleLabel}>
            <Input
              autoFocus={!needsScholarPick && !isCurriculum}
              placeholder={titlePlaceholder}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && target.kind === "group") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
          </Field>
        )}

        {target.kind === "learner" && !isCurriculum && (
          <Field label={isQuest ? "Framing for the scholar (optional)" : "Guidance for the tutor (optional)"}>
            <Textarea
              placeholder={
                isQuest
                  ? "Why this quest, and what a great outcome looks like."
                  : "How should the AI tutor approach this? Left blank, it stays Socratic."
              }
              value={guidance}
              onChange={(e) => setGuidance(e.target.value)}
              rows={3}
            />
          </Field>
        )}

        {!isQuest && (
          <Field label="Mode">
            <Segmented
              options={[
                { value: "classFocus", label: "Class focus" },
                { value: "homework", label: "Homework" },
              ]}
              value={mode}
              onChange={(v) => setMode(v as AssignMode)}
            />
            <Text fontSize="2xs" color="charcoal.300" mt={1.5}>
              {mode === "homework"
                ? "Shows on the scholar's homework rail, done on their own time."
                : "In-class work the scholar sees during the block."}
            </Text>
          </Field>
        )}

        {target.kind === "learner" && !isQuest && (
          <Field label="Timing">
            <Segmented
              options={[
                { value: "now", label: "Start now" },
                { value: "queue", label: "Add to queue" },
              ]}
              value={timing}
              onChange={(v) => setTiming(v as "now" | "queue")}
            />
            <Text fontSize="2xs" color="charcoal.300" mt={1.5}>
              {timing === "now"
                ? "Goes live for this scholar immediately."
                : "Staged for you to start later. This scholar cannot see it yet."}
            </Text>
          </Field>
        )}

        {target.kind === "group" && !target.slotLabel && (
          <Text fontSize="2xs" color="charcoal.300">
            No block selected — this lands on the shelf as tentative. Drag it onto a
            day/block to schedule it.
          </Text>
        )}
      </VStack>

      {/* Footer */}
      <VStack
        align="stretch"
        gap={2}
        px={5}
        py={4}
        borderTop="1px solid"
        borderColor="gray.100"
      >
        <Button
          colorPalette="violet"
          onClick={() => void submit()}
          disabled={!canSubmit}
          loading={saving}
        >
          {target.kind === "group"
            ? "Add to schedule"
            : isQuest
              ? "Offer quest"
              : timing === "now"
                ? isCurriculum
                  ? "Assign now"
                  : "Dispatch now"
                : "Add to queue"}
        </Button>
        <Button variant="ghost" size="sm" onClick={askBot} color="charcoal.500">
          <HStack gap={1.5}>
            <Robot size={15} /> Ask the bot instead
          </HStack>
        </Button>
      </VStack>
    </>
  );
}

// ── Small local form primitives ──────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box>
      <Text
        fontSize="xs"
        color="charcoal.400"
        fontFamily="heading"
        fontWeight="600"
        textTransform="uppercase"
        letterSpacing="0.04em"
        mb={1.5}
      >
        {label}
      </Text>
      {children}
    </Box>
  );
}

function Segmented<T extends string>({
  options,
  value,
  onChange,
  fitted = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** Stretch to fill the row with equal-width buttons (for 3+ options). */
  fitted?: boolean;
}) {
  return (
    <HStack
      gap={1}
      p={1}
      bg="gray.100"
      borderRadius="lg"
      display={fitted ? "flex" : "inline-flex"}
      w={fitted ? "full" : undefined}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <chakra.button
            key={o.value}
            type="button"
            cursor="pointer"
            onClick={() => onChange(o.value)}
            flex={fitted ? 1 : undefined}
            px={fitted ? 2 : 3}
            py={1.5}
            borderRadius="md"
            fontFamily="heading"
            fontWeight="600"
            fontSize={fitted ? "xs" : "sm"}
            whiteSpace="nowrap"
            bg={active ? "white" : "transparent"}
            color={active ? "navy.700" : "charcoal.400"}
            shadow={active ? "xs" : "none"}
            _hover={active ? {} : { color: "charcoal.600" }}
            transition="background 0.1s, color 0.1s"
          >
            {o.label}
          </chakra.button>
        );
      })}
    </HStack>
  );
}

/**
 * CurriculumActivityPicker — a compact, in-drawer Unit → Activity drill-down
 * for the "Curriculum" kind. Lists real curriculum units (scholar-owned IS /
 * quest units are filtered out), then the activities inside the chosen unit
 * (flattened across its lessons via `activities.listByUnitPublic`). The lesson
 * level is skipped: `assignWork`'s activity target only needs unitId +
 * activityId, and the drawer is too narrow for the 3-column dialog picker.
 */
function CurriculumActivityPicker({
  onPick,
}: {
  onPick: (sel: {
    unitId: Id<"units">;
    unitTitle: string;
    activityId: Id<"activities">;
    activityTitle: string;
  }) => void;
}) {
  const units = useQuery(api.units.list, {});
  const [unitId, setUnitId] = useState<Id<"units"> | null>(null);
  const [unitTitle, setUnitTitle] = useState("");
  const [query, setQuery] = useState("");
  const activities = useQuery(
    api.activities.listByUnitPublic,
    unitId ? { unitId } : "skip",
  );

  // Real curriculum only — scholar-authored IS/quest units are private and
  // shouldn't show up as "assign an existing activity" sources.
  const curriculumUnits = useMemo(
    () =>
      (units ?? []).filter((u) => u.isActive !== false && !u.authorScholarId),
    [units],
  );

  const needle = query.trim().toLowerCase();
  const unitMatches = useMemo(
    () =>
      needle
        ? curriculumUnits.filter((u) =>
            (u.title ?? "").toLowerCase().includes(needle),
          )
        : curriculumUnits,
    [curriculumUnits, needle],
  );
  const activityMatches = useMemo(
    () =>
      needle
        ? (activities ?? []).filter((a) =>
            (a.title ?? "").toLowerCase().includes(needle),
          )
        : activities ?? [],
    [activities, needle],
  );

  // Unit chosen → show its activities.
  if (unitId) {
    return (
      <Box borderWidth="1px" borderColor="gray.100" borderRadius="lg">
        <Flex
          align="center"
          gap={2}
          px={3}
          py={2}
          borderBottom="1px solid"
          borderColor="gray.50"
        >
          <chakra.button
            type="button"
            cursor="pointer"
            onClick={() => {
              setUnitId(null);
              setUnitTitle("");
              setQuery("");
            }}
            color="violet.600"
            fontSize="xs"
            fontWeight="600"
            display="inline-flex"
            alignItems="center"
            gap={1}
            flexShrink={0}
          >
            <CaretLeft size={12} /> Units
          </chakra.button>
          <Text fontSize="xs" color="charcoal.400" lineClamp={1}>
            {unitTitle}
          </Text>
        </Flex>
        <Box p={2}>
          <Input
            size="sm"
            placeholder="Search activities…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            mb={2}
            autoFocus
          />
          <VStack
            align="stretch"
            gap={0.5}
            maxH="220px"
            overflowY="auto"
            role="listbox"
            aria-label="Curriculum activities"
          >
            {activities === undefined && (
              <Text fontSize="xs" color="charcoal.300" px={2} py={3}>
                Loading…
              </Text>
            )}
            {activities && activityMatches.length === 0 && (
              <Text fontSize="xs" color="charcoal.300" px={2} py={3}>
                No activities in this unit.
              </Text>
            )}
            {activityMatches.map((a) => (
              <chakra.button
                key={a._id}
                type="button"
                role="option"
                cursor="pointer"
                onClick={() =>
                  onPick({
                    unitId,
                    unitTitle,
                    activityId: a._id,
                    activityTitle: a.title,
                  })
                }
                textAlign="left"
                px={3}
                py={2}
                borderRadius="md"
                _hover={{ bg: "violet.50" }}
              >
                <Text
                  fontSize="sm"
                  color="navy.700"
                  fontWeight="600"
                  lineClamp={1}
                >
                  {a.title}
                </Text>
                <Text
                  fontSize="2xs"
                  color="charcoal.300"
                  textTransform="capitalize"
                >
                  {a.kind}
                  {a.durationMinutes ? ` · ${a.durationMinutes} min` : ""}
                </Text>
              </chakra.button>
            ))}
          </VStack>
        </Box>
      </Box>
    );
  }

  // No unit chosen yet → show the unit list.
  return (
    <Box borderWidth="1px" borderColor="gray.100" borderRadius="lg" p={2}>
      <Input
        size="sm"
        placeholder="Search units…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        mb={2}
        autoFocus
      />
      <VStack
        align="stretch"
        gap={0.5}
        maxH="220px"
        overflowY="auto"
        role="listbox"
        aria-label="Curriculum units"
      >
        {units === undefined && (
          <Text fontSize="xs" color="charcoal.300" px={2} py={3}>
            Loading…
          </Text>
        )}
        {units && unitMatches.length === 0 && (
          <Text fontSize="xs" color="charcoal.300" px={2} py={3}>
            No units found.
          </Text>
        )}
        {unitMatches.map((u) => (
          <chakra.button
            key={u._id}
            type="button"
            role="option"
            cursor="pointer"
            onClick={() => {
              setUnitId(u._id);
              setUnitTitle(u.title);
              setQuery("");
            }}
            textAlign="left"
            px={3}
            py={2}
            borderRadius="md"
            _hover={{ bg: "violet.50" }}
            display="flex"
            alignItems="center"
            justifyContent="space-between"
            gap={2}
          >
            <Text
              fontSize="sm"
              color="navy.700"
              fontWeight="600"
              lineClamp={1}
            >
              {u.emoji ? `${u.emoji} ` : ""}
              {u.title}
            </Text>
            <Box as="span" color="charcoal.300" flexShrink={0}>
              <CaretRight size={12} />
            </Box>
          </chakra.button>
        ))}
      </VStack>
    </Box>
  );
}

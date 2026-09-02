"use client";

/**
 * The scholar's take-home lane — the evening plan, the day's still-open work,
 * and the two ways to start something new tonight.
 *
 * This is a THIN rendering of `api.takeHomePlans.forSelf`: the backend owns
 * ordering, what is checkable, and which suggestions exist. Every affordance is
 * driven off each row's own `actions` array — the client never infers an action
 * from a row's kind, and never reshapes the wire data.
 *
 * Two modes, one card vocabulary (review/prep-quest-for-tonight-plan.html):
 * - `prep` (Scholar's Prep, page + Home tab): the full lane — the list, "Still
 *   open from today", what was marked done (with Undo), and the new-quest card.
 * - `home` (the Home Now tab, AFTER Prep): the SAME take-home card and
 *   nothing else — choosing is a Prep-time act; at home the kid just works the
 *   list. An empty plan stays visible as a quiet affirmative state.
 *
 * The two modes never render at once: Home shows the plan on the Now tab only
 * outside the Prep window, and the Prep tab owns it inside the window.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import {
  Box,
  Button,
  Flex,
  HStack,
  Input,
  Spinner,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import { BookmarkSimple, CaretRight, Check, NotePencil, Plus, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { TakeHomePinButton } from "@/components/TakeHomePinButton";
import { GameCapabilityNotice } from "@/components/GameCapabilityNotice";
import { WebAssignmentDoneDialog } from "@/components/WebAssignmentDoneDialog";
import { remainingLabel } from "@/components/takeHomePlanPlacement";
import { useGameActivity } from "@/hooks/useGameActivity";
import { useWebAssignment } from "@/hooks/useWebAssignment";
import { toaster } from "@/lib/toaster";
import { DueChip } from "@/components/ui/DueChip";

type Plan = FunctionReturnType<typeof api.takeHomePlans.forSelf>;
type AssignedItem = Plan["assigned"][number];
type SelectedItem = Plan["selected"][number];
type Suggestion = Plan["suggestions"][number];
type ResolvedItem = Plan["resolvedToday"][number];

/** The editor is either closed, composing a new note, or editing one row. */
type NoteEditor =
  | null
  | { mode: "new" }
  | { mode: "edit"; itemId: Id<"takeHomePlanItems"> };

const MINUTE_MS = 60_000;
const floorToMinute = (ms: number) => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

/** Every tappable control clears the 44px touch target on an iPad. */
const TOUCH = "44px";

const CHECK_ACTIONS = [
  "setChecked",
  "markDone",
  "undoMarkDone",
  "closeQuest",
  "undoCloseQuest",
];
const canCheckItem = (actions: readonly string[]) =>
  actions.some((action) => CHECK_ACTIONS.includes(action));

/**
 * Item rows keep their text on the card's 16px content inset. A checkbox is a
 * 44px touch target around a 22px glyph, so a row that has one pulls its own
 * padding in to 8px — that lets the tap area bleed outward while the glyph
 * still lands on the inset. Rows without a checkbox just use the inset
 * directly; they must not reserve an empty 44px column, which reads as a hole.
 */
const ROW_PX_WITH_CHECK = 2;
const ROW_PX_PLAIN = 4;
const FOCUS_RING = {
  outline: "2px solid",
  outlineColor: "violet.400",
  outlineOffset: "2px",
} as const;

export function TakeHomePlanCard({
  mode = "prep",
  onAddQuest,
  hideWhenEmpty = false,
}: {
  mode?: "prep" | "home";
  onAddQuest?: () => void;
  /** "One nothing per screen": when the page already renders a top-level empty
   *  state for a clear day, the home-mode card must not stack a second
   *  nothing-message above it. */
  hideWhenEmpty?: boolean;
}) {
  const router = useRouter();

  // The minute-rounded clock is the query's own reactive dependency: it re-runs
  // across the institution-local midnight (and as homework falls due) without
  // the client inventing a day key. Rounded so the subscription changes at most
  // once a minute.
  const [now, setNow] = useState(() => floorToMinute(Date.now()));
  useEffect(() => {
    const id = setInterval(() => setNow(floorToMinute(Date.now())), MINUTE_MS);
    return () => clearInterval(id);
  }, []);
  const plan = useQuery(api.takeHomePlans.forSelf, { now });

  const addSuggestion = useMutation(api.takeHomePlans.addSuggestion);
  const resolveSuggestion = useMutation(api.takeHomePlans.resolveSuggestion);
  const undoResolveSuggestion = useMutation(
    api.takeHomePlans.undoResolveSuggestion,
  );
  const addNote = useMutation(api.takeHomePlans.addNote);
  const editNote = useMutation(api.takeHomePlans.editNote);
  const setNoteChecked = useMutation(api.takeHomePlans.setNoteChecked);
  const removeItem = useMutation(api.takeHomePlans.removeItem);
  const markActivityDone = useMutation(api.takeHomePlans.markActivityDone);
  const undoMarkActivityDone = useMutation(
    api.takeHomePlans.undoMarkActivityDone,
  );
  const closeQuest = useMutation(api.takeHomePlans.closeQuest);
  const undoCloseQuest = useMutation(api.takeHomePlans.undoCloseQuest);
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const webAssignment = useWebAssignment();
  const gameActivity = useGameActivity();

  // Only the control the scholar touched goes busy — the rest of the list stays
  // live and readable.
  const [pending, setPending] = useState<string | null>(null);
  const [editor, setEditor] = useState<NoteEditor>(null);
  const [draft, setDraft] = useState("");
  // Closing the editor always returns focus to "Add a note" — whatever opened
  // it (that button, or a note's title) is unmounted while the editor is open,
  // so a stored element reference would be stale and focus would fall to
  // <body>. This button is present in every non-editing state.
  const addNoteRef = useRef<HTMLButtonElement | null>(null);

  const run = async (
    key: string,
    action: () => Promise<unknown>,
    failure = "Couldn't update your list",
  ) => {
    if (pending) return;
    setPending(key);
    try {
      await action();
    } catch (error) {
      console.error("[take-home-plan]", error);
      toaster.error({ title: failure, description: "Please try again." });
    } finally {
      setPending(null);
    }
  };

  const closeEditor = () => {
    setEditor(null);
    setDraft("");
    requestAnimationFrame(() => addNoteRef.current?.focus());
  };

  const saveNote = () => {
    const text = draft.trim();
    if (!editor || !text) {
      closeEditor();
      return;
    }
    const current = editor;
    void run("note", async () => {
      if (current.mode === "edit") {
        await editNote({ itemId: current.itemId, text });
      } else {
        await addNote({ text });
      }
      closeEditor();
    });
  };

  const openAssigned = (item: AssignedItem) => {
    void run(
      `assigned:${item.id}`,
      async () => {
        if (item.activityKind === "offline") {
          const result = await openOfflineHomework({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
          });
          router.push(`/scholar/${result.id}`);
          return;
        }
        if (item.activityKind === "web") {
          await webAssignment.launch({
            activityId: item.activityId,
            assignmentId: item.assignmentId,
            title: item.label,
            webUrl: item.webUrl,
            webAllowedHosts: item.webAllowedHosts,
          });
          return;
        }
        if (item.activityKind === "game") {
          await gameActivity.launch({
            activityId: item.activityId,
            title: item.label,
            gameId: item.gameId,
          });
          return;
        }
        if (item.activityKind === "problem_set" && item.practiceSkillKey) {
          router.push(
            `/scholar/practice?skill=${encodeURIComponent(item.practiceSkillKey)}`,
          );
          return;
        }
        const result = await createSession({
          activityId: item.activityId,
          assignmentId: item.assignmentId,
        });
        if (result) router.push(`/scholar/${result.id}`);
      },
      "Couldn't open that activity",
    );
  };

  if (plan === undefined) {
    // Home never flashes a skeleton card for a list that may be empty.
    if (mode === "home") return null;
    return (
      <Surface p={6}>
        <Flex justify="center">
          <Spinner
            size="sm"
            colorPalette="violet"
            aria-label="Loading tonight's list"
          />
        </Flex>
      </Surface>
    );
  }

  // A non-scholar (a teacher previewing, a parent) gets the empty shape back.
  if (plan.dayKey === null) return null;

  const total = plan.assigned.length + plan.selected.length;
  const isWeekendPlan = plan.takeHomePeriod === "weekend";
  const planHeading = isWeekendPlan ? "To do this weekend" : "To do tonight";
  const countLabel = remainingLabel({
    assignedCount: plan.assigned.length,
    selected: plan.selected,
  });

  if (mode === "home" && total === 0) {
    if (hideWhenEmpty) return null;
    return (
      <Surface p={0}>
        <EmptyState title="Nothing due tonight" />
      </Surface>
    );
  }

  const openSelected = (item: SelectedItem) => {
    if (item.kind === "note" || !item.sessionId) return;
    router.push(`/scholar/${item.sessionId}`);
  };

  const anyCheckable = plan.selected.some((item) => canCheckItem(item.actions));

  return (
    <Stack gap={3}>
      {/* ── Canonical take-home list ─────────────────────────────────── */}
      <Surface p={0} overflow="hidden">        <Flex
          align="center"
          gap={3}
          px={4}
          py={3}
          borderBottomWidth="1px"
          borderColor="gray.100"
        >
          <Box color="violet.600" display="flex">
            <BookmarkSimple aria-hidden="true" size={18} weight="fill" />
          </Box>
          <Text
            fontFamily="heading"
            fontWeight="700"
            fontSize="md"
            color="charcoal.600"
          >
            {planHeading}
          </Text>
          <Box flex={1} />
          {countLabel && (
            <Text fontFamily="heading" fontSize="sm" color="charcoal.400">
              {countLabel}
            </Text>
          )}
        </Flex>

        {total === 0 && (
          <Text px={4} py={4} fontSize="sm" color="charcoal.500" lineHeight="1.5">
            Nothing on your list yet. Add a note, or check the ideas below.
          </Text>
        )}

        {plan.assigned.map((item) => (
          <AssignedRow
            key={item.id}
            item={item}
            reserveCheckSlot={anyCheckable}
            disabled={pending !== null}
            nowMs={now}
            timeZone={plan.timeZone}
            onOpen={() => openAssigned(item)}
          />
        ))}

        {plan.selected.map((item) => {
          const label = item.kind === "note" ? item.text : item.label;
          const canCheck = canCheckItem(item.actions);
          const busy = pending === String(item.id);
          const editing =
            editor?.mode === "edit" && editor.itemId === item.id;
          if (editing) {
            return (
              <NoteEditorRow
                key={item.id}
                value={draft}
                onChange={setDraft}
                onCancel={closeEditor}
                onSave={saveNote}
                busy={pending === "note"}
                label="Edit note"
              />
            );
          }
          return (
            <Flex
              key={item.id}
              align="center"
              gap={2}
              px={anyCheckable ? ROW_PX_WITH_CHECK : ROW_PX_PLAIN}
              py={2}
              minH="56px"
              borderTopWidth="1px"
              borderColor="gray.100"
              opacity={busy ? 0.6 : 1}
            >
              {canCheck ? (
                <chakra.button
                  type="button"
                  role="checkbox"
                  aria-checked={item.checked}
                  aria-label={`${item.checked ? "Uncheck" : "Check"} ${label}`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(String(item.id), () => {
                      if (item.kind === "note") {
                        return setNoteChecked({
                          itemId: item.id,
                          checked: !item.checked,
                        });
                      }
                      if (item.kind === "activity") {
                        return item.checked
                          ? undoMarkActivityDone({ itemId: item.id })
                          : markActivityDone({ itemId: item.id });
                      }
                      if (item.kind === "quest") {
                        return item.checked
                          ? undoCloseQuest({ itemId: item.id })
                          : closeQuest({ itemId: item.id });
                      }
                      return Promise.resolve();
                    })
                  }
                  w={TOUCH}
                  h={TOUCH}
                  flexShrink={0}
                  display="grid"
                  placeItems="center"
                  cursor="pointer"
                  borderRadius="md"
                  _hover={{ bg: "gray.50" }}
                  _focusVisible={{
                    outline: "2px solid",
                    outlineColor: "gray.400",
                    outlineOffset: "2px",
                  }}
                  _disabled={{ cursor: "not-allowed" }}
                >
                  <Box
                    w="22px"
                    h="22px"
                    borderWidth="2px"
                    borderColor={item.checked ? "violet.500" : "gray.300"}
                    borderRadius="md"
                    bg={item.checked ? "violet.500" : "white"}
                    color="white"
                    display="grid"
                    placeItems="center"
                    aria-hidden
                  >
                    {item.checked && <Check size={14} weight="bold" />}
                  </Box>
                </chakra.button>
              ) : anyCheckable ? (
                <Box w={TOUCH} h={TOUCH} flexShrink={0} aria-hidden />
              ) : null}

              <Box flex={1} minW={0}>
                <RowTitle                  label={label}
                  checked={item.checked}
                  onClick={
                    item.kind !== "note" && item.sessionId
                      ? () => openSelected(item)
                      : undefined
                  }
                  actionLabel={`Open ${label}`}
                />
                {item.kind !== "note" && item.meta && (
                  <Text
                    fontSize="sm"
                    color="charcoal.400"
                    lineHeight="1.4"
                    overflowWrap="anywhere"
                  >
                    {item.meta}
                  </Text>
                )}
              </Box>

              {item.kind !== "note" ? (
                <TakeHomePinButton
                  pinned
                  busy={pending !== null}
                  subject={label}
                  onToggle={() =>
                    void run(String(item.id), () => removeItem({ itemId: item.id }))
                  }
                />
              ) : (
                <HStack gap={0} flexShrink={0}>
                  {item.kind === "note" && item.actions.includes("edit") && (
                    <chakra.button
                      type="button"
                      aria-label={`Edit ${label}`}
                      disabled={pending !== null}
                      onClick={() => {
                        setDraft(item.text);
                        setEditor({ mode: "edit", itemId: item.id });
                      }}
                      w={TOUCH}
                      h={TOUCH}
                      display="grid"
                      placeItems="center"
                      color="charcoal.300"
                      borderRadius="md"
                      cursor="pointer"
                      _hover={{ bg: "gray.50", color: "violet.600" }}
                      _focusVisible={FOCUS_RING}
                      _disabled={{ cursor: "not-allowed" }}
                    >
                      <NotePencil size={17} />
                    </chakra.button>
                  )}
                  {item.actions.includes("remove") && (
                    <chakra.button
                      type="button"
                      aria-label={`Remove ${label}`}
                      disabled={pending !== null}
                      onClick={() =>
                        void run(String(item.id), () =>
                          removeItem({ itemId: item.id }),
                        )
                      }
                      w={TOUCH}
                      h={TOUCH}
                      display="grid"
                      placeItems="center"
                      color="charcoal.400"
                      borderRadius="md"
                      cursor="pointer"
                      _hover={{ bg: "gray.50", color: "charcoal.600" }}
                      _focusVisible={FOCUS_RING}
                      _disabled={{ cursor: "not-allowed" }}
                    >
                      <X size={18} />
                    </chakra.button>
                  )}
                </HStack>
              )}
            </Flex>
          );
        })}

        {editor?.mode === "new" ? (
          <NoteEditorRow
            value={draft}
            onChange={setDraft}
            onCancel={closeEditor}
            onSave={saveNote}
            busy={pending === "note"}
            label="Note"
          />
        ) : (
          <Flex
            px={ROW_PX_PLAIN}
            py={2}
            borderTopWidth="1px"
            borderColor="gray.100"
            gap={6}
          >
            <Button
              size="sm"
              minH={TOUCH}
              px={0}
              variant="plain"
              colorPalette="violet"
              ref={addNoteRef}
              disabled={pending !== null}
              onClick={() => {
                setDraft("");
                setEditor({ mode: "new" });
              }}
              _focusVisible={FOCUS_RING}
            >
              <Plus size={16} weight="bold" /> Add a note
            </Button>
            {mode === "prep" && onAddQuest && (
              <Button
                size="sm"
                minH={TOUCH}
                px={0}
                variant="plain"
                colorPalette="violet"
                disabled={pending !== null}
                onClick={onAddQuest}
                _focusVisible={FOCUS_RING}
              >
                <Plus size={16} weight="bold" /> Add a Quest
              </Button>
            )}
          </Flex>
        )}
      </Surface>

      {/* ── Still open from today ────────────────────────────────────── */}
      {mode === "prep" && plan.suggestions.length > 0 && (
        <Surface p={0} overflow="hidden">
          <Box px={4} py={3} borderBottomWidth="1px" borderColor="gray.100">
            <Text
              fontFamily="heading"
              fontWeight="700"
              fontSize="md"
              color="charcoal.600"
            >
              Still open from today
            </Text>
            <Text fontSize="sm" color="charcoal.500" lineHeight="1.5" mt={1}>
              Rabbithole saw these open. Only you know if they&rsquo;re
              finished. You can leave anything you&rsquo;re not sure about.
            </Text>
          </Box>
          {plan.suggestions.map((item) => (
            <SuggestionRow
              key={item.id}
              item={item}
              disabled={pending !== null}
              onAdd={() =>
                void run(`add:${item.id}`, () =>
                  addSuggestion({
                    suggestion:
                      item.kind === "activity"
                        ? { kind: "activity", sessionId: item.sessionId }
                        : { kind: "quest", unitId: item.unitId },
                  }),
                )
              }
              onFinish={() =>
                void run(`done:${item.id}`, () =>
                  resolveSuggestion({
                    suggestion:
                      item.kind === "activity"
                        ? { kind: "activity", sessionId: item.sessionId }
                        : { kind: "quest", unitId: item.unitId },
                  }),
                )
              }
            />
          ))}
        </Surface>
      )}

      {/* ── Marked done (durable undo, not a toast) ──────────────────── */}
      {mode === "prep" && plan.resolvedToday.length > 0 && (
        <Surface p={0} overflow="hidden">
          <Box px={4} py={3} borderBottomWidth="1px" borderColor="gray.100">
            <Text
              fontFamily="heading"
              fontWeight="700"
              fontSize="md"
              color="charcoal.600"
            >
              Marked done
            </Text>
          </Box>
          {plan.resolvedToday.map((item: ResolvedItem) => (
            <Flex
              key={item.itemId}
              align="center"
              gap={3}
              px={4}
              py={2}
              borderTopWidth="1px"
              borderColor="gray.100"
              minH="52px"
            >
              <Text
                fontSize="sm"
                color="charcoal.500"
                overflowWrap="anywhere"
                flex={1}
              >
                {item.label}
              </Text>
              {item.actions.includes("undo") && (
                <Button
                  size="sm"
                  minH={TOUCH}
                  variant="plain"
                  colorPalette="violet"
                  aria-label={`Undo ${item.label}`}
                  disabled={pending !== null}
                  onClick={() =>
                    void run(`undo:${item.itemId}`, () =>
                      undoResolveSuggestion({ itemId: item.itemId }),
                    )
                  }
                  _focusVisible={FOCUS_RING}
                >
                  Undo
                </Button>
              )}
            </Flex>
          ))}
        </Surface>
      )}

      <WebAssignmentDoneDialog
        prompt={webAssignment.donePrompt}
        onResolve={webAssignment.resolveDonePrompt}
      />
      <GameCapabilityNotice
        prompt={gameActivity.prompt}
        onDismiss={gameActivity.dismiss}
      />
    </Stack>
  );
}

/**
 * Assigned homework is DERIVED, never a plan row the scholar edits — so it has
 * no checkbox and no remove. Each row launches its exact assigned activity.
 *
 * The anatomy is the shared row grammar: glyph · (title + attribution) ·
 * status · CTA. Notably it used to signal "you can press this" THREE times
 * (whole-row press, an "Assigned" tag, and a bare caret) while the deadline ate
 * the attribution slot, so an overdue row lost its unit and teacher. Now the
 * deadline has its own status chip, "Assigned" demotes to the meta prefix it
 * always was, and the bare caret is absorbed into the one CTA.
 */
function AssignedRow({
  item,
  disabled,
  nowMs,
  timeZone,
  reserveCheckSlot,
  onOpen,
}: {
  item: AssignedItem;
  disabled: boolean;
  nowMs: number;
  timeZone: string | null;
  reserveCheckSlot: boolean;
  onOpen: () => void;
}) {
  // Attribution: what this is and whose it is. These rows are not grouped under
  // a unit band, so they carry their own identity (see the axes in
  // review/scholar-activity-row-rationalization.html §4).
  const meta = ["Assigned", item.meta, item.teacherName ? `with ${item.teacherName}` : null]
    .filter(Boolean)
    .join(" \u00b7 ");
  return (
    <chakra.button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${item.label}`}
      disabled={disabled}
      display="flex"
      w="full"
      textAlign="left"
      alignItems="center"
      gap={2}
      px={reserveCheckSlot ? ROW_PX_WITH_CHECK : ROW_PX_PLAIN}
      py={2}
      minH="56px"
      borderTopWidth="1px"
      borderColor="gray.100"
      cursor="pointer"
      _hover={{ bg: "gray.50" }}
      _disabled={{ cursor: "not-allowed" }}
      _focusVisible={FOCUS_RING}
    >
      {/* Assigned rows are derived, so they never get a checkbox. They only
          reserve its column when a sibling row actually has one — otherwise
          the empty 44px reads as a hole punched in the card. */}
      {reserveCheckSlot && (
        <Box w={TOUCH} h={TOUCH} flexShrink={0} aria-hidden />
      )}
      {item.unitEmoji && (
        <Text fontSize="md" flexShrink={0} lineHeight="1.4" aria-hidden>
          {item.unitEmoji}
        </Text>
      )}
      <Box flex={1} minW={0}>
        <Text
          fontFamily="heading"
          fontWeight="600"
          fontSize="md"
          color="charcoal.600"
          lineHeight="1.35"
          overflowWrap="anywhere"
          flex={1}
          minW={0}
        >
          {item.label}
        </Text>
        <Text fontSize="xs" color="charcoal.400" lineHeight="1.4">
          {meta}
        </Text>
      </Box>
      {timeZone && (
        <DueChip dueAt={item.dueAt} nowMs={nowMs} timeZone={timeZone} />
      )}
      <HStack gap={0.5} flexShrink={0} color="violet.600" aria-hidden>
        <Text fontFamily="heading" fontWeight="600" fontSize="xs">
          Open
        </Text>
        <CaretRight size={14} weight="bold" />
      </HStack>
    </chakra.button>
  );
}

function RowTitle({
  label,
  checked,
  onClick,
  actionLabel,
}: {
  label: string;
  checked: boolean;
  onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  actionLabel: string;
}) {
  const styles = {
    fontFamily: "heading",
    fontWeight: 600,
    fontSize: "md",
    color: checked ? "charcoal.400" : "charcoal.600",
    textDecoration: checked ? "line-through" : undefined,
    lineHeight: "1.35",
  } as const;
  if (!onClick) {
    return (
      <Text {...styles} overflowWrap="anywhere">
        {label}
      </Text>
    );
  }
  return (
    <chakra.button
      type="button"
      onClick={onClick}
      aria-label={actionLabel}
      display="block"
      textAlign="left"
      w="full"
      minH={TOUCH}
      cursor="pointer"
      overflowWrap="anywhere"
      borderRadius="sm"
      _hover={{ textDecorationLine: "underline" }}
      _focusVisible={FOCUS_RING}
      {...styles}
    >
      {label}
    </chakra.button>
  );
}

/** Focused, cancelable note editor — Escape and Cancel both back out. */
function NoteEditorRow({
  value,
  onChange,
  onCancel,
  onSave,
  busy,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
  label: string;
}) {
  return (
    <Flex
      as="form"
      onSubmit={(event: React.FormEvent) => {
        event.preventDefault();
        onSave();
      }}
      align="center"
      gap={2}
      px={4}
      py={3}
      borderTopWidth="1px"
      borderColor="gray.100"
      flexWrap="wrap"
    >
      <Box color="violet.500" display="flex" aria-hidden>
        <NotePencil size={18} />
      </Box>
      <Input
        autoFocus
        flex={1}
        minW="180px"
        minH={TOUCH}
        size="md"
        fontSize="md"
        aria-label={label}
        placeholder="What do you want to remember?"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        _focusVisible={FOCUS_RING}
      />
      <HStack gap={2}>
        <Button
          type="button"
          size="sm"
          minH={TOUCH}
          variant="outline"
          colorPalette="gray"
          onClick={onCancel}
          _focusVisible={FOCUS_RING}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          minH={TOUCH}
          colorPalette="violet"
          disabled={!value.trim() || busy}
          _focusVisible={FOCUS_RING}
        >
          Save
        </Button>
      </HStack>
    </Flex>
  );
}

function SuggestionRow({
  item,
  disabled,
  onAdd,
  onFinish,
}: {
  item: Suggestion;
  disabled: boolean;
  onAdd: () => void;
  onFinish: () => void;
}) {
  return (
    <Stack
      gap={1.5}
      px={4}
      py={3}
      borderTopWidth="1px"
      borderColor="gray.100"
      opacity={disabled ? 0.75 : 1}
    >
      <Text
        fontFamily="heading"
        fontWeight="700"
        fontSize="xs"
        color="violet.600"
        textTransform="uppercase"
        letterSpacing="0.04em"
      >
        {item.kind === "quest" ? "Quest" : "From today's class"}
      </Text>
      <Flex align="baseline" gap={2}>
        {item.kind === "quest" && item.meta && (
          <Text aria-hidden="true" fontSize="lg" lineHeight="1" flexShrink={0}>
            {item.meta}
          </Text>
        )}
        <Text
          fontFamily="heading"
          fontWeight="600"
          fontSize="md"
          color="charcoal.600"
          lineHeight="1.35"
          overflowWrap="anywhere"
        >
          {item.label}
        </Text>
      </Flex>
      {item.kind === "activity" && item.meta && (
        <Text fontSize="sm" color="charcoal.400" overflowWrap="anywhere">
          {item.meta}
        </Text>
      )}
      <HStack gap={2} flexWrap="wrap" pt={1}>
        {item.actions.includes("addToPlan") && (
          <TakeHomePinButton
            pinned={false}
            busy={disabled}
            subject={item.label}
            onToggle={onAdd}
          />
        )}
        {item.actions.includes("markDone") && (
          <Button
            size="sm"
            minH={TOUCH}
            w="88px"
            variant="outline"
            colorPalette="gray"
            aria-label={`I’m finished with ${item.label}`}
            disabled={disabled}
            onClick={onFinish}
            _focusVisible={FOCUS_RING}
          >
            <Check aria-hidden="true" size={16} weight="bold" />
            Done
          </Button>
        )}
      </HStack>
    </Stack>
  );
}

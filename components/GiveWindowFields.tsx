"use client";

/**
 * The two questions every give asks (TRA-571): "Shows up" and "Finish".
 *
 * One form, used by every way a teacher gives work in the web app: the Run
 * page's "Give…", the agenda's schedule dialog, the assign dialog, and the
 * Master Schedule drawer. The choices come from `api.assignments.giveChoices`
 * (the group's bell blocks, when "in that class" would end, due-day
 * suggestions, and what "the end of the unit" means), and the answers are
 * sent to the server as-is: the server maps them onto stored fields
 * (convex/lib/giveWindow.ts), so the form never decides a mode.
 *
 * "Open until a date" is stored as a class focus that ends on a later day
 * (shared/openUntil.ts tells it apart from "In that class").
 *
 * Nothing is pre-selected under "Finish". A give button stays disabled until
 * the teacher picks one (`finish` stays null until then).
 *
 * `mode="push"` is the same form for an app, a file or a link put in front of
 * scholars now (GiveNowDialog; TRA-580): no "Shows up" (it's now), and the
 * fading finishes only, since an app has nothing to be late on: In that class,
 * For a while (quick picks, for a window no class lines up with), Open until a
 * date. Its choices come from `api.pushes.focusGiveChoices`.
 */
import { useEffect, useState } from "react";
import { Box, chakra, HStack, Spinner, Stack, Text } from "@chakra-ui/react";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import { FOCUS_DURATION_CHOICES_MIN } from "@/convex/lib/pushes";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import {
  dayKeyForTimezone,
  instantForLocalMinutes,
  minuteOfDayForTimezone,
} from "@/shared/institutionDay";
import {
  nonSchoolDayNote,
  schoolDayKeysAfter,
  shortDayLabel,
} from "@/shared/schoolClosures";

type GiveChoicesResult = NonNullable<
  FunctionReturnType<typeof api.assignments.giveChoices>
>;
/** The choices a give form offers. */
export type GiveChoices = Exclude<GiveChoicesResult, { refused: string }>;
/** The server refused the roster: a state the form shows, never a crash. */
export type GiveRefusal = Extract<GiveChoicesResult, { refused: string }>;

/** The usable choices, or null while loading, skipped or refused. */
export function usableGiveChoices(
  choices: GiveChoices | GiveRefusal | null | undefined,
): GiveChoices | null {
  return choices && !("refused" in choices) ? choices : null;
}
export type GiveFinish =
  | { kind: "inClass" }
  | { kind: "by"; dayKey: string }
  | { kind: "endOfUnit" }
  | { kind: "openUntil"; dayKey: string };
export type ShowsUp = { kind: "now" } | { kind: "at"; at: number };
/** An app's, a file's or a link's finish (convex/pushes.ts pushFinishValidator). */
export type PushFinish =
  | { kind: "inClass" }
  | { kind: "forAWhile"; minutes: number }
  | { kind: "openUntil"; dayKey: string };

const MINUTE = 60_000;

function minuteRoundedNow(): number {
  return Math.floor(Date.now() / MINUTE) * MINUTE;
}

/** The minute-rounded clock the give queries take (T11). */
export function useMinuteNow(): number {
  const [nowMs, setNowMs] = useState(minuteRoundedNow);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(minuteRoundedNow()), MINUTE);
    return () => clearInterval(timer);
  }, []);
  return nowMs;
}

/** Epoch ms for when the work shows up (now = the current minute). */
export function showsUpAt(showsUp: ShowsUp, nowMs: number): number {
  return showsUp.kind === "now" ? nowMs : showsUp.at;
}

/**
 * Load the give choices for one give. Pass `assignmentId`, or `unitId` +
 * `scholarIds` for a give that may create the assignment; "skip" until the
 * form knows who it's for.
 */
export function useGiveChoices(
  args:
    | Omit<FunctionArgs<typeof api.assignments.giveChoices>, "nowMs">
    | "skip",
  nowMs: number,
): GiveChoices | GiveRefusal | null | undefined {
  const choices = useSmoothedQuery(
    api.assignments.giveChoices,
    args === "skip" ? "skip" : { ...args, nowMs },
    {
      resetKey:
        args === "skip"
          ? "skip"
          : `${args.assignmentId ?? ""}|${args.unitId ?? ""}|${(args.scholarIds ?? []).join(",")}`,
    },
  );
  // Skipped = the form doesn't know who it's for yet: say so, don't spin.
  return args === "skip" ? null : choices;
}

function clockTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(ms));
}

/** The server's "Today" / "Tomorrow" / "Fri, Nov 6", for use mid-sentence. */
function lowerRelative(label: string): string {
  return label === "Today" || label === "Tomorrow" ? label.toLowerCase() : label;
}

/** A school-local "YYYY-MM-DDTHH:MM" for a datetime-local input: the school's
 *  clock, not the browser's, so a teacher abroad types school time. */
export function schoolInputValue(ms: number, timeZone: string): string {
  const minutes = minuteOfDayForTimezone(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dayKeyForTimezone(ms, timeZone)}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Epoch ms for a school-local datetime-local value, or null when invalid. */
export function parseSchoolInputValue(
  value: string,
  timeZone: string,
): number | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  try {
    return instantForLocalMinutes(
      match[1],
      Number(match[2]) * 60 + Number(match[3]),
      timeZone,
    );
  } catch {
    return null; // a DST gap
  }
}

const inputStyle = {
  w: "full",
  px: 3,
  py: 2,
  borderWidth: "1px",
  borderColor: "gray.200",
  borderRadius: "md",
  fontFamily: "heading",
  fontSize: "sm",
  bg: "white",
} as const;

type WorkFieldsProps = {
  mode?: "work";
  showsUp: ShowsUp;
  onShowsUpChange: (next: ShowsUp) => void;
  /** False where the form only plans ahead (the agenda dialog). */
  allowNow?: boolean;
  /** False for unit-less work (an ad-hoc dispatch has no unit to end). */
  allowEndOfUnit?: boolean;
  finish: GiveFinish | null;
  onFinishChange: (next: GiveFinish) => void;
};

type PushFieldsProps = {
  mode: "push";
  finish: PushFinish | null;
  onFinishChange: (next: PushFinish) => void;
};

const NOW: ShowsUp = { kind: "now" };
const DEFAULT_FOR_A_WHILE_MIN = 60;

export function GiveWindowFields(
  props: {
    choices: GiveChoices | GiveRefusal | null | undefined;
    nowMs: number;
  } & (WorkFieldsProps | PushFieldsProps),
) {
  const { choices, nowMs, finish } = props;
  const push = props.mode === "push";
  const showsUp = props.mode === "push" ? NOW : props.showsUp;
  const onShowsUpChange =
    props.mode === "push" ? () => {} : props.onShowsUpChange;
  const allowNow = props.mode === "push" ? true : (props.allowNow ?? true);
  const allowEndOfUnit =
    props.mode === "push" ? false : (props.allowEndOfUnit ?? true);
  // Each mode only ever hands back its own finishes.
  const onFinishChange = props.onFinishChange as (
    next: GiveFinish | PushFinish,
  ) => void;
  const [minutes, setMinutes] = useState<number>(
    finish?.kind === "forAWhile" ? finish.minutes : DEFAULT_FOR_A_WHILE_MIN,
  );
  const refusal = choices && "refused" in choices ? choices.refused : null;
  const usable = usableGiveChoices(choices);
  // "Another time…" and "Another date…" open their own inputs.
  const blockStarts = new Set((usable?.blocks ?? []).map((b) => b.startsAt));
  const [customTime, setCustomTime] = useState(
    showsUp.kind === "at" && !blockStarts.has(showsUp.at),
  );
  // "By a date" opens on the week's last school day: "this week" (TRA-581).
  const firstDueDay =
    (usable?.dueDays.find((day) => day.isWeekEnd) ?? usable?.dueDays[0])
      ?.dayKey ?? "";
  const [byDay, setByDay] = useState<string>(
    finish?.kind === "by" ? finish.dayKey : "",
  );
  // The saved finish wins over local picker state: an edit dialog can hand us
  // its finish after the first render, when `byDay` has already seeded empty.
  const effectiveByDay =
    (finish?.kind === "by" ? finish.dayKey : "") || byDay || firstDueDay;
  const [customDay, setCustomDay] = useState(false);
  const [untilDay, setUntilDay] = useState<string>(
    finish?.kind === "openUntil" ? finish.dayKey : "",
  );
  const [customUntilDay, setCustomUntilDay] = useState(false);

  const showsUpValue =
    showsUp.kind === "now"
      ? "now"
      : customTime || !blockStarts.has(showsUp.at)
        ? "other"
        : String(showsUp.at);

  if (choices === undefined) {
    return <Spinner size="sm" color="violet.500" />;
  }
  if (refusal) {
    return (
      <Text fontSize="xs" color="red.600" fontFamily="heading" role="alert">
        {refusal}
      </Text>
    );
  }
  if (usable === null) {
    return (
      <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
        Pick the work and who it&apos;s for first.
      </Text>
    );
  }

  // A "by" or "open until" date that isn't a school day gets a quiet note
  // (and the next school day as a one-click fix). A warning only: Give stays
  // enabled.
  const datedFinish =
    finish?.kind === "by" || finish?.kind === "openUntil" ? finish : null;
  const dayNote = datedFinish
    ? nonSchoolDayNote(datedFinish.dayKey, usable.closures)
    : null;
  const nextSchoolDay =
    dayNote && datedFinish
      ? (schoolDayKeysAfter(datedFinish.dayKey, usable.closures, 1, {
          maxCalendarDays: 60,
        })[0] ?? null)
      : null;
  const pickByDay = (dayKey: string) => {
    setByDay(dayKey);
    if (!usable.dueDays.some((day) => day.dayKey === dayKey)) setCustomDay(true);
    onFinishChange({ kind: "by", dayKey });
  };
  // Open until has to end on a later day than it shows up (the same day is
  // "In that class"), so its suggestions skip the start day.
  const startDayKey = dayKeyForTimezone(
    showsUpAt(showsUp, nowMs),
    usable.timeZone,
  );
  const untilDays = usable.dueDays.filter((day) => day.dayKey > startDayKey);
  const effectiveUntilDay =
    (finish?.kind === "openUntil" ? finish.dayKey : "") ||
    untilDay ||
    untilDays[0]?.dayKey ||
    "";
  const pickUntilDay = (dayKey: string) => {
    setUntilDay(dayKey);
    if (!untilDays.some((day) => day.dayKey === dayKey)) setCustomUntilDay(true);
    onFinishChange({ kind: "openUntil", dayKey });
  };
  const nonSchoolDayNoteRow = dayNote && (
    <HStack gap={2} px={3} flexWrap="wrap" role="status">
      <Text fontSize="xs" color="orange.700" fontFamily="heading">
        {dayNote}
      </Text>
      {nextSchoolDay && (
        <chakra.button
          type="button"
          fontSize="xs"
          fontFamily="heading"
          fontWeight="600"
          color="violet.600"
          textDecoration="underline"
          cursor="pointer"
          onClick={() =>
            datedFinish?.kind === "openUntil"
              ? pickUntilDay(nextSchoolDay)
              : pickByDay(nextSchoolDay)
          }
        >
          Use {shortDayLabel(nextSchoolDay)}
        </chakra.button>
      )}
    </HStack>
  );

  const inClassHint = usable.inClass.blockLabel
    ? `leaves their screen when ${usable.inClass.blockLabel} ends (${clockTime(usable.inClass.endsAt, usable.timeZone)})`
    : usable.inClass.unavailable
      ? usable.inClass.unavailable
      : usable.inClass.lastBell
        ? `no class meeting now, so it stays on their screen until the last bell, ${clockTime(usable.inClass.endsAt, usable.timeZone)}`
        : "no class block then, so it leaves their screen at the end of the day";
  const pickMinutes = (next: number) => {
    setMinutes(next);
    onFinishChange({ kind: "forAWhile", minutes: next });
  };

  return (
    <Stack gap={4}>
      {!push && (
      <Box>
        <FieldLabel>Shows up</FieldLabel>
        <chakra.select
          {...inputStyle}
          cursor="pointer"
          aria-label="Shows up"
          value={showsUpValue}
          onChange={(e) => {
            const value = e.target.value;
            if (value === "now") {
              setCustomTime(false);
              onShowsUpChange({ kind: "now" });
            } else if (value === "other") {
              setCustomTime(true);
              onShowsUpChange({
                kind: "at",
                at: showsUp.kind === "at" ? showsUp.at : nowMs + 60 * MINUTE,
              });
            } else {
              setCustomTime(false);
              onShowsUpChange({ kind: "at", at: Number(value) });
            }
          }}
        >
          {allowNow && (
            <option value="now">
              {usable.currentBlock
                ? `Now, in this class · ${usable.currentBlock.subject} until ${clockTime(usable.currentBlock.endsAt, usable.timeZone)}`
                : "Now"}
            </option>
          )}
          {usable.blocks.map((block) => (
            <option key={block.startsAt} value={String(block.startsAt)}>
              {block.label}
            </option>
          ))}
          <option value="other">Another time…</option>
        </chakra.select>
        {showsUpValue === "other" && showsUp.kind === "at" && (
          <chakra.input
            {...inputStyle}
            mt={2}
            type="datetime-local"
            aria-label="Shows up at"
            value={schoolInputValue(showsUp.at, usable.timeZone)}
            onChange={(e) => {
              const at = parseSchoolInputValue(e.target.value, usable.timeZone);
              if (at != null) onShowsUpChange({ kind: "at", at });
            }}
          />
        )}
        {/* Classwork only: homework's class can be chosen. */}
        {usable.filedUnder && finish?.kind !== "by" && (
          <Text mt={1} fontSize="xs" color="gray.600" fontFamily="heading">
            {/* Finishing "in that class" keeps it in that class's slot on
                the Master Schedule (TRA-725). */}
            {finish?.kind === "inClass" && usable.filedShownIn
              ? `Shows in ${usable.filedShownIn}. `
              : ""}
            Filed under {usable.filedUnder}, the class that teaches this unit.
          </Text>
        )}
      </Box>
      )}

      <Box role="radiogroup" aria-label="Finish">
        <FieldLabel>Finish</FieldLabel>
        <Stack gap={1.5}>
          <FinishOption
            checked={finish?.kind === "inClass"}
            disabled={Boolean(usable.inClass.unavailable)}
            onSelect={() => onFinishChange({ kind: "inClass" })}
            label="In that class"
            title="In that class"
            hint={inClassHint}
          />
          {push && (
            <FinishOption
              checked={finish?.kind === "forAWhile"}
              onSelect={() => pickMinutes(minutes)}
              label="For a while"
              title={
                <HStack gap={1.5} flexWrap="wrap">
                  <Text as="span" mr={0.5}>
                    For
                  </Text>
                  {FOCUS_DURATION_CHOICES_MIN.map((choice) => (
                    <chakra.button
                      key={choice}
                      type="button"
                      aria-pressed={
                        finish?.kind === "forAWhile" && minutes === choice
                      }
                      px={2}
                      py={0.5}
                      borderRadius="full"
                      borderWidth="1px"
                      fontSize="xs"
                      fontFamily="heading"
                      fontWeight="600"
                      cursor="pointer"
                      borderColor={
                        finish?.kind === "forAWhile" && minutes === choice
                          ? "violet.500"
                          : "gray.200"
                      }
                      bg={
                        finish?.kind === "forAWhile" && minutes === choice
                          ? "violet.500"
                          : "white"
                      }
                      color={
                        finish?.kind === "forAWhile" && minutes === choice
                          ? "white"
                          : "navy.600"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        pickMinutes(choice);
                      }}
                    >
                      {choice} min
                    </chakra.button>
                  ))}
                </HStack>
              }
              hint={`leaves their screen at ${clockTime(nowMs + minutes * MINUTE, usable.timeZone)}, whatever class is on`}
            />
          )}
          {!push && (
          <FinishOption
            checked={finish?.kind === "by"}
            onSelect={() =>
              effectiveByDay &&
              onFinishChange({ kind: "by", dayKey: effectiveByDay })
            }
            label="By a date"
            title={
              <FinishDatePicker
                lead="By"
                ariaLabel="Finish by"
                custom={customDay}
                onCustom={() => setCustomDay(true)}
                value={effectiveByDay}
                days={usable.dueDays}
                onPick={(dayKey) => {
                  setByDay(dayKey);
                  if (dayKey) onFinishChange({ kind: "by", dayKey });
                }}
              />
            }
            hint="stays on their list until they're done"
          />
          )}
          {finish?.kind === "by" && nonSchoolDayNoteRow}
          <FinishOption
            checked={finish?.kind === "openUntil"}
            onSelect={() =>
              effectiveUntilDay &&
              onFinishChange({ kind: "openUntil", dayKey: effectiveUntilDay })
            }
            label="Open until a date"
            title={
              <FinishDatePicker
                lead="Open until"
                ariaLabel="Open until"
                custom={customUntilDay || untilDays.length === 0}
                onCustom={() => setCustomUntilDay(true)}
                value={effectiveUntilDay}
                days={untilDays}
                onPick={(dayKey) => {
                  setUntilDay(dayKey);
                  if (dayKey) onFinishChange({ kind: "openUntil", dayKey });
                }}
              />
            }
            hint={
              push
                ? "on their screen until the end of that day, then it leaves"
                : "Available until then. Unfinished work leaves their list; it's never marked late."
            }
          />
          {finish?.kind === "openUntil" && nonSchoolDayNoteRow}
          {allowEndOfUnit && (
            <FinishOption
              checked={finish?.kind === "endOfUnit"}
              disabled={!usable.endOfUnit}
              onSelect={() => onFinishChange({ kind: "endOfUnit" })}
              label="By the end of the unit"
              title="By the end of the unit"
              hint={
                usable.endOfUnit
                  ? `${lowerRelative(usable.endOfUnit.label)}, the last day planned in this unit`
                  : "nothing else in this unit is scheduled yet, so pick a date"
              }
            />
          )}
        </Stack>
      </Box>
    </Stack>
  );
}

/** The give button's label: names the missing answer while it's disabled. */
export function giveButtonLabel(
  finish: GiveFinish | PushFinish | null,
  ready = "Give",
): string {
  return finish ? ready : `${ready} · pick a finish first`;
}

/** The suggested days, plus `value` in date order when it isn't one of them.
 *  Exported for tests. */
export function withCurrentDay(
  days: { dayKey: string; label: string }[],
  value: string,
): { dayKey: string; label: string }[] {
  if (!value || days.some((day) => day.dayKey === value)) return days;
  return [...days, { dayKey: value, label: shortDayLabel(value) }].sort(
    (a, b) => a.dayKey.localeCompare(b.dayKey),
  );
}

/** "By [Fri ▾]" / "Open until [Fri ▾]": the suggested days, or a date input
 *  once the teacher picks "Another date…". */
function FinishDatePicker({
  lead,
  ariaLabel,
  custom,
  onCustom,
  value,
  days,
  onPick,
}: {
  lead: string;
  ariaLabel: string;
  custom: boolean;
  onCustom: () => void;
  value: string;
  days: { dayKey: string; label: string }[];
  onPick: (dayKey: string) => void;
}) {
  // A saved day that isn't one of the suggestions (editing a give due Thu
  // when the suggestions are Mon and Fri) still needs its own option: a
  // select whose value matches no option shows its FIRST option, so the
  // dialog read "By Tomorrow" while saving kept Thu.
  const options = withCurrentDay(days, value);
  return (
    <HStack gap={2} onClick={(e) => e.stopPropagation()}>
      <Text as="span">{lead}</Text>
      {custom ? (
        <chakra.input
          {...inputStyle}
          w="auto"
          py={1}
          type="date"
          aria-label={`${ariaLabel} date`}
          value={value}
          onChange={(e) => onPick(e.target.value)}
        />
      ) : (
        <chakra.select
          {...inputStyle}
          w="auto"
          py={1}
          cursor="pointer"
          aria-label={ariaLabel}
          value={value}
          onChange={(e) => {
            if (e.target.value === "other") {
              onCustom();
              return;
            }
            onPick(e.target.value);
          }}
        >
          {options.map((day) => (
            <option key={day.dayKey} value={day.dayKey}>
              {day.label}
            </option>
          ))}
          <option value="other">Another date…</option>
        </chakra.select>
      )}
    </HStack>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="2xs"
      fontFamily="heading"
      fontWeight="700"
      letterSpacing="0.04em"
      textTransform="uppercase"
      color="charcoal.400"
      mb={1.5}
    >
      {children}
    </Text>
  );
}

function FinishOption({
  checked,
  disabled,
  onSelect,
  label,
  title,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** The option's accessible name. */
  label: string;
  title: React.ReactNode;
  hint: string;
}) {
  return (
    <HStack
      role="radio"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={() => !disabled && onSelect()}
      onKeyDown={(e) => {
        // Only the radio's own keys: Enter on a chip, a select or a date
        // input inside it belongs to that control.
        if (disabled || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      align="flex-start"
      gap={2.5}
      px={3}
      py={2}
      borderRadius="md"
      borderWidth="1px"
      borderColor={checked ? "violet.300" : "gray.200"}
      bg={checked ? "violet.50" : "white"}
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.55 : 1}
      _hover={disabled ? undefined : { bg: checked ? "violet.50" : "gray.50" }}
    >
      <Box
        mt="3px"
        flexShrink={0}
        w="14px"
        h="14px"
        borderRadius="full"
        borderWidth={checked ? "4px" : "1.5px"}
        borderColor={checked ? "violet.500" : "gray.300"}
        bg="white"
      />
      <Stack gap={0} minW={0}>
        <Box fontFamily="heading" fontWeight="600" fontSize="sm" color="navy.600">
          {title}
        </Box>
        <Text fontSize="xs" color="charcoal.400">
          {hint}
        </Text>
      </Stack>
    </HStack>
  );
}

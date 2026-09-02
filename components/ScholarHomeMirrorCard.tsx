"use client";

// Home screen mirror — the teacher-facing snapshot of what this scholar sees on
// their iPad Home right now. Backed by api.scholarPlate.homeForScholar, which
// shares the plate core with the native Home's activeForMe (uncapped IS, web
// activities on), so the plate sections are the real plate, not an
// approximation. Same section order as the iPad: Onboarding · Class focus ·
// Homework · Quests. The scholar-home "Suggested by your teacher" offer cards
// are then mirrored INLINE, adjacent to the Quests lane (the same UnitGroupCard
// band the scholar sees), so the mirror is a pure mirror of the iPad Home.
//
// Each row carries provenance (origin, a Draft badge when the unit is still at
// maturity Draft, last-touched) and the removal actions that take work OFF the
// scholar's Home: archive a session, retract a scholar quest (cascades unit +
// seeds + sessions), remove the scholar from an assignment, or clear a pushed
// activity. A suggested card keeps the one-call Retract (a teacher can't Start it
// for the kid). All destructive actions confirm through ONE shared Dialog (never
// a remount-while-open — see .claude/rules/engineering-principles.md).

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import {
  Box,
  Flex,
  HStack,
  VStack,
  Text,
  Badge,
  Spinner,
  Menu,
  Portal,
  IconButton,
  Dialog,
  Button,
} from "@chakra-ui/react";
import { House, DotsThreeVertical, ShootingStar } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/EmptyState";
import { Surface } from "@/components/ui/Surface";
import { SuggestedQuestCard } from "@/components/SuggestedQuests";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { formatTimeAgo } from "@/lib/relativeTime";

type Home = FunctionReturnType<typeof api.scholarPlate.homeForScholar>;
type HomeRow = Home["rows"][number];
type HomeOnboarding = NonNullable<Home["onboarding"]>;
type SuggestedQuest = Home["suggested"][number];

type SectionOrigin = "onboarding" | "classFocus" | "homework" | "is";

const SECTION_META: Record<
  SectionOrigin,
  { heading: string; badge: string; palette: string }
> = {
  onboarding: { heading: "Onboarding", badge: "Onboarding", palette: "teal" },
  classFocus: { heading: "Class focus", badge: "Class focus", palette: "violet" },
  homework: { heading: "Homework", badge: "Homework", palette: "orange" },
  is: { heading: "Quests", badge: "Quest", palette: "cyan" },
};

type PendingAction =
  | { type: "archive"; row: HomeRow }
  | { type: "retract"; row: HomeRow }
  | { type: "removeAssignment"; row: HomeRow }
  | { type: "clearActivity"; row: HomeRow }
  | { type: "retractSuggested"; quest: SuggestedQuest }
  | { type: "removeSuggestion"; quest: SuggestedQuest };

export function ScholarHomeMirrorCard({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const home = useQuery(api.scholarPlate.homeForScholar, { scholarId });

  const archiveSession = useMutation(api.sessions.archive);
  const retractQuest = useMutation(api.quests.retract);
  const setScholars = useMutation(api.assignments.setScholars);
  const clearActivity = useMutation(api.assignments.clearActivity);
  const dismissSeed = useMutation(api.seeds.setStatus);

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  // For "remove from assignment" we need the assignment's current roster.
  // Loaded only while that dialog is open (skips otherwise).
  const removeAssignmentId =
    pending?.type === "removeAssignment"
      ? pending.row.assignmentId ?? null
      : null;
  const assignment = useQuery(
    api.assignments.get,
    removeAssignmentId ? { assignmentId: removeAssignmentId } : "skip",
  );

  const heading = (
    <Flex justify="space-between" align="center" gap={2} mb={3}>
      <HStack gap={2} minW={0} flex={1}>
        <Box color="violet.500" lineHeight="0" display="flex" flexShrink={0}>
          <House />
        </Box>
        <Text
          fontWeight="600"
          fontFamily="heading"
          color="navy.500"
          fontSize="sm"
          whiteSpace="nowrap"
        >
          Home screen
        </Text>
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="body"
          lineClamp={1}
          minW={0}
        >
          exactly what this scholar sees on their iPad right now
        </Text>
      </HStack>
    </Flex>
  );

  if (home === undefined) {
    return (
      <Surface p={4}>
        {heading}
        <Flex justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </Flex>
      </Surface>
    );
  }

  const classFocus = home.rows.filter((r) => r.origin === "classFocus");
  const homework = home.rows.filter((r) => r.origin === "homework");
  const quests = home.rows.filter((r) => r.origin === "is");
  const plateEmpty =
    !home.onboarding &&
    classFocus.length === 0 &&
    homework.length === 0 &&
    quests.length === 0;
  // Only truly empty when there's nothing on the plate AND no suggested-quest
  // offer cards to mirror. A scholar with only a teacher-offered quest they
  // haven't started yet still has something to show here.
  const isEmpty = plateEmpty && home.suggested.length === 0;

  const runConfirm = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.type === "archive" && pending.row.sessionId) {
        await archiveSession({ id: pending.row.sessionId });
        toaster.success({ title: "Session archived" });
      } else if (pending.type === "retract" && pending.row.unitId) {
        const res = await retractQuest({ unitId: pending.row.unitId });
        toaster.success({
          title: "Quest retracted",
          description: `${res.seedsDismissed} offer${res.seedsDismissed === 1 ? "" : "s"} dismissed · ${res.sessionsArchived} session${res.sessionsArchived === 1 ? "" : "s"} archived`,
        });
      } else if (pending.type === "retractSuggested") {
        const res = await retractQuest({ unitId: pending.quest.unitId });
        toaster.success({
          title: "Quest retracted",
          description: `${res.seedsDismissed} offer${res.seedsDismissed === 1 ? "" : "s"} dismissed · ${res.sessionsArchived} session${res.sessionsArchived === 1 ? "" : "s"} archived`,
        });
      } else if (pending.type === "removeSuggestion") {
        await dismissSeed({ id: pending.quest.seedId, status: "dismissed" });
        toaster.success({ title: "Suggestion removed" });
      } else if (
        pending.type === "removeAssignment" &&
        pending.row.assignmentId &&
        assignment
      ) {
        const next = assignment.scholarIds.filter(
          (id) => String(id) !== String(scholarId),
        );
        await setScholars({
          assignmentId: pending.row.assignmentId,
          scholarIds: next,
        });
        toaster.success({ title: "Removed from assignment" });
      } else if (
        pending.type === "clearActivity" &&
        pending.row.assignmentId &&
        pending.row.activityId
      ) {
        await clearActivity({
          assignmentId: pending.row.assignmentId,
          activityId: pending.row.activityId,
        });
        toaster.success({ title: "Activity cleared" });
      }
      setPending(null);
    } catch (e) {
      toaster.error({
        title: "Couldn't complete that",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmCopy = buildConfirmCopy(pending, assignment ?? null);

  return (
    <Surface p={4}>
      {heading}

      {isEmpty ? (
        <EmptyState
          title="Nothing on their Home right now"
          hint="Class focus, homework, and quests this scholar has going will mirror here."
        />
      ) : (
        <VStack gap={4} align="stretch">
          {home.onboarding && (
            <Section heading={SECTION_META.onboarding.heading}>
              <OnboardingRow pin={home.onboarding} />
            </Section>
          )}
          {classFocus.length > 0 && (
            <Section heading={SECTION_META.classFocus.heading}>
              {classFocus.map((r) => (
                <PlateRowView key={rowKey(r)} row={r} onAction={setPending} />
              ))}
            </Section>
          )}
          {homework.length > 0 && (
            <Section heading={SECTION_META.homework.heading}>
              {homework.map((r) => (
                <PlateRowView key={rowKey(r)} row={r} onAction={setPending} />
              ))}
            </Section>
          )}
          {quests.length > 0 && (
            <Section heading={SECTION_META.is.heading}>
              {quests.map((r) => (
                <PlateRowView key={rowKey(r)} row={r} onAction={setPending} />
              ))}
            </Section>
          )}
          {home.suggested.length > 0 && (
            <SuggestedSection quests={home.suggested} onAction={setPending} />
          )}
        </VStack>
      )}

      {/* ONE shared confirm dialog — never remounted while open (Ark body-lock
          gotcha). `open` is driven purely by whether an action is pending. */}
      <Dialog.Root
        open={pending !== null}
        onOpenChange={(e) => {
          if (!e.open && !busy) setPending(null);
        }}
        placement="center"
        role="alertdialog"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title
                  fontFamily="heading"
                  fontSize="lg"
                  color="navy.500"
                >
                  {confirmCopy.title}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  {confirmCopy.body}
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  disabled={busy}
                  onClick={() => setPending(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  colorPalette="red"
                  fontFamily="heading"
                  loading={busy}
                  disabled={
                    pending?.type === "removeAssignment" &&
                    assignment === undefined
                  }
                  onClick={runConfirm}
                >
                  {confirmCopy.cta}
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Surface>
  );
}

function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text
        fontFamily="heading"
        fontWeight="600"
        fontSize="xs"
        letterSpacing="wide"
        textTransform="uppercase"
        color="charcoal.400"
        mb={2}
      >
        {heading}
      </Text>
      <VStack gap={2} align="stretch">
        {children}
      </VStack>
    </Box>
  );
}

function OriginBadge({ origin }: { origin: SectionOrigin }) {
  const meta = SECTION_META[origin];
  return (
    <Badge
      colorPalette={meta.palette}
      variant="subtle"
      fontSize="2xs"
      fontFamily="heading"
      textTransform="none"
    >
      {meta.badge}
    </Badge>
  );
}

function DraftBadge() {
  return (
    <Badge
      colorPalette="gray"
      variant="outline"
      fontSize="2xs"
      fontFamily="heading"
      textTransform="none"
    >
      Draft
    </Badge>
  );
}

function RowShell({
  emoji,
  title,
  subline,
  badges,
  action,
}: {
  emoji?: string | null;
  title: string;
  subline?: React.ReactNode;
  badges?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Flex
      p={3}
      bg="white"
      borderRadius="md"
      borderWidth="1px"
      borderColor="gray.200"
      align="center"
      gap={3}
    >
      {emoji && (
        <Box fontSize="lg" lineHeight="1" flexShrink={0}>
          {emoji}
        </Box>
      )}
      <VStack gap={0.5} flex={1} minW={0} align="stretch">
        <Text
          fontFamily="heading"
          fontWeight="600"
          color="navy.500"
          fontSize="sm"
          lineClamp={1}
        >
          {title}
        </Text>
        {(badges || subline) && (
          <HStack gap={2} minW={0} flexWrap="wrap">
            {badges}
            {subline}
          </HStack>
        )}
      </VStack>
      {action && <Box flexShrink={0}>{action}</Box>}
    </Flex>
  );
}

function OnboardingRow({ pin }: { pin: HomeOnboarding }) {
  return (
    <RowShell
      emoji={pin.emoji}
      title={pin.nextBeatTitle}
      badges={
        // No DraftBadge here even when `pin.unitIsDraft` — Draft is the
        // curriculum node's authoring/maturity status, meaningful for
        // ordinary curriculum rows (see PlateRowView below) but confusing on
        // the system-owned onboarding sequence: a brand-new scholar's very
        // first row reading "Draft" reads as "this onboarding is unfinished",
        // not as a maturity label a teacher would recognize.
        <OriginBadge origin="onboarding" />
      }
      subline={
        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
          Welcome to Rabbithole · {pin.completedCount}/{pin.totalCount} complete
        </Text>
      }
    />
  );
}

function PlateRowView({
  row,
  onAction,
}: {
  row: HomeRow;
  onAction: (a: PendingAction) => void;
}) {
  const origin = row.origin as SectionOrigin;
  const canArchive = row.sessionId != null;
  const canRetract = row.origin === "is" && row.unitId != null;
  const canRemoveAssignment = row.assignmentId != null;
  const canClearActivity = row.assignmentId != null && row.activityId != null;
  const hasActions =
    canArchive || canRetract || canRemoveAssignment || canClearActivity;

  const meta: string[] = [];
  if (row.unitTitle) meta.push(row.unitTitle);
  meta.push(`updated ${formatTimeAgo(row.lastTouched)}`);
  if (row.notStarted) meta.push("not started yet");

  return (
    <RowShell
      emoji={row.unitEmoji}
      title={row.title}
      badges={
        <>
          <OriginBadge origin={origin} />
          {row.unitIsDraft && <DraftBadge />}
          {row.unitIsActive === false && (
            <Badge
              colorPalette="gray"
              variant="subtle"
              fontSize="2xs"
              fontFamily="heading"
              textTransform="none"
            >
              Inactive unit
            </Badge>
          )}
        </>
      }
      subline={
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          lineClamp={1}
        >
          {meta.join(" · ")}
        </Text>
      }
      action={
        hasActions ? (
          <Menu.Root>
            <Menu.Trigger asChild>
              <IconButton
                aria-label="Row actions"
                variant="ghost"
                size="sm"
                color="charcoal.400"
              >
                <DotsThreeVertical />
              </IconButton>
            </Menu.Trigger>
            <Portal>
              <Menu.Positioner>
                <Menu.Content>
                  {canArchive && (
                    <Menu.Item
                      value="archive"
                      fontFamily="heading"
                      fontSize="sm"
                      onSelect={() => onAction({ type: "archive", row })}
                    >
                      Archive session
                    </Menu.Item>
                  )}
                  {canRetract && (
                    <Menu.Item
                      value="retract"
                      fontFamily="heading"
                      fontSize="sm"
                      color="red.600"
                      onSelect={() => onAction({ type: "retract", row })}
                    >
                      Retract quest
                    </Menu.Item>
                  )}
                  {canRemoveAssignment && (
                    <Menu.Item
                      value="removeAssignment"
                      fontFamily="heading"
                      fontSize="sm"
                      color="red.600"
                      onSelect={() =>
                        onAction({ type: "removeAssignment", row })
                      }
                    >
                      Remove from assignment
                    </Menu.Item>
                  )}
                  {canClearActivity && (
                    <Menu.Item
                      value="clearActivity"
                      fontFamily="heading"
                      fontSize="sm"
                      onSelect={() => onAction({ type: "clearActivity", row })}
                    >
                      Clear this activity
                    </Menu.Item>
                  )}
                </Menu.Content>
              </Menu.Positioner>
            </Portal>
          </Menu.Root>
        ) : undefined
      }
    />
  );
}

function SuggestedSection({
  quests,
  onAction,
}: {
  quests: SuggestedQuest[];
  onAction: (a: PendingAction) => void;
}) {
  return (
    <Box>
      {/* The scholar-home "Suggested by your teacher" eyebrow, verbatim. */}
      <HStack gap={1.5} color="yellow.700" mb={2}>
        <ShootingStar size={14} weight="fill" />
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          Suggested by your teacher
        </Text>
      </HStack>
      <VStack gap={2} align="stretch">
        {quests.map((q) => {
          // Scholar-authored quest → Retract (deactivate the unit + cascade).
          // Catalog-unit suggestion → Remove suggestion (dismiss the seed; the
          // shared catalog unit itself is untouched).
          const action: PendingAction = q.isAuthored
            ? { type: "retractSuggested", quest: q }
            : { type: "removeSuggestion", quest: q };
          const label = q.isAuthored ? "Retract quest" : "Remove suggestion";
          return (
            <SuggestedQuestCard
              key={String(q.seedId)}
              emoji={q.emoji}
              title={q.title}
              teacherName={q.teacherName}
              teacherImage={q.teacherImage}
              activityCount={q.activityCount}
              body={q.body}
              secondaryAction={
                <Menu.Root>
                  <Menu.Trigger asChild>
                    <IconButton
                      aria-label="Suggested quest actions"
                      variant="ghost"
                      size="sm"
                      color="charcoal.400"
                    >
                      <DotsThreeVertical />
                    </IconButton>
                  </Menu.Trigger>
                  <Portal>
                    <Menu.Positioner>
                      <Menu.Content>
                        <Menu.Item
                          value={action.type}
                          fontFamily="heading"
                          fontSize="sm"
                          color="red.600"
                          onSelect={() => onAction(action)}
                        >
                          {label}
                        </Menu.Item>
                      </Menu.Content>
                    </Menu.Positioner>
                  </Portal>
                </Menu.Root>
              }
            />
          );
        })}
      </VStack>
    </Box>
  );
}

function buildConfirmCopy(
  pending: PendingAction | null,
  assignment: FunctionReturnType<typeof api.assignments.get>,
): { title: string; body: string; cta: string } {
  if (!pending) return { title: "", body: "", cta: "Confirm" };
  const name =
    pending.type === "retractSuggested" || pending.type === "removeSuggestion"
      ? pending.quest.title
      : pending.row.title;
  switch (pending.type) {
    case "archive":
      return {
        title: "Archive this session?",
        body: `"${name}" will be moved to the scholar's archived sessions. They can restore it from Finished. This takes it off their Home.`,
        cta: "Archive session",
      };
    case "retract":
      return {
        title: "Retract this quest?",
        body: `"${name}" will be deactivated, any suggested offers pointing at it dismissed, and its in-progress sessions archived — removing it from the scholar's Home. Nothing is deleted; you can reactivate the unit later.`,
        cta: "Retract quest",
      };
    case "retractSuggested":
      return {
        title: "Retract this quest?",
        body: `"${name}" will be deactivated and the teacher offer dismissed, so it stops appearing on the scholar's Home and Sky. Nothing is deleted; you can reactivate the unit later.`,
        cta: "Retract quest",
      };
    case "removeSuggestion":
      return {
        title: "Remove this suggestion?",
        body: `The suggestion "${name}" will be dismissed, so it stops appearing on the scholar's Home and Sky. The unit itself is untouched — you can suggest it again later.`,
        cta: "Remove suggestion",
      };
    case "removeAssignment": {
      const label =
        assignment?.title ?? assignment?.unitTitle ?? pending.row.unitTitle ?? "this assignment";
      return {
        title: "Remove from assignment?",
        body: `This scholar will be dropped from the roster of "${label}", so its class-focus and homework pushes stop appearing on their Home. Other scholars on the assignment are unaffected.`,
        cta: "Remove from assignment",
      };
    }
    case "clearActivity":
      return {
        title: "Clear this activity?",
        body: `"${name}" will be removed from the assignment's schedule (both class-focus and homework state), so it stops appearing on the scholar's Home.`,
        cta: "Clear activity",
      };
  }
}

function rowKey(row: HomeRow): string {
  return (
    (row.sessionId ? String(row.sessionId) : "") +
    "|" +
    (row.assignmentId ? String(row.assignmentId) : "") +
    "|" +
    (row.activityId ? String(row.activityId) : "") +
    "|" +
    row.origin
  );
}

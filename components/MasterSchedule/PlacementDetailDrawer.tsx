"use client";

/**
 * PlacementDetailDrawer — the click-through detail drawer for a scheduled
 * class (review/schedule-activity-detail-drawer-plan.html). Drag moves,
 * click reveals: the grid and Now chips open this drawer; movement never
 * enters it (no bump controls — cells are the drop targets). Placement-first
 * content order:
 *
 *   1. Header — the canonical PlacementChipExpanded + one quiet context line.
 *   2. Links out — Open in Curriculum / Open Run page.
 *   3. Placement edits — subject / teacher / note, field-level immediate
 *      mutations through masterSchedule.updatePlacement.
 *   4. Activity body — the shared ActivityReadBody (snippet mode; the
 *      Curriculum link is the click-through to full text).
 *   5. Remove (destructive, live-state-aware) in the footer.
 *
 * Shell mirrors AssignWorkDrawer: Chakra Drawer.Root placement="end"
 * size="sm" in a Portal, Drawer.Root stably mounted (never keyed while
 * open — the Ark body-lock leak class; see engineering-principles.md), the
 * inner body keyed per target. Placements resolve from the live grid on
 * every render, never a snapshot, so concurrent edits can't strand stale
 * data. Never stack a Dialog over this drawer — the Remove confirm is
 * inline.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Box,
  Button,
  Drawer,
  Flex,
  HStack,
  Input,
  Menu,
  Portal,
  Text,
  VStack,
  chakra,
} from "@chakra-ui/react";
import {
  AppWindow,
  ArrowSquareOut,
  ChatCircle,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import { ActivityReadBody } from "@/components/ActivityReadBody";
import { ResourcesEditor } from "@/components/nodeEditor/ResourcesSection";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import {
  PlacementChipExpanded,
  type Lens,
  type PlacementChipData,
} from "@/components/MasterSchedule/PlacementChip";
import { fmtTimeRange } from "@/components/MasterSchedule/timeFormat";

type GridData = NonNullable<ReturnType<typeof useQuery<typeof api.masterSchedule.grid>>>;
type Placement = GridData["placements"][number];

export type DrawerTarget = { kind: "placement"; placementId: string };
type DrawerVariant = "teacher" | "program";

const WEEKDAY_FULL = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

/** "A" · "A and B" · "A, B and C" — a natural conjunction list for prose. */
function andJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function targetKey(t: DrawerTarget): string {
  return `p:${t.placementId}`;
}

/** One quiet line locating the placement: group · weekday · block · teacher. */
function contextLine(p: Placement, grid: GridData): string {
  const parts: string[] = [];
  const group = grid.groups.find((g) => String(g._id) === String(p.groupId));
  if (group) parts.push(`${group.emoji ? `${group.emoji} ` : ""}${group.name}`);
  if (p.onShelf) {
    parts.push("No day yet");
  } else {
    if (p.weekday != null && WEEKDAY_FULL[p.weekday]) parts.push(WEEKDAY_FULL[p.weekday]);
    const block = grid.blocks.find((b) => String(b._id) === String(p.blockId));
    if (block) parts.push(`${block.label} (${fmtTimeRange(block.startLocal, block.endLocal)})`);
  }
  if (p.teacherName) parts.push(p.teacherName);
  return parts.join(" · ");
}

export function PlacementDetailDrawer({
  target,
  grid,
  onClose,
  lens = "group",
  variant = "teacher",
  onAskBot,
  onRemove,
}: {
  target: DrawerTarget | null;
  grid: GridData | undefined;
  onClose: () => void;
  /** The opening surface's current lens — only affects the header chip's avatar. */
  lens?: Lens;
  /** Program staff may inspect every linked activity and edit only Handouts
   * owned by their exact program assignment. */
  variant?: DrawerVariant;
  onAskBot?: (text: string) => void;
  onRemove?: (placementId: string) => void;
}) {
  return (
    <Drawer.Root
      open={target !== null}
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
            {target && grid && (
              <DrawerBody
                key={targetKey(target)}
                target={target}
                grid={grid}
                lens={lens}
                variant={variant}
                onClose={onClose}
                onAskBot={onAskBot}
                onRemove={onRemove}
              />
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function DrawerBody({
  target,
  grid,
  lens,
  variant,
  onClose,
  onAskBot,
  onRemove,
}: {
  target: DrawerTarget;
  grid: GridData;
  lens: Lens;
  variant: DrawerVariant;
  onClose: () => void;
  onAskBot?: (text: string) => void;
  onRemove?: (placementId: string) => void;
}) {
  // Set when WE requested the removal — the placement vanishing then closes
  // the drawer instead of showing the "no longer exists" state meant for external edits.
  const removeRequestedRef = useRef(false);

  const placementsById = useMemo(() => {
    const m = new Map<string, Placement>();
    for (const p of grid.placements) m.set(String(p._id), p);
    return m;
  }, [grid.placements]);

  // Resolve from the LIVE grid every render — never a snapshot.
  const placement = placementsById.get(target.placementId);

  // Our own remove landed: close the drawer rather than
  // showing the "no longer exists" state meant for external edits.
  useEffect(() => {
    if (removeRequestedRef.current && !placement) {
      onClose();
    }
  }, [onClose, placement]);

  if (!placement) {
    return <VanishedState onClose={onClose} />;
  }
  return (
    <PlacementDetail
      placement={placement}
      grid={grid}
      lens={lens}
      variant={variant}
      onClose={onClose}
      onAskBot={onAskBot}
      onRemove={
        onRemove
          ? (id) => {
              removeRequestedRef.current = true;
              onRemove(id);
            }
          : undefined
      }
    />
  );
}

function VanishedState({ onClose }: { onClose: () => void }) {
  return (
    <>
      <DrawerHeader title="Class details" onClose={onClose} />
      <Flex flex={1} align="center" justify="center" p={6}>
        <Text fontSize="sm" color="charcoal.400">
          This placement no longer exists.
        </Text>
      </Flex>
    </>
  );
}

function DrawerHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <Flex
      align="start"
      justify="space-between"
      gap={3}
      px={5}
      py={4}
      borderBottom="1px solid"
      borderColor="gray.100"
    >
      <Box minW={0}>
        <Drawer.Title asChild>
          <Text fontFamily="heading" fontWeight="700" fontSize="md" color="navy.700" lineClamp={1}>
            {title}
          </Text>
        </Drawer.Title>
        {subtitle && (
          <Text fontSize="xs" color="charcoal.400" lineClamp={2}>
            {subtitle}
          </Text>
        )}
      </Box>
      <chakra.button
        type="button"
        cursor="pointer"
        onClick={onClose}
        aria-label="Close"
        color="charcoal.400"
        _hover={{ color: "charcoal.600" }}
        p={1}
        flexShrink={0}
      >
        <X size={18} />
      </chakra.button>
    </Flex>
  );
}

function PlacementDetail({
  placement: p,
  grid,
  lens,
  variant,
  onClose,
  onAskBot,
  onRemove,
}: {
  placement: Placement;
  grid: GridData;
  lens: Lens;
  variant: DrawerVariant;
  onClose: () => void;
  onAskBot?: (text: string) => void;
  onRemove?: (placementId: string) => void;
}) {
  const updatePlacement = useMutation(api.masterSchedule.updatePlacement);
  const updateProgramHandout = useMutation(
    api.masterSchedule.updateProgramHandout,
  );
  const placementId = p._id;
  // Only fetched when the picker can actually render: teacher variant, no
  // linked activity, AND no app already set (once externalAppId is set the
  // drawer shows the App display + Remove action instead of the picker —
  // see the JSX below). A program handout, an activity-linked cell, and an
  // already app-linked cell all skip the query rather than paying for a
  // catalog read on every drawer open.
  const appCatalog = useQuery(
    api.externalApps.listCatalog,
    variant === "teacher" && !p.activityId && !p.externalAppId ? {} : "skip",
  );

  const [handoutTitle, setHandoutTitle] = useState(
    p.activityTitle ?? p.subject,
  );
  const [savingHandoutTitle, setSavingHandoutTitle] = useState(false);
  const cancelHandoutTitleRef = useRef(false);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const groupEmoji =
    grid.groups.find((g) => String(g._id) === String(p.groupId))?.emoji ?? null;

  // Staffing conflict (§ deriveCoverage): this placement is party to a
  // double-booking when a conflict entry's placementIds include it — matched on
  // IDS, not cell coords, so only the double-booked TEACHER's chips surface it
  // (the other classes sharing the slot but taught by someone else don't). The
  // OTHER placements in that entry are the collisions; resolve them via
  // grid.placements + grid.groups, dropping any stale/missing id. There is NO
  // dismiss: unlike a cosmetic overload, a double-booked teacher is a real
  // staffing problem, and deriveCoverage builds conflicts purely from slot
  // occupancy with no dismissedFlags path to silence them.
  const conflict = useMemo(() => {
    const pid = String(p._id);
    const entry = grid.conflicts.find((c) =>
      c.placementIds.some((id) => String(id) === pid),
    );
    if (!entry) return null;
    // "Other" means other CLASSES, not other rows: a class can be party to the
    // conflict as TWO rows (its structure row + its cascaded chip), so exclude
    // the opened placement's whole class key and dedupe the rest by class key —
    // otherwise opening one row of a structure+chip class names its own class
    // as an "other" and duplicates multi-row classes in the ask-text.
    const classKey = (groupId: unknown, subject: string) =>
      `${String(groupId)}|${subject.trim().toLowerCase()}`;
    const ownKey = classKey(p.groupId, p.subject);
    const seenKeys = new Set<string>([ownKey]);
    const others = entry.placementIds
      .filter((id) => String(id) !== pid)
      .map((id) => grid.placements.find((pl) => String(pl._id) === String(id)))
      .filter((pl): pl is Placement => Boolean(pl)) // omit stale/missing ids
      .filter((pl) => {
        const k = classKey(pl.groupId, pl.subject);
        if (seenKeys.has(k)) return false;
        seenKeys.add(k);
        return true;
      })
      .map((pl) => {
        const g = grid.groups.find((gr) => String(gr._id) === String(pl.groupId));
        return {
          subject: pl.subject,
          groupLabel: g ? `${g.emoji ? `${g.emoji} ` : ""}${g.name}` : null,
        };
      });
    if (others.length === 0) return null; // no OTHER class → nothing to name
    const teacherFirstName = p.teacherName?.trim().split(/\s+/)[0] ?? "This teacher";
    const weekdayLabel = p.weekday != null ? WEEKDAY_FULL[p.weekday] ?? "" : "";
    const blockLabel =
      grid.blocks.find((b) => String(b._id) === String(p.blockId))?.label ?? "";
    const allSubjects = [p.subject, ...others.map((o) => o.subject)];
    const askText = `${teacherFirstName} is double-booked${weekdayLabel ? ` ${weekdayLabel}` : ""}${blockLabel ? ` ${blockLabel}` : ""}: ${andJoin(allSubjects)}. Help me resolve it — move one or reassign a teacher.`;
    return { others, teacherFirstName, weekdayLabel, askText };
  }, [grid.conflicts, grid.placements, grid.groups, grid.blocks, p._id, p.groupId, p.teacherName, p.weekday, p.blockId, p.subject]);

  // Strip the activity from the slot but KEEP the class slot (unset
  // activity/assignment link → it reverts to an awaiting slot; the backend
  // unmaterializes any planned entry). The slot itself is edited on
  // School › Classes & times.
  async function clearActivity() {
    try {
      await updatePlacement({ placementId, activityId: null, assignmentId: null });
      onClose();
    } catch (err) {
      toaster.create({ title: "Couldn't remove activity", description: String(err), type: "error" });
    }
  }

  // The "standing assignment" app target (review/app-access-unification-plan.html
  // §robotics) — the smallest honest picker: writing externalAppId auto-clears
  // any activity link server-side (mutual exclusivity is enforced in
  // masterSchedule.coreUpdatePlacement), so this never has to also send
  // activityId: null.
  async function commitExternalApp(appId: Id<"externalApps"> | null) {
    try {
      await updatePlacement({ placementId, externalAppId: appId });
    } catch (err) {
      toaster.create({ title: "Couldn't set the app", description: String(err), type: "error" });
    }
  }

  const programHandout =
    variant === "program" &&
    p.activityId &&
    p.assignmentId &&
    p.isProgramHandout
      ? {
          activityId: p.activityId,
          assignmentId: p.assignmentId,
        }
      : null;

  async function commitHandoutTitle() {
    if (!programHandout || savingHandoutTitle) return;
    if (cancelHandoutTitleRef.current) {
      cancelHandoutTitleRef.current = false;
      return;
    }
    const title = handoutTitle.trim();
    if (!title) {
      setHandoutTitle(p.activityTitle ?? p.subject);
      return;
    }
    if (title === p.activityTitle) return;
    setSavingHandoutTitle(true);
    try {
      await updateProgramHandout({ ...programHandout, title });
      setHandoutTitle(title);
    } catch (err) {
      setHandoutTitle(p.activityTitle ?? p.subject);
      toaster.create({
        title: "Couldn’t rename handout",
        description: String(err),
        type: "error",
      });
    } finally {
      setSavingHandoutTitle(false);
    }
  }

  // The exact copy the retired context menu used for a flagged chip.

  const curriculumHref =
    p.unitId && p.activityId
      ? curriculumUnitHref(p.unitId, { activityId: p.activityId })
      : null;
  const runHref = p.assignmentId ? `/teacher/schedule/${p.assignmentId}` : null;

  return (
    <>
      {/* Accessible name for the dialog — the visible header is the canonical
          chip (no plain heading), so a screen-reader-only Drawer.Title carries
          the name and Ark wires aria-labelledby to it. */}
      <Drawer.Title srOnly>{p.activityTitle ?? p.subject}</Drawer.Title>
      {/* 1 · Header — the canonical chip: class subject as a quiet eyebrow, the
          linked activity title emphasized as the heading (consistent with the
          grid chip). One quiet context line below. The activity title renders
          once here now, so the Activity section below is just the eyebrow + body
          (T3). */}
      <Flex
        direction="column"
        gap={2}
        px={5}
        py={4}
        borderBottom="1px solid"
        borderColor="gray.100"
      >
        <Flex align="start" justify="space-between" gap={3}>
          <Box />
          <chakra.button
            type="button"
            cursor="pointer"
            onClick={onClose}
            aria-label="Close"
            color="charcoal.400"
            _hover={{ color: "charcoal.600" }}
            p={1}
            flexShrink={0}
          >
            <X size={18} />
          </chakra.button>
        </Flex>
        <PlacementChipExpanded p={p as PlacementChipData} lens={lens} groupEmoji={groupEmoji} />
        <Text fontSize="xs" color="charcoal.400" lineClamp={2}>
          {contextLine(p, grid)}
        </Text>
      </Flex>

      <VStack align="stretch" gap={5} px={5} py={5} flex={1} overflowY="auto">
        {/* 2 · Links out — plain links, not buttons. */}
        {variant === "teacher" && (curriculumHref || runHref) && (
          <HStack gap={4} flexWrap="wrap">
            {curriculumHref && (
              <Link href={curriculumHref}>
                <HStack gap={1} color="violet.600" fontSize="sm" fontWeight="600" _hover={{ color: "violet.700", textDecoration: "underline" }}>
                  <Text>Open in Curriculum</Text>
                  <ArrowSquareOut size={13} />
                </HStack>
              </Link>
            )}
            {runHref && (
              <Link href={runHref}>
                <HStack gap={1} color="violet.600" fontSize="sm" fontWeight="600" _hover={{ color: "violet.700", textDecoration: "underline" }}>
                  <Text>Open Run page</Text>
                  <ArrowSquareOut size={13} />
                </HStack>
              </Link>
            )}
          </HStack>
        )}

        {/* 4 · Activity body — the shared read-only detail, snippet mode. */}
        {programHandout ? (
          <VStack align="stretch" gap={5}>
            <Field label="Handout name">
              <Input
                value={handoutTitle}
                onChange={(event) => setHandoutTitle(event.target.value)}
                onBlur={() => void commitHandoutTitle()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelHandoutTitleRef.current = true;
                    setHandoutTitle(p.activityTitle ?? p.subject);
                    event.currentTarget.blur();
                  }
                }}
                disabled={savingHandoutTitle}
                aria-label="Handout name"
                size="sm"
              />
            </Field>
            <Box>
              <SectionEyebrow>Materials</SectionEyebrow>
              <Box
                mt={1.5}
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="lg"
                overflow="hidden"
              >
                <ResourcesEditor
                  activityId={programHandout.activityId}
                  assignmentId={programHandout.assignmentId}
                />
              </Box>
            </Box>
          </VStack>
        ) : p.activityId ? (
          <Box>
            <SectionEyebrow>Activity</SectionEyebrow>
            <ActivityReadBody unitId={p.unitId} activityId={p.activityId} longText="snippet" />
          </Box>
        ) : p.externalAppId ? (
          <Box>
            <SectionEyebrow>App</SectionEyebrow>
            <HStack mt={1.5} gap={2} justify="space-between">
              <HStack gap={2} minW={0}>
                <AppWindow size={16} weight="fill" />
                <Text fontSize="sm" fontWeight="600" lineClamp={1}>
                  {p.externalAppName ?? "App"}
                </Text>
              </HStack>
              {variant === "teacher" && (
                <Button
                  size="xs"
                  variant="ghost"
                  color="red.600"
                  onClick={() => void commitExternalApp(null)}
                >
                  Remove
                </Button>
              )}
            </HStack>
          </Box>
        ) : variant === "teacher" ? (
          <Box>
            <SectionEyebrow>Activity</SectionEyebrow>
            <Text fontSize="sm" color="charcoal.400" mt={1.5} mb={2}>
              No activity linked
            </Text>
            {/* The standing-assignment app target — the smallest honest
                affordance: a group's recurring block (Robotics' Block E) can
                grant a catalog app for exactly its window instead of
                curriculum content. See
                review/app-access-unification-plan.html §robotics. Assigning
                curriculum content itself still happens from the Schedule
                surface's Assign-work flow, not here — this menu only covers
                the app-target case, which has no other entry point yet. */}
            {appCatalog && appCatalog.length > 0 && (
              <Menu.Root positioning={{ placement: "bottom-start" }}>
                <Menu.Trigger asChild>
                  <Button size="sm" variant="outline" fontWeight="600" fontSize="sm" gap={1.5}>
                    <AppWindow size={14} /> Give this slot an app…
                  </Button>
                </Menu.Trigger>
                <Portal>
                  <Menu.Positioner>
                    <Menu.Content minW="220px" maxH="50vh" overflowY="auto">
                      {appCatalog.map((app) => (
                        <Menu.Item
                          key={String(app._id)}
                          value={String(app._id)}
                          cursor="pointer"
                          onClick={() => void commitExternalApp(app._id)}
                        >
                          <HStack w="full" gap={2}>
                            <Text flex={1} lineClamp={1}>{app.name}</Text>
                          </HStack>
                        </Menu.Item>
                      ))}
                    </Menu.Content>
                  </Menu.Positioner>
                </Portal>
              </Menu.Root>
            )}
          </Box>
        ) : (
          <Box>
            <SectionEyebrow>Activity</SectionEyebrow>
            <Text fontSize="sm" color="charcoal.400" mt={1.5}>
              No activity linked
            </Text>
          </Box>
        )}

        {/* 4c · Double-booked teacher — the only surfaced explanation for the
            grid's red conflict badge (its sibling overload flag already does this:
            → OverloadTag). A real staffing
            problem, so it's a red warn callout with one action and no dismiss. */}
        {variant === "teacher" && conflict && (
          <Box borderWidth="1px" borderColor="red.200" bg="red.50" borderRadius="md" p={3}>
            <SectionEyebrow>Double-booked</SectionEyebrow>
            <Text fontSize="sm" color="charcoal.600" mt={1.5} mb={2.5}>
              <chakra.strong>{conflict.teacherFirstName}</chakra.strong> is
              double-booked
              {conflict.weekdayLabel ? ` this ${conflict.weekdayLabel}` : ""} — also
              teaching{" "}
              {conflict.others.map((o, i) => (
                <chakra.span key={i}>
                  {i > 0 && (i === conflict.others.length - 1 ? " and " : ", ")}
                  <chakra.strong>{o.subject}</chakra.strong>
                  {o.groupLabel ? ` (${o.groupLabel})` : ""}
                </chakra.span>
              ))}
              .
            </Text>
            {onAskBot && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAskBot(conflict.askText)}
              >
                <HStack gap={1.5}>
                  <ChatCircle size={15} /> Ask the bot to resolve
                </HStack>
              </Button>
            )}
          </Box>
        )}

      </VStack>

      {/* 6 · Footer — the destructive action (inline confirm, never a Dialog
          stacked over the drawer). A filled slot's "Remove activity" strips the
          activity but KEEPS the class slot. The class slot itself is edited on
          School › Classes & times. */}
      {variant === "program" && programHandout && onRemove ? (
        <VStack align="stretch" gap={2} px={5} py={4} borderTop="1px solid" borderColor="gray.100">
          {confirmingClear ? (
            <>
              <Text fontSize="xs" color="charcoal.500">
                {p.linkState === "live"
                  ? "Scholars' live work keeps running after this handout leaves the schedule."
                  : "Remove this handout from the schedule?"}
              </Text>
              <HStack gap={2}>
                <Button size="sm" colorPalette="red" onClick={() => onRemove(String(p._id))}>
                  <HStack gap={1.5}>
                    <Trash size={13} /> Remove activity
                  </HStack>
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmingClear(false)}>
                  Cancel
                </Button>
              </HStack>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              color="red.600"
              justifyContent="flex-start"
              onClick={() => setConfirmingClear(true)}
            >
              <HStack gap={1.5}>
                <Trash size={13} /> Remove activity…
              </HStack>
            </Button>
          )}
        </VStack>
      ) : variant === "teacher" && (p.activityId && (
            <VStack align="stretch" gap={2} px={5} py={4} borderTop="1px solid" borderColor="gray.100">
              {confirmingClear ? (
                <>
                  <Text fontSize="xs" color="charcoal.500">
                    {p.linkState === "live" ? (
                      <>
                        Scholars&apos; live work on this activity keeps running after
                        it leaves the slot.{" "}
                        {runHref && (
                          <Link href={runHref}>
                            <chakra.span color="violet.600" fontWeight="600" _hover={{ textDecoration: "underline" }}>
                              Open the Run page
                            </chakra.span>
                          </Link>
                        )}{" "}
                        to wrap it up. The class slot stays.
                      </>
                    ) : (
                      "Remove this activity? The class slot stays — you can add another activity to it."
                    )}
                  </Text>
                  <HStack gap={2}>
                    <Button size="sm" colorPalette="red" onClick={() => void clearActivity()}>
                      <HStack gap={1.5}>
                        <Trash size={13} /> Remove activity
                      </HStack>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmingClear(false)}>
                      Cancel
                    </Button>
                  </HStack>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  color="red.600"
                  justifyContent="flex-start"
                  onClick={() => setConfirmingClear(true)}
                >
                  <HStack gap={1.5}>
                    <Trash size={13} /> Remove activity…
                  </HStack>
                </Button>
              )}
            </VStack>
          ))}
    </>
  );
}

// Same tiny local form-label primitive as AssignWorkDrawer's (each drawer
// stays specialized — no generic drawer framework).
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

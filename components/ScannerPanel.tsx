"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Checkbox,
  Drawer,
  Flex,
  VStack,
  HStack,
  Input,
  SimpleGrid,
  Text,
  Badge,
  Button,
  IconButton,
  Heading,
  Menu,
  Portal,
  Spinner,
  Tooltip,
  Dialog,
  Grid,
  Image,
} from "@chakra-ui/react";
import { CloudArrowUp, File, HardDrive, Camera, Printer, FileText, ArrowSquareOut, Trash, CaretDown, X, Play, VideoCamera, Check } from "@phosphor-icons/react";
import { captureMediaKind, formatCaptureDuration } from "@/shared/captureMedia";
import { HEALTH_DOCUMENT_MAX_BYTES } from "@/shared/healthDocuments";
import { ScholarPicker } from "@/components/ScholarPicker";
import { FilingPicker } from "@/components/FilingPicker";
import { GooglePickerButton } from "@/components/GooglePickerButton";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  visibleUploadKinds,
  type DocumentKindSpec,
} from "@/convex/lib/documentKinds";
import { CameraScanDialog } from "@/components/CameraScanDialog";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { EmptyState } from "@/components/ui/EmptyState";
import { formatTimeAgo } from "@/lib/relativeTime";
import { openExternal } from "@/lib/native";
import { toaster } from "@/lib/toaster";

/**
 * Scanner inbox — the always-present control for work flowing into the uploads
 * queue (scanned pages from the Drive folder, camera scans, and program-station
 * captures). A persistent icon in the staff header (left of the account menu)
 * opens a drawer with two sections:
 *   - To review: items still missing a scholar and/or an assignment.
 *   - Filed: fully-filed items (scholar + assignment resolved).
 * In BOTH sections every item's scholar and filing destination are editable
 * (via the shared ScholarPicker / FilingPicker dialogs), so any triage —
 * including an auto-match — can be corrected after the fact. A capture reviewer
 * scopes the queue to a program group with the scope selector in the drawer
 * header.
 *
 * "File as" is ONE axis, not two. A scan is either the scholar's work (an
 * assignment, or explicitly none) or a scholar record (a report card, an
 * immunization record) — never both. Filing it as a record moves it out of
 * `portfolioItems` into its canonical store, which is a correctness
 * requirement rather than a nicety: a portfolio item is readable by the
 * scholar and their guardians and is read by the observer as learning
 * evidence, none of which may happen to a custody document or a report card.
 */

/** One selectable scope for the queue. A flat option list (not a boolean) so a
 *  future scope kind (e.g. a class period — see the design plan §2.5) drops in
 *  as one more entry with no structural change: `programGroupId === null` is the
 *  whole-school scope, a non-null id scopes to that program group. */
type ScannerScopeOption = {
  key: string;
  label: string;
  programGroupId: Id<"scholarGroups"> | null;
};

type FeedItem = {
  _id: Id<"portfolioItems">;
  _creationTime: number;
  title: string;
  source: "google_drive" | "manual" | "upload" | "photo" | "capture_station";
  aiCaption?: string;
  documentHeading?: string;
  label?: string;
  detectedName?: string;
  fileMimeType?: string;
  fileSizeBytes?: number;
  thumbUrl?: string | null;
  thumbStatus?: "pending" | "ready" | "error";
  // Program-station captures: a video renders as a poster still (videoThumbUrl)
  // with a duration badge, exactly like the kiosk gallery. Null for stills.
  videoThumbUrl?: string | null;
  videoDurationMs?: number | null;
  scholarId?: Id<"users"> | null;
  scholarName: string | null;
  scholarIds: Id<"users">[];
  scholarNames: string[];
  captureRosterIds?: Id<"users">[];
  assignmentId?: Id<"assignments"> | null;
  assignmentTitle: string | null;
  assignmentStatus?: string;
  activityId?: Id<"activities"> | null;
  activityTitle: string | null;
  familyVisibility?: "staff_only" | "attributed_families";
  canShareWithFamilies: boolean;
  familySharingBlocker: string | null;
  open: { scholar: boolean; assignment: boolean };
};

type ProcessingItem = {
  _id: Id<"portfolioItems">;
  _creationTime: number;
  title: string;
  source: "google_drive" | "manual" | "upload" | "photo";
  processingStatus: "pending" | "extracting" | "matching" | "ready" | "error";
  fileMimeType?: string;
};

function processingLabel(status: ProcessingItem["processingStatus"]): string {
  switch (status) {
    case "extracting":
      return "Reading pages…";
    case "matching":
      return "Matching scholar & assignment…";
    case "pending":
    default:
      return "Queued…";
  }
}

// ── Thumbnail (server-rendered preview for images AND PDFs, else file icon) ─
// A video capture renders its poster still with a duration badge — the same
// vocabulary as the kiosk gallery (shared/captureMedia), never a second one.
function FileThumb({
  itemId,
  thumbUrl,
  thumbStatus,
  size = 56,
  isVideo = false,
  posterUrl = null,
  durationMs = null,
}: {
  itemId: Id<"portfolioItems">;
  thumbUrl?: string | null;
  thumbStatus?: "pending" | "ready" | "error";
  size?: number;
  isVideo?: boolean;
  posterUrl?: string | null;
  durationMs?: number | null;
}) {
  // The thumbnail comes from the feed; the full file URL is only needed for the
  // click-to-open, so fetch it lazily alongside.
  const fileUrl = useQuery(api.portfolio.getFileUrl, { itemId });
  const displayUrl = isVideo ? posterUrl : thumbUrl;
  const pending = !displayUrl && thumbStatus === "pending";
  return (
    <Box
      as={fileUrl ? "button" : "div"}
      position="relative"
      w={`${size}px`}
      h={`${size}px`}
      flexShrink={0}
      bg="gray.50"
      borderRadius="md"
      overflow="hidden"
      display="flex"
      alignItems="center"
      justifyContent="center"
      cursor={fileUrl ? "pointer" : "default"}
      onClick={() => fileUrl && openExternal(fileUrl)}
      title={fileUrl ? "Open file" : undefined}
    >
      {displayUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={displayUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      ) : pending ? (
        <Spinner size="xs" color="violet.400" />
      ) : isVideo ? (
        <VideoCamera size={size * 0.4} color="#AD60BF" />
      ) : (
        <FileText size={size * 0.4} color="#AD60BF" />
      )}
      {isVideo && (
        <HStack
          position="absolute"
          left="4px"
          bottom="4px"
          gap="2px"
          px="5px"
          py="1px"
          borderRadius="full"
          bg="blackAlpha.700"
          pointerEvents="none"
        >
          <Play size={8} weight="fill" color="white" />
          {durationMs != null && (
            <Text fontSize="9px" fontFamily="heading" fontWeight="600" color="white" lineHeight="1">
              {formatCaptureDuration(durationMs)}
            </Text>
          )}
        </HStack>
      )}
    </Box>
  );
}

function FilingScanPreview({ item }: { item: FeedItem }) {
  const fileUrl = useQuery(api.portfolio.getFileUrl, { itemId: item._id });
  const isVideo = captureMediaKind(item.fileMimeType) === "video";
  const displayUrl = isVideo ? item.videoThumbUrl : item.thumbUrl;
  const pending = !displayUrl && item.thumbStatus === "pending";

  return (
    <VStack
      align="stretch"
      gap={2}
      h={{ base: "320px", lg: "full" }}
      minH={0}
      maxH="none"
    >
      <Text
        fontSize="2xs"
        fontWeight="700"
        fontFamily="heading"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.05em"
      >
        Scan preview
      </Text>
      <Flex
        position="relative"
        flex={1}
        minH={0}
        align="center"
        justify="center"
        overflow="hidden"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="lg"
        bg="gray.50"
      >
        {displayUrl ? (
          <Image
            src={displayUrl}
            alt={`Preview of ${item.title}`}
            w="full"
            h="full"
            objectFit="contain"
          />
        ) : pending ? (
          <Spinner color="violet.400" />
        ) : isVideo ? (
          <VideoCamera size={64} color="#AD60BF" />
        ) : (
          <FileText size={64} color="#AD60BF" />
        )}
        {isVideo && displayUrl && (
          <Flex
            position="absolute"
            inset={0}
            align="center"
            justify="center"
            pointerEvents="none"
          >
            <Flex
              align="center"
              justify="center"
              w={12}
              h={12}
              borderRadius="full"
              bg="blackAlpha.700"
              color="white"
            >
              <Play size={22} weight="fill" />
            </Flex>
          </Flex>
        )}
      </Flex>
      {fileUrl && (
        <Button
          size="xs"
          variant="ghost"
          alignSelf="end"
          color="charcoal.500"
          onClick={() => openExternal(fileUrl)}
        >
          <ArrowSquareOut />
          Open original
        </Button>
      )}
    </VStack>
  );
}

// ── Editable field row: gray label + ghost-button value ─────────────────
function FieldRow({
  label,
  value,
  open,
  onClick,
}: {
  label: string;
  value: string;
  open: boolean; // true = field still needs filling → draw attention
  onClick: () => void;
}) {
  return (
    <HStack gap={2} align="center" w="full">
      <Text
        w="74px"
        flexShrink={0}
        fontSize="2xs"
        fontWeight="600"
        fontFamily="heading"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.04em"
        lineHeight="1.2"
      >
        {label}
      </Text>
      <Button
        size="xs"
        variant="ghost"
        h="auto"
        py={1}
        px={1.5}
        fontFamily="heading"
        fontWeight={open ? "600" : "500"}
        color={open ? "violet.600" : "navy.600"}
        _hover={{ bg: "gray.100" }}
        onClick={onClick}
        maxW="220px"
        justifyContent="flex-start"
        // The visible label is a sibling <Text>, so without this the button
        // announces only its value ("Choose assignment or record") with no
        // hint as to which field it edits.
        aria-label={`${label}: ${value}`}
      >
        <Box as="span" truncate>{value}</Box>
        <CaretDown size={11} style={{ marginLeft: 4, opacity: 0.5, flexShrink: 0 }} />
      </Button>
    </HStack>
  );
}

// These dialogs are opened from INSIDE the scanner Upload drawer, which is
// itself a Chakra `dialog`-scope machine. A *modal* dialog stacked on top of
// the (still-open) drawer locks `document.body` (pointer-events:none + inert +
// scroll-lock), and Ark fails to release that lock on close while the drawer
// dialog underneath is still open — leaving the whole page unclickable. Making
// these non-modal means they never touch the body lock, so there's nothing to
// get stuck. (Verified: the bug only reproduces with modal dialogs over the
// open drawer.) Keep `modal={false}` on every dialog launched from the drawer.

// ── Scholar dialog (shared ScholarPicker) ───────────────────────────────
function ScholarDialog({ item, open, onClose }: { item: FeedItem; open: boolean; onClose: () => void }) {
  const setAttributions = useMutation(api.portfolio.setAttributions);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" modal={false}>
      <Portal>
        {/* Non-modal dialogs don't auto-dismiss on outside click (Ark's
            interact-outside doesn't fire while the drawer layer is open), so
            close explicitly when the backdrop is clicked. */}
        <Dialog.Backdrop onClick={() => onClose()} />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={1}>
              <HStack align="start" justify="space-between" w="full" gap={3}>
                <VStack align="start" gap={1}>
                  <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                    {item.scholarNames.length > 0 ? "Edit scholars" : "Assign scholars"}
                  </Dialog.Title>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={2}>
                    {item.title}
                    {item.detectedName ? ` · name on page: “${item.detectedName}”` : ""}
                  </Text>
                </VStack>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }} flexShrink={0} onClick={() => onClose()}>
                  <X />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px={6} pb={5} pt={3}>
              {/* Reserve the picker's full height so the centered dialog doesn't
                  jump when the async roster query resolves (spinner → list). */}
              <Box minH="470px">
                <ScholarPicker
                  mode="multi"
                  scholarIds={item.captureRosterIds}
                  selected={new Set(item.scholarIds)}
                  onChange={async (selection) => {
                    if (busy) return;
                    setBusy(true);
                    try {
                      await setAttributions({
                        itemId: item._id,
                        scholarIds: Array.from(selection) as Id<"users">[],
                      });
                    } catch (error) {
                      toaster.create({
                        title: "Couldn’t update scholars",
                        description:
                          error instanceof Error ? error.message : String(error),
                        type: "error",
                      });
                    } finally {
                      setBusy(false);
                    }
                  }}
                  showAffinityToggle={false}
                  includeProgramGuests={item.captureRosterIds !== undefined}
                  showEnrollmentStanding={item.captureRosterIds !== undefined}
                  autoFocusSearch
                  maxH="320px"
                  emptyHint="No scholars yet"
                />
              </Box>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Filing dialog (ONE axis: an assignment, or a record kind) ───────────
// Assignments and record kinds are siblings in one option space because the
// two are mutually exclusive. Picking an assignment sets a field and is
// reversible, exactly as before. Picking a record kind MOVES the scan into
// `scholarDocuments` or the health record and drops it from the queue, so it
// goes through a confirm step that names the destination and its pipeline.
function FilingDialog({
  item,
  scope,
  open,
  onClose,
}: {
  item: FeedItem;
  /** The caller's active institution lens, forwarded verbatim to the server. */
  scope?: string;
  open: boolean;
  onClose: () => void;
}) {
  const setAssignment = useMutation(api.portfolio.setAssignment);
  // An action, not a mutation: it copies the scan's blob into the destination
  // store's own file before the source portfolio item (and its blob) is
  // deleted, and `ctx.storage.get` is action-only.
  const fileAsRecord = useAction(api.portfolioRefile.fileAsRecord);
  const { user } = useCurrentUser();
  const [busy, setBusy] = useState(false);
  // selected: the assignment id, null for "none", or "" (matches nothing) when
  // still unresolved.
  const selected: string | null = item.assignmentId
    ? (item.assignmentId as string)
    : item.assignmentStatus === "none"
      ? null
      : "";

  // Both record stores are single-scholar; a portfolio item is not. Exactly one
  // attribution is the precondition, and the picker says so per-option rather
  // than hiding the capability.
  const onlyScholarId =
    item.scholarIds.length === 1 ? item.scholarIds[0] : null;

  // Can this caller file ANY record kind? This gates the QUERY, not just the
  // menu: listDocumentsForStaff throws for a caller with neither teacher nor
  // scholar-admin access over the scholar (a captures:review-only coach
  // triaging a station capture), and a throwing useQuery would take the whole
  // drawer down.
  const canFileRecords = useMemo(
    () =>
      visibleUploadKinds(
        user?.role,
        true,
        user?.hasSchoolOperationsAccess === true,
        user?.hasHealthManagementAccess === true,
      ).length > 0,
    [
      user?.role,
      user?.hasSchoolOperationsAccess,
      user?.hasHealthManagementAccess,
    ],
  );

  // Only to know whether the Health record group is offerable for THIS scholar
  // — a staff filing attaches to a signed record, so without one there is no
  // slot. Same query the Documents tab and the upload modal subscribe to.
  const staffView = useQuery(
    api.scholarDocuments.listDocumentsForStaff,
    open && canFileRecords && onlyScholarId
      ? { scholarId: onlyScholarId, institutionScope: scope }
      : "skip",
  );
  // Optimistic until known, so the group is never silently absent while the
  // scholar is still being chosen — an option with a stated reason teaches
  // more than a missing one. Every such option is disabled below.
  const healthFormsAvailable = staffView?.healthFormsAvailable ?? true;
  const attachableHealthKinds = useMemo(
    () => new Set<string>(staffView?.attachableHealthKinds ?? []),
    [staffView?.attachableHealthKinds],
  );

  const recordKinds = useMemo(
    () =>
      canFileRecords
        ? visibleUploadKinds(
            user?.role,
            healthFormsAvailable,
            user?.hasSchoolOperationsAccess === true,
            user?.hasHealthManagementAccess === true,
          )
        : undefined,
    [
      canFileRecords,
      user?.role,
      user?.hasSchoolOperationsAccess,
      user?.hasHealthManagementAccess,
      healthFormsAvailable,
    ],
  );

  const scholarCount = item.scholarIds.length;
  const recordDisabledReason = useCallback(
    (spec: DocumentKindSpec): string | null => {
      if (scholarCount === 0) {
        return "Choose a scholar first — a record belongs to one scholar.";
      }
      if (scholarCount > 1) {
        return "A record belongs to one scholar. Remove the others first.";
      }
      if (spec.store !== "healthRecordFiles") return null;
      if (
        item.fileSizeBytes !== undefined &&
        item.fileSizeBytes > HEALTH_DOCUMENT_MAX_BYTES
      ) {
        return "Health record documents must be 10 MB or smaller.";
      }
      if (staffView === undefined) return "Checking the health record…";
      if (!staffView.canUploadHealthDocuments) {
        return staffView.healthDocumentsVisible
          ? "Health record documents need a submitted Medical & Emergency form — ask a guardian to complete it first."
          : "Health record documents aren’t available on the All institutions view. Select this scholar’s institution first.";
      }
      if (!attachableHealthKinds.has(spec.kind)) {
        return spec.kind === "action_plan_document"
          ? "This record has no healthcare action plan selected, so there is no slot to attach to. Ask the family to update their Medical & Emergency form first."
          : spec.kind === "support_plan_document"
            ? "This record has no support plan selected, so there is no slot to attach to. Ask the family to update their Medical & Emergency form first."
            : "This record has no slot for that document yet.";
      }
      return null;
    },
    [scholarCount, item.fileSizeBytes, staffView, attachableHealthKinds],
  );

  const commitRecord = async (spec: DocumentKindSpec) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await fileAsRecord({
        itemId: item._id,
        kind: spec.kind,
        ...(scope ? { institutionScope: scope } : {}),
      });
      // The item leaves portfolioItems, so the reactive feed drops the row —
      // there is nothing left on screen to link from. The toast carries the
      // destination instead. The name comes from the server's result, not the
      // stale row we were rendering.
      toaster.create({
        title: `Filed to ${result.scholarName}’s documents`,
        description: `${spec.label} · find it under Documents on their profile.`,
        type: "success",
      });
      onClose();
    } catch (error) {
      toaster.create({
        title: "Couldn’t file this record",
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && onClose()}
      placement="center"
      size="xl"
      modal={false}
    >
      <Portal>
        {/* Non-modal dialogs don't auto-dismiss on outside click (Ark's
            interact-outside doesn't fire while the drawer layer is open), so
            close explicitly when the backdrop is clicked. */}
        <Dialog.Backdrop onClick={onClose} />
        <Dialog.Positioner>
          <StyledDialogContent
            maxW="6xl"
            w="calc(100vw - 32px)"
            h={{
              base: "calc(100vh - 32px)",
              lg: "min(820px, calc(100vh - 32px))",
            }}
            maxH="calc(100vh - 32px)"
          >
            <Dialog.Header
              px={6}
              pt={5}
              pb={1}
              h={{ base: "auto", lg: "92px" }}
              flexShrink={0}
            >
              <HStack align="start" justify="space-between" w="full" gap={3}>
                <VStack align="start" gap={1}>
                  <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                    File this scan
                  </Dialog.Title>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={2}>
                    {item.title}
                  </Text>
                </VStack>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }} flexShrink={0} onClick={() => onClose()}>
                  <X />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body
              px={6}
              pb={5}
              pt={3}
              minH={0}
              flex={1}
              display="flex"
              overflowY={{ base: "auto", lg: "hidden" }}
            >
              <Grid
                templateColumns={{
                  base: "1fr",
                  lg: "minmax(0, 1.05fr) minmax(320px, 0.95fr)",
                }}
                gap={5}
                minH={0}
                h={{ base: "auto", lg: "full" }}
                w="full"
              >
                <Box minW={0} minH={0} overflow="hidden">
                  <FilingPicker
                    selected={selected}
                    recordKinds={recordKinds}
                    recordDisabledReason={recordDisabledReason}
                    maxH="min(644px, calc(100vh - 208px))"
                    onChooseRecord={(spec) => void commitRecord(spec)}
                    onChooseAssignment={async (next) => {
                      if (busy) return;
                      setBusy(true);
                      // Hoisted out of the try body: a conditional value block
                      // inside try/catch triggers a React Compiler bail-out.
                      const assignmentId = next
                        ? (next as Id<"assignments">)
                        : undefined;
                      try {
                        await setAssignment({ itemId: item._id, assignmentId });
                        onClose();
                      } catch (error) {
                        toaster.create({
                          title: "Couldn’t set assignment",
                          description:
                            error instanceof Error ? error.message : String(error),
                          type: "error",
                        });
                      } finally {
                        setBusy(false);
                      }
                    }}
                  />
                </Box>
                <FilingScanPreview item={item} />
              </Grid>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Activity dialog (which activity within the assignment) ──────────────
// Only meaningful once an assignment is chosen — the activity list is the
// assignment's unit. Picking an activity (with a resolved scholar)
// materializes the scan into a deliverable.
function ActivityDialog({ item, open, onClose }: { item: FeedItem; open: boolean; onClose: () => void }) {
  const setActivity = useMutation(api.portfolio.setActivity);
  const activities = useQuery(
    api.portfolio.listActivitiesForAssignment,
    item.assignmentId ? { assignmentId: item.assignmentId } : "skip",
  );
  const [busy, setBusy] = useState(false);

  const pick = async (activityId: Id<"activities"> | undefined) => {
    if (busy) return;
    setBusy(true);
    try {
      await setActivity({ itemId: item._id, activityId });
      onClose();
    } catch (error) {
      toaster.create({
        title: "Couldn’t set activity",
        description:
          error instanceof Error ? error.message : String(error),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" modal={false}>
      <Portal>
        <Dialog.Backdrop onClick={() => onClose()} />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={1}>
              <HStack align="start" justify="space-between" w="full" gap={3}>
                <VStack align="start" gap={1}>
                  <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                    {item.activityTitle ? "Change activity" : "Choose activity"}
                  </Dialog.Title>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={2}>
                    {item.assignmentTitle ?? "this assignment"}
                  </Text>
                </VStack>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }} flexShrink={0} onClick={() => onClose()}>
                  <X />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px={6} pb={5} pt={3}>
              <Box minH="120px" maxH="420px" overflowY="auto">
                <VStack align="stretch" gap={1}>
                  {/* "Not for a specific activity" — clears the activity (the
                      scan stays filed to the cohort but produces no deliverable). */}
                  <Button
                    size="sm"
                    variant={item.activityId ? "ghost" : "subtle"}
                    justifyContent="flex-start"
                    fontFamily="heading"
                    color="charcoal.500"
                    onClick={() => pick(undefined)}
                  >
                    No specific activity
                  </Button>
                  {activities === undefined ? (
                    <Flex justify="center" py={6}><Spinner size="sm" color="violet.500" /></Flex>
                  ) : activities.length === 0 ? (
                    <EmptyState title="No activities to file to" />
                  ) : (
                    activities.map((a) => {
                      const selected = item.activityId === a.id;
                      return (
                        <Button
                          key={a.id}
                          size="sm"
                          variant={selected ? "subtle" : "ghost"}
                          colorPalette={selected ? "violet" : undefined}
                          justifyContent="flex-start"
                          fontFamily="heading"
                          h="auto"
                          py={2}
                          onClick={() => pick(a.id)}
                        >
                          <VStack align="start" gap={0} minW={0}>
                            <Text fontWeight="600" color="navy.600" truncate>
                              {a.title}
                            </Text>
                            <Text fontSize="2xs" color="charcoal.400">
                              {a.lessonTitle} · {a.kind === "offline" ? "offline" : "online"}
                            </Text>
                          </VStack>
                        </Button>
                      );
                    })
                  )}
                </VStack>
              </Box>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── One item row (used in both To review and Filed) ─────────────────────
function ItemRow({
  item,
  scope,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  item: FeedItem;
  scope?: string;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const removeItem = useMutation(api.portfolio.deleteItem);
  const setFamilyVisibility = useMutation(api.portfolio.setFamilyVisibility);
  const fileUrl = useQuery(api.portfolio.getFileUrl, { itemId: item._id });
  const [scholarOpen, setScholarOpen] = useState(false);
  const [filingOpen, setFilingOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [visibilityBusy, setVisibilityBusy] = useState(false);

  const isVideo = captureMediaKind(item.fileMimeType) === "video";

  // One destination, one value. The unresolved copy names both halves of the
  // choice, because a scanned record has no other affordance to discover.
  const filingLabel = item.assignmentTitle
    ? item.assignmentTitle
    : item.assignmentStatus === "none"
      ? "No assignment"
      : "Choose assignment or record";
  // Activity is the optional second axis within an assignment; only offer it
  // once a real assignment is chosen. Highlight it as "open" when the
  // assignment is set but no activity is picked yet (filing it materializes
  // the scan into a deliverable).
  const hasAssignment = !!item.assignmentId;
  const canManageFamilySharing =
    hasAssignment || item.source === "capture_station";
  const activityLabel = item.activityTitle ?? "Choose activity";
  const activityOpenField = hasAssignment && !item.activityId;

  return (
    <HStack align="start" gap={3} p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="gray.200">
      {selectable && (
        <Box pt={1} flexShrink={0}>
          <Checkbox.Root
            size="sm"
            checked={selected}
            onCheckedChange={() => onToggleSelect?.()}
            aria-label={`Select ${item.title}`}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
          </Checkbox.Root>
        </Box>
      )}
      <FileThumb
        itemId={item._id}
        thumbUrl={item.thumbUrl}
        thumbStatus={item.thumbStatus}
        isVideo={isVideo}
        posterUrl={item.videoThumbUrl ?? null}
        durationMs={item.videoDurationMs ?? null}
      />
      <VStack align="start" gap={1.5} flex={1} minW={0}>
        {/* w="full" is load-bearing: the VStack is align="start", so children
            size to content and `truncate` would have no width to clip against —
            the title would overrun into the timestamp column. */}
        {/* Eyebrow: the human-assigned label wins, else the page's printed
            heading. A program capture has no heading, so an unnamed capture
            shows no eyebrow and reads by its title alone until it's named. */}
        {(item.label || item.documentHeading) && (
          <Text
            fontSize="2xs"
            fontWeight="700"
            fontFamily="heading"
            color="charcoal.400"
            textTransform="uppercase"
            letterSpacing="0.05em"
            truncate
            w="full"
          >
            {item.label || item.documentHeading}
          </Text>
        )}
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm" truncate w="full">
          {item.title}
        </Text>
        {item.aiCaption && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={1} w="full">
            {item.aiCaption}
          </Text>
        )}
        {/* Both fields are editable in the uploads queue so triage can be
            corrected after the fact — including a capture reviewer retagging a
            station capture to a different scholar in the group. */}
        <VStack gap={0.5} align="start" w="full">
          <FieldRow
            label="Scholars"
            value={
              item.scholarNames.length > 0
                ? item.scholarNames.length === 1
                  ? item.scholarNames[0]
                  : `${item.scholarNames.join(", ")} (${item.scholarNames.length})`
                : item.detectedName
                  ? `“${item.detectedName}”?`
                  : "Choose scholars"
            }
            open={item.open.scholar}
            onClick={() => setScholarOpen(true)}
          />
          <FieldRow
            label="File as"
            value={filingLabel}
            open={item.open.assignment}
            onClick={() => setFilingOpen(true)}
          />
          {hasAssignment && (
            <FieldRow
              label="Activity"
              value={activityLabel}
              open={activityOpenField}
              onClick={() => setActivityOpen(true)}
            />
          )}
        </VStack>
        {canManageFamilySharing &&
          item.scholarIds.length > 0 &&
          item.canShareWithFamilies && (
          <Button
            size="2xs"
            variant={
              item.familyVisibility === "attributed_families"
                ? "subtle"
                : "outline"
            }
            colorPalette="violet"
            disabled={visibilityBusy}
            onClick={async () => {
              setVisibilityBusy(true);
              try {
                await setFamilyVisibility({
                  itemId: item._id,
                  familyVisibility:
                    item.familyVisibility === "attributed_families"
                      ? "staff_only"
                      : "attributed_families",
                });
              } catch (error) {
                toaster.create({
                  title: "Couldn’t update family sharing",
                  description:
                    error instanceof Error ? error.message : String(error),
                  type: "error",
                });
              } finally {
                setVisibilityBusy(false);
              }
            }}
          >
            {item.familyVisibility === "attributed_families"
              ? "Shared with families"
              : "Share with families"}
          </Button>
        )}
        {canManageFamilySharing &&
          item.scholarIds.length > 0 &&
          !item.canShareWithFamilies && (
          <Text fontSize="xs" color="charcoal.400">
            Staff only — {item.familySharingBlocker ?? "family sharing is unavailable."}
          </Text>
        )}
      </VStack>
      <VStack gap={0} align="end" flexShrink={0}>
        <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" whiteSpace="nowrap">
          {formatTimeAgo(item._creationTime)}
        </Text>
        <HStack gap={0}>
          {fileUrl && (
            <IconButton aria-label="Open file" size="2xs" variant="ghost" color="charcoal.400" onClick={() => openExternal(fileUrl)}>
              <ArrowSquareOut />
            </IconButton>
          )}
          <IconButton
            aria-label="Delete"
            size="2xs"
            variant="ghost"
            color="red.400"
            _hover={{ bg: "red.50", color: "red.600" }}
            onClick={async () => {
              try {
                await removeItem({ itemId: item._id });
              } catch (error) {
                toaster.create({
                  title: "Couldn’t delete",
                  description:
                    error instanceof Error ? error.message : String(error),
                  type: "error",
                });
              }
            }}
          >
            <Trash />
          </IconButton>
        </HStack>
      </VStack>

      {/* Conditionally mounted so the Dialog's focus trap + scroll lock fully
          tear down on close — sharing a React subtree with the Drawer's modal
          context otherwise leaves pointer-events blocked. Same pattern as
          CameraScanDialog. */}
      {scholarOpen && (
        <ScholarDialog item={item} open={scholarOpen} onClose={() => setScholarOpen(false)} />
      )}
      {filingOpen && (
        <FilingDialog item={item} scope={scope} open={filingOpen} onClose={() => setFilingOpen(false)} />
      )}
      {activityOpen && (
        <ActivityDialog item={item} open={activityOpen} onClose={() => setActivityOpen(false)} />
      )}
    </HStack>
  );
}

// ── Processing row — one in-flight scan (no thumbnail, just spinner + label) ─
function ProcessingRow({ item }: { item: ProcessingItem }) {
  return (
    <HStack align="center" gap={3} p={3} bg="white" borderRadius="md" borderWidth="1px" borderColor="violet.100">
      <Box
        w="56px"
        h="56px"
        flexShrink={0}
        bg="violet.50"
        borderRadius="md"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        <Spinner size="md" color="violet.500" />
      </Box>
      <VStack align="start" gap={0.5} flex={1} minW={0}>
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm" truncate w="full">
          {item.title}
        </Text>
        <Text fontSize="xs" color="violet.600" fontFamily="body">
          {processingLabel(item.processingStatus)}
        </Text>
      </VStack>
      <Text fontSize="2xs" color="charcoal.300" fontFamily="heading" whiteSpace="nowrap" flexShrink={0}>
        {formatTimeAgo(item._creationTime)}
      </Text>
    </HStack>
  );
}

// ── Drawer body ─────────────────────────────────────────────────────────
function ProcessingSection({ items }: { items: ProcessingItem[] }) {
  if (items.length === 0) return null;
  return (
    <Box>
      <HStack mb={2} gap={2}>
        <Spinner size="xs" color="violet.500" />
        <Text fontSize="xs" fontWeight="700" fontFamily="heading" color="violet.600" textTransform="uppercase" letterSpacing="0.05em">
          In progress
        </Text>
        <Badge bg="violet.100" color="violet.700" fontSize="2xs" fontFamily="heading">
          {items.length}
        </Badge>
      </HStack>
      <VStack align="stretch" gap={2}>
        {items.map((item) => (
          <ProcessingRow key={item._id} item={item} />
        ))}
      </VStack>
    </Box>
  );
}

function FeedSection({
  title,
  items,
  scope,
  emptyTitle,
  emptyHint,
  showBadge = false,
  selectable = false,
  selectedIds,
  onToggleItem,
  onToggleSection,
}: {
  title: string;
  items: FeedItem[];
  /** Institution lens, forwarded to each row's filing dialog. */
  scope?: string;
  emptyTitle: string;
  emptyHint?: string;
  showBadge?: boolean;
  selectable?: boolean;
  selectedIds?: Set<Id<"portfolioItems">>;
  onToggleItem?: (id: Id<"portfolioItems">) => void;
  onToggleSection?: (ids: Id<"portfolioItems">[], checked: boolean) => void;
}) {
  // "Select all" is scoped to THIS section (predictable beats a global toggle
  // that reaches across the divider).
  const sectionIds = items.map((i) => i._id);
  const selectedInSection = selectedIds
    ? sectionIds.filter((id) => selectedIds.has(id)).length
    : 0;
  const allSelected = sectionIds.length > 0 && selectedInSection === sectionIds.length;
  const someSelected = selectedInSection > 0 && !allSelected;
  return (
    <Box>
      <HStack mb={2} gap={2}>
        <Text fontSize="xs" fontWeight="700" fontFamily="heading" color="charcoal.500" textTransform="uppercase" letterSpacing="0.05em">
          {title}
        </Text>
        {showBadge && items.length > 0 && (
          <Badge bg="orange.100" color="orange.700" fontSize="2xs" fontFamily="heading">
            {items.length}
          </Badge>
        )}
        {selectable && items.length > 0 && onToggleSection && (
          <Checkbox.Root
            size="sm"
            ml="auto"
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(d) => onToggleSection(sectionIds, d.checked === true)}
          >
            <Checkbox.HiddenInput />
            <Checkbox.Control />
            <Checkbox.Label fontSize="sm" fontFamily="heading" color="charcoal.500">
              Select all
            </Checkbox.Label>
          </Checkbox.Root>
        )}
      </HStack>
      {items.length === 0 ? (
        <EmptyState title={emptyTitle} hint={emptyHint} />
      ) : (
        <VStack align="stretch" gap={2}>
          {items.map((item) => (
            <ItemRow
              key={item._id}
              item={item}
              scope={scope}
              selectable={selectable}
              selected={selectedIds?.has(item._id) ?? false}
              onToggleSelect={() => onToggleItem?.(item._id)}
            />
          ))}
        </VStack>
      )}
    </Box>
  );
}

// ── Scanner info dialog ─────────────────────────────────────────────────
function ScannerInfoDialog({
  open,
  onClose,
  name,
  instructions,
}: {
  open: boolean;
  onClose: () => void;
  name: string | null;
  instructions: string | null;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" modal={false}>
      <Portal>
        {/* Non-modal dialogs don't auto-dismiss on outside click (Ark's
            interact-outside doesn't fire while the drawer layer is open), so
            close explicitly when the backdrop is clicked. */}
        <Dialog.Backdrop onClick={() => onClose()} />
        <Dialog.Positioner>
          <StyledDialogContent maxW="sm">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                {name ?? "Scanner"}
              </Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6} pt={1}>
              <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                {instructions ?? "Scans from the classroom scanner arrive in this inbox automatically."}
              </Text>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Launcher tile — square button with stacked icon + label ─────────────
function LauncherTile({
  icon,
  label,
  onClick,
  disabled = false,
  loading = false,
  title,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  title?: string;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      variant="outline"
      h="auto"
      py={3}
      px={2}
      borderRadius="lg"
      borderColor="gray.200"
      bg="white"
      _hover={{ bg: "violet.50", borderColor: "violet.300", color: "violet.600" }}
      _disabled={{ opacity: 0.5, cursor: "not-allowed" }}
      display="flex"
      flexDir="column"
      alignItems="center"
      justifyContent="center"
      gap={1.5}
      fontFamily="heading"
      color="charcoal.600"
    >
      {loading ? <Spinner size="md" color="violet.500" /> : <Box fontSize="22px" lineHeight={1}>{icon}</Box>}
      <Text fontSize="xs" fontFamily="heading" fontWeight="600" lineHeight={1}>
        {label}
      </Text>
    </Button>
  );
}

const HEIC_EXT_RE = /\.(heic|heif)$/i;

/** iPhones default to HEIC, which the server pipeline can't read. */
function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || HEIC_EXT_RE.test(file.name);
}

/**
 * Normalize a picked file into something the ingest pipeline accepts. For HEIC/
 * HEIF we transcode to JPEG in the browser (the server only handles PDF +
 * jpeg/png/webp/gif). heic2any pulls in a libheif WASM blob, so it's imported
 * lazily — non-HEIC uploads never pay for it.
 */
async function toUploadable(
  file: File,
): Promise<{ blob: Blob; name: string; type: string }> {
  if (!isHeic(file)) {
    return {
      blob: file,
      name: file.name,
      type: file.type || "application/octet-stream",
    };
  }
  const { default: heic2any } = await import("heic2any");
  const out = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  const blob = Array.isArray(out) ? out[0] : out;
  return {
    blob,
    name: file.name.replace(HEIC_EXT_RE, ".jpg"),
    type: "image/jpeg",
  };
}

// ── "Add work" — launcher grid for the four ways to get scans IN ────────
// camera + scanner-info dialog state is OWNED BY PARENT (ScannerPanel) so the
// dialogs render as siblings of the Drawer rather than nested inside Drawer.Body.
// Nesting a modal Dialog inside Chakra's Drawer leaves the Drawer pointer-event-
// blocked after the inner dialog closes — hoisting fixes it.
function AddWorkBar({
  onOpenCamera,
  onOpenScannerInfo,
  printer,
  scope,
}: {
  onOpenCamera: () => void;
  onOpenScannerInfo: () => void;
  printer: { name: string | null; instructions: string | null } | null;
  scope?: string;
}) {
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const ingestUploadedScan = useAction(api.portfolioActions.ingestUploadedScan);
  const ingestDriveFileById = useAction(api.portfolioActions.ingestDriveFileById);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const uploadFiles = async (files: FileList) => {
    setBusy(true);
    setMsg(null);
    try {
      for (const file of Array.from(files)) {
        // HEIC → JPEG in the browser before upload (server can't read HEIC).
        const { blob, name, type } = await toUploadable(file);
        const url = await generateUploadUrl();
        const put = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": type },
          body: blob,
        });
        if (!put.ok) throw new Error(`Upload failed (${put.status})`);
        const { storageId } = (await put.json()) as { storageId: Id<"_storage"> };
        await ingestUploadedScan({
          storageId,
          fileMimeType: type,
          title: name,
          source: "upload",
          scope,
        });
      }
      // Success needs no message — the item shows up under "In Progress"
      // with a spinner. `msg` is reserved for errors.
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <Box>
      <SimpleGrid columns={4} gap={2}>
        <LauncherTile
          icon={<File />}
          label="File"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        />
        <input
          ref={fileRef}
          type="file"
          accept="application/pdf,image/*,.heic,.heif"
          multiple
          style={{ display: "none" }}
          onChange={(e) => e.target.files && e.target.files.length > 0 && uploadFiles(e.target.files)}
        />
        <GooglePickerButton
          mode="files"
          disabled={busy}
          onPicked={async (doc) => {
            setBusy(true);
            setMsg(null);
            try {
              const r = await ingestDriveFileById({
                fileId: doc.id,
                fileName: doc.name,
                fileMimeType: doc.mimeType,
                scope,
              });
              // Only surface failures; a scheduled import shows under "In Progress".
              setMsg(r.scheduled ? null : `Drive import failed: ${r.error ?? "unknown"}`);
            } catch (e) {
              setMsg(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
          renderTrigger={({ onClick, loading, disabled }) => (
            <LauncherTile
              icon={<HardDrive />}
              label="Drive"
              onClick={onClick}
              loading={loading}
              disabled={disabled}
            />
          )}
        />
        <LauncherTile
          icon={<Camera />}
          label="Camera"
          disabled={busy}
          onClick={onOpenCamera}
        />
        <LauncherTile
          icon={<Printer />}
          label="Scanner"
          disabled={busy}
          onClick={onOpenScannerInfo}
          title={printer ? undefined : "No scanner configured — set one up in Admin Settings"}
        />
      </SimpleGrid>
      {msg && (
        <Text fontSize="xs" color="charcoal.500" fontFamily="body" mt={2}>
          {msg}
        </Text>
      )}
    </Box>
  );
}

// ── Bulk action bar — appears only with a live selection ────────────────
// A quiet working-surface strip, not a hero. Sticky at the bottom of the
// scrolling drawer body so it never covers the list.
function BulkActionBar({
  count,
  onAssign,
  onName,
  onClear,
}: {
  count: number;
  onAssign: () => void;
  onName: () => void;
  onClear: () => void;
}) {
  return (
    <HStack
      position="sticky"
      bottom={0}
      mx={-4}
      mb={-4}
      px={4}
      py={3}
      bg="white"
      borderTop="1px solid"
      borderColor="gray.200"
      justify="space-between"
      gap={3}
    >
      <Text fontSize="sm" fontFamily="heading" fontWeight="600" color="navy.600">
        {count} selected
      </Text>
      <HStack gap={2}>
        <Button
          size="sm"
          variant="ghost"
          fontFamily="heading"
          color="charcoal.500"
          _hover={{ bg: "gray.100" }}
          onClick={onClear}
        >
          Clear
        </Button>
        <Button size="sm" variant="outline" fontFamily="heading" onClick={onName}>
          Rename
        </Button>
        <Button size="sm" colorPalette="violet" fontFamily="heading" onClick={onAssign}>
          Set assignment
        </Button>
      </HStack>
    </HStack>
  );
}

function BulkAssignmentDialog({
  itemIds,
  open,
  onClose,
  onDone,
}: {
  itemIds: Id<"portfolioItems">[];
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const setAssignments = useMutation(api.portfolio.setAssignments);
  const [busy, setBusy] = useState(false);
  const count = itemIds.length;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(event) => !event.open && onClose()}
      placement="center"
      modal={false}
    >
      <Portal>
        <Dialog.Backdrop onClick={onClose} />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={1}>
              <HStack align="start" justify="space-between" w="full" gap={3}>
                <VStack align="start" gap={1}>
                  <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                    Set assignment
                  </Dialog.Title>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                    {count === 1 ? "1 scan selected" : `${count} scans selected`}
                  </Text>
                </VStack>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                  flexShrink={0}
                  onClick={onClose}
                >
                  <X />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px={6} pb={5} pt={3}>
              <FilingPicker
                selected=""
                allowNoAssignment={false}
                recordKinds={[]}
                emptyHint="No active assignments yet."
                maxH="480px"
                onChooseRecord={() => undefined}
                onChooseAssignment={async (assignmentId) => {
                  if (busy || !assignmentId) return;
                  setBusy(true);
                  try {
                    const result = await setAssignments({
                      itemIds,
                      assignmentId: assignmentId as Id<"assignments">,
                    });
                    toaster.create({
                      title: `Set assignment on ${result.updated} ${
                        result.updated === 1 ? "scan" : "scans"
                      }`,
                      type: "success",
                    });
                    onDone();
                    onClose();
                  } catch (error) {
                    toaster.create({
                      title: "Couldn’t set assignment",
                      description:
                        error instanceof Error ? error.message : String(error),
                      type: "error",
                    });
                  } finally {
                    setBusy(false);
                  }
                }}
              />
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// ── Naming dialog — free-text label + one-tap recent labels ─────────────
// Opened from the bulk bar. Follows the drawer's non-modal dialog rule (see
// the comment block above ScholarDialog): modal={false} + explicit backdrop.
function LabelDialog({
  itemIds,
  scope,
  programGroupId,
  open,
  onClose,
  onDone,
}: {
  itemIds: Id<"portfolioItems">[];
  scope?: string;
  programGroupId: Id<"scholarGroups"> | null;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const setLabels = useMutation(api.portfolio.setLabels);
  // Recent labels are scoped to the SAME queue population as the feed, so the
  // chips a reviewer sees match the rows they're naming (per-institution, and
  // per program group when one is selected).
  const recent = useQuery(api.portfolio.listRecentLabels, {
    limit: 12,
    scope,
    ...(programGroupId ? { programGroupId } : {}),
  });
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const count = itemIds.length;

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const { updated } = await setLabels({ itemIds, label: value });
      const cleared = value.trim().length === 0;
      const noun = updated === 1 ? "item" : "items";
      toaster.create({
        title: cleared
          ? `Cleared name on ${updated} ${noun}`
          : `Named ${updated} ${noun}`,
        type: "success",
      });
      onDone();
      onClose();
    } catch (error) {
      toaster.create({
        title: "Couldn’t name work",
        description: error instanceof Error ? error.message : String(error),
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(e) => !e.open && onClose()} placement="center" modal={false}>
      <Portal>
        {/* Non-modal dialogs don't auto-dismiss on outside click (Ark's
            interact-outside doesn't fire while the drawer layer is open), so
            close explicitly when the backdrop is clicked. */}
        <Dialog.Backdrop onClick={() => onClose()} />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={1}>
              <HStack align="start" justify="space-between" w="full" gap={3}>
                <VStack align="start" gap={1}>
                  <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                    Name work
                  </Dialog.Title>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                    {count === 1 ? "1 item selected" : `${count} items selected`}
                  </Text>
                </VStack>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }} flexShrink={0} onClick={() => onClose()}>
                  <X />
                </IconButton>
              </HStack>
            </Dialog.Header>
            <Dialog.Body px={6} pb={5} pt={3}>
              <VStack align="stretch" gap={4}>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit(label);
                  }}
                >
                  <HStack gap={2}>
                    <Input
                      autoFocus
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      placeholder="e.g. Learning print"
                      fontFamily="body"
                      size="sm"
                      disabled={busy}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      colorPalette="violet"
                      fontFamily="heading"
                      disabled={busy}
                      flexShrink={0}
                    >
                      Apply
                    </Button>
                  </HStack>
                </form>
                {recent && recent.length > 0 && (
                  <VStack align="stretch" gap={2}>
                    <Text
                      fontSize="2xs"
                      fontWeight="600"
                      fontFamily="heading"
                      color="charcoal.400"
                      textTransform="uppercase"
                      letterSpacing="0.04em"
                    >
                      Recent
                    </Text>
                    <Flex gap={2} wrap="wrap">
                      {recent.map((name) => (
                        <Button
                          key={name}
                          size="sm"
                          variant="outline"
                          fontFamily="heading"
                          borderColor="gray.200"
                          color="navy.600"
                          _hover={{ bg: "violet.50", borderColor: "violet.300" }}
                          disabled={busy}
                          onClick={() => submit(name)}
                        >
                          {name}
                        </Button>
                      ))}
                    </Flex>
                  </VStack>
                )}
              </VStack>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

// A shared, never-mutated empty selection. Returned while the feed is loading
// so the bulk bar acts on nothing rather than a stale scope's ids.
const EMPTY_SELECTION = new Set<Id<"portfolioItems">>();

function ScannerBody({
  open,
  programGroupId,
  scope,
}: {
  open: boolean;
  programGroupId: Id<"scholarGroups"> | null;
  scope?: string;
}) {
  const feed = useQuery(
    api.portfolio.scannerFeed,
    open
      ? {
         scope,
         ...(programGroupId ? { programGroupId } : {}),
       }
      : "skip",
  );

  // Every row in the unified queue is selectable for bulk actions — ordinary
  // scans AND program-station captures alike (captures are no longer a
  // read-only reviewer view; they're rows in the same queue).
  const selectable = true;
  const [selectedIds, setSelectedIds] = useState<Set<Id<"portfolioItems">>>(
    () => new Set(),
  );
  const [labelOpen, setLabelOpen] = useState(false);
  const [assignmentOpen, setAssignmentOpen] = useState(false);

  // Selection belongs to an open drawer session — a fresh open starts clean.
  // Reset during render on the close transition (an effect here would trip
  // react-hooks/set-state-in-effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (!open) {
      setSelectedIds(new Set());
      setLabelOpen(false);
      setAssignmentOpen(false);
    }
  }

  // Selection is scope-bound: switching institution or program group must not
  // carry a prior scope's ids into the new (and still-loading) feed, or the
  // bulk bar could name rows no longer on screen. Reset during render, same
  // pattern as the open/close transition above.
  const scopeIdentity = `${scope ?? ""}|${programGroupId ?? ""}`;
  const [selectionScope, setSelectionScope] = useState(scopeIdentity);
  if (selectionScope !== scopeIdentity) {
    setSelectionScope(scopeIdentity);
    setSelectedIds(new Set());
    setLabelOpen(false);
    setAssignmentOpen(false);
  }

  const feedIds = useMemo(() => {
    if (!feed) return null;
    return new Set<Id<"portfolioItems">>([
      ...(feed.toReview as FeedItem[]).map((i) => i._id),
      ...(feed.processed as FeedItem[]).map((i) => i._id),
    ]);
  }, [feed]);

  // Derive the live selection by intersecting with what's currently in the
  // feed, so ids that have left it (deleted, filed out of view, or belonging to
  // a scope we just switched away from) never inflate "N selected" or reach the
  // bulk action. While the feed is (re)loading, feedIds is null: act on NOTHING
  // rather than falling back to a stale set. Deriving (vs. syncing in an effect)
  // keeps this a pure read.
  const effectiveSelectedIds = useMemo(() => {
    if (!feedIds) return EMPTY_SELECTION;
    const next = new Set<Id<"portfolioItems">>();
    selectedIds.forEach((id) => {
      if (feedIds.has(id)) next.add(id);
    });
    return next;
  }, [selectedIds, feedIds]);

  const toggleItem = useCallback((id: Id<"portfolioItems">) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSection = useCallback(
    (ids: Id<"portfolioItems">[], checked: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) {
          if (checked) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [],
  );

  const selectedCount = effectiveSelectedIds.size;
  return (
    <>
      <VStack align="stretch" gap={5} p={4}>
        {feed === undefined ? (
          <Flex justify="center" py={8}>
            <Spinner color="violet.500" />
          </Flex>
        ) : (
          <>
            <ProcessingSection items={(feed.processing ?? []) as ProcessingItem[]} />
            <FeedSection
              title="To review"
              items={feed.toReview as FeedItem[]}
              scope={scope}
              emptyTitle="Nothing to review"
              emptyHint="Newly uploaded work appears here for triage."
              showBadge
              selectable={selectable}
              selectedIds={effectiveSelectedIds}
              onToggleItem={toggleItem}
              onToggleSection={toggleSection}
            />
            <FeedSection
              title="Filed"
              items={feed.processed as FeedItem[]}
              scope={scope}
              emptyTitle="Nothing filed yet"
              selectable={selectable}
              selectedIds={effectiveSelectedIds}
              onToggleItem={toggleItem}
              onToggleSection={toggleSection}
            />
          </>
        )}
        {selectable && selectedCount > 0 && (
          <BulkActionBar
            count={selectedCount}
            onAssign={() => setAssignmentOpen(true)}
            onName={() => setLabelOpen(true)}
            onClear={() => setSelectedIds(new Set())}
          />
        )}
      </VStack>
      {assignmentOpen && (
        <BulkAssignmentDialog
          itemIds={Array.from(effectiveSelectedIds)}
          open={assignmentOpen}
          onClose={() => setAssignmentOpen(false)}
          onDone={() => setSelectedIds(new Set())}
        />
      )}
      {labelOpen && (
        <LabelDialog
          itemIds={Array.from(effectiveSelectedIds)}
          scope={scope}
          programGroupId={programGroupId}
          open={labelOpen}
          onClose={() => setLabelOpen(false)}
          onDone={() => setSelectedIds(new Set())}
        />
      )}
    </>
  );
}

// ── Scope selector (All school + each reviewable program group) ─────────
// The house dropdown-menu semantic (not a hand-rolled pill row — visual-design.md).
// A flat option list, so a future scope kind (a class period, say) is one more
// entry rather than a new branch.
function ScopeSelector({
  options,
  activeKey,
  onSelect,
}: {
  options: ScannerScopeOption[];
  activeKey: string;
  onSelect: (key: string) => void;
}) {
  const active = options.find((o) => o.key === activeKey) ?? options[0];
  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        <Button
          size="sm"
          variant="outline"
          justifyContent="space-between"
          gap={1.5}
          fontFamily="heading"
          fontWeight="600"
          fontSize="sm"
          color="navy.600"
          bg="white"
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="full"
          px={3}
          h="auto"
          py={1}
          maxW="240px"
          _hover={{ bg: "gray.50" }}
          title="Switch scope"
        >
          <HStack gap={1} minW={0}>
            <Text as="span" color="charcoal.400">Scope:</Text>
            <Text as="span" lineClamp={1}>{active.label}</Text>
          </HStack>
          <CaretDown size={14} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="220px" maxH="60vh" overflowY="auto">
            {options.map((o) => (
              <Menu.Item key={o.key} value={o.key} cursor="pointer" onClick={() => onSelect(o.key)}>
                <HStack w="full" gap={2}>
                  <Text flex={1} lineClamp={1}>{o.label}</Text>
                  {o.key === active.key && <Check size={13} />}
                </HStack>
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

// ── The persistent header control ───────────────────────────────────────
export function ScannerPanel({ scope }: { scope?: string }) {
  const [scopeKey, setScopeKey] = useState<string>("all");
  const [open, setOpen] = useState(false);
  const [camera, setCamera] = useState(false);
  const [scannerInfo, setScannerInfo] = useState(false);

  // The selected scope's group id (null = whole school). Derived straight from
  // the key so the counts query below doesn't depend on its own result.
  const programGroupId: Id<"scholarGroups"> | null =
    scopeKey === "all" ? null : (scopeKey as Id<"scholarGroups">);

  const counts = useQuery(api.portfolio.scannerCounts, {
    scope,
    ...(programGroupId ? { programGroupId } : {}),
  });
  const reviewableGroups = counts?.reviewableGroups ?? [];
  // "All school" is always present; each reviewable program group is one more
  // option. A capture reviewer with no group access sees only "All school" and
  // the selector is hidden. Empty for non-reviewers (per scannerCounts).
  const scopeOptions: ScannerScopeOption[] = [
    { key: "all", label: "All school", programGroupId: null },
    ...reviewableGroups.map((g) => ({
      key: g.groupId as string,
      label: g.label,
      programGroupId: g.groupId as Id<"scholarGroups">,
    })),
  ];
  const activeScope =
    scopeOptions.find((o) => o.key === scopeKey) ?? scopeOptions[0];

  const reviewCount = counts?.toReview ?? 0;
  const processingCount = counts?.processing ?? 0;
  const status = useQuery(api.driveSyncState.status, { scope });

  const printer = status?.configured
    ? { name: status.printerName, instructions: status.printerInstructions }
    : null;

  return (
    <>
      <Tooltip.Root openDelay={400} closeDelay={0}>
        <Tooltip.Trigger asChild>
          <IconButton
            aria-label={`Upload${
              processingCount > 0
                ? ` (${processingCount} processing)`
                : reviewCount > 0
                  ? ` (${reviewCount} to review)`
                  : ""
            }`}
            size="sm"
            variant="ghost"
            color="charcoal.400"
            _hover={{ color: "navy.500", bg: "gray.100" }}
            position="relative"
            onClick={() => setOpen(true)}
          >
            <CloudArrowUp size={16} />
            {processingCount > 0 ? (
              // Work in flight — show a spinner so the header reflects the
              // drawer's "In progress" section even while it's closed.
              <Box position="absolute" top="-3px" right="-3px" lineHeight="0">
                <Spinner size="xs" color="violet.500" borderWidth="1.5px" />
              </Box>
            ) : reviewCount > 0 ? (
              <Box
                position="absolute"
                top="-2px"
                right="-2px"
                minW="16px"
                h="16px"
                px="3px"
                borderRadius="full"
                bg="orange.500"
                color="white"
                fontSize="9px"
                fontFamily="heading"
                fontWeight="700"
                display="flex"
                alignItems="center"
                justifyContent="center"
              >
                {reviewCount}
              </Box>
            ) : null}
          </IconButton>
        </Tooltip.Trigger>
        <Portal>
          <Tooltip.Positioner>
            <Tooltip.Content fontFamily="heading" fontSize="xs">
              Upload
              {processingCount > 0
                ? ` — ${processingCount} processing`
                : reviewCount > 0
                  ? ` — ${reviewCount} to review`
                  : ""}
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Portal>
      </Tooltip.Root>

      <Drawer.Root
        open={open}
        onOpenChange={(d) => {
          if (!d.open) setOpen(false);
        }}
        placement="end"
        size={{ base: "full", md: "md" }}
        // Non-modal on purpose. A modal drawer traps focus and marks everything
        // outside its content (incl. the Google Picker, which renders at <body>
        // level) as inert/aria-hidden — so the picker shows on top but can't be
        // clicked. Non-modal drops the focus trap + inert, making the picker
        // interactive. Paired with closeOnInteractOutside={false} so clicking
        // the picker (or the page) doesn't dismiss the drawer mid-upload; it
        // closes via the X or Escape.
        modal={false}
        closeOnInteractOutside={false}
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            {/* Portaled overlays are position:fixed, so the body's
                env(safe-area-inset-top) padding doesn't reach them — pad the
                drawer so its header clears the iPad status bar. env() is 0 in
                desktop browsers, so this is a no-op on web. */}
            <Drawer.Content
              pt="env(safe-area-inset-top)"
              pb="env(safe-area-inset-bottom)"
            >
              <Drawer.Header px={5} pt={4} pb={4} borderBottom="1px solid" borderColor="gray.200" display="block">
                <HStack justify="space-between" mb={3}>
                  <Heading size="md" color="navy.500" fontFamily="heading">
                    Upload
                  </Heading>
                  <Drawer.CloseTrigger asChild>
                    <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400">
                      <X />
                    </IconButton>
                  </Drawer.CloseTrigger>
                </HStack>
                {scopeOptions.length > 1 && (
                  <Box mb={3}>
                    <ScopeSelector options={scopeOptions} activeKey={activeScope.key} onSelect={setScopeKey} />
                  </Box>
                )}
                <AddWorkBar
                  onOpenCamera={() => setCamera(true)}
                  onOpenScannerInfo={() => setScannerInfo(true)}
                  printer={printer}
                  scope={scope}
                />
              </Drawer.Header>
              <Drawer.Body p={0} bg="gray.50">
                <ScannerBody
                  open={open}
                  programGroupId={programGroupId}
                  scope={scope}
                />
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      {/* Dialogs live here, NOT nested inside Drawer.Body — see comment above
          on AddWorkBar. Conditional mount also fully unmounts the camera (and
          its getUserMedia stream + scroll/pointer locks) on close. */}
      {camera && (
        <CameraScanDialog
          open={camera}
          onClose={() => setCamera(false)}
          scope={scope}
        />
      )}
      <ScannerInfoDialog
        open={scannerInfo}
        onClose={() => setScannerInfo(false)}
        name={printer?.name ?? null}
        instructions={printer?.instructions ?? null}
      />
    </>
  );
}

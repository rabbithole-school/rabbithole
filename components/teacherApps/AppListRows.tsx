"use client";

/**
 * The rows of the teacher Apps list (/teacher/apps): catalog apps, the apps
 * scholars built, and both kinds archived (review/teacher-apps-scholar-rows-
 * options.html, Option 2).
 *
 * ONE GRID FOR EVERY ROW. Each row is a `RowShell`: the same four columns
 * (tile · name · reach · actions) from the same template, and the actions are
 * fixed-width slots (preview · primary · archive · chevron), so "Make focus"
 * and "Open" occupy the same box and Archive and the chevron line up down the
 * list whatever kind of row they sit on. A row that has nothing for a slot
 * leaves it empty rather than letting its neighbours shift.
 *
 * A catalog row is a pointer shortcut to the access drawer and a scholar row
 * one to "view as scholar"; neither is a control, because both hold real
 * buttons and a control nested in a control makes every child activation
 * ambiguous for the keyboard. The chevron is the focusable twin of the click.
 */

import type { ReactNode } from "react";
import NextLink from "next/link";
import { Box, Button, Flex, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import { CaretRight, Plus, Timer, X } from "@phosphor-icons/react";
import type { Id } from "@/convex/_generated/dataModel";
import type { AppTimedWindow } from "@/convex/appAudiences";
import type { ScholarBuiltApp } from "@/convex/scholarBuiltApps";
import type { ManagedNativeAppKey } from "@/convex/lib/managedNativeApps";
import type { ExternalAppKind } from "@/shared/appKind";
import { appLaunchSummary, domainOf } from "@/components/AppAccessDrawer";
import { AppPreviewButton } from "@/components/AppPreviewButton";
import { Avatar } from "@/components/Avatar";
import {
  ScholarFacepile,
  type FacepileScholar,
} from "@/components/ScholarFacepile";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
import { TimedAccessChip } from "@/components/teacherApps/TimedAccessChip";
import { formatTimeAgo } from "@/lib/relativeTime";
import { TEACHER_ARCHIVE_COPY } from "@/shared/teacherArchive";

export type AppRow = {
  _id: Id<"externalApps">;
  name: string;
  webUrl: string;
  nativeUrlScheme: string | null;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
  credentialSource: "scholarApp" | "libraryCard" | null;
  defaultForNewScholars: boolean;
  managedNativeAppKey: ManagedNativeAppKey | null;
  appKind: ExternalAppKind;
  archived: boolean;
  timed: AppTimedWindow | null;
  screenshotUrl: string | null;
  /** When the catalog row was added. */
  createdAt: number;
  /** A custom app's last HTML edit (customApps.updatedAt); null for web and
   *  native apps, which record no edit. */
  lastEditedAt: number | null;
  /** An un-archived activity coaches with this app under a buildContract. */
  hasLearningContract: boolean;
  audiences: {
    grantId: Id<"appAudiences">;
    audienceKind: "group" | "institution";
    audienceId: string;
    enabled: boolean;
    label: string;
    emoji: string | null;
    memberCount: number;
  }[];
  directScholarCount: number;
  directFacepile: FacepileScholar[];
};

export function launchSummary(row: AppRow): string {
  return appLaunchSummary({
    _id: row._id,
    name: row.name,
    webUrl: row.webUrl,
    credentialSource: row.credentialSource,
    managedNativeAppKey: row.managedNativeAppKey,
  });
}

/** Where a scholar-built app came from, in one line under its name. */
export function scholarAppSource(app: ScholarBuiltApp): string {
  if (app.fromStarter) {
    const whose = app.fromStarter.teacherName
      ? `${app.fromStarter.teacherName}’s`
      : "a teacher’s";
    return `From ${whose} “${app.fromStarter.starterName}” starter${
      app.activityTitle ? ` · ${app.activityTitle}` : ""
    }`;
  }
  if (app.activityTitle) {
    return app.ownQuest ? `${app.activityTitle} · own Quest` : app.activityTitle;
  }
  return "Free build";
}

/** The "view as scholar" link for a scholar-built app. */
export function scholarAppHref(app: ScholarBuiltApp): string {
  return `/scholar/${app.sessionId}?remote=${app.builder.id}`;
}

// ── The shared grid ────────────────────────────────────────────────────────

const TILE = "42px";
const PREVIEW_SLOT = "28px";
const PRIMARY_SLOT = "116px";
const SECONDARY_SLOT = "96px";
const CHEVRON_SLOT = "28px";

function RowShell({
  tile,
  name,
  reach,
  actions,
  onClick,
  muted = false,
}: {
  tile: ReactNode;
  name: ReactNode;
  reach: ReactNode;
  actions: ReactNode;
  onClick?: () => void;
  muted?: boolean;
}) {
  return (
    <Box
      display="grid"
      gridTemplateColumns={{
        base: `${TILE} minmax(0, 1fr)`,
        md: `${TILE} minmax(0, 1fr) minmax(0, 1.15fr) auto`,
      }}
      columnGap={3}
      rowGap={2}
      alignItems="center"
      px={4}
      py={3.5}
      borderBottomWidth="1px"
      borderColor="gray.100"
      _last={{ borderBottomWidth: 0 }}
      cursor={onClick ? "pointer" : "default"}
      transition="background 0.12s"
      _hover={onClick ? { bg: "violet.50" } : undefined}
      onClick={onClick}
    >
      <Box
        filter={muted ? "grayscale(0.85)" : undefined}
        opacity={muted ? 0.6 : 1}
      >
        {tile}
      </Box>
      <Box minW={0}>{name}</Box>
      <Box minW={0} gridColumn={{ base: "2 / -1", md: "auto" }}>
        {reach}
      </Box>
      {/* On a narrow screen the actions take the whole row width, so the
          fixed slots fit a phone; they stay the same slots, so they still
          line up row to row. */}
      <Box gridColumn={{ base: "1 / -1", md: "auto" }} justifySelf="start">
        {actions}
      </Box>
    </Box>
  );
}

function RowActions({
  preview,
  primary,
  secondary,
  chevron,
}: {
  preview?: ReactNode;
  primary?: ReactNode;
  secondary?: ReactNode;
  chevron?: ReactNode;
}) {
  return (
    <HStack gap={1}>
      <Box w={PREVIEW_SLOT} flexShrink={0}>
        {preview}
      </Box>
      <Box w={PRIMARY_SLOT} flexShrink={0}>
        {primary}
      </Box>
      <Box w={SECONDARY_SLOT} flexShrink={0}>
        {secondary}
      </Box>
      <Box w={CHEVRON_SLOT} flexShrink={0}>
        {chevron}
      </Box>
    </HStack>
  );
}

const iconButtonStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "md",
  w: "28px",
  h: "28px",
  color: "charcoal.300",
  cursor: "pointer",
  _hover: { color: "violet.500", bg: "violet.50" },
  _focusVisible: {
    outline: "2px solid",
    outlineColor: "violet.400",
    outlineOffset: "2px",
  },
} as const;

function RowName({
  title,
  tag,
  subline,
  sublineTitle,
  muted = false,
}: {
  title: string;
  tag?: ReactNode;
  subline: string;
  sublineTitle?: string;
  muted?: boolean;
}) {
  return (
    <>
      {/* Tags wrap under a long name rather than squeezing it to a stub. */}
      <HStack gap={2} rowGap={1} minW={0} flexWrap="wrap">
        <Text
          fontSize="sm"
          fontFamily="heading"
          fontWeight="700"
          color={muted ? "charcoal.400" : "charcoal.500"}
          lineClamp={1}
          flexShrink={0}
          maxW="full"
        >
          {title}
        </Text>
        {tag}
      </HStack>
      <Text
        fontSize="2xs"
        color="charcoal.400"
        fontFamily="body"
        lineClamp={1}
        title={sublineTitle}
      >
        {subline}
      </Text>
    </>
  );
}

function Tag({
  tone,
  children,
}: {
  tone: "green" | "violet" | "gray";
  children: ReactNode;
}) {
  return (
    <Box
      as="span"
      flexShrink={0}
      fontSize="2xs"
      fontWeight="700"
      color={`${tone}.700`}
      bg={`${tone}.50`}
      borderRadius="4px"
      px={1.5}
      py={0.5}
    >
      {children}
    </Box>
  );
}

function SlotButton({
  children,
  onClick,
  disabled,
  ariaLabel,
  tone = "violet",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  tone?: "violet" | "gray";
}) {
  return (
    <Button
      size="xs"
      w="full"
      variant="outline"
      colorPalette={tone}
      fontFamily="heading"
      disabled={disabled}
      aria-label={ariaLabel}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Button>
  );
}

/** The tags after a row's name: each names a fact about the app, nothing
 *  decorative. "Learning contract" marks an app a coached activity steers with
 *  a buildContract (the filter's signal, shown where it applies). */
function NameTags({
  isDefault = false,
  scholar = false,
  learningContract,
}: {
  isDefault?: boolean;
  scholar?: boolean;
  learningContract: boolean;
}) {
  if (!isDefault && !scholar && !learningContract) return null;
  return (
    <HStack gap={1} flexShrink={0}>
      {isDefault && <Tag tone="green">Default</Tag>}
      {scholar && <Tag tone="violet">Scholar</Tag>}
      {learningContract && <Tag tone="gray">Learning contract</Tag>}
    </HStack>
  );
}

/** "Edited 3d ago" for a custom app; null for an app with no recorded edit. */
export function editedLabel(lastEditedAt: number | null): string | null {
  return lastEditedAt === null ? null : `Edited ${formatTimeAgo(lastEditedAt)}`;
}

// ── Catalog rows ───────────────────────────────────────────────────────────

export function CatalogRow({
  row,
  now,
  busy,
  onOpen,
  onTile,
  onFocus,
  onArchive,
  onUnassign,
}: {
  row: AppRow;
  now: number;
  busy: boolean;
  onOpen: () => void;
  onTile: () => void;
  onFocus: () => void;
  onArchive: () => void;
  onUnassign: (aud: AppRow["audiences"][number]) => void;
}) {
  const hasAssignments = row.audiences.length > 0 || row.directScholarCount > 0;
  return (
    <RowShell
      onClick={onOpen}
      tile={
        <chakra.button
          type="button"
          aria-label={`Change the ${row.name} tile`}
          title="Change the tile"
          display="block"
          borderRadius="12px"
          cursor="pointer"
          _focusVisible={{
            outline: "2px solid",
            outlineColor: "violet.400",
            outlineOffset: "2px",
          }}
          onClick={(e) => {
            e.stopPropagation();
            onTile();
          }}
        >
          <AppTileIcon
            name={row.name}
            iconUrl={row.iconUrl}
            iconEmoji={row.iconEmoji}
            color={row.color}
            boxSize={TILE}
            radius="12px"
            markFontSize="18px"
            imagePadding="6px"
            // The button it sits in is labeled "Change the <app> tile", and
            // the row names the app beside it.
            decorative
          />
        </chakra.button>
      }
      name={
        <RowName
          title={row.name}
          tag={
            <NameTags
              isDefault={row.defaultForNewScholars}
              learningContract={row.hasLearningContract}
            />
          }
          subline={[editedLabel(row.lastEditedAt), launchSummary(row)]
            .filter(Boolean)
            .join(" · ")}
          sublineTitle={
            row.managedNativeAppKey
              ? `The iPad unlocks the installed app temporarily, one app at a time, only while a scholar has access here. In a browser the tile opens ${domainOf(row.webUrl)} instead.`
              : undefined
          }
        />
      }
      reach={
        <Stack gap={1.5} align="flex-start">
          {hasAssignments ? (
            <HStack gap={2} flexWrap="wrap" align="center">
              {row.audiences.map((aud) => (
                <AudienceChip
                  key={aud.grantId}
                  aud={aud}
                  busy={busy}
                  onRemove={() => onUnassign(aud)}
                />
              ))}
              {row.directScholarCount > 0 && (
                <HStack gap={1.5} align="center">
                  <ScholarFacepile
                    scholars={row.directFacepile}
                    total={row.directScholarCount}
                    size="xs"
                    max={3}
                    showOverflow={false}
                  />
                  <Text
                    fontSize="2xs"
                    color="charcoal.400"
                    fontFamily="heading"
                    fontWeight="600"
                  >
                    Enabled for{" "}
                    {row.directScholarCount === 1 && row.directFacepile[0]?.name
                      ? row.directFacepile[0].name
                      : `${row.directScholarCount} scholar${row.directScholarCount === 1 ? "" : "s"}`}
                  </Text>
                </HStack>
              )}
            </HStack>
          ) : !row.timed ? (
            <HStack gap={1.5} align="center">
              <Flex
                w="24px"
                h="24px"
                borderRadius="full"
                bg="gray.100"
                color="charcoal.400"
                align="center"
                justify="center"
                flexShrink={0}
              >
                <Plus size={14} strokeWidth={2.5} />
              </Flex>
              <Text
                fontSize="2xs"
                color="charcoal.400"
                fontFamily="heading"
                fontWeight="600"
              >
                Enable for&hellip;
              </Text>
            </HStack>
          ) : null}
          {row.timed && (
            <TimedAccessChip window={row.timed} now={now} onClick={onOpen} />
          )}
        </Stack>
      }
      actions={
        <RowActions
          preview={
            <AppPreviewButton
              app={{
                name: row.name,
                webUrl: row.webUrl,
                nativeUrlScheme: row.nativeUrlScheme,
              }}
            />
          }
          primary={
            <SlotButton onClick={onFocus}>
              <Timer style={{ marginRight: 4 }} size={14} />
              Make focus
            </SlotButton>
          }
          secondary={
            <SlotButton
              tone="gray"
              disabled={busy}
              ariaLabel={`Archive ${row.name}`}
              onClick={onArchive}
            >
              Archive
            </SlotButton>
          }
          chevron={
            <chakra.button
              {...iconButtonStyle}
              type="button"
              aria-label={`Enable ${row.name} for scholars, groups, or school-wide`}
              onClick={(e) => {
                e.stopPropagation();
                onOpen();
              }}
            >
              <CaretRight size={18} weight="bold" />
            </chakra.button>
          }
        />
      }
    />
  );
}

/** An archived catalog app: its tile, name, and Restore. It reaches no scholar
 *  while archived, so the reach column is empty. */
export function ArchivedCatalogRow({
  row,
  busy,
  onRestore,
}: {
  row: AppRow;
  busy: boolean;
  onRestore: () => void;
}) {
  return (
    <RowShell
      muted
      tile={
        <AppTileIcon
          name={row.name}
          iconUrl={row.iconUrl}
          iconEmoji={row.iconEmoji}
          color={row.color}
          boxSize={TILE}
          radius="12px"
          markFontSize="18px"
          imagePadding="6px"
          decorative
        />
      }
      name={<RowName title={row.name} subline={launchSummary(row)} muted />}
      reach={null}
      actions={
        <RowActions
          secondary={
            <SlotButton disabled={busy} onClick={onRestore}>
              Restore
            </SlotButton>
          }
        />
      }
    />
  );
}

// ── Scholar-built rows ─────────────────────────────────────────────────────

export function ScholarAppRow({
  app,
  busy,
  onNavigate,
  onArchive,
  onRestore,
}: {
  app: ScholarBuiltApp;
  busy: boolean;
  onNavigate: (href: string) => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const archived = app.archivedAt !== null;
  const href = scholarAppHref(app);
  return (
    <RowShell
      muted={archived}
      onClick={archived ? undefined : () => onNavigate(href)}
      tile={
        <AppTileIcon
          name={app.title}
          boxSize={TILE}
          radius="12px"
          markFontSize="18px"
          imagePadding="6px"
          decorative
        />
      }
      name={
        <RowName
          title={app.title}
          tag={<NameTags scholar learningContract={app.hasLearningContract} />}
          subline={scholarAppSource(app)}
          muted={archived}
        />
      }
      reach={
        <HStack gap={1.5} align="center" minW={0}>
          <Avatar
            name={app.builder.name}
            src={app.builder.image ?? undefined}
            size="xs"
          />
          <Text
            fontSize="2xs"
            color="charcoal.400"
            fontFamily="heading"
            fontWeight="600"
            lineClamp={1}
          >
            Built by {app.builder.name} ·{" "}
            {archived
              ? `archived ${new Date(app.archivedAt ?? 0).toLocaleDateString(
                  "en-US",
                  { month: "short", day: "numeric" },
                )}`
              : `edited ${formatTimeAgo(app.lastEditedAt)}`}
          </Text>
        </HStack>
      }
      actions={
        archived ? (
          <RowActions
            secondary={
              <SlotButton disabled={busy} onClick={onRestore}>
                {TEACHER_ARCHIVE_COPY.restoreAction}
              </SlotButton>
            }
          />
        ) : (
          <RowActions
            primary={
              <Button
                asChild
                size="xs"
                w="full"
                variant="outline"
                colorPalette="violet"
                fontFamily="heading"
                onClick={(e) => e.stopPropagation()}
              >
                <NextLink href={href}>Open</NextLink>
              </Button>
            }
            secondary={
              <SlotButton
                tone="gray"
                ariaLabel={`Archive ${app.title}`}
                onClick={onArchive}
              >
                Archive
              </SlotButton>
            }
            chevron={
              <chakra.a
                {...iconButtonStyle}
                asChild
                aria-label={`Open ${app.title} as ${app.builder.name} sees it`}
                onClick={(e) => e.stopPropagation()}
              >
                <NextLink href={href}>
                  <CaretRight size={18} weight="bold" />
                </NextLink>
              </chakra.a>
            }
          />
        )
      }
    />
  );
}

// ── Pieces ─────────────────────────────────────────────────────────────────

/** Who a custom app reaches, in one line under its gallery card's name. */
export function ReachLine({ row }: { row: AppRow }) {
  const parts = row.audiences.map((aud) =>
    aud.audienceKind === "institution"
      ? "School-wide"
      : `${aud.emoji ? `${aud.emoji} ` : ""}${aud.label}`,
  );
  if (row.directScholarCount > 0) {
    parts.push(
      row.directScholarCount === 1 && row.directFacepile[0]?.name
        ? row.directFacepile[0].name
        : `${row.directScholarCount} scholars`,
    );
  }
  return (
    <HStack gap={1.5}>
      {row.directScholarCount > 0 && (
        <ScholarFacepile
          scholars={row.directFacepile}
          total={row.directScholarCount}
          size="2xs"
          max={3}
          showOverflow={false}
        />
      )}
      <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={1}>
        {parts.length > 0 ? parts.join(" · ") : "Not enabled for anyone yet"}
      </Text>
    </HStack>
  );
}

/** A removable audience chip: a group (emoji + name) or a School-wide grant.
 *  A paused grant (enabled:false) reads muted. Click the × to un-assign. */
function AudienceChip({
  aud,
  busy,
  onRemove,
}: {
  aud: AppRow["audiences"][number];
  busy: boolean;
  onRemove: () => void;
}) {
  const school = aud.audienceKind === "institution";
  const paused = !aud.enabled;
  const label = school ? "School-wide" : aud.label;
  return (
    <HStack
      gap={1}
      fontSize="3xs"
      fontWeight="700"
      fontFamily="body"
      color={paused ? "charcoal.400" : school ? "violet.700" : "green.700"}
      bg={paused ? "gray.100" : school ? "violet.50" : "green.50"}
      borderRadius="full"
      pl={2}
      pr={1}
      py={0.5}
    >
      <Text>
        {!school && aud.emoji ? `${aud.emoji} ` : ""}
        {label}
        {paused ? " · paused" : ""}
      </Text>
      <chakra.button
        display="flex"
        alignItems="center"
        justifyContent="center"
        borderRadius="full"
        w="14px"
        h="14px"
        color="currentColor"
        opacity={busy ? 0.4 : 0.7}
        cursor={busy ? "not-allowed" : "pointer"}
        _hover={{ opacity: busy ? 0.4 : 1, bg: busy ? undefined : "blackAlpha.100" }}
        type="button"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          if (!busy) onRemove();
        }}
        aria-label={`Un-assign ${label}`}
      >
        <X size={9} weight="bold" />
      </chakra.button>
    </HStack>
  );
}

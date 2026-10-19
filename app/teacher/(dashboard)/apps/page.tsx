"use client";

/**
 * The Apps tab (plan §6.2) — the app-centric home for External Apps, and now
 * the primary entry point for granting them (the scholar profile is demoted to
 * a read-only provenance view, §6.4). Reachable by any staff role that can
 * grant — teacher / admin / operations staff (plan §10) — so it lives on the teacher
 * dashboard, not inside /admin.
 *
 * Each app row shows its live audiences as removable chips (click the × to
 * un-assign the whole grant — the tile then disappears for everyone it covered)
 * plus a facepile of scholars who have it as a one-off direct add. Clicking the
 * row opens the Enable dialog (§6.1); "New app" adds a catalog row from a name
 * + URL.
 *
 * Apps scholars built sit in the same list (review/teacher-apps-scholar-rows-
 * options.html, Option 2): "All" means all, so they appear beside catalog apps
 * with a Scholar tag, and By scholars shows only them. Teachers see them;
 * operations staff hold no scholar records and don't.
 *
 * The launcher union is resolved at read time (convex/scholarApps.ts), so a
 * grant here is followed as membership churns — never fanned out per scholar.
 */

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import NextLink from "next/link";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Input,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Plus, AppWindow, Timer } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ScholarBuiltApp } from "@/convex/scholarBuiltApps";
import { Surface } from "@/components/ui/Surface";
import {
  AppAccessDrawer,
  type AppAccessTarget,
} from "@/components/AppAccessDrawer";
import { ScholarPicker } from "@/components/ScholarPicker";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { MakeFocusDialog } from "@/components/MakeFocusDialog";
import { LiveFocusBar } from "@/components/LiveFocusBar";
import {
  AppTileEditorDialog,
  AppTileFields,
  type AppTileDraft,
} from "@/components/AppTileEditor";
import { toaster } from "@/lib/toaster";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isTeacherRole } from "@/convex/lib/roles";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { ContextTabs } from "@/components/ui/ContextTabs";
import type { ExternalAppKind } from "@/shared/appKind";
import { ScholarScopePicker } from "@/components/ScholarScopePicker";
import { EmptyState } from "@/components/ui/EmptyState";
import { useArchiveAppConfirm } from "@/components/TeacherArchivedApp";
import { useAppsScope } from "@/components/teacherApps/useAppsScope";
import { TimedAccessChip } from "@/components/teacherApps/TimedAccessChip";
import { AppGalleryCard } from "@/components/teacherApps/AppGalleryCard";
import {
  ArchivedCatalogRow,
  CatalogRow,
  ReachLine,
  ScholarAppRow,
  scholarAppHref,
  scholarAppSource,
  editedLabel,
  type AppRow,
} from "@/components/teacherApps/AppListRows";
import { Avatar } from "@/components/Avatar";
import {
  appListItems,
  sortCatalog,
  type AppSort,
  type ListItem as AppListItem,
} from "@/components/teacherApps/appListOrder";
import { useNow } from "@/hooks/useNow";
import { useSmoothedQuery } from "@/hooks/useSmoothedQuery";
import { TEACHER_ARCHIVE_COPY } from "@/shared/teacherArchive";

type RoomRow = {
  _id: Id<"rooms">;
  name: string;
  kind: "assignment" | "group" | "explicit";
  assignmentId: Id<"assignments"> | null;
  assignmentTitle: string | null;
  groupId: Id<"scholarGroups"> | null;
  groupName: string | null;
  memberIds: Id<"users">[];
  members: Array<{ _id: Id<"users">; name: string }>;
  updatedAt: number;
};

type KindFilter = "all" | ExternalAppKind | "scholar" | "archived";

const KIND_FILTERS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "web", label: "Web" },
  { value: "custom", label: "Custom" },
  { value: "native", label: "Native iPad" },
  { value: "scholar", label: "By scholars" },
  { value: "archived", label: "Archived" },
];

// One sentence-case line per empty filtered view (no CTA).
const KIND_EMPTY_LINE: Record<Exclude<KindFilter, "all">, string> = {
  web: "No web apps yet.",
  custom: "No custom apps yet.",
  native: "No native iPad apps yet.",
  scholar: "No scholar-built apps yet.",
  archived: "No archived apps.",
};

type ContractFilter = "all" | "with" | "without";

const SORT_OPTIONS: { value: AppSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "edited", label: "Last edited" },
];

const CONTRACT_OPTIONS: { value: ContractFilter; label: string }[] = [
  { value: "all", label: "Any learning contract" },
  { value: "with", label: "With learning contract" },
  { value: "without", label: "Without learning contract" },
];

function matchesContract(has: boolean, filter: ContractFilter): boolean {
  return filter === "all" || has === (filter === "with");
}

function isKindFilter(value: string | null): value is KindFilter {
  return KIND_FILTERS.some((f) => f.value === value);
}

// Scholar-built rows arrive a page at a time (scholarBuiltApps.listForScholars
// is paginated and index-bounded); catalog rows always come whole.
const SCHOLAR_PAGE = 30;

type ListItem = AppListItem<AppRow, ScholarBuiltApp>;

export default function TeacherAppsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useCurrentUser();
  const isTeacher = isTeacherRole(user?.role);
  // The scholar scope (review/teacher-apps-v2-sketch.html §4), kept in the URL.
  const scope = useAppsScope();
  // Minute-rounded clock for the timed-access windows (T11): the query re-runs
  // once a minute, and useSmoothedQuery keeps the list on screen meanwhile.
  const now = Math.floor(useNow(60_000) / 60_000) * 60_000;
  const apps = useSmoothedQuery(
    api.appAudiences.listAppsWithAudiences,
    scope.isLoading
      ? "skip"
      : {
          includeArchived: true,
          now,
          ...(scope.isWholePool
            ? {}
            : { scholarIds: scope.scholarIds as Id<"users">[] }),
        },
  ) as AppRow[] | undefined;
  const unassignAudience = useMutation(api.appAudiences.unassignAudience);
  const createCatalogApp = useMutation(api.externalApps.createCatalogApp);
  const setCatalogAppArchived = useMutation(
    api.externalApps.setCatalogAppArchived,
  );
  const restoreScholarApp = useMutation(api.sessions.restoreApp);
  // One archive dialog for the page: a row unmounts the moment its archive
  // lands, so a dialog inside the row would take the body lock down with it.
  const archiveScholarApp = useArchiveAppConfirm();

  const [enableApp, setEnableApp] = useState<AppAccessTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [focusApp, setFocusApp] = useState<{
    appId: Id<"externalApps">;
    name: string;
  } | null>(null);
  const [composeLink, setComposeLink] = useState(false);
  const [newTile, setNewTile] = useState<AppTileDraft>({ emoji: "", color: "" });
  const [tileApp, setTileApp] = useState<AppRow | null>(null);
  // Which apps to list. Local state, seeded from `?tab=` so the retired
  // /teacher/apps/scholar-built route can land on By scholars.
  const [chosenFilter, setKindFilter] = useState<KindFilter>(() => {
    const tab = searchParams.get("tab");
    return isKindFilter(tab) ? tab : "all";
  });
  // Order and the learning-contract narrowing. Catalog rows come whole and are
  // sorted and filtered here; scholar rows are paged by the server, so both
  // travel as arguments and a page still fills with matching apps.
  const [sort, setSort] = useState<AppSort>("name");
  const [contractFilter, setContractFilter] = useState<ContractFilter>("all");
  // By scholars is a teacher view: anyone else landing on ?tab=scholar sees All.
  const kindFilter: KindFilter =
    chosenFilter === "scholar" && !isTeacher ? "all" : chosenFilter;

  const wantsScholarApps =
    isTeacher &&
    (kindFilter === "all" || kindFilter === "scholar" || kindFilter === "archived");
  const scholarApps = usePaginatedQuery(
    api.scholarBuiltApps.listForScholars,
    wantsScholarApps && !scope.isLoading
      ? {
          scholarIds: scope.scholarIds as Id<"users">[],
          archived: kindFilter === "archived",
          // Oldest walks the same index ascending. There is no index on edit
          // time, so Name and Last edited keep the newest-first walk.
          ...(sort === "oldest" ? { order: "asc" as const } : {}),
          ...(contractFilter === "all"
            ? {}
            : { learningContract: contractFilter }),
        }
      : "skip",
    { initialNumItems: SCHOLAR_PAGE },
  );
  const scholarLoaded = wantsScholarApps ? scholarApps.results : [];
  const scholarPending =
    wantsScholarApps && scholarApps.status === "LoadingFirstPage";
  const scholarMore =
    wantsScholarApps &&
    (scholarApps.status === "CanLoadMore" || scholarApps.status === "LoadingMore");

  const guarded = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toaster.error({
        title: serverErrorMessage(err, "Something went wrong"),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleUnassign = (row: AppRow, aud: AppRow["audiences"][number]) => {
    // Narrowed to a few scholars, a group chip still removes the whole
    // group's grant: say who loses the tile before doing it.
    if (scope.scopeLabel) {
      const who =
        aud.audienceKind === "institution"
          ? "every scholar at the school"
          : `everyone in ${aud.label}`;
      if (
        !window.confirm(
          `Remove ${row.name} from ${aud.audienceKind === "institution" ? "the school" : aud.label}? This removes it for ${who}, not just ${scope.scopeLabel}.`,
        )
      ) {
        return;
      }
    }
    return guarded(async () => {
      await unassignAudience({
        appId: row._id,
        audienceKind: aud.audienceKind,
        audienceId: aud.audienceId,
      });
      toaster.success({
        title: `${row.name} · removed ${aud.label}`,
        description: "The tile is gone for everyone that grant covered.",
      });
    });
  };

  const handleCreate = () =>
    guarded(async () => {
      const name = newName.trim();
      const webUrl = newUrl.trim();
      if (!name || !webUrl) throw new Error("Enter a name and a URL");
      // Teachers add web apps only. A managed iPad entry additionally needs the
      // app installed and licensed on the device fleet, so it is provisioned
      // server-side rather than typed in here.
      await createCatalogApp({
        name,
        webUrl,
        ...(newTile.emoji ? { iconEmoji: newTile.emoji } : {}),
        ...(newTile.color ? { color: newTile.color } : {}),
      });
      setNewName("");
      setNewUrl("");
      setNewTile({ emoji: "", color: "" });
      setShowNew(false);
    });

  // Archive, not delete: the app moves to the Archived filter, where Restore
  // brings it back with its grants intact.
  const handleArchive = (row: AppRow) => {
    const inUse = row.audiences.length > 0 || row.directScholarCount > 0;
    const warning = inUse
      ? `Archive ${row.name}? It's enabled for scholars, and the tile will disappear from their home launchers until you restore it.`
      : `Archive ${row.name}? You can restore it from Archived.`;
    if (!window.confirm(warning)) return;
    return guarded(async () => {
      await setCatalogAppArchived({ appId: row._id, archived: true });
      toaster.success({
        title: `${row.name} archived`,
        description: "Restore it from Archived.",
      });
    });
  };

  const handleRestore = (row: AppRow) =>
    guarded(async () => {
      await setCatalogAppArchived({ appId: row._id, archived: false });
      toaster.success({ title: `${row.name} restored` });
    });

  const handleRestoreScholarApp = (app: ScholarBuiltApp) =>
    guarded(async () => {
      await restoreScholarApp({ id: app.sessionId });
      toaster.success({ title: TEACHER_ARCHIVE_COPY.restoredToast });
    });

  const targetFor = (row: AppRow): AppAccessTarget => ({
    _id: row._id,
    name: row.name,
    webUrl: row.webUrl,
    nativeUrlScheme: row.nativeUrlScheme,
    credentialSource: row.credentialSource,
    managedNativeAppKey: row.managedNativeAppKey,
  });

  const renderRow = (item: ListItem) => {
    if (item.kind === "scholar") {
      const app = item.app;
      return (
        <ScholarAppRow
          key={app.sessionId}
          app={app}
          busy={busy}
          onNavigate={(href) => router.push(href)}
          onArchive={() => archiveScholarApp.open(app.title, app.sessionId)}
          onRestore={() => void handleRestoreScholarApp(app)}
        />
      );
    }
    const row = item.row;
    return row.archived ? (
      <ArchivedCatalogRow
        key={row._id}
        row={row}
        busy={busy}
        onRestore={() => void handleRestore(row)}
      />
    ) : (
      <CatalogRow
        key={row._id}
        row={row}
        now={now}
        busy={busy}
        onOpen={() => setEnableApp(targetFor(row))}
        onTile={() => setTileApp(row)}
        onFocus={() => setFocusApp({ appId: row._id, name: row.name })}
        onArchive={() => void handleArchive(row)}
        onUnassign={(aud) => void handleUnassign(row, aud)}
      />
    );
  };

  const showMore = scholarMore ? (
    <Flex justify="center" mt={3}>
      <Button
        size="sm"
        variant="outline"
        colorPalette="violet"
        fontFamily="heading"
        loading={scholarApps.status === "LoadingMore"}
        onClick={() => scholarApps.loadMore(SCHOLAR_PAGE)}
      >
        Show more scholar apps
      </Button>
    </Flex>
  ) : null;

  const emptyLine =
    contractFilter !== "all"
      ? contractFilter === "with"
        ? "No apps here have a learning contract."
        : "Every app here has a learning contract."
      : kindFilter === "all"
      ? scope.scopeLabel
        ? `No apps reach ${scope.scopeLabel} yet.`
        : "No apps yet. Add one with “New app.”"
      : kindFilter === "scholar" && scope.scopeLabel
        ? `No apps from ${scope.scopeLabel} yet.`
        : KIND_EMPTY_LINE[kindFilter];

  const body = (() => {
    if (apps === undefined || (kindFilter === "scholar" && scholarPending)) {
      return (
        <HStack justify="center" py={12}>
          <Spinner color="violet.500" />
        </HStack>
      );
    }
    if (kindFilter === "custom") {
      const custom = sortCatalog(
        apps.filter(
          (row) =>
            !row.archived &&
            row.appKind === "custom" &&
            matchesContract(row.hasLearningContract, contractFilter),
        ),
        sort,
      );
      if (custom.length === 0) {
        return (
          <Surface p={8}>
            <EmptyState title={emptyLine} />
          </Surface>
        );
      }
      return (
        <SimpleGrid templateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap={3.5}>
          {custom.map((row) => (
            <AppGalleryCard
              key={row._id}
              name={row.name}
              screenshotUrl={row.screenshotUrl}
              iconUrl={row.iconUrl}
              iconEmoji={row.iconEmoji}
              color={row.color}
              overlay={
                row.timed ? (
                  <TimedAccessChip
                    window={row.timed}
                    now={now}
                    withAudience={false}
                    onClick={() => setEnableApp(targetFor(row))}
                  />
                ) : undefined
              }
              actions={
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={() => setEnableApp(targetFor(row))}
                  >
                    Edit
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    colorPalette="gray"
                    fontFamily="heading"
                    disabled={busy}
                    onClick={() => void handleArchive(row)}
                  >
                    Archive
                  </Button>
                </>
              }
            >
              <ReachLine row={row} />
              <GalleryFacts
                edited={editedLabel(row.lastEditedAt)}
                learningContract={row.hasLearningContract}
              />
            </AppGalleryCard>
          ))}
        </SimpleGrid>
      );
    }
    if (kindFilter === "scholar") {
      if (scholarLoaded.length === 0 && !scholarMore) {
        return (
          <Surface p={8}>
            <EmptyState
              title={emptyLine}
              hint="Apps scholars build in Quests, app activities and free builds show up here."
            />
          </Surface>
        );
      }
      return (
        <>
          <SimpleGrid templateColumns="repeat(auto-fill, minmax(220px, 1fr))" gap={3.5}>
            {scholarLoaded.map((app) => (
              <AppGalleryCard
                key={app.sessionId}
                name={app.title}
                actions={
                  <>
                    <Button asChild size="xs" colorPalette="violet" fontFamily="heading">
                      <NextLink href={scholarAppHref(app)}>Open</NextLink>
                    </Button>
                    <Button
                      size="xs"
                      variant="outline"
                      colorPalette="gray"
                      fontFamily="heading"
                      onClick={() => archiveScholarApp.open(app.title, app.sessionId)}
                    >
                      {TEACHER_ARCHIVE_COPY.archiveAction}
                    </Button>
                  </>
                }
              >
                {!scope.focusScholar && (
                  <HStack gap={1.5}>
                    <Avatar
                      name={app.builder.name}
                      src={app.builder.image ?? undefined}
                      size="2xs"
                    />
                    <Text fontSize="xs" color="charcoal.500" fontFamily="heading" fontWeight="600">
                      {app.builder.name}
                    </Text>
                  </HStack>
                )}
                <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={2}>
                  {scholarAppSource(app)}
                </Text>
                <GalleryFacts
                  edited={editedLabel(app.lastEditedAt)}
                  learningContract={app.hasLearningContract}
                />
              </AppGalleryCard>
            ))}
          </SimpleGrid>
          {showMore}
        </>
      );
    }
    const catalog = apps.filter(
      (row) =>
        (kindFilter === "archived"
          ? row.archived
          : !row.archived && (kindFilter === "all" || row.appKind === kindFilter)) &&
        matchesContract(row.hasLearningContract, contractFilter),
    );
    // Catalog in the chosen sort, then scholar-built apps in server order
    // (appListOrder.ts), so "Show more" only appends at the bottom.
    const items: ListItem[] = appListItems(
      catalog,
      kindFilter === "all" || kindFilter === "archived" ? scholarLoaded : [],
      sort,
    );
    if (items.length === 0 && !scholarMore && !scholarPending) {
      return (
        <Surface p={8}>
          <EmptyState title={emptyLine} />
        </Surface>
      );
    }
    return (
      <>
        <Surface p={0} overflow="hidden">
          <VStack gap={0} align="stretch">
            {items.map(renderRow)}
            {scholarPending && (
              <HStack
                gap={2}
                px={4}
                py={3}
                color="charcoal.400"
                borderTopWidth={items.length > 0 ? "1px" : 0}
                borderColor="gray.100"
              >
                <Spinner size="xs" color="violet.500" />
                <Text fontSize="sm" fontFamily="body">
                  Loading apps scholars built&hellip;
                </Text>
              </HStack>
            )}
          </VStack>
        </Surface>
        {showMore}
      </>
    );
  })();

  return (
    <Box flex={1} h="full" overflowY="auto" bg="gray.50">
      <Box maxW="4xl" mx="auto" px={{ base: 4, md: 8 }} py={8}>
        <Flex justify="space-between" align="flex-start" mb={6} gap={4} wrap="wrap">
          <Stack gap={1}>
            <HStack gap={2}>
              <Box color="violet.500">
                <AppWindow weight="duotone" size={24} />
              </Box>
              <Heading
                size="lg"
                color="navy.500"
                fontFamily="heading"
                fontWeight="700"
              >
                Apps
              </Heading>
            </HStack>
            <Text fontSize="sm" color="charcoal.400" fontFamily="body">
              {isTeacher
                ? "Apps on scholars’ launchers and apps they built"
                : "Standing apps on scholars’ home launchers"}
            </Text>
          </Stack>
          <HStack gap={2} flexShrink={0}>
            {/* Ad-hoc push: a video or web page doesn't need a catalog entry
                to go in front of scholars for the next twenty minutes. */}
            <Button
              size="sm"
              variant="outline"
              colorPalette="violet"
              fontFamily="heading"
              onClick={() => setComposeLink(true)}
            >
              <Timer style={{ marginRight: 4 }} size={14} /> Push a link
            </Button>
            <Button
              size="sm"
              colorPalette="violet"
              fontFamily="heading"
              onClick={() => setShowNew((v) => !v)}
            >
              <Plus style={{ marginRight: 4 }} /> New app
            </Button>
          </HStack>
        </Flex>

        <LiveFocusBar />

        {/* New app inline form */}
        {showNew && (
          <Surface p={4} mb={4}>
            <Stack gap={2}>
              <Text
                fontSize="xs"
                color="charcoal.500"
                fontFamily="heading"
                fontWeight="600"
              >
                Add a web app
              </Text>
              <Input
                size="sm"
                placeholder="App name (e.g. TypingClub)"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                fontFamily="body"
                bg="white"
              />
              <Input
                size="sm"
                placeholder="https://…"
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                fontFamily="body"
                bg="white"
              />
              <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                This adds a web app, which opens in the browser on every device.
                Managed iPad apps are set up by the school&rsquo;s device admin,
                because the app has to be installed and licensed on the iPads
                first.
              </Text>
              <Box borderTopWidth="1px" borderColor="gray.100" pt={3}>
                <AppTileFields
                  name={newName}
                  draft={newTile}
                  onChange={setNewTile}
                />
              </Box>
              <HStack gap={2} justify="flex-end">
                <Button
                  size="xs"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => {
                    setShowNew(false);
                    setNewName("");
                    setNewUrl("");
                    setNewTile({ emoji: "", color: "" });
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="xs"
                  colorPalette="violet"
                  fontFamily="heading"
                  disabled={busy || !newName.trim() || !newUrl.trim()}
                  onClick={() => void handleCreate()}
                >
                  Create
                </Button>
              </HStack>
            </Stack>
          </Surface>
        )}

        <Flex gap={3} align="center" wrap="wrap" mb={3}>
          <ScholarScopePicker
            groups={scope.groups}
            scopeKey={scope.scopeKey}
            hasMine={scope.hasMine}
            onSelectScope={scope.selectScope}
            visibleScholarIds={scope.visibleScholarIds}
            scopedScholarIds={scope.scopedScholarIds}
            focusScholar={scope.focusScholar}
            onFocusScholar={scope.focus}
          />
          {scope.truncatedTo !== null && (
            <Text fontSize="sm" color="charcoal.400" fontFamily="body">
              Showing the first {scope.truncatedTo} scholars
            </Text>
          )}
        </Flex>
        <Flex mb={3} gap={2} align="center" wrap="wrap">
          {/* Six tabs outgrow a phone: the strip scrolls sideways there
              instead of clipping Archived. */}
          <Box maxW="full" overflowX="auto">
            <ContextTabs<KindFilter>
              ariaLabel="Filter apps by kind"
              value={kindFilter}
              onChange={setKindFilter}
              items={isTeacher ? KIND_FILTERS : KIND_FILTERS.filter((f) => f.value !== "scholar")}
            />
          </Box>
          <HStack gap={2} ml={{ md: "auto" }}>
            <FieldSelect
              value={contractFilter}
              onChange={(v) => setContractFilter(v as ContractFilter)}
              w="auto"
              fieldProps={{ "aria-label": "Learning contract", fontSize: "sm" }}
            >
              {CONTRACT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FieldSelect>
            <FieldSelect
              value={sort}
              onChange={(v) => setSort(v as AppSort)}
              w="auto"
              fieldProps={{ "aria-label": "Sort", fontSize: "sm" }}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </FieldSelect>
          </HStack>
        </Flex>

        {body}

        {isTeacher && <SharedRoomsPanel />}
      </Box>

      <AppAccessDrawer
        open={enableApp !== null}
        onClose={() => setEnableApp(null)}
        app={enableApp}
      />
      <MakeFocusDialog
        open={composeLink}
        onClose={() => setComposeLink(false)}
        composeLink
        target={null}
        targetTitle=""
      />
      <MakeFocusDialog
        open={focusApp !== null}
        onClose={() => setFocusApp(null)}
        target={
          focusApp
            ? { kind: "app", externalAppId: focusApp.appId }
            : null
        }
        targetTitle={focusApp?.name ?? ""}
      />

      <AppTileEditorDialog app={tileApp} onClose={() => setTileApp(null)} />
      {archiveScholarApp.dialog}
    </Box>
  );
}

/** A gallery card's edit time and learning-contract fact, on one quiet line;
 *  nothing when it has neither. */
function GalleryFacts({
  edited,
  learningContract,
}: {
  edited: string | null;
  learningContract: boolean;
}) {
  const parts = [edited, learningContract ? "Learning contract" : null].filter(
    Boolean,
  );
  if (parts.length === 0) return null;
  return (
    <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={1}>
      {parts.join(" · ")}
    </Text>
  );
}

function SharedRoomsPanel() {
  const { activeInstitution } = useActiveInstitution();
  const institutionScope =
    activeInstitution === undefined
      ? undefined
      : activeInstitution.scope === "all"
        ? "all"
        : activeInstitution.institutionSlug ?? "primary";
  const rooms = useQuery(api.rooms.listOwned, {}) as RoomRow[] | undefined;
  const assignments = useQuery(api.assignments.listForTeacher, {
    includeArchived: false,
  });
  const groups = useQuery(
    api.scholarGroups.list,
    institutionScope === undefined ? "skip" : { institutionScope },
  );
  const createRoom = useMutation(api.rooms.create);
  const setRoomMembers = useMutation(api.rooms.setMembers);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] =
    useState<"explicit" | "assignment" | "group">("explicit");
  const [assignmentId, setAssignmentId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<Id<"rooms"> | null>(null);
  const [editingMembers, setEditingMembers] = useState(false);
  const [memberDraft, setMemberDraft] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const selected =
    rooms?.find((room) => room._id === selectedId) ?? rooms?.[0] ?? null;
  const sharedState = useQuery(
    api.appStates.getRoomState,
    selected ? { roomId: selected._id } : "skip",
  );
  const presence = useQuery(
    api.appStates.getRoomPresence,
    selected ? { roomId: selected._id } : "skip",
  );

  const resetCreate = () => {
    setShowCreate(false);
    setName("");
    setScope("explicit");
    setAssignmentId("");
    setGroupId("");
    setMembers(new Set());
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      const roomId = await createRoom(
        scope === "assignment"
          ? {
              name,
              kind: "assignment",
              assignmentId: assignmentId as Id<"assignments">,
            }
          : scope === "group"
            ? {
                name,
                kind: "group",
                groupId: groupId as Id<"scholarGroups">,
              }
          : {
              name,
              kind: "explicit",
              memberIds: Array.from(members) as Id<"users">[],
            },
      );
      setSelectedId(roomId);
      resetCreate();
      toaster.success({ title: "Shared room created" });
    } catch (error) {
      toaster.error({
        title: serverErrorMessage(error, "Could not create room"),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSaveMembers = async () => {
    if (!selected) return;
    setBusy(true);
    try {
      await setRoomMembers({
        roomId: selected._id,
        memberIds: Array.from(memberDraft) as Id<"users">[],
      });
      setEditingMembers(false);
      toaster.success({ title: "Room members updated" });
    } catch (error) {
      toaster.error({
        title:
          serverErrorMessage(error, "Could not update members"),
      });
    } finally {
      setBusy(false);
    }
  };

  const canCreate =
    name.trim().length > 0 &&
    (scope === "assignment"
      ? assignmentId.length > 0
      : scope === "group"
        ? groupId.length > 0
        : members.size > 0);

  return (
    <Box as="section" mt={10}>
      <Flex
        direction={{ base: "column", md: "row" }}
        justify="space-between"
        align={{ base: "stretch", md: "flex-start" }}
        gap={3}
        mb={4}
      >
        <Stack gap={1}>
          <Heading
            size="md"
            color="navy.500"
            fontFamily="heading"
            fontWeight="700"
          >
            Shared rooms
          </Heading>
          <Text fontSize="sm" color="charcoal.400" fontFamily="body">
            Multiplayer state for teacher-created app rooms
          </Text>
        </Stack>
        <Button
          size="sm"
          colorPalette="violet"
          variant="outline"
          alignSelf={{ base: "flex-start", md: "auto" }}
          onClick={() => setShowCreate((value) => !value)}
        >
          <Plus style={{ marginRight: 4 }} />
          New room
        </Button>
      </Flex>

      {showCreate && (
        <Surface p={4} mb={4}>
          <Stack gap={4}>
            <Input
              aria-label="Room name"
              placeholder="Room name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              bg="white"
            />
            <HStack gap={2}>
              <Button
                size="xs"
                variant={scope === "explicit" ? "solid" : "outline"}
                colorPalette="violet"
                onClick={() => setScope("explicit")}
              >
                Pick members
              </Button>
              <Button
                size="xs"
                variant={scope === "assignment" ? "solid" : "outline"}
                colorPalette="violet"
                onClick={() => setScope("assignment")}
              >
                Assignment cohort
              </Button>
              <Button
                size="xs"
                variant={scope === "group" ? "solid" : "outline"}
                colorPalette="violet"
                onClick={() => setScope("group")}
              >
                Scholar group
              </Button>
            </HStack>
            {scope === "assignment" ? (
              <FieldSelect
                value={assignmentId}
                onChange={setAssignmentId}
                fieldProps={{ "aria-label": "Assignment cohort" }}
              >
                <option value="">Choose an assignment</option>
                {(assignments ?? []).map((assignment) => (
                  <option key={assignment._id} value={assignment._id}>
                    {assignment.title ?? assignment.unitTitle} ·{" "}
                    {assignment.scholarCount} scholars
                  </option>
                ))}
              </FieldSelect>
            ) : scope === "group" ? (
              <FieldSelect
                value={groupId}
                onChange={setGroupId}
                fieldProps={{ "aria-label": "Scholar group" }}
              >
                <option value="">Choose a group</option>
                {(groups ?? []).map((group) => (
                  <option key={group._id} value={group._id}>
                    {group.emoji ? `${group.emoji} ` : ""}
                    {group.name} · {group.scholarIds.length} scholars
                  </option>
                ))}
              </FieldSelect>
            ) : (
              <Box
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="lg"
                p={2}
              >
                <ScholarPicker
                  mode="multi"
                  selected={members}
                  onChange={setMembers}
                  maxH="260px"
                />
              </Box>
            )}
            <HStack justify="flex-end">
              <Button size="xs" variant="ghost" onClick={resetCreate}>
                Cancel
              </Button>
              <Button
                size="xs"
                colorPalette="violet"
                disabled={busy || !canCreate}
                onClick={() => void handleCreate()}
              >
                Create room
              </Button>
            </HStack>
          </Stack>
        </Surface>
      )}

      {rooms === undefined ? (
        <HStack justify="center" py={10}>
          <Spinner color="violet.500" />
        </HStack>
      ) : rooms.length === 0 ? (
        <Surface p={6}>
          <Text
            fontSize="sm"
            color="charcoal.400"
            fontFamily="body"
            textAlign="center"
          >
            No shared rooms yet.
          </Text>
        </Surface>
      ) : (
        <Flex direction={{ base: "column", md: "row" }} gap={4} align="stretch">
          <Surface p={0} overflow="hidden" flex={{ md: "0 0 260px" }}>
            {rooms.map((room) => {
              const active = selected?._id === room._id;
              return (
                <Box
                  as="button"
                  key={room._id}
                  display="block"
                  w="full"
                  textAlign="left"
                  px={4}
                  py={3}
                  bg={active ? "violet.50" : "white"}
                  borderBottomWidth="1px"
                  borderColor="gray.100"
                  _last={{ borderBottomWidth: 0 }}
                  _hover={{ bg: "violet.50" }}
                  onClick={() => {
                    setSelectedId(room._id);
                    setEditingMembers(false);
                  }}
                >
                  <Text
                    fontSize="sm"
                    fontFamily="heading"
                    fontWeight="700"
                    color="charcoal.500"
                  >
                    {room.name}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400">
                    {room.assignmentTitle ??
                      room.groupName ??
                      `${room.memberIds.length} members`}
                  </Text>
                </Box>
              );
            })}
          </Surface>

          {selected && (
            <Surface p={5} flex={1} minW={0}>
              <Stack gap={4}>
                <Flex justify="space-between" gap={3} align="flex-start">
                  <Stack gap={0.5} minW={0}>
                    <Heading size="sm" color="navy.500" fontFamily="heading">
                      {selected.name}
                    </Heading>
                    <Text
                      fontSize="2xs"
                      color="charcoal.400"
                      fontFamily="monospace"
                      wordBreak="break-all"
                    >
                      {selected._id}
                    </Text>
                  </Stack>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      setMemberDraft(new Set(selected.memberIds));
                      setEditingMembers((value) => !value);
                    }}
                  >
                    Members
                  </Button>
                </Flex>

                {editingMembers ? (
                  <Stack gap={3}>
                    <Box
                      borderWidth="1px"
                      borderColor="gray.200"
                      borderRadius="lg"
                      p={2}
                    >
                      <ScholarPicker
                        mode="multi"
                        selected={memberDraft}
                        onChange={setMemberDraft}
                        maxH="240px"
                      />
                    </Box>
                    <HStack justify="flex-end">
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => setEditingMembers(false)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        colorPalette="violet"
                        disabled={busy || memberDraft.size === 0}
                        onClick={() => void handleSaveMembers()}
                      >
                        Save members
                      </Button>
                    </HStack>
                  </Stack>
                ) : (
                  <Text fontSize="sm" color="charcoal.500">
                    {selected.members.map((member) => member.name).join(", ")}
                  </Text>
                )}

                <Box>
                  <Text
                    fontSize="xs"
                    fontFamily="heading"
                    fontWeight="700"
                    color="charcoal.500"
                    mb={1}
                  >
                    Present now
                  </Text>
                  <Text fontSize="sm" color="charcoal.400">
                    {presence === undefined
                      ? "Loading…"
                      : presence.length > 0
                        ? presence.map((entry) => entry.name).join(", ")
                        : "Nobody is connected."}
                  </Text>
                </Box>

                <Box>
                  <Text
                    fontSize="xs"
                    fontFamily="heading"
                    fontWeight="700"
                    color="charcoal.500"
                    mb={2}
                  >
                    Shared state · read only
                  </Text>
                  <Box
                    as="pre"
                    bg="gray.900"
                    color="green.200"
                    borderRadius="md"
                    p={3}
                    maxH="260px"
                    overflow="auto"
                    fontFamily="monospace"
                    fontSize="xs"
                    whiteSpace="pre-wrap"
                    wordBreak="break-word"
                  >
                    {sharedState === undefined
                      ? "Loading…"
                      : JSON.stringify(sharedState?.doc ?? {}, null, 2)}
                  </Box>
                </Box>
              </Stack>
            </Surface>
          )}
        </Flex>
      )}
    </Box>
  );
}

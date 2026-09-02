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
 * The launcher union is resolved at read time (convex/scholarApps.ts), so a
 * grant here is followed as membership churns — never fanned out per scholar.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  Heading,
  HStack,
  Input,
  Spinner,
  Stack,
  Text,
  VStack,
  chakra,
} from "@chakra-ui/react";
import { Plus, X, AppWindow, CaretRight, Trash, Timer } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import {
  AppAccessDrawer,
  appLaunchSummary,
  domainOf,
  type AppAccessTarget,
} from "@/components/AppAccessDrawer";
import { ScholarPicker } from "@/components/ScholarPicker";
import {
  ScholarFacepile,
  type FacepileScholar,
} from "@/components/ScholarFacepile";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { MakeFocusDialog } from "@/components/MakeFocusDialog";
import { LiveFocusBar } from "@/components/LiveFocusBar";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
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

type AppRow = {
  _id: Id<"externalApps">;
  name: string;
  webUrl: string;
  iconUrl: string | null;
  iconEmoji: string | null;
  color: string | null;
  credentialSource: "scholarApp" | "libraryCard" | null;
  defaultForNewScholars: boolean;
  managedNativeAppKey: "google-sheets" | "lego-spike" | null;
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

function launchSummary(row: AppRow): string {
  return appLaunchSummary({
    _id: row._id,
    name: row.name,
    webUrl: row.webUrl,
    credentialSource: row.credentialSource,
    managedNativeAppKey: row.managedNativeAppKey,
  });
}

export default function TeacherAppsPage() {
  const { user } = useCurrentUser();
  const apps = useQuery(api.appAudiences.listAppsWithAudiences, {}) as
    | AppRow[]
    | undefined;
  const unassignAudience = useMutation(api.appAudiences.unassignAudience);
  const createCatalogApp = useMutation(api.externalApps.createCatalogApp);
  const setCatalogAppArchived = useMutation(
    api.externalApps.setCatalogAppArchived,
  );

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

  const handleUnassign = (row: AppRow, aud: AppRow["audiences"][number]) =>
    guarded(async () => {
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

  const handleDelete = (row: AppRow) => {
    const inUse = row.audiences.length > 0 || row.directScholarCount > 0;
    const warning = inUse
      ? `Delete ${row.name}? It's enabled for scholars — the tile will disappear from their home launchers.`
      : `Delete ${row.name}? It will be removed from the catalog.`;
    if (!window.confirm(warning)) return;
    return guarded(async () => {
      await setCatalogAppArchived({ appId: row._id, archived: true });
      toaster.success({
        title: `${row.name} deleted`,
        description: "Removed from the catalog.",
      });
    });
  };

  return (
    <Box flex={1} h="full" overflowY="auto" bg="gray.50">
      <Box maxW="4xl" mx="auto" px={{ base: 4, md: 8 }} py={8}>
        <Flex justify="space-between" align="flex-start" mb={6} gap={4}>
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
              Standing apps on scholars&rsquo; home launchers
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

        {apps === undefined ? (
          <HStack justify="center" py={12}>
            <Spinner color="violet.500" />
          </HStack>
        ) : apps.length === 0 ? (
          <Surface p={8}>
            <Text
              fontSize="sm"
              color="charcoal.400"
              fontFamily="body"
              textAlign="center"
            >
              No apps yet. Add one with “New app.”
            </Text>
          </Surface>
        ) : (
          <Surface p={0} overflow="hidden">
            <VStack gap={0} align="stretch">
              {apps.map((row) => {
                const target: AppAccessTarget = {
                  _id: row._id,
                  name: row.name,
                  webUrl: row.webUrl,
                  credentialSource: row.credentialSource,
                  managedNativeAppKey: row.managedNativeAppKey,
                };
                const hasAssignments =
                  row.audiences.length > 0 || row.directScholarCount > 0;
                return (
                  <Box
                    key={row._id}
                    px={4}
                    py={3.5}
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    _last={{ borderBottomWidth: 0 }}
                    cursor="pointer"
                    transition="background 0.12s"
                    _hover={{ bg: "violet.50" }}
                    // A POINTER shortcut, deliberately not a control: the row
                    // contains real buttons (change the tile, delete, open
                    // access), and a control nested inside a control makes
                    // every child activation ambiguous for the keyboard — Space
                    // scrolls or is swallowed, Enter fires both. Each action is
                    // its own <button> instead; the caret at the end of the row
                    // is the focusable twin of this click.
                    onClick={() => setEnableApp(target)}
                  >
                    <Flex gap={3} align="center" wrap="wrap">
                      <chakra.button
                        type="button"
                        aria-label={`Change the ${row.name} tile`}
                        title="Change the tile"
                        flexShrink={0}
                        borderRadius="12px"
                        cursor="pointer"
                        _focusVisible={{
                          outline: "2px solid",
                          outlineColor: "violet.400",
                          outlineOffset: "2px",
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setTileApp(row);
                        }}
                      >
                        <AppTileIcon
                          name={row.name}
                          iconUrl={row.iconUrl}
                          iconEmoji={row.iconEmoji}
                          color={row.color}
                          boxSize="42px"
                          radius="12px"
                          markFontSize="18px"
                          imagePadding="6px"
                          // The button it sits in is labeled "Change the <app>
                          // tile", and the row names the app beside it.
                          decorative
                        />
                      </chakra.button>

                      {/* Name + how it opens */}
                      <Box flex="1 1 180px" minW="170px">
                        <HStack gap={2}>
                          <Text
                            fontSize="sm"
                            fontFamily="heading"
                            fontWeight="700"
                            color="charcoal.500"
                          >
                            {row.name}
                          </Text>
                          {row.defaultForNewScholars && (
                            <Box
                              as="span"
                              fontSize="2xs"
                              fontWeight="700"
                              color="green.700"
                              bg="green.50"
                              borderRadius="4px"
                              px={1.5}
                              py={0.5}
                            >
                              Default
                            </Box>
                          )}
                        </HStack>
                        <Text
                          fontSize="2xs"
                          color="charcoal.400"
                          fontFamily="body"
                          title={
                            row.managedNativeAppKey
                              ? `The iPad unlocks the installed app temporarily, one app at a time, only while a scholar has access here. In a browser the tile opens ${domainOf(row.webUrl)} instead.`
                              : undefined
                          }
                        >
                          {launchSummary(row)}
                        </Text>
                      </Box>

                      {/* Who it's enabled for */}
                      <Box flex="1 1 200px" minW="180px">
                        {hasAssignments ? (
                          <HStack gap={2} flexWrap="wrap" align="center">
                            {row.audiences.map((aud) => (
                              <AudienceChip
                                key={aud.grantId}
                                aud={aud}
                                busy={busy}
                                onRemove={() => void handleUnassign(row, aud)}
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
                                  Enabled for {row.directScholarCount} scholar
                                  {row.directScholarCount === 1 ? "" : "s"}
                                </Text>
                              </HStack>
                            )}
                          </HStack>
                        ) : (
                          // Mirrors the facepile above it: same 24px circle and
                          // same label type, so an empty app reads as a row in
                          // the same column rather than absent sub-text.
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
                        )}
                      </Box>

                      {/* Make focus + delete + the row's own access control.
                          "Make focus" is the headline ad-hoc-push action —
                          kept as its own labeled button, not folded into an
                          overflow menu, so it's visible at a glance. */}
                      <HStack gap={1} flexShrink={0}>
                        <Button
                          size="xs"
                          variant="outline"
                          colorPalette="violet"
                          fontFamily="heading"
                          onClick={(e) => {
                            e.stopPropagation();
                            setFocusApp({ appId: row._id, name: row.name });
                          }}
                        >
                          <Timer style={{ marginRight: 4 }} size={14} />
                          Make focus
                        </Button>
                        <chakra.button
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          borderRadius="md"
                          w="28px"
                          h="28px"
                          color="charcoal.300"
                          opacity={busy ? 0.4 : 1}
                          cursor={busy ? "not-allowed" : "pointer"}
                          _hover={{
                            color: busy ? "charcoal.300" : "red.500",
                            bg: busy ? undefined : "red.50",
                          }}
                          _focusVisible={{
                            outline: "2px solid",
                            outlineColor: "violet.400",
                            outlineOffset: "2px",
                          }}
                          type="button"
                          disabled={busy}
                          aria-label={`Delete ${row.name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!busy) void handleDelete(row);
                          }}
                        >
                          <Trash size={16} weight="bold" />
                        </chakra.button>
                        {/* The keyboard-reachable form of "click the row" */}
                        <chakra.button
                          display="flex"
                          alignItems="center"
                          justifyContent="center"
                          borderRadius="md"
                          w="28px"
                          h="28px"
                          color="charcoal.300"
                          cursor="pointer"
                          _hover={{ color: "violet.500", bg: "violet.50" }}
                          _focusVisible={{
                            outline: "2px solid",
                            outlineColor: "violet.400",
                            outlineOffset: "2px",
                          }}
                          type="button"
                          aria-label={`Enable ${row.name} for scholars, groups, or school-wide`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEnableApp(target);
                          }}
                        >
                          <CaretRight size={18} weight="bold" />
                        </chakra.button>
                      </HStack>
                    </Flex>
                  </Box>
                );
              })}
            </VStack>
          </Surface>
        )}

        {isTeacherRole(user?.role) && <SharedRoomsPanel />}
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
    </Box>
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

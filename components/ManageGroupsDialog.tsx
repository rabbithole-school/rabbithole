"use client";

// Teacher surface to create / edit / delete scholar groups (geckos,
// honu, …). Two-pane: group list on the left, editor on the right.
// Membership editing dogfoods the shared <ScholarPicker /> (multi).

import { useState, useEffect, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  Heading,
  IconButton,
  Input,
  Portal,
  RadioGroup,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Plus, Trash, Heart } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { EmojiPickerButton } from "@/components/ui/EmojiPickerButton";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { ContextTabs } from "@/components/ui/ContextTabs";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
import { ScholarPicker } from "@/components/ScholarPicker";
import {
  AppAccessDrawer,
  type AppAccessTarget,
} from "@/components/AppAccessDrawer";
import { useScholarRoster, type RosterGroup } from "@/hooks/useScholarRoster";
import {
  EXTENDED_EDUCATION_LABEL,
  PRIMARY_GROUP_TYPE,
} from "@/shared/scholarGroupRouting";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

type GroupParticipation = "enrolled_only" | "includes_program_guests";
type EditorTab = "settings" | "members" | "apps";

type Draft = {
  groupId: Id<"scholarGroups"> | null; // null = creating new
  name: string;
  emoji: string;
  /** Routing tag — "" = the main age-based group, else a subject key. */
  type: string;
  participation: GroupParticipation;
  /** Staff member who runs the group — "" = unowned. */
  ownerId: string;
  members: Set<string>;
};

const EMPTY_DRAFT: Draft = {
  groupId: null,
  name: "",
  emoji: "",
  type: "",
  participation: "enrolled_only",
  ownerId: "",
  members: new Set(),
};

// The subject keys a surface actually routes on today. Anything else in the
// data (a hand-set `type`) still routes correctly — this list only bounds what
// the picker can WRITE, so a typo can't silently orphan a group's routing.
const GROUP_TYPES: { value: string; label: string }[] = [
  { value: "", label: "Main group" },
  { value: "math", label: "Math" },
  { value: "robotics", label: "Robotics" },
];

export function ManageGroupsDialog({
  open,
  onClose,
  initialGroupId,
}: {
  open: boolean;
  onClose: () => void;
  /** When opened with this set, jump straight to editing that group's members.
   *  Omitted → the group list, where "New group" lives. */
  initialGroupId?: string;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editorTab, setEditorTab] = useState<EditorTab>("settings");
  // Group administration needs the stored membership intact. The picker below
  // still reveals program guests only when the draft is explicitly Robotics.
  const roster = useScholarRoster({
    includeProgramGuests: true,
    retainEnrolledFallback: false,
    enabled: open,
  });
  // Owner candidates — the same staff directory the school surfaces use.
  const staff = useQuery(api.users.listInstitutionStaff, open ? {} : "skip");
  const createGroup = useMutation(api.scholarGroups.create);
  const updateGroup = useMutation(api.scholarGroups.update);
  const setScholars = useMutation(api.scholarGroups.setScholars);
  const removeGroup = useMutation(api.scholarGroups.remove);

  const [saving, setSaving] = useState(false);

  const startNew = () => {
    setEditorTab("settings");
    setDraft({ ...EMPTY_DRAFT, members: new Set() });
  };
  const startEdit = (g: RosterGroup) => {
    setEditorTab("settings");
    setDraft({
      groupId: g.id as Id<"scholarGroups">,
      name: g.name,
      emoji: g.emoji ?? "",
      // A legacy explicit "primary" is the same thing as unset; show it as the
      // main group rather than as an unknown subject.
      type: g.type && g.type !== PRIMARY_GROUP_TYPE ? g.type : "",
      participation: g.participation,
      ownerId: g.ownerId ?? "",
      members: new Set(g.scholarIds),
    });
  };

  // Apply the open-time target group once per open (groups may load after open),
  // and reset the draft when the dialog closes so a later "Manage groups…" from
  // the menu starts on the list rather than a stale editor.
  const appliedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      appliedRef.current = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- closing the dialog discards its transient draft so the next open starts clean.
      setDraft(null);
      return;
    }
    if (appliedRef.current) return;
    if (initialGroupId) {
      const g = roster.groups.find((x) => x.id === initialGroupId);
      if (g) {
        startEdit(g);
        appliedRef.current = true;
      }
    } else {
      appliedRef.current = true;
    }
  }, [open, initialGroupId, roster.groups]);

  const handleSave = async () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      toaster.error({ title: "Name required" });
      return;
    }
    setSaving(true);
    try {
      if (draft.groupId === null) {
        await createGroup({
          name,
          emoji: draft.emoji.trim() || undefined,
          type: draft.type || undefined,
          participation: draft.participation,
          ownerId: (draft.ownerId || undefined) as Id<"users"> | undefined,
          scholarIds: Array.from(draft.members) as Id<"users">[],
        });
        toaster.success({ title: `Created ${name}` });
      } else {
        await updateGroup({
          groupId: draft.groupId,
          name,
          emoji: draft.emoji.trim() || undefined,
          // `null` is the explicit clear — an omitted arg would leave the
          // existing value in place, so "Main group" / "Unowned" wouldn't stick.
          type: draft.type || null,
          ownerId: (draft.ownerId || null) as Id<"users"> | null,
        });
        await setScholars({
          groupId: draft.groupId,
          scholarIds: Array.from(draft.members) as Id<"users">[],
          participation: draft.participation,
        });
        toaster.success({ title: `Saved ${name}` });
      }
      setDraft(null);
    } catch (e) {
      toaster.error({
        title: "Failed to save",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleParticipationChange = (participation: GroupParticipation) => {
    if (participation === "enrolled_only") {
      const programGuestCount = roster.scholars.filter(
        (scholar) =>
          scholar.enrollmentStanding === "program_guest" &&
          draft?.members.has(scholar.id),
      ).length;
      if (programGuestCount > 0) {
        toaster.error({
          title: `Remove ${EXTENDED_EDUCATION_LABEL} scholars first`,
          description: `${programGuestCount} ${EXTENDED_EDUCATION_LABEL} ${
            programGuestCount === 1 ? "scholar is" : "scholars are"
          } still in this group.`,
        });
        return;
      }
    }
    if (draft) setDraft({ ...draft, participation });
  };

  const handleDelete = async (g: RosterGroup) => {
    if (!window.confirm(`Delete group "${g.name}"? Scholars are not deleted.`)) {
      return;
    }
    try {
      await removeGroup({ groupId: g.id as Id<"scholarGroups"> });
      if (draft?.groupId === g.id) setDraft(null);
      toaster.success({ title: `Deleted ${g.name}` });
    } catch (e) {
      toaster.error({
        title: "Failed to delete",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && onClose()}>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent
            maxW="1080px"
            w="96vw"
            h={{ base: "92dvh", md: "86dvh" }}
            maxH={{ base: "92dvh", md: "86dvh" }}
          >
            <Dialog.Header px={6} pt={6} pb={3}>
              <Dialog.Title asChild>
                <Heading size="md" color="navy.500" fontFamily="heading">
                  Scholar groups
                </Heading>
              </Dialog.Title>
            </Dialog.Header>

            <Dialog.Body
              px={0}
              pb={0}
              pt={0}
              flex="1"
              minH={0}
              overflowY="scroll"
              scrollbarGutter="stable"
            >
              <Flex
                borderTop="1px solid"
                borderTopColor="gray.200"
                minH="520px"
              >
                {/* Group list */}
                <Box
                  w="280px"
                  flexShrink={0}
                  borderRight="1px solid"
                  borderRightColor="gray.200"
                  bg="gray.50"
                >
                  <Stack gap={0} p={2}>
                    <Flex
                      as="button"
                      align="center"
                      gap={1}
                      w="full"
                      minH="58px"
                      px={2}
                      py={2}
                      borderRadius="md"
                      borderWidth="1px"
                      borderColor="transparent"
                      color="violet.500"
                      textAlign="left"
                      _hover={{ bg: "white" }}
                      onClick={startNew}
                    >
                      <Flex w={6} justify="center" flexShrink={0}>
                        <Plus size={18} />
                      </Flex>
                      <Box flex={1} minW={0}>
                        <Text
                          fontFamily="heading"
                          fontSize="sm"
                          fontWeight="600"
                        >
                          New group
                        </Text>
                      </Box>
                    </Flex>
                    {roster.isLoading ? (
                      <HStack justify="center" py={4}>
                        <Spinner size="sm" color="violet.500" />
                      </HStack>
                    ) : roster.groups.length === 0 ? (
                      <Text
                        fontSize="xs"
                        color="charcoal.400"
                        fontFamily="body"
                        px={3}
                        py={4}
                      >
                        No groups yet. Create one to organize your roster.
                      </Text>
                    ) : (
                      roster.groups.map((g) => {
                        const active = draft?.groupId === g.id;
                        return (
                          <Flex
                            key={g.id}
                            align="center"
                            gap={1}
                            px={2}
                            py={2}
                            borderRadius="md"
                            bg={active ? "white" : "transparent"}
                            borderWidth="1px"
                            borderColor={active ? "violet.300" : "transparent"}
                            _hover={{ bg: "white" }}
                            cursor="pointer"
                            onClick={() => startEdit(g)}
                          >
                            <Text
                              fontSize="lg"
                              w={6}
                              textAlign="center"
                              color={g.emoji ? undefined : "charcoal.200"}
                            >
                              {g.emoji || "○"}
                            </Text>
                            <Box flex={1} minW={0}>
                              <Text
                                fontFamily="heading"
                                fontSize="sm"
                                fontWeight="600"
                                color="navy.500"
                                overflow="hidden"
                                whiteSpace="nowrap"
                                textOverflow="ellipsis"
                              >
                                {g.name}
                              </Text>
                              <Text fontSize="xs" color="charcoal.400">
                                {g.scholarIds.length} scholar
                                {g.scholarIds.length === 1 ? "" : "s"}
                              </Text>
                            </Box>
                            <IconButton
                              aria-label="Mark group as mine"
                              size="2xs"
                              variant="ghost"
                              color={g.isMine ? "red.400" : "charcoal.200"}
                              _hover={{ color: "red.400", bg: "red.50" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                roster.toggleAffinityGroup(g.id);
                              }}
                            >
                              <Heart
                                size={13}
                                fill={g.isMine ? "currentColor" : "none"}
                              />
                            </IconButton>
                            <IconButton
                              aria-label="Delete group"
                              size="2xs"
                              variant="ghost"
                              color="charcoal.300"
                              _hover={{ color: "red.500", bg: "red.50" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(g);
                              }}
                            >
                              <Trash size={13} />
                            </IconButton>
                          </Flex>
                        );
                      })
                    )}
                  </Stack>
                </Box>

                {/* Editor */}
                <Box flex={1} minW={0} p={6}>
                  {draft === null ? (
                    <Flex
                      h="full"
                      minH="300px"
                      align="center"
                      justify="center"
                      color="charcoal.300"
                      fontFamily="body"
                      fontSize="sm"
                      textAlign="center"
                      px={6}
                    >
                      Pick a group to edit, or create a new one.
                    </Flex>
                  ) : (
                    <Stack gap={5}>
                      <ContextTabs<EditorTab>
                        ariaLabel="Scholar group sections"
                        value={editorTab}
                        onChange={setEditorTab}
                        items={[
                          { value: "settings", label: "Settings" },
                          { value: "members", label: "Members" },
                          { value: "apps", label: "Apps" },
                        ]}
                      />

                      {editorTab === "settings" && (
                        <Stack gap={4}>
                          <HStack gap={3} align="flex-end">
                            <Box w="64px">
                              <Text
                                fontSize="xs"
                                color="charcoal.400"
                                fontFamily="heading"
                                fontWeight="600"
                                mb={1}
                              >
                                Emoji
                              </Text>
                              <EmojiPickerButton
                                value={draft.emoji}
                                onChange={(emoji) =>
                                  setDraft({ ...draft, emoji })
                                }
                                height="40px"
                                fontSize="xl"
                              />
                            </Box>
                            <Box flex={1}>
                              <Text
                                fontSize="xs"
                                color="charcoal.400"
                                fontFamily="heading"
                                fontWeight="600"
                                mb={1}
                              >
                                Group name
                              </Text>
                              <Input
                                value={draft.name}
                                onChange={(e) =>
                                  setDraft({ ...draft, name: e.target.value })
                                }
                                placeholder="Geckos"
                                autoFocus
                              />
                            </Box>
                          </HStack>

                          {/* Routing: what the group IS, and who runs it.
                              Neither field grants access. */}
                          <HStack gap={3} align="flex-start">
                            <Box flex={1}>
                              <Text
                                fontSize="xs"
                                color="charcoal.400"
                                fontFamily="heading"
                                fontWeight="600"
                                mb={1}
                              >
                                Kind
                              </Text>
                              <FieldSelect
                                value={draft.type}
                                onChange={(type) =>
                                  setDraft({ ...draft, type })
                                }
                                fieldProps={{ "aria-label": "Group kind" }}
                              >
                                {GROUP_TYPES.map((type) => (
                                  <option key={type.value} value={type.value}>
                                    {type.label}
                                  </option>
                                ))}
                              </FieldSelect>
                            </Box>
                            <Box flex={1}>
                              <Text
                                fontSize="xs"
                                color="charcoal.400"
                                fontFamily="heading"
                                fontWeight="600"
                                mb={1}
                              >
                                Owner
                              </Text>
                              <FieldSelect
                                value={draft.ownerId}
                                onChange={(ownerId) =>
                                  setDraft({ ...draft, ownerId })
                                }
                                fieldProps={{ "aria-label": "Group owner" }}
                              >
                                <option value="">No owner</option>
                                {(staff ?? []).map((staffMember) => (
                                  <option
                                    key={staffMember.id}
                                    value={staffMember.id}
                                  >
                                    {staffMember.name ??
                                      staffMember.username ??
                                      "(unnamed)"}
                                  </option>
                                ))}
                              </FieldSelect>
                            </Box>
                          </HStack>
                          <Text
                            fontSize="xs"
                            color="charcoal.300"
                            fontFamily="body"
                            mt={-2}
                          >
                            The owner opens their Scholars and Math skills tabs
                            on this group instead of the whole school.
                          </Text>

                          <Box>
                            <Text
                              fontSize="xs"
                              color="charcoal.400"
                              fontFamily="heading"
                              fontWeight="600"
                              mb={1}
                            >
                              Participation
                            </Text>
                            <RadioGroup.Root
                              value={draft.participation}
                              onValueChange={(details) =>
                                handleParticipationChange(
                                  details.value as GroupParticipation,
                                )
                              }
                              aria-label="Group participation"
                            >
                              <HStack gap={6} flexWrap="wrap">
                                <RadioGroup.Item value="enrolled_only">
                                  <RadioGroup.ItemHiddenInput />
                                  <RadioGroup.ItemIndicator />
                                  <RadioGroup.ItemText>
                                    Enrolled scholars
                                  </RadioGroup.ItemText>
                                </RadioGroup.Item>
                                <RadioGroup.Item value="includes_program_guests">
                                  <RadioGroup.ItemHiddenInput />
                                  <RadioGroup.ItemIndicator />
                                  <RadioGroup.ItemText>
                                    Extended education
                                  </RadioGroup.ItemText>
                                </RadioGroup.Item>
                              </HStack>
                            </RadioGroup.Root>
                            <Text
                              fontSize="xs"
                              color="charcoal.300"
                              fontFamily="body"
                              mt={1}
                            >
                              {draft.participation ===
                              "includes_program_guests"
                                ? `This group can include both enrolled and ${EXTENDED_EDUCATION_LABEL.toLocaleLowerCase()} scholars. Capture stations are set up in School › Devices.`
                                : "Only enrolled scholars appear in this group’s member picker."}
                            </Text>
                          </Box>
                        </Stack>
                      )}

                      {editorTab === "members" && (
                        <ScholarPicker
                          mode="multi"
                          selected={draft.members}
                          onChange={(members) =>
                            setDraft({ ...draft, members })
                          }
                          showGroups={false}
                          showAffinityToggle={false}
                          includeProgramGuests={
                            draft.participation === "includes_program_guests"
                          }
                          showEnrollmentStanding={
                            draft.participation === "includes_program_guests"
                          }
                          maxH="none"
                        />
                      )}

                      {editorTab === "apps" &&
                        (draft.groupId === null ? (
                          <Box
                            borderColor="border.subtle"
                            borderRadius="lg"
                            borderStyle="dashed"
                            borderWidth="1px"
                            color="fg.muted"
                            p={6}
                            textAlign="center"
                          >
                            Save this group before connecting apps.
                          </Box>
                        ) : (
                          <GroupAppsSection
                            groupId={draft.groupId}
                            groupName={draft.name.trim() || "this group"}
                          />
                        ))}
                    </Stack>
                  )}
                </Box>
              </Flex>
            </Dialog.Body>

            <Box
              borderTop="1px solid"
              borderTopColor="gray.200"
              px={6}
              py={4}
            >
              {/* One action bar, always pinned below the fold. While a
                  draft is open it owns the real commit action (Create /
                  Save) so it can never scroll out of view; otherwise it's
                  just the dialog's Done. */}
              <Flex justify="flex-end" gap={2}>
                {draft === null ? (
                  <Button variant="ghost" onClick={onClose}>
                    Done
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      onClick={() => setDraft(null)}
                      disabled={saving}
                    >
                      Cancel
                    </Button>
                    <Button
                      bg="violet.500"
                      color="white"
                      _hover={{ bg: "violet.600" }}
                      onClick={handleSave}
                      loading={saving}
                      disabled={saving || !draft.name.trim()}
                    >
                      {draft.groupId === null ? "Create group" : "Save"}
                    </Button>
                  </>
                )}
              </Flex>
            </Box>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * "Apps for this group" — the group-first mirror of the Apps tab (plan §6.3).
 * Lists this group's OWN grants (a one-click Remove) plus any inherited
 * school-wide app, shown muted-and-read-only so a teacher understands why every
 * member already has it (to change that, edit the catalog / school-wide grant).
 * "+ Enable an app" opens the shared Enable dialog pre-scoped to this group —
 * same mutation, group-first framing.
 */
function GroupAppsSection({
  groupId,
  groupName,
}: {
  groupId: Id<"scholarGroups">;
  groupName: string;
}) {
  const apps = useQuery(api.appAudiences.listAppsWithAudiences, { groupId });
  const unassignAudience = useMutation(api.appAudiences.unassignAudience);
  const [enableApp, setEnableApp] = useState<AppAccessTarget | null>(null);
  const [busy, setBusy] = useState(false);

  const rows = (apps ?? [])
    .map((app) => {
      const own =
        app.audiences.find(
          (a) => a.audienceKind === "group" && a.audienceId === String(groupId),
        ) ?? null;
      const inherited =
        app.audiences.find(
          (a) => a.audienceKind === "institution" && a.enabled,
        ) ?? null;
      return { app, own, inherited };
    })
    .filter((r) => r.own || r.inherited);

  const handleRemove = (appId: Id<"externalApps">, appName: string) => {
    setBusy(true);
    void (async () => {
      try {
        await unassignAudience({
          appId,
          audienceKind: "group",
          audienceId: String(groupId),
        });
        toaster.success({ title: `Removed ${appName} from ${groupName}` });
      } catch (err) {
        toaster.error({
          title: serverErrorMessage(err, "Couldn't remove app"),
        });
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Box>
      <Flex justify="space-between" align="center" mb={2}>
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          Apps for this group
        </Text>
        <Button
          size="xs"
          variant="ghost"
          color="violet.500"
          fontFamily="heading"
          _hover={{ bg: "violet.50" }}
          onClick={() => {
            // Group-scope add needs a target; pick the first not-yet-granted
            // app if any, else fall through to the dialog's own picker with the
            // first catalog app.
            const target =
              (apps ?? []).find(
                (a) =>
                  !a.audiences.some(
                    (x) =>
                      x.audienceKind === "group" &&
                      x.audienceId === String(groupId),
                  ),
              ) ??
              (apps ?? [])[0];
            if (target) {
              setEnableApp({
                _id: target._id,
                name: target.name,
                webUrl: target.webUrl,
                credentialSource: target.credentialSource,
              });
            }
          }}
        >
          <Plus style={{ marginRight: 4 }} /> Enable an app
        </Button>
      </Flex>

      {apps === undefined ? (
        <HStack py={3} justify="center">
          <Spinner size="sm" color="violet.500" />
        </HStack>
      ) : rows.length === 0 ? (
        <Text fontSize="sm" color="charcoal.400" fontFamily="body">
          No apps enabled for this group yet.
        </Text>
      ) : (
        <Stack gap={0} align="stretch">
          {rows.map(({ app, own, inherited }) => {
            const ownOnly = !!own;
            return (
              <HStack
                key={app._id}
                gap={3}
                py={2.5}
                borderBottomWidth="1px"
                borderColor="gray.100"
                _last={{ borderBottomWidth: 0 }}
                opacity={ownOnly ? 1 : 0.7}
              >
                <AppTileIcon
                  name={app.name}
                  iconUrl={app.iconUrl}
                  iconEmoji={app.iconEmoji}
                  color={app.color}
                  boxSize="34px"
                  radius="10px"
                  markFontSize="15px"
                  imagePadding="4px"
                  // The row names the app immediately to its right.
                  decorative
                />
                <Box flex={1} minW={0}>
                  <Text
                    fontSize="sm"
                    fontFamily="heading"
                    fontWeight="600"
                    color="charcoal.500"
                  >
                    {app.name}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
                    {own
                      ? `Enabled for ${groupName} · on ${own.memberCount} launcher${
                          own.memberCount === 1 ? "" : "s"
                        }`
                      : "School-wide — every scholar (managed in the catalog)"}
                  </Text>
                </Box>
                {own ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    color="charcoal.400"
                    fontFamily="heading"
                    _hover={{ color: "red.500", bg: "red.50" }}
                    disabled={busy}
                    onClick={() => handleRemove(app._id, app.name)}
                  >
                    <Trash style={{ marginRight: 4 }} /> Remove
                  </Button>
                ) : (
                  <Box
                    as="span"
                    fontSize="3xs"
                    fontWeight="700"
                    fontFamily="body"
                    color="charcoal.400"
                    bg="gray.100"
                    borderRadius="full"
                    px={2}
                    py={0.5}
                    flexShrink={0}
                  >
                    inherited
                  </Box>
                )}
                {/* An app can be both directly granted AND school-wide. */}
                {own && inherited && (
                  <Box
                    as="span"
                    fontSize="3xs"
                    fontWeight="700"
                    fontFamily="body"
                    color="charcoal.400"
                    bg="gray.100"
                    borderRadius="full"
                    px={2}
                    py={0.5}
                    flexShrink={0}
                  >
                    also school-wide
                  </Box>
                )}
              </HStack>
            );
          })}
        </Stack>
      )}

      <AppAccessDrawer
        open={enableApp !== null}
        onClose={() => setEnableApp(null)}
        app={enableApp}
        presetGroupId={groupId}
      />
    </Box>
  );
}

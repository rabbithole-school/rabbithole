"use client";

/**
 * AppAccessDrawer (plan §6.1, refined) — the ONE place to edit an app's
 * *complete* audience: who can use it, big→small (Institution · Groups ·
 * Scholars). It opens reflecting the CURRENT state (everything already enabled
 * is checked); Save applies the diff — check to enable, uncheck to remove:
 *   • Institution / Group → appAudiences.assignToAudience / unassignAudience
 *     (read-time grants, followed as membership churns — never fanned out).
 *   • Scholars → scholarApps.addToScholar / removeFromScholar per scholar.
 * A grant provisions the TILE, never a shared password — logins stay per-kid,
 * set on each profile.
 *
 * Rendered as a right-hand inspector Drawer (not a modal) so it reads as
 * "editing this app's access," not a one-shot action. Open to any scholarAdmin
 * (teacher / admin / operations staff); mounts its roster subscription only while open.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Drawer,
  Heading,
  HStack,
  IconButton,
  Portal,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Check, X } from "@phosphor-icons/react";
import { ScholarPicker } from "@/components/ScholarPicker";
import { useScholarRoster } from "@/hooks/useScholarRoster";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

export interface AppAccessTarget {
  _id: Id<"externalApps">;
  name: string;
  webUrl: string;
  credentialSource: "scholarApp" | "libraryCard" | null;
  /**
   * Set when the catalog entry also launches an app that is installed on
   * managed iPads. Web surfaces always open `webUrl`.
   */
  managedNativeAppKey?: "google-sheets" | "lego-spike" | null;
}

type Scope = "group" | "institution" | "scholars";

type Enablement = {
  groupIds: string[];
  institutionIds: string[];
  direct: { scholarId: Id<"users">; scholarAppId: Id<"scholarApps"> }[];
};

/** Prettify a webUrl to a bare domain for the subtitle ("pressreader.com"). */
export function domainOf(webUrl: string): string {
  try {
    return new URL(webUrl).hostname.replace(/^www\./, "");
  } catch {
    return webUrl;
  }
}

function loginTypeLabel(app: AppAccessTarget): string {
  return app.credentialSource === "libraryCard"
    ? "library-card sign-in"
    : "per-scholar login";
}

/**
 * The one canonical line describing how an app opens for a scholar.
 *
 * A managed entry hands off to the installed app on iPad and returns before
 * ever touching `webUrl` or the stored login (see the native AppLauncher), so
 * naming a domain or a login type there would describe a path the primary
 * scholar device never takes. Those apply only on the web launcher, which has
 * no native concept and opens `webUrl` for every tile.
 */
export function appLaunchSummary(app: AppAccessTarget): string {
  if (app.managedNativeAppKey) return "Managed iPad app";
  return `${domainOf(app.webUrl)} · ${loginTypeLabel(app)}`;
}

export function AppAccessDrawer({
  open,
  onClose,
  app,
  presetGroupId,
}: {
  open: boolean;
  onClose: () => void;
  app: AppAccessTarget | null;
  /** Group-mirror entry: open on the Groups tab (plan §6.3). */
  presetGroupId?: Id<"scholarGroups">;
}) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(d) => !d.open && onClose()}
      placement="end"
      size="md"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            display="flex"
            flexDirection="column"
            bg="white"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            {open && app ? (
              <AppAccessDrawerInner
                key={app._id}
                app={app}
                onClose={onClose}
                presetGroupId={presetGroupId}
              />
            ) : (
              <Box p={6} />
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

function DrawerHeader({
  app,
  onClose,
}: {
  app: AppAccessTarget;
  onClose: () => void;
}) {
  return (
    <Drawer.Header
      borderBottom="1px solid"
      borderColor="gray.100"
      px={6}
      py={5}
      display="flex"
      alignItems="flex-start"
      gap={3}
    >
      <Stack gap={0.5} flex={1} minW={0}>
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          Manage access
        </Text>
        <Heading
          size="md"
          color="navy.500"
          fontFamily="heading"
          fontWeight="700"
          lineClamp={2}
        >
          Who can use {app.name}?
        </Heading>
        <Text fontSize="xs" color="charcoal.400" fontFamily="body">
          {appLaunchSummary(app)}
        </Text>
      </Stack>
      <Drawer.CloseTrigger asChild>
        <IconButton
          aria-label="Close"
          size="sm"
          variant="ghost"
          color="charcoal.400"
          _hover={{ bg: "gray.100" }}
          onClick={onClose}
        >
          <X />
        </IconButton>
      </Drawer.CloseTrigger>
    </Drawer.Header>
  );
}

function AppAccessDrawerInner({
  app,
  onClose,
  presetGroupId,
}: {
  app: AppAccessTarget;
  onClose: () => void;
  presetGroupId?: Id<"scholarGroups">;
}) {
  const enablement = useQuery(api.appAudiences.enablementForApp, {
    appId: app._id,
  });

  return (
    <>
      <DrawerHeader app={app} onClose={onClose} />
      {enablement === undefined ? (
        <Drawer.Body px={6} py={6}>
          <HStack py={8} justify="center">
            <Spinner size="md" color="violet.500" />
          </HStack>
        </Drawer.Body>
      ) : (
        <AppAccessEditor
          app={app}
          onClose={onClose}
          presetGroupId={presetGroupId}
          initial={enablement}
        />
      )}
    </>
  );
}

function toggleIn(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function previewNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} +${names.length - max} more`;
}

function AppAccessEditor({
  app,
  onClose,
  presetGroupId,
  initial,
}: {
  app: AppAccessTarget;
  onClose: () => void;
  presetGroupId?: Id<"scholarGroups">;
  initial: Enablement;
}) {
  const roster = useScholarRoster();
  const institutions = useQuery(api.institutions.listForStaff, {});
  const assignToAudience = useMutation(api.appAudiences.assignToAudience);
  const unassignAudience = useMutation(api.appAudiences.unassignAudience);
  const addToScholar = useMutation(api.scholarApps.addToScholar);
  const removeFromScholar = useMutation(api.scholarApps.removeFromScholar);

  const [scope, setScope] = useState<Scope>(presetGroupId ? "group" : "group");
  // Seeded once from the current state — this drawer edits the COMPLETE list.
  const [groupSel, setGroupSel] = useState<Set<string>>(
    () => new Set(initial.groupIds),
  );
  const [instSel, setInstSel] = useState<Set<string>>(
    () => new Set(initial.institutionIds),
  );
  const [scholarSel, setScholarSel] = useState<Set<string>>(
    () => new Set(initial.direct.map((d) => String(d.scholarId))),
  );
  const [busy, setBusy] = useState(false);

  const scholarAppIdBy = useMemo(
    () =>
      new Map(initial.direct.map((d) => [String(d.scholarId), d.scholarAppId])),
    [initial.direct],
  );
  const nameById = useMemo(
    () => new Map(roster.scholars.map((s) => [s.id, s.name])),
    [roster.scholars],
  );
  const groupNameById = useMemo(
    () => new Map(roster.groups.map((g) => [g.id, g.name])),
    [roster.groups],
  );
  const instNameById = useMemo(
    () => new Map((institutions ?? []).map((i) => [String(i._id), i.name])),
    [institutions],
  );

  const diff = useMemo(() => {
    const initialScholarIds = initial.direct.map((d) => String(d.scholarId));
    return {
      groupAdd: [...groupSel].filter((id) => !initial.groupIds.includes(id)),
      groupRemove: initial.groupIds.filter((id) => !groupSel.has(id)),
      instAdd: [...instSel].filter(
        (id) => !initial.institutionIds.includes(id),
      ),
      instRemove: initial.institutionIds.filter((id) => !instSel.has(id)),
      scholarAdd: [...scholarSel].filter(
        (id) => !initialScholarIds.includes(id),
      ),
      scholarRemove: initialScholarIds.filter((id) => !scholarSel.has(id)),
    };
  }, [groupSel, instSel, scholarSel, initial]);

  const enablingNames = [
    ...diff.groupAdd.map((id) => groupNameById.get(id) ?? "a group"),
    ...diff.instAdd.map((id) => instNameById.get(id) ?? "school-wide"),
    ...diff.scholarAdd.map((id) => nameById.get(id) ?? "a scholar"),
  ];
  const removingNames = [
    ...diff.groupRemove.map((id) => groupNameById.get(id) ?? "a group"),
    ...diff.instRemove.map((id) => instNameById.get(id) ?? "school-wide"),
    ...diff.scholarRemove.map((id) => nameById.get(id) ?? "a scholar"),
  ];
  const hasChanges = enablingNames.length + removingNames.length > 0;

  const handleSave = async () => {
    if (!hasChanges || busy) return;
    setBusy(true);
    try {
      const ops: Promise<unknown>[] = [];
      for (const id of diff.groupAdd)
        ops.push(
          assignToAudience({
            appId: app._id,
            audienceKind: "group",
            audienceId: id,
          }),
        );
      for (const id of diff.groupRemove)
        ops.push(
          unassignAudience({
            appId: app._id,
            audienceKind: "group",
            audienceId: id,
          }),
        );
      for (const id of diff.instAdd)
        ops.push(
          assignToAudience({
            appId: app._id,
            audienceKind: "institution",
            audienceId: id,
          }),
        );
      for (const id of diff.instRemove)
        ops.push(
          unassignAudience({
            appId: app._id,
            audienceKind: "institution",
            audienceId: id,
          }),
        );
      for (const id of diff.scholarAdd)
        ops.push(
          addToScholar({ appId: app._id, scholarId: id as Id<"users"> }),
        );
      for (const id of diff.scholarRemove) {
        const said = scholarAppIdBy.get(id);
        if (said) ops.push(removeFromScholar({ scholarAppId: said }));
      }
      await Promise.all(ops);
      const added = enablingNames.length;
      const removed = removingNames.length;
      toaster.success({
        title: `${app.name} access saved`,
        description:
          [
            added ? `enabled ${added}` : null,
            removed ? `removed ${removed}` : null,
          ]
            .filter(Boolean)
            .join(" · ") || "Up to date.",
      });
      onClose();
    } catch (err) {
      toaster.error({
        title: serverErrorMessage(err, "Couldn't save access"),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Drawer.Body px={6} py={5} flex={1} overflowY="auto">
        <Stack gap={4}>
          <Text fontSize="xs" color="charcoal.400" fontFamily="body">
            Everyone who can use it now is checked. Check to enable, uncheck to
            remove — changes apply when you save.
          </Text>

          {/* Scope segmented control — big → small */}
          <HStack
            gap={0}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="lg"
            p={1}
            bg="gray.50"
          >
            {(
              [
                ["institution", "Institution"],
                ["group", "Groups"],
                ["scholars", "Scholars"],
              ] as [Scope, string][]
            ).map(([value, label]) => {
              const active = scope === value;
              return (
                <Button
                  key={value}
                  flex={1}
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  fontWeight={active ? "700" : "500"}
                  color={active ? "violet.600" : "charcoal.400"}
                  bg={active ? "white" : "transparent"}
                  boxShadow={active ? "0 1px 3px rgba(20,24,50,0.10)" : "none"}
                  _hover={{ bg: active ? "white" : "gray.100" }}
                  onClick={() => setScope(value)}
                >
                  {label}
                </Button>
              );
            })}
          </HStack>

          {scope === "group" && (
            <Stack gap={2}>
              <FieldLabel>Groups</FieldLabel>
              {roster.isLoading ? (
                <HStack py={4} justify="center">
                  <Spinner size="sm" color="violet.500" />
                </HStack>
              ) : roster.groups.length === 0 ? (
                <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                  No groups yet. Create one from the Scholars tab.
                </Text>
              ) : (
                <Stack
                  gap={1}
                  maxH="420px"
                  overflowY="auto"
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="lg"
                  p={1}
                >
                  {roster.groups.map((g) => (
                    <CheckRow
                      key={g.id}
                      emoji={g.emoji ?? "👥"}
                      title={g.name}
                      subtitle={`${g.scholarIds.length} scholar${
                        g.scholarIds.length === 1 ? "" : "s"
                      }`}
                      checked={groupSel.has(g.id)}
                      onToggle={() => setGroupSel(toggleIn(groupSel, g.id))}
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          )}

          {scope === "institution" && (
            <Stack gap={2}>
              <FieldLabel>Institutions</FieldLabel>
              {institutions === undefined ? (
                <HStack py={4} justify="center">
                  <Spinner size="sm" color="violet.500" />
                </HStack>
              ) : institutions.length === 0 ? (
                <Text fontSize="sm" color="charcoal.400" fontFamily="body">
                  No institutions found.
                </Text>
              ) : (
                <Stack
                  gap={1}
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="lg"
                  p={1}
                >
                  {institutions.map((i) => (
                    <CheckRow
                      key={i._id}
                      emoji={i.emoji ?? "🏫"}
                      title={i.name}
                      subtitle="Every scholar at this school"
                      checked={instSel.has(i._id)}
                      onToggle={() => setInstSel(toggleIn(instSel, i._id))}
                    />
                  ))}
                </Stack>
              )}
            </Stack>
          )}

          {scope === "scholars" && (
            <Stack gap={2}>
              <FieldLabel>Scholars</FieldLabel>
              <Box
                borderWidth="1px"
                borderColor="gray.200"
                borderRadius="lg"
                p={2}
              >
                <ScholarPicker
                  mode="multi"
                  selected={scholarSel}
                  onChange={setScholarSel}
                  maxH="420px"
                />
              </Box>
            </Stack>
          )}
        </Stack>
      </Drawer.Body>

      <Drawer.Footer
        borderTop="1px solid"
        borderColor="gray.100"
        px={6}
        py={5}
        display="flex"
        flexDirection="column"
        alignItems="stretch"
        gap={3}
      >
        <Box
          bg={hasChanges ? "violet.50" : "gray.50"}
          borderRadius="lg"
          px={4}
          py={3}
        >
          {!hasChanges ? (
            <Text fontSize="sm" color="charcoal.400" fontFamily="body">
              No changes yet — this is who can use it right now.
            </Text>
          ) : (
            <Stack gap={1}>
              {enablingNames.length > 0 && (
                <Text
                  fontSize="sm"
                  color="violet.700"
                  fontFamily="body"
                  fontWeight="600"
                >
                  Enabling: {previewNames(enablingNames)}
                </Text>
              )}
              {removingNames.length > 0 && (
                <Text
                  fontSize="sm"
                  color="charcoal.600"
                  fontFamily="body"
                  fontWeight="600"
                >
                  Removing: {previewNames(removingNames)}
                </Text>
              )}
            </Stack>
          )}
          <Text fontSize="2xs" color="charcoal.400" fontFamily="body" mt={1.5}>
            Grants provision the tile only — each scholar signs in with their own
            login.
          </Text>
        </Box>

        <HStack gap={2} justify="flex-end">
          <Button
            size="sm"
            variant="ghost"
            fontFamily="heading"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            colorPalette="violet"
            fontFamily="heading"
            disabled={!hasChanges || busy}
            onClick={() => void handleSave()}
          >
            {busy ? "Saving…" : "Save changes"}
          </Button>
        </HStack>
      </Drawer.Footer>
    </>
  );
}

function CheckRow({
  emoji,
  title,
  subtitle,
  checked,
  onToggle,
}: {
  emoji: string;
  title: string;
  subtitle?: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <HStack
      as="button"
      gap={3}
      px={3}
      py={2}
      borderRadius="md"
      textAlign="left"
      w="full"
      bg={checked ? "violet.50" : "transparent"}
      borderWidth="1px"
      borderColor={checked ? "violet.300" : "transparent"}
      cursor="pointer"
      _hover={{ bg: checked ? "violet.50" : "gray.100" }}
      onClick={onToggle}
    >
      <CheckMark checked={checked} />
      <Text fontSize="lg" flexShrink={0}>
        {emoji}
      </Text>
      <Box flex={1} minW={0}>
        <Text
          fontSize="sm"
          fontFamily="heading"
          fontWeight="600"
          color="charcoal.500"
        >
          {title}
        </Text>
        {subtitle && (
          <Text fontSize="2xs" color="charcoal.400" fontFamily="body">
            {subtitle}
          </Text>
        )}
      </Box>
    </HStack>
  );
}

function CheckMark({ checked }: { checked: boolean }) {
  return (
    <Box
      w="18px"
      h="18px"
      borderRadius="4px"
      borderWidth="2px"
      borderColor={checked ? "violet.500" : "gray.300"}
      bg={checked ? "violet.500" : "transparent"}
      color="white"
      display="flex"
      alignItems="center"
      justifyContent="center"
      flexShrink={0}
    >
      {checked && <Check weight="bold" size={12} />}
    </Box>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <Text
      fontSize="2xs"
      color="charcoal.400"
      fontFamily="heading"
      fontWeight="700"
      textTransform="uppercase"
      letterSpacing="0.05em"
    >
      {children}
    </Text>
  );
}

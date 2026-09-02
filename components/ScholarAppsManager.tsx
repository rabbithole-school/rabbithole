"use client";

/**
 * Teacher/admin panel — manage a scholar's standing External Apps (the
 * tiles on their home launcher). Lives in the scholar profile's Settings
 * tab. Teachers AND admins (and operations staff, via scholarAdmin) can add from
 * the catalog or paste an ad-hoc URL, toggle apps on/off, and remove them.
 * No reordering (we assume <4 apps/scholar). See
 * review/external-apps-launcher.html §4.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import {
  Box,
  HStack,
  VStack,
  Text,
  Input,
  Button,
  Switch,
  Spinner,
} from "@chakra-ui/react";
import { useQuery, useMutation } from "convex/react";
import { Plus, Trash, Globe, AppWindow, Key } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { AppTileIcon } from "@/components/ui/AppTileIcon";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";

/** A small "why does this scholar have this app" provenance pill. A group grant
 *  reads green, a school-wide grant violet, a direct add grey (plan §6.4). */
function ProvChip({
  tone,
  children,
}: {
  tone: "group" | "institution" | "direct";
  children: ReactNode;
}) {
  const palette = {
    group: { color: "green.700", bg: "green.50" },
    institution: { color: "violet.700", bg: "violet.50" },
    direct: { color: "charcoal.400", bg: "gray.100" },
  }[tone];
  return (
    <Box
      as="span"
      fontSize="3xs"
      fontWeight="700"
      fontFamily="body"
      color={palette.color}
      bg={palette.bg}
      borderRadius="4px"
      px={1.5}
      py={0.5}
      whiteSpace="nowrap"
    >
      {children}
    </Box>
  );
}

export function ScholarAppsManager({
  scholarId,
}: {
  scholarId: Id<"users">;
}) {
  const apps = useQuery(api.scholarApps.listForScholar, { scholarId });
  const catalog = useQuery(api.externalApps.listCatalog, {});
  const addToScholar = useMutation(api.scholarApps.addToScholar);
  const setEnabled = useMutation(api.scholarApps.setEnabled);
  const removeFromScholar = useMutation(api.scholarApps.removeFromScholar);
  const setCredentials = useMutation(api.scholarApps.setCredentials);

  const [busy, setBusy] = useState(false);
  const [showUrlForm, setShowUrlForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [openCreds, setOpenCreds] = useState<Id<"externalApps"> | null>(null);
  const [credUser, setCredUser] = useState("");
  const [credPass, setCredPass] = useState("");

  const linkedAppIds = new Set((apps ?? []).map((a) => a.appId));
  const addable = (catalog ?? []).filter((c) => !linkedAppIds.has(c._id));

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

  const handleAddFromCatalog = (appId: Id<"externalApps">) =>
    guarded(() => addToScholar({ scholarId, appId }));

  const handleAddUrl = () =>
    guarded(async () => {
      const name = newName.trim();
      const webUrl = newUrl.trim();
      if (!name || !webUrl) {
        throw new Error("Enter a name and a URL");
      }
      await addToScholar({ scholarId, name, webUrl });
      setNewName("");
      setNewUrl("");
      setShowUrlForm(false);
    });

  const toggleCreds = (app: {
    appId: Id<"externalApps">;
    loginUsername: string | null;
  }) => {
    if (openCreds === app.appId) {
      setOpenCreds(null);
      return;
    }
    setOpenCreds(app.appId);
    setCredUser(app.loginUsername ?? "");
    setCredPass("");
  };

  const handleSaveCreds = (app: { appId: Id<"externalApps"> }) =>
    guarded(async () => {
      await setCredentials({
        scholarId,
        appId: app.appId,
        username: credUser,
        // Only touch the password when the staffer typed one (merge-safe).
        password: credPass ? credPass : undefined,
      });
      setOpenCreds(null);
      setCredPass("");
    });

  const handleClearCreds = (app: { appId: Id<"externalApps"> }) =>
    guarded(async () => {
      await setCredentials({ scholarId, appId: app.appId, username: "", password: "" });
      setOpenCreds(null);
      setCredUser("");
      setCredPass("");
    });

  return (
    <Surface p={5}>
      <HStack gap={2} mb={1}>
        <Box color="violet.500">
          <AppWindow weight="duotone" />
        </Box>
        <Text fontFamily="heading" fontWeight="600" color="charcoal.500">
          External Apps
        </Text>
      </HStack>
      <Text fontSize="xs" color="charcoal.400" fontFamily="body" mb={4}>
        Apps this scholar can open from their home launcher.
      </Text>

      {apps === undefined ? (
        <HStack justify="center" py={4}>
          <Spinner size="sm" color="violet.500" />
        </HStack>
      ) : apps.length === 0 ? (
        <Text fontSize="sm" color="charcoal.400" fontFamily="body" mb={3}>
          No apps yet.
        </Text>
      ) : (
        <VStack gap={0} align="stretch" mb={2}>
          {apps.map((app) => {
            const scholarAppId = app.scholarAppId;
            const hasProvenance =
              app.direct ||
              app.grantGroups.length > 0 ||
              app.grantInstitution;
            return (
            <Box
              key={app.appId}
              borderBottomWidth="1px"
              borderColor="gray.100"
              _last={{ borderBottomWidth: 0 }}
            >
              <HStack gap={3} py={2.5}>
              <AppTileIcon
                name={app.name}
                iconUrl={app.iconUrl}
                iconEmoji={app.iconEmoji}
                color={app.color}
                boxSize="38px"
                radius="11px"
                markFontSize="16px"
                imagePadding="5px"
                // The row names the app immediately to its right.
                decorative
              />
              <Box flex={1} minW={0}>
                <HStack gap={2}>
                  <Text
                    fontSize="sm"
                    fontFamily="heading"
                    fontWeight="600"
                    color="charcoal.500"
                  >
                    {app.name}
                  </Text>
                  {app.isDefault && (
                    <Box
                      as="span"
                      fontSize="3xs"
                      fontWeight="800"
                      textTransform="uppercase"
                      letterSpacing="0.03em"
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
                  truncate
                >
                  {app.webUrl}
                </Text>
                {hasProvenance && (
                  <HStack gap={1} flexWrap="wrap" mt={1}>
                    {app.grantGroups.map((g) => (
                      <ProvChip key={g.id} tone="group">
                        via {g.emoji ? `${g.emoji} ` : ""}
                        {g.name}
                      </ProvChip>
                    ))}
                    {app.grantInstitution && (
                      <ProvChip tone="institution">School-wide</ProvChip>
                    )}
                    {app.direct && (
                      <ProvChip tone="direct">Added directly</ProvChip>
                    )}
                  </HStack>
                )}
              </Box>
              {/* Only a DIRECT add is toggled / removed here. A granted row is
                  read-only (managed from the group/school) — but its login is
                  still per-scholar, so the "key" stays for every row. */}
              {app.direct && scholarAppId ? (
                <>
                  <Switch.Root
                    checked={app.enabled}
                    disabled={busy}
                    onCheckedChange={(e) =>
                      void guarded(() =>
                        setEnabled({
                          scholarAppId,
                          enabled: e.checked,
                        }),
                      )
                    }
                  >
                    <Switch.HiddenInput />
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Root>
                  <Button
                    size="xs"
                    variant="ghost"
                    color={app.loginUsername ? "violet.500" : "charcoal.300"}
                    _hover={{ color: "violet.500", bg: "violet.50" }}
                    disabled={busy}
                    onClick={() => toggleCreds(app)}
                    aria-label={`Sign-in for ${app.name}`}
                  >
                    <Key />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    color="charcoal.300"
                    _hover={{ color: "red.500", bg: "red.50" }}
                    disabled={busy}
                    onClick={() =>
                      void guarded(() =>
                        removeFromScholar({ scholarAppId }),
                      )
                    }
                    aria-label={`Remove ${app.name}`}
                  >
                    <Trash />
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="ghost"
                  color={app.loginUsername ? "violet.500" : "charcoal.300"}
                  _hover={{ color: "violet.500", bg: "violet.50" }}
                  disabled={busy}
                  onClick={() => toggleCreds(app)}
                  aria-label={`Sign-in for ${app.name}`}
                >
                  <Key />
                </Button>
              )}
              </HStack>
              {openCreds === app.appId && (
                <VStack
                  gap={2}
                  align="stretch"
                  bg="gray.50"
                  borderRadius="lg"
                  p={3}
                  mb={2.5}
                >
                  <Text fontSize="xs" color="charcoal.500" fontFamily="body">
                    {app.credentialSource === "libraryCard" ? (
                      <>
                        Library card for <b>{app.name}</b>. Saved on the scholar
                        and shared across their library apps; the card number +
                        PIN drive the embedded auto-sign-in. Stored in plain text
                        and only ever revealed to this scholar&rsquo;s
                        autofill — never shown back here.
                      </>
                    ) : (
                      <>
                        Sign-in helper for <b>{app.name}</b>. The username
                        pre-fills on the login page. A saved password is
                        optional, stored in plain text, and only ever revealed to
                        this scholar&rsquo;s autofill — never shown back here.
                      </>
                    )}
                  </Text>
                  <Input
                    size="sm"
                    placeholder={
                      app.credentialSource === "libraryCard"
                        ? "Library card number"
                        : "App username"
                    }
                    value={credUser}
                    onChange={(e) => setCredUser(e.target.value)}
                    fontFamily="body"
                    bg="white"
                    autoComplete="off"
                  />
                  <Input
                    size="sm"
                    type="password"
                    placeholder={
                      app.hasPassword
                        ? app.credentialSource === "libraryCard"
                          ? "PIN saved — type to replace"
                          : "Password saved — type to replace"
                        : app.credentialSource === "libraryCard"
                          ? "PIN or password"
                          : "App password (optional)"
                    }
                    value={credPass}
                    onChange={(e) => setCredPass(e.target.value)}
                    fontFamily="body"
                    bg="white"
                    autoComplete="off"
                  />
                  <HStack gap={2} justify="space-between">
                    <Button
                      size="xs"
                      variant="ghost"
                      color="red.500"
                      fontFamily="heading"
                      disabled={busy || (!app.loginUsername && !app.hasPassword)}
                      onClick={() => void handleClearCreds(app)}
                    >
                      Clear
                    </Button>
                    <HStack gap={2}>
                      <Button
                        size="xs"
                        variant="ghost"
                        fontFamily="heading"
                        onClick={() => setOpenCreds(null)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        colorPalette="violet"
                        fontFamily="heading"
                        disabled={busy || !credUser.trim()}
                        onClick={() => void handleSaveCreds(app)}
                      >
                        Save
                      </Button>
                    </HStack>
                  </HStack>
                </VStack>
              )}
            </Box>
            );
          })}
        </VStack>
      )}

      {/* Add from catalog */}
      {addable.length > 0 && (
        <HStack gap={2} flexWrap="wrap" mt={3}>
          {addable.map((c) => (
            <Button
              key={c._id}
              size="xs"
              variant="outline"
              borderColor="gray.200"
              fontFamily="heading"
              fontSize="xs"
              disabled={busy}
              onClick={() => void handleAddFromCatalog(c._id)}
            >
              <Plus style={{ marginRight: 4 }} /> {c.name}
            </Button>
          ))}
        </HStack>
      )}

      {/* Add by URL */}
      <Box mt={3}>
        {!showUrlForm ? (
          <Button
            size="xs"
            variant="ghost"
            color="violet.500"
            fontFamily="heading"
            fontSize="xs"
            _hover={{ bg: "violet.50" }}
            onClick={() => setShowUrlForm(true)}
          >
            <Globe style={{ marginRight: 4 }} /> Add by URL
          </Button>
        ) : (
          <VStack
            gap={2}
            align="stretch"
            bg="gray.50"
            borderRadius="lg"
            p={3}
          >
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
            <HStack gap={2} justify="flex-end">
              <Button
                size="xs"
                variant="ghost"
                fontFamily="heading"
                onClick={() => {
                  setShowUrlForm(false);
                  setNewName("");
                  setNewUrl("");
                }}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                colorPalette="violet"
                fontFamily="heading"
                disabled={busy || !newName.trim() || !newUrl.trim()}
                onClick={() => void handleAddUrl()}
              >
                Add
              </Button>
            </HStack>
          </VStack>
        )}
      </Box>
    </Surface>
  );
}

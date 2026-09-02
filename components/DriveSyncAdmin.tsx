"use client";

import { useState } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Box,
  VStack,
  HStack,
  Text,
  Badge,
  Spinner,
  Skeleton,
  Button,
  Input,
  Textarea,
  Heading,
} from "@chakra-ui/react";
import {
  ArrowClockwise,
  WarningCircle,
  FolderOpen,
  ShieldCheck,
  UserCircle,
} from "@phosphor-icons/react";
import { formatTimeAgo } from "@/lib/relativeTime";
import { extractDriveFolderId } from "@/lib/driveFolderId";
import { GooglePickerButton } from "./GooglePickerButton";
import { GoogleAccountConnect } from "./GoogleAccountConnect";
import { InstitutionMark } from "./InstitutionMark";
import {
  googleReconsentReason,
  needsGoogleReconsent,
} from "./googleConsentStatus";

/**
 * Admin control for a school's watched printer Drive folder that feeds the
 * portfolio. The inbox is PER-INSTITUTION: a platform_admin picks which school
 * to configure (institution switcher); a school_admin manages only their own.
 * Each school calls Drive as its OWN institution-owned identity — a dedicated
 * Google account or a GCP service account — never a staffer's personal link.
 *
 * NOTE: registering the push watch requires an HTTPS callback, so "Connect"
 * only works on the deployed (prod) app, not local http dev.
 */

const RETURN_TO = "/admin/drive-sync";

type ActionKind = "connect" | "sync" | "stop" | "identity";

// Turn a raw Convex action error into something a human can act on.
function cleanError(raw: string): string {
  if (/school-admin role required|not authorized|forbidden/i.test(raw)) {
    return "Only a school or platform administrator can connect this school's Workspace bot.";
  }
  if (/No institution resolved/i.test(raw)) {
    return "Your account is not assigned to a school. Ask a platform administrator to set up your school first.";
  }
  if (/webhookUrlNotHttps|must be HTTPS/i.test(raw)) {
    return "Connecting registers a Google Drive webhook, which Google only allows on an HTTPS site. This can't work from local dev (http://localhost) — do it from the deployed admin page.";
  }
  if (/Set this school's Drive-sync identity first/i.test(raw)) {
    return "Set this school's sync identity first (a Google account or a service account), then connect the folder.";
  }
  if (/No Google account linked|Reconnect Google|no refresh token|Link a Google account first/i.test(raw)) {
    return "This can't reach Drive until the school's sync identity is set. Choose a Google account or paste a service-account key above, then try again.";
  }
  if (/File not found|not found|404|does not have permission|insufficient|403/i.test(raw)) {
    return "Google couldn't open that folder with this school's identity. Double-check the folder ID/link, and make sure the sync identity has access to it (share the folder to the service-account email).";
  }
  if (/invalid_grant|invalid_client|private key|Invalid service account/i.test(raw)) {
    return "That service-account key didn't mint a token. Re-download the JSON key from Google Cloud and paste the whole file.";
  }
  // Strip the Convex wrapper + trailing JSON blob for readability.
  const m = raw.match(/Uncaught Error:\s*([^]*?)(?:\s+at\s|$)/);
  let msg = (m ? m[1] : raw).trim();
  msg = msg.replace(/:\s*\{[^]*$/, "").trim();
  return msg || "Something went wrong.";
}

function WorkspaceBotCard({ scope }: { scope: string | undefined }) {
  const workspaceBotStatus = useQuery(api.driveSyncState.workspaceBotStatus, { scope });
  const beginWorkspaceBotOAuth = useAction(api.driveSync.beginWorkspaceBotOAuth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspaceNeedsReconsent = workspaceBotStatus?.connected
    ? needsGoogleReconsent(workspaceBotStatus, "workspace")
    : false;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { url } = await beginWorkspaceBotOAuth({ scope, returnTo: RETURN_TO });
      window.location.assign(url);
    } catch (err) {
      setError(cleanError(err instanceof Error ? err.message : String(err)));
      setBusy(false);
    }
  };

  return (
    <Box bg="white" borderRadius="xl" shadow="sm" p={5}>
      <Heading fontFamily="heading" color="navy.500" size="md" mb={1}>
        Institution Workspace bot
      </Heading>
      {workspaceBotStatus === undefined ? (
        <VStack align="stretch" gap={3} aria-hidden>
          <Skeleton height="14px" w="300px" borderRadius="sm" />
          <Skeleton height="32px" w="180px" borderRadius="md" />
        </VStack>
      ) : (
        <VStack align="stretch" gap={3}>
          <Text fontSize="sm" color="charcoal.400" fontFamily="body">
            A shared institution identity for Rabbithole to create and edit
            Google Docs and Google Slides. It is separate from the scanner&apos;s
            Drive inbox identity.
          </Text>
          {workspaceBotStatus.connected ? (
            <>
              <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                Connected as {workspaceBotStatus.email}
              </Text>
              {workspaceNeedsReconsent ? (
                <Text
                  fontSize="xs"
                  color={
                    workspaceBotStatus.hasRefreshToken
                      ? "orange.700"
                      : "red.700"
                  }
                  fontFamily="body"
                >
                  {googleReconsentReason(
                    { ...workspaceBotStatus },
                    "workspace",
                  )}
                </Text>
              ) : (
                <Text fontSize="xs" color="green.700" fontFamily="body">
                  Google Docs and Google Slides access are ready.
                </Text>
              )}
            </>
          ) : null}
          {error ? (
            <Text fontSize="xs" color="red.700" fontFamily="body">
              {error}
            </Text>
          ) : null}
          <HStack>
            <Button
              size="sm"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              disabled={busy}
              onClick={connect}
            >
              {busy ? <Spinner size="xs" mr={2} /> : null}
              {workspaceBotStatus.connected
                ? workspaceNeedsReconsent
                  ? workspaceBotStatus.hasRefreshToken
                    ? "Update Workspace access"
                    : "Reconnect Workspace bot"
                  : "Change Workspace bot"
                : "Connect Workspace bot"}
            </Button>
          </HStack>
        </VStack>
      )}
    </Box>
  );
}

function PrinterInfoRow({
  scope,
  currentName,
  currentInstructions,
}: {
  scope: string | undefined;
  currentName: string | null;
  currentInstructions: string | null;
}) {
  const setPrinterInfo = useMutation(api.driveSyncState.setPrinterInfo);
  const [name, setName] = useState(currentName ?? "");
  const [instructions, setInstructions] = useState(currentInstructions ?? "");
  const [busy, setBusy] = useState(false);
  const dirty =
    name.trim() !== (currentName ?? "") ||
    instructions.trim() !== (currentInstructions ?? "");
  return (
    <Box>
      <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>
        SCANNER NAME &amp; INSTRUCTIONS
      </Text>
      <VStack align="stretch" gap={2}>
        <Input
          size="sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Brother MFC-L2750DW"
          bg="gray.50"
          fontFamily="body"
        />
        <Textarea
          size="sm"
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="How to scan, e.g. “Load pages face-up, press the green Scan-to-Drive button.”"
          bg="gray.50"
          fontFamily="body"
          rows={2}
        />
        <Button
          size="sm"
          variant="outline"
          fontFamily="heading"
          alignSelf="flex-end"
          disabled={busy || !dirty}
          onClick={async () => {
            setBusy(true);
            try {
              await setPrinterInfo({
                name: name.trim(),
                instructions: instructions.trim(),
                scope,
              });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? <Spinner size="xs" mr={2} /> : null}
          Save
        </Button>
      </VStack>
    </Box>
  );
}

/**
 * The school's sync IDENTITY block — the institution-owned credential the
 * importer calls Drive as. Two identity types:
 *   • Service account (recommended): paste the GCP key JSON; share the folder
 *     to its email. Least-privilege, survives staff churn, no personal Drive
 *     exposure.
 *   • Google account: a dedicated scanner consent requesting Drive read-only.
 */
function IdentityBlock({
  identity,
  busy,
  onConnectScanner,
  onSetServiceAccount,
}: {
  identity: {
    type: "google_oauth" | "service_account";
    email: string | null;
    scopes: string[];
  } | null;
  busy: ActionKind | null;
  onConnectScanner: () => void;
  onSetServiceAccount: (keyJson: string) => void;
}) {
  const [keyJson, setKeyJson] = useState("");
  const scannerNeedsReconnect =
    identity?.type === "google_oauth" &&
    (identity.scopes.length !== 1 ||
      identity.scopes[0] !==
        "https://www.googleapis.com/auth/drive.readonly");
  const [open, setOpen] = useState(!identity || scannerNeedsReconnect);

  return (
    <Box borderWidth="1px" borderColor="gray.100" borderRadius="md" p={4} bg="gray.50">
      <HStack justify="space-between" mb={2}>
        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">
          Scanner sync identity
        </Text>
        {identity ? (
          <Button
            size="2xs"
            variant="ghost"
            fontFamily="heading"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "Cancel" : "Change"}
          </Button>
        ) : null}
      </HStack>

      {identity ? (
        <>
          <HStack gap={2} mb={open ? 3 : 0} wrap="wrap">
            <Badge
              bg={identity.type === "service_account" ? "violet.100" : "blue.100"}
              color={identity.type === "service_account" ? "violet.700" : "blue.700"}
              fontSize="2xs"
              fontFamily="heading"
            >
              <HStack gap={1}>
                {identity.type === "service_account" ? (
                  <ShieldCheck weight="fill" />
                ) : (
                  <UserCircle weight="fill" />
                )}
                <Text>
                  {identity.type === "service_account"
                    ? "Service account"
                    : "Google account"}
                </Text>
              </HStack>
            </Badge>
            <Text fontSize="sm" color="charcoal.500" fontFamily="mono">
              {identity.email ?? "—"}
            </Text>
          </HStack>
          {scannerNeedsReconnect ? (
            <Text fontSize="xs" color="orange.700" fontFamily="body" mb={3}>
              This legacy scanner connection has broader Google access. Reconnect
              it below with Drive read-only access.
            </Text>
          ) : null}
        </>
      ) : (
        <Text fontSize="xs" color="charcoal.500" fontFamily="body" mb={3}>
          This school has no sync identity yet. Set one before connecting a
          folder — the importer calls Drive as this identity.
        </Text>
      )}

      {open || !identity ? (
        <VStack align="stretch" gap={4}>
          {/* Recommended: service account */}
          <Box>
            <HStack gap={1} mb={1}>
              <ShieldCheck weight="fill" color="var(--chakra-colors-violet-500)" />
              <Text fontSize="xs" color="charcoal.500" fontFamily="heading">
                SERVICE ACCOUNT (RECOMMENDED)
              </Text>
            </HStack>
            <Text fontSize="2xs" color="charcoal.400" fontFamily="body" mb={2}>
              Paste the downloaded GCP service-account key JSON. Then share the
              scanner&apos;s Drive folder with the service-account email (Viewer).
              Least-privilege — no domain-wide delegation, no personal Drive.
            </Text>
            <Textarea
              size="sm"
              value={keyJson}
              onChange={(e) => setKeyJson(e.target.value)}
              placeholder='{ "type": "service_account", "client_email": "…", "private_key": "<PEM private key>" }'
              bg="white"
              fontFamily="mono"
              fontSize="2xs"
              rows={4}
            />
            <Button
              size="sm"
              mt={2}
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              disabled={busy !== null || !keyJson.trim()}
              onClick={() => onSetServiceAccount(keyJson.trim())}
            >
              {busy === "identity" ? <Spinner size="xs" mr={2} /> : null}
              Save service account
            </Button>
          </Box>

          {/* Alternative: dedicated read-only Google account */}
          <Box borderTopWidth="1px" borderColor="gray.200" pt={3}>
            <HStack gap={1} mb={1}>
              <UserCircle weight="fill" color="var(--chakra-colors-blue-500)" />
              <Text fontSize="xs" color="charcoal.500" fontFamily="heading">
                OR A DRIVE-ONLY GOOGLE ACCOUNT
              </Text>
            </HStack>
            <Text fontSize="2xs" color="charcoal.400" fontFamily="body" mb={2}>
              Sign into the scanner&apos;s Google account. Rabbithole requests
              read-only Drive access for this inbox and no Docs or Slides access.
            </Text>
            <Button
              size="sm"
              variant="outline"
              fontFamily="heading"
              disabled={busy !== null}
              onClick={onConnectScanner}
            >
              {busy === "identity" ? <Spinner size="xs" mr={2} /> : null}
              {scannerNeedsReconnect
                ? "Reconnect scanner account"
                : "Connect scanner account"}
            </Button>
          </Box>
        </VStack>
      ) : null}
    </Box>
  );
}

/**
 * The connect-a-folder controls, shared between the first-time "Connect" state
 * and the configured "Switch folder" state. Two ways in: a visual Google
 * folder picker (uses YOUR personal link just to browse) and a paste-a-link/ID
 * fallback. The actual import calls Drive as the school's sync identity, set
 * separately above — so the paste path works even without a personal link.
 */
function ConnectControls({
  variant,
  googleLinked,
  identitySet,
  folderId,
  setFolderId,
  busy,
  onPick,
  onConnectManual,
}: {
  variant: "connect" | "switch";
  googleLinked: boolean;
  identitySet: boolean;
  folderId: string;
  setFolderId: (v: string) => void;
  busy: ActionKind | null;
  onPick: (doc: { id: string; name?: string }) => void;
  onConnectManual: () => void;
}) {
  const primary = variant === "connect";
  const ctaLabel = primary ? "Connect" : "Switch / reconnect";
  return (
    <VStack align="stretch" gap={3}>
      {!identitySet ? (
        <Box bg="orange.50" borderWidth="1px" borderColor="orange.200" borderRadius="md" p={3}>
          <Text fontSize="xs" color="charcoal.500" fontFamily="body">
            Set this school&apos;s sync identity above before connecting a folder.
          </Text>
        </Box>
      ) : null}

      {/* Primary path: visual folder picker (browses via your personal link). */}
      <HStack gap={2} wrap="wrap">
        <GooglePickerButton
          mode="folders"
          label="Pick a folder"
          icon={<FolderOpen />}
          disabled={busy !== null || !googleLinked || !identitySet}
          onPicked={onPick}
        />
        <Text fontSize="xs" color="charcoal.400" fontFamily="body">
          Choose the classroom scanner&apos;s Drive folder.
        </Text>
      </HStack>
      {!googleLinked ? (
        <Box>
          <Text fontSize="2xs" color="charcoal.400" fontFamily="body" mb={1}>
            Connect your personal Google account to browse Drive, or paste the
            folder link below.
          </Text>
          <GoogleAccountConnect
            returnTo={RETURN_TO}
            compact
            requiredAccess="drive"
          />
        </Box>
      ) : null}

      {/* Fallback: paste a link or ID. */}
      <Box>
        <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" mb={1}>
          OR PASTE A FOLDER LINK / ID
        </Text>
        <HStack gap={2}>
          <Input
            size="sm"
            value={folderId}
            onChange={(e) => setFolderId(e.target.value)}
            placeholder="https://drive.google.com/drive/folders/… — or the ID"
            bg="gray.50"
            fontFamily="mono"
          />
          <Button
            size="sm"
            {...(primary
              ? { bg: "violet.500", color: "white", _hover: { bg: "violet.600" } }
              : { variant: "outline" as const })}
            fontFamily="heading"
            flexShrink={0}
            disabled={busy !== null || !folderId.trim() || !identitySet}
            onClick={onConnectManual}
          >
            {busy === "connect" ? <Spinner size="xs" mr={2} /> : null}
            {ctaLabel}
          </Button>
        </HStack>
        <Text fontSize="2xs" color="charcoal.400" fontFamily="body" mt={1}>
          Open the folder in Google Drive and copy the address-bar URL.
        </Text>
      </Box>
    </VStack>
  );
}

/** Institution switcher — only rendered when the caller can act in >1 school. */
function InstitutionSwitcher({
  institutions,
  activeSlug,
  onSelect,
}: {
  institutions: {
    _id: string;
    slug: string;
    name: string;
    emoji: string | null;
    logoUrl: string | null;
    isPrimary: boolean;
  }[];
  activeSlug: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <Box mb={4}>
      <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>
        SCHOOL
      </Text>
      <HStack gap={2} wrap="wrap">
        {institutions.map((inst) => {
          const active =
            activeSlug === inst.slug ||
            (activeSlug === "" && inst.isPrimary);
          return (
            <Button
              key={inst._id}
              size="xs"
              fontFamily="heading"
              variant={active ? "solid" : "outline"}
              {...(active
                ? { bg: "navy.500", color: "white", _hover: { bg: "navy.600" } }
                : {})}
              onClick={() => onSelect(inst.isPrimary ? "" : inst.slug)}
            >
              <InstitutionMark
                logoUrl={inst.logoUrl}
                emoji={inst.emoji}
                name={inst.name}
                size={14}
                style={{ marginRight: 6 }}
              />
              {inst.name}
            </Button>
          );
        })}
      </HStack>
    </Box>
  );
}

export function DriveSyncAdmin() {
  const [scopeSlug, setScopeSlug] = useState("");
  const scope = scopeSlug || undefined;

  const institutions = useQuery(api.institutions.list, {});
  const status = useQuery(api.driveSyncState.status, { scope });
  const googleStatus = useQuery(api.googleAccounts.status);
  const beginScannerOAuth = useAction(api.driveSync.beginScannerOAuth);
  const setIdentityServiceAccount = useAction(api.driveSync.setIdentityServiceAccount);
  const connectFolder = useAction(api.driveSync.connectFolder);
  const syncNow = useAction(api.driveSync.syncNow);
  const stopWatch = useAction(api.driveSync.stopWatch);

  const [folderId, setFolderId] = useState("");
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, setPending] = useState<{
    which: ActionKind;
    fn: () => Promise<string>;
  } | null>(null);

  const googleLinked = !!(
    googleStatus?.connected &&
    !needsGoogleReconsent(googleStatus, "drive")
  );
  const identity = status?.identity ?? null;
  const identitySet = !!identity;
  const showSwitcher = (institutions?.length ?? 0) > 1;

  const run = async (which: ActionKind, fn: () => Promise<string>) => {
    setBusy(which);
    setError(null);
    setMsg(null);
    try {
      setMsg(await fn());
      setPending(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPending({ which, fn });
    } finally {
      setBusy(null);
    }
  };

  const connectWith = (raw: string, name?: string) => async (): Promise<string> => {
    const id = extractDriveFolderId(raw);
    if (!id) {
      throw new Error(
        "That doesn't look like a Google Drive folder link or ID. Open the folder in Drive and copy the URL from the address bar — or use “Pick a folder”.",
      );
    }
    const r = await connectFolder({ folderId: id, scope });
    const label = name ? `“${name}”` : `folder ${id}`;
    return `Connected to ${label} as ${r.identityEmail}. Initial sync: ${r.initial?.ingested ?? 0} new item(s).`;
  };

  const onPickFolder = (doc: { id: string; name?: string }) => {
    setFolderId(doc.id);
    run("connect", connectWith(doc.id, doc.name));
  };

  const onConnectScanner = async () => {
    setBusy("identity");
    setError(null);
    try {
      const { url } = await beginScannerOAuth({
        scope,
        returnTo: RETURN_TO,
      });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  };

  const onSetServiceAccount = (keyJson: string) =>
    run("identity", async () => {
      const r = await setIdentityServiceAccount({ scope, keyJson });
      return r.shareHint;
    });

  const errorTitle =
    pending?.which === "sync"
      ? "Sync failed"
      : pending?.which === "stop"
        ? "Couldn't stop the watch"
        : pending?.which === "identity"
          ? "Couldn't set the sync identity"
          : "Couldn't connect the folder";

  const schoolName = status?.institution?.name ?? null;

  return (
    <VStack align="stretch" gap={5}>
      <Box bg="white" borderRadius="xl" shadow="sm" p={5}>
      <Heading fontFamily="heading" color="navy.500" size="md" mb={1}>
        Scanner Drive inbox
      </Heading>
      <Text fontSize="sm" color="charcoal.400" fontFamily="body" mb={4}>
        The classroom printer&apos;s Drive folder that auto-imports scanned work
        into {schoolName ? `${schoolName}'s` : "this school's"} scholar
        portfolios. Each school syncs as its own institution-owned identity.
        (Connecting requires the deployed HTTPS app.)
      </Text>

      {showSwitcher && institutions ? (
        <InstitutionSwitcher
          institutions={institutions}
          activeSlug={scopeSlug}
          onSelect={setScopeSlug}
        />
      ) : null}

      {error ? (
        <Box bg="red.50" borderWidth="1px" borderColor="red.200" borderRadius="md" p={4}>
          <HStack gap={2} color="red.700" mb={1}>
            <WarningCircle />
            <Text fontWeight="600" fontSize="sm" fontFamily="heading">
              {errorTitle}
            </Text>
          </HStack>
          <Text fontSize="xs" color="red.700" fontFamily="body" mb={3}>
            {cleanError(error)}
          </Text>
          <HStack gap={2}>
            <Button
              size="sm"
              variant="outline"
              fontFamily="heading"
              onClick={() => {
                setError(null);
                setPending(null);
              }}
            >
              Dismiss
            </Button>
            {pending && (
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                loading={busy !== null}
                onClick={() => run(pending.which, pending.fn)}
              >
                <ArrowClockwise style={{ marginRight: "4px" }} /> Retry
              </Button>
            )}
          </HStack>
        </Box>
      ) : status === undefined ? (
        <VStack align="stretch" gap={3} aria-hidden>
          <HStack gap={2}>
            <Skeleton height="18px" w="92px" borderRadius="full" />
            <Skeleton height="12px" w="180px" borderRadius="sm" />
          </HStack>
          <Skeleton height="10px" w="240px" borderRadius="sm" />
          <Skeleton height="64px" borderRadius="md" />
          <HStack gap={2}>
            <Skeleton height="32px" w="120px" borderRadius="md" />
            <Skeleton height="32px" w="96px" borderRadius="md" />
          </HStack>
        </VStack>
      ) : status.configured ? (
        <VStack align="stretch" gap={3}>
          <HStack gap={2} wrap="wrap">
            <Badge
              bg={status.watchActive ? "green.100" : "orange.100"}
              color={status.watchActive ? "green.700" : "orange.700"}
              fontSize="2xs"
              fontFamily="heading"
            >
              {status.watchActive ? "Watch active" : "Watch inactive"}
            </Badge>
            <Text fontSize="sm" color="charcoal.500" fontFamily="body">
              {status.identity?.email ?? status.syncOwnerEmail ?? "—"}
              {status.lastSyncedAt ? ` · synced ${formatTimeAgo(status.lastSyncedAt)}` : ""}
            </Text>
          </HStack>
          <Text fontSize="xs" color="charcoal.400" fontFamily="mono">
            folder: {status.folderId}
          </Text>

          <IdentityBlock
            identity={identity}
            busy={busy}
            onConnectScanner={onConnectScanner}
            onSetServiceAccount={onSetServiceAccount}
          />

          <PrinterInfoRow
            key={`${status.printerName ?? ""}|${status.printerInstructions ?? ""}`}
            scope={scope}
            currentName={status.printerName}
            currentInstructions={status.printerInstructions}
          />
          {status.lastError && (
            <HStack gap={2} color="red.600">
              <WarningCircle />
              <Text fontSize="xs" fontFamily="body">
                Last sync issue: {cleanError(status.lastError)}
              </Text>
            </HStack>
          )}

          <Box borderTopWidth="1px" borderColor="gray.100" pt={3}>
            <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={2}>
              SWITCH FOLDER
            </Text>
            <ConnectControls
              variant="switch"
              googleLinked={googleLinked}
              identitySet={identitySet}
              folderId={folderId}
              setFolderId={setFolderId}
              busy={busy}
              onPick={onPickFolder}
              onConnectManual={() => run("connect", connectWith(folderId))}
            />
          </Box>

          <HStack gap={2}>
            <Button
              size="sm"
              variant="outline"
              fontFamily="heading"
              disabled={busy !== null}
              onClick={() =>
                run("sync", async () => {
                  const r = await syncNow({ scope });
                  return `Sync done: ${r?.ingested ?? 0} new, ${r?.skipped ?? 0} skipped.`;
                })
              }
            >
              {busy === "sync" ? <Spinner size="xs" mr={2} /> : <ArrowClockwise style={{ marginRight: "4px" }} />}
              Sync now
            </Button>
            <Button
              size="sm"
              variant="ghost"
              color="red.500"
              fontFamily="heading"
              _hover={{ bg: "red.50" }}
              disabled={busy !== null || !status.watchActive}
              onClick={() =>
                run("stop", async () => {
                  await stopWatch({ scope });
                  return "Watch stopped.";
                })
              }
            >
              {busy === "stop" ? <Spinner size="xs" mr={2} /> : null}
              Stop watch
            </Button>
          </HStack>
        </VStack>
      ) : (
        // Not configured yet: set identity first, then connect a folder.
        <VStack align="stretch" gap={4}>
          <IdentityBlock
            identity={identity}
            busy={busy}
            onConnectScanner={onConnectScanner}
            onSetServiceAccount={onSetServiceAccount}
          />
          <ConnectControls
            variant="connect"
            googleLinked={googleLinked}
            identitySet={identitySet}
            folderId={folderId}
            setFolderId={setFolderId}
            busy={busy}
            onPick={onPickFolder}
            onConnectManual={() => run("connect", connectWith(folderId))}
          />
        </VStack>
      )}

      {msg && (
        <Text fontSize="xs" color="green.600" fontFamily="body" mt={3}>
          {msg}
        </Text>
      )}
      </Box>
      <WorkspaceBotCard scope={scope} />
    </VStack>
  );
}

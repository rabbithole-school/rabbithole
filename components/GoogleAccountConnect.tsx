"use client";

import { useEffect, useState } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button, HStack, Spinner, Text, VStack } from "@chakra-ui/react";
import { Link } from "@phosphor-icons/react";
import {
  googleReconsentReason,
  needsGoogleReconsent,
  type GoogleAccessRequirement,
} from "./googleConsentStatus";

/**
 * Map the `googleError` query param the OAuth callback may add when
 * something goes wrong server-side into a human-readable line. Returns
 * null for unknown codes (defensive — don't render arbitrary strings
 * from the URL).
 */
function describeGoogleError(code: string): string | null {
  if (code === "already_linked") {
    return "That Google account is already linked to a different Rabbithole user. Sign in to that user, or pick a different Google account.";
  }
  if (code === "google_link_failed") {
    return "Could not link your Google account. Try again, or contact support if it keeps failing.";
  }
  return null;
}

/**
 * Tiny "Connect / Disconnect Google" widget. Shows the linked account's
 * email when connected. Drop this into Settings or anywhere a teacher
 * needs to manage the Rabbithole ↔ Google link.
 *
 * The "Connect" button calls a Convex action that returns a signed
 * authorization URL, then we navigate the browser to it. Google
 * redirects back to the Convex `/google/oauth/callback` route, which
 * stores tokens and redirects back into the app.
 */
export function GoogleAccountConnect({
  returnTo,
  compact = false,
  hideLabel = false,
  textSize = "xs",
  requiredAccess = "all",
}: {
  /** Path to come back to after consent. Default: current page. */
  returnTo?: string;
  /** Render as a single-line row instead of a labeled block. */
  compact?: boolean;
  /** In compact mode, omit the leading "Google: " prefix when the
   *  surrounding form already labels the row. */
  hideLabel?: boolean;
  /** Text size for the email line in compact mode. */
  textSize?: "xs" | "sm" | "md";
  /** Capability this placement needs; the profile default describes the full link. */
  requiredAccess?: GoogleAccessRequirement;
}) {
  const status = useQuery(api.googleAccounts.status);
  const beginOAuth = useAction(api.googleAccountsActions.beginOAuth);
  const disconnect = useAction(api.googleAccountsActions.disconnect);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // The OAuth callback may redirect back here with `?googleError=...`
  // when token persistence fails. Read it once on mount, show a banner,
  // and strip the param from the URL so the message doesn't reappear
  // on refresh.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const code = url.searchParams.get("googleError");
    if (!code) return;
    const desc = describeGoogleError(code);
    if (desc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot read of URL state on mount
      setErrorMessage(desc);
    }
    url.searchParams.delete("googleError");
    window.history.replaceState(
      window.history.state,
      "",
      url.pathname + url.search + url.hash
    );
  }, []);

  // Wrap any rendered output with the error banner when present so the
  // message reaches the user regardless of which branch rendered.
  const wrap = (node: React.ReactNode) =>
    errorMessage ? (
      <VStack align="stretch" gap={1.5}>
        <Text
          fontSize="xs"
          color="red.500"
          fontFamily="body"
          lineHeight="1.4"
        >
          {errorMessage}
        </Text>
        {node}
      </VStack>
    ) : (
      <>{node}</>
    );

  if (status === undefined) {
    return wrap(<Spinner size="sm" />);
  }

  const handleConnect = async () => {
    setBusy(true);
    try {
      const path =
        returnTo ??
        (typeof window !== "undefined"
          ? window.location.pathname + window.location.search
          : "/teacher");
      const { url } = await beginOAuth({ returnTo: path });
      window.location.assign(url);
    } catch (e) {
      setBusy(false);
      alert(
        e instanceof Error
          ? e.message
          : "Could not start Google sign-in. Check Convex env vars."
      );
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Disconnect Google account from Rabbithole?")) return;
    setBusy(true);
    try {
      await disconnect();
    } finally {
      setBusy(false);
    }
  };

  if (status.connected) {
    const stale = needsGoogleReconsent(status, requiredAccess);
    const staleNote = stale
      ? googleReconsentReason(status, requiredAccess)
      : null;
    const staleColor = status.hasRefreshToken ? "orange.600" : "red.500";
    const staleAction = status.hasRefreshToken ? "Update access" : "Reconnect";
    const staleSuffix = status.hasRefreshToken
      ? " · access update needed"
      : " · reconnect needed";
    if (compact) {
      return wrap(
        <VStack align="start" gap={1}>
          <Text
            fontSize={textSize}
            color={stale ? staleColor : "charcoal.400"}
            fontFamily="body"
          >
            {hideLabel ? status.email : `Google: ${status.email}`}
            {stale ? staleSuffix : ""}
          </Text>
          {staleNote && (
            <Text fontSize="2xs" color={staleColor} fontFamily="body">
              {staleNote}
            </Text>
          )}
          <HStack gap={2}>
            {stale && (
              <Button
                size="2xs"
                variant="outline"
                onClick={handleConnect}
                disabled={busy}
                fontFamily="heading"
              >
                {staleAction}
              </Button>
            )}
            <Button
              size="2xs"
              variant="outline"
              onClick={handleDisconnect}
              disabled={busy}
              fontFamily="heading"
            >
              Disconnect
            </Button>
          </HStack>
        </VStack>
      );
    }
    return wrap(
      <VStack align="stretch" gap={1}>
        <Text fontFamily="heading" fontSize="sm" color="navy.500">
          Google account
        </Text>
        <HStack gap={2}>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500">
            Connected as <strong>{status.email}</strong>
          </Text>
          {stale && (
            <Button
              size="xs"
              variant="outline"
              onClick={handleConnect}
              disabled={busy}
              fontFamily="heading"
            >
              {staleAction}
            </Button>
          )}
          <Button
            size="xs"
            variant="outline"
            onClick={handleDisconnect}
            disabled={busy}
            fontFamily="heading"
          >
            Disconnect
          </Button>
        </HStack>
        {staleNote && (
          <Text fontSize="xs" color={staleColor} fontFamily="body">
            {staleNote}
          </Text>
        )}
      </VStack>
    );
  }

  if (compact) {
    return wrap(
      <Button
        size="xs"
        variant="outline"
        fontFamily="heading"
        onClick={handleConnect}
        disabled={busy}
      >
        <Link style={{ marginRight: 6 }} />
        Connect Google
      </Button>
    );
  }

  return wrap(
    <VStack align="stretch" gap={1}>
      <Text fontFamily="heading" fontSize="sm" color="navy.500">
        Google account
      </Text>
      <Text fontFamily="body" fontSize="xs" color="charcoal.400">
        One personal connection supports Google Docs, Google Slides, and Drive
        workflows, including the file picker.
      </Text>
      <HStack>
        <Button
          size="sm"
          variant="outline"
          fontFamily="heading"
          onClick={handleConnect}
          disabled={busy}
        >
          <Link style={{ marginRight: 6 }} />
          Connect Google
        </Button>
      </HStack>
    </VStack>
  );
}

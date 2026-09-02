"use client";

import { useState, useEffect } from "react";
import { useQuery, useAction, useMutation } from "convex/react";
import {
  Box,
  Button,
  HStack,
  IconButton,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Trash, Key } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/relativeTime";
import {
  runPasskeyRegistration,
  isPasskeyCancellation,
  browserSupportsWebAuthn,
  guessDeviceLabel,
  relatedOriginPasskeyFallbackUrl,
} from "@/lib/passkeyClient";
import { PasskeyRelatedOriginFallback } from "@/components/PasskeyRelatedOriginFallback";

/**
 * Self-service passkey management for the signed-in user: list, add, and
 * remove their own passkeys. Renders as the right-hand content of a
 * label-left row inside the Account Details modal (the "Passkeys" label is
 * supplied by the parent).
 */
export function PasskeyManager() {
  const passkeys = useQuery(api.passkeys.listMine);
  const startEnroll = useAction(api.passkeys.startEnrollment);
  const finishEnroll = useAction(api.passkeys.finishEnrollment);
  const deleteMine = useMutation(api.passkeys.deleteMine);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [passkeyFallbackUrl, setPasskeyFallbackUrl] = useState<string | null>(null);

  // Deferred past SSR to avoid a hydration mismatch (navigator is absent
  // server-side). Assume supported for the first render, correct after mount.
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only capability check, deferred past SSR to avoid a hydration mismatch
    setSupported(browserSupportsWebAuthn());
  }, []);
  // Has passkeys, but none sync across devices (all device-bound) → if this
  // device is lost they're locked out. Nudge them to add a synced one.
  const needsSyncedBackup =
    !!passkeys &&
    passkeys.length > 0 &&
    !passkeys.some((p) => p.deviceType === "multiDevice");

  const handleAdd = async () => {
    setBusy(true);
    setError("");
    setPasskeyFallbackUrl(null);
    try {
      await runPasskeyRegistration({
        start: () => startEnroll({}),
        finish: (args: {
          challengeId: Id<"webauthnChallenges">;
          response: string;
          label?: string;
        }) => finishEnroll(args),
        label: guessDeviceLabel(),
      });
    } catch (err) {
      const fallbackUrl = relatedOriginPasskeyFallbackUrl(err, window.location);
      if (fallbackUrl) {
        setError("This browser can’t set up a passkey on rabbithole.school.");
        setPasskeyFallbackUrl(fallbackUrl);
      } else if (!isPasskeyCancellation(err)) {
        console.error("Add passkey failed:", err);
        setError(
          err instanceof Error ? err.message : "Could not add that passkey.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = (passkeyId: Id<"passkeys">) => {
    setPasskeyFallbackUrl(null);
    void deleteMine({ passkeyId });
  };

  return (
    <VStack align="stretch" gap={2} flex={1}>
      <HStack>
        <Button
          size="xs"
          variant="outline"
          fontFamily="heading"
          disabled={!supported || busy}
          onClick={handleAdd}
        >
          <Key style={{ marginRight: 6 }} />
          {busy ? "Waiting…" : "Add passkey"}
        </Button>
      </HStack>

      {!supported && (
        <Text fontSize="sm" color="red.500" fontFamily="body">
          This browser doesn&apos;t support passkeys.
        </Text>
      )}
      {error && (
        <Text fontSize="sm" color="red.500" fontFamily="body" role="alert">
          {error}
        </Text>
      )}
      {passkeyFallbackUrl && (
        <PasskeyRelatedOriginFallback href={passkeyFallbackUrl} />
      )}

      {needsSyncedBackup && (
        <Box
          borderWidth="1px"
          borderColor="orange.200"
          bg="orange.50"
          borderRadius="lg"
          px={4}
          py={3}
        >
          <Text fontFamily="body" fontSize="sm" color="charcoal.500">
            None of your passkeys sync across devices, so you could get locked
            out if you lose this one. We recommend adding a passkey that syncs
            to iCloud Keychain or Google.
          </Text>
        </Box>
      )}

      {passkeys && passkeys.length === 0 ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          No passkeys yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {passkeys?.map((p) => (
            <HStack
              key={p._id}
              justify="space-between"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="lg"
              px={4}
              py={3}
            >
              <Box>
                <Text fontFamily="body" fontWeight="500">
                  {p.label ?? "Passkey"}
                  {p.backedUp ? " · synced" : ""}
                </Text>
                <Text fontFamily="body" fontSize="xs" color="charcoal.400">
                  Added {formatRelative(p.createdAt)}
                  {p.lastUsedAt
                    ? ` · last used ${formatRelative(p.lastUsedAt)}`
                    : " · never used"}
                </Text>
              </Box>
              <IconButton
                aria-label="Remove passkey"
                size="xs"
                variant="ghost"
                color="charcoal.300"
                _hover={{ color: "red.500", bg: "red.50" }}
                onClick={() => handleDelete(p._id)}
              >
                <Trash size={14} />
              </IconButton>
            </HStack>
          ))}
        </VStack>
      )}
    </VStack>
  );
}

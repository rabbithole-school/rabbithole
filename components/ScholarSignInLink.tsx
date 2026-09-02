"use client";

import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Copy, Check } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import {
  NO_USERNAME_GUIDANCE,
  ISSUE_FAILED_GUIDANCE,
  canIssueSignInLink,
  passwordActionLabel,
} from "@/components/scholarSignInLinkUtils";

// Shared password affordance for a scholar — "Create password" when they've
// never had one, "Reset password" once they do. Scholars sign in with a
// username + password, and this deliberately does NOT store or show a
// credential: it issues a one-time /enroll link (issueScholarEnrollLink) the
// scholar opens to CHOOSE their own password, which the redeem action then
// writes server-side (see convex/enrollment.ts).
//
// ⚠️ The link is a WEB URL, so it is NOT reachable from a locked-down fleet
// iPad: Safari and Mail are not in the app allowlist
// (mdm/profiles/app-allowlist.mobileconfig), and the native app has no /enroll
// route. The copy below therefore points the operator at a browser, not at the
// scholar's iPad. Signing a fleet iPad in is a separate mechanism (managed
// claims / device pairing — convex/managedDeviceClaims.ts,
// convex/devicePairing.ts).
//
// Used by the school-admin Scholars tab: the add-scholar success state and the
// per-row Create/Reset password action.

type ScholarSignInLinkPanelProps = {
  scholarId: Id<"users">;
  scholarName: string;
  /** The scholar's login username, if set. A link can't be issued without one. */
  username: string | null | undefined;
  /**
   * Whether the scholar already has a stored password. Selects the "Create
   * password" vs "Reset password" wording. Undefined/false → Create (the safe
   * default for a brand-new scholar).
   */
  hasCredential?: boolean;
};

/**
 * Issues (on mount) and renders a one-time sign-in link for a scholar, with a
 * copy button and a plain sentence. Handles the no-username case with
 * actionable guidance instead of a silent failure.
 */
export function ScholarSignInLinkPanel({
  scholarId,
  scholarName,
  username,
  hasCredential,
}: ScholarSignInLinkPanelProps) {
  const issueLink = useMutation(api.enrollment.issueScholarEnrollLink);
  const [link, setLink] = useState("");
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const startedRef = useRef(false);
  const isReset = hasCredential === true;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    if (!canIssueSignInLink(username)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- report the synchronous request-validation failure in this one-shot link lifecycle.
      setStatus("error");
      setError(NO_USERNAME_GUIDANCE);
      return;
    }
    (async () => {
      try {
        const result = await issueLink({ userId: scholarId });
        setLink(window.location.origin + result.path);
        setStatus("ready");
      } catch (err) {
        // Prod redacts thrown Error messages to "Server Error", so surface
        // actionable guidance rather than the raw string.
        console.error("Issue scholar sign-in link failed:", err);
        setStatus("error");
        setError(ISSUE_FAILED_GUIDANCE);
      }
    })();
  }, [issueLink, scholarId, username]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail (permissions / insecure context) — the link is still
      // selectable in the field.
    }
  };

  if (status === "loading") {
    return (
      <HStack gap={2} py={2} color="charcoal.400">
        <Spinner size="sm" color="violet.500" />
        <Text fontSize="sm" fontFamily="body">
          Creating a link…
        </Text>
      </HStack>
    );
  }

  if (status === "error") {
    return (
      <Text fontSize="sm" fontFamily="body" color="red.500">
        {error}
      </Text>
    );
  }

  return (
    <VStack gap={3} align="stretch">
      <Box>
        <Text fontSize="xs" fontFamily="heading" color="charcoal.500" mb={1}>
          Username
        </Text>
        <Text fontFamily="mono" fontSize="sm" color="navy.500">
          {username}
        </Text>
      </Box>
      <Box>
        <Text fontSize="xs" fontFamily="heading" color="charcoal.500" mb={1}>
          One-time link
        </Text>
        <HStack gap={2}>
          <Input
            value={link}
            readOnly
            aria-label="One-time sign-in link"
            onFocus={(e) => e.target.select()}
            size="sm"
            fontFamily="mono"
            fontSize="xs"
            borderColor="gray.300"
          />
          <Button
            size="sm"
            variant="outline"
            borderColor="gray.200"
            fontFamily="heading"
            flexShrink={0}
            onClick={copy}
          >
            {copied ? (
              <Check style={{ marginRight: "6px" }} />
            ) : (
              <Copy style={{ marginRight: "6px" }} />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </HStack>
      </Box>
      <Text fontSize="sm" fontFamily="body" color="charcoal.500">
        {scholarName} opens this one-time link in a browser to{" "}
        {isReset ? "choose a new password" : "choose their password"}, then
        signs in with their username and that password.{" "}
        {isReset ? "Their old password keeps working until they do. " : ""}
        Open it on a computer next to them, or copy the link to send.
      </Text>
      <Text fontSize="xs" fontFamily="body" color="charcoal.400">
        A locked-down school iPad can&apos;t open this link — those sign in
        through device setup instead.
      </Text>
    </VStack>
  );
}

/**
 * Dialog wrapper around {@link ScholarSignInLinkPanel} for the per-row Create/
 * Reset password action ("kid forgot their password" / "I created them
 * yesterday").
 */
export function ScholarSignInLinkDialog({
  scholarId,
  scholarName,
  username,
  hasCredential,
  open,
  onClose,
}: ScholarSignInLinkPanelProps & { open: boolean; onClose: () => void }) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title
                fontFamily="heading"
                fontSize="lg"
                color="navy.500"
              >
                {passwordActionLabel(hasCredential)}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              {open && (
                <ScholarSignInLinkPanel
                  scholarId={scholarId}
                  scholarName={scholarName}
                  username={username}
                  hasCredential={hasCredential}
                />
              )}
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2}>
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={onClose}
              >
                Done
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

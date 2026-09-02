"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { useSignOut } from "@/hooks/useSignOut";
import { api } from "@/convex/_generated/api";
import {
  Box,
  Button,
  Dialog,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import {
  MIN_PASSWORD_LENGTH,
  normalizePassword,
  passwordsMatch,
} from "@/shared/password";

interface SetPasswordDialogProps {
  open: boolean;
  onClose: () => void;
  requireCurrentPassword: boolean;
}

export function SetPasswordDialog({
  open,
  onClose,
  requireCurrentPassword,
}: SetPasswordDialogProps) {
  const router = useRouter();
  // Escape hatch for the forced (non-dismissible) reset: reliably lands on
  // /sign-in so a stuck scholar can hand control back to their teacher.
  const [signOutAndRedirect, isSigningOut] = useSignOut();
  const setMyPassword = useAction(api.accountPassword.setMyPassword);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const reset = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
    setIsSubmitting(false);
  };

  const handleSubmit = async () => {
    setError("");
    const normalizedNewPassword = normalizePassword(newPassword);

    if (normalizedNewPassword.length < MIN_PASSWORD_LENGTH) {
      setError(
        `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      );
      return;
    }
    if (!passwordsMatch(newPassword, confirmPassword)) {
      setError("Passwords don't match");
      return;
    }

    setIsSubmitting(true);

    try {
      // One server-side call does the whole thing: it re-verifies the current
      // password, swaps the secret in place, clears mustResetPassword, and
      // signs the user's OTHER devices out.
      //
      // This replaces a client-side delete → signOut → signUp sequence that had
      // to be retired for two reasons. It left the account with NO credential
      // between the delete and the re-signUp, so anyone who knew the username
      // could win that race; and its final `flow: "signUp"` arrived
      // unauthenticated (signOut had already run), making it indistinguishable
      // from an attacker claiming a username — which is what blocked closing
      // the username-coupon hole. See convex/accountPassword.ts.
      await setMyPassword({
        ...(requireCurrentPassword
          ? { currentPassword }
          : {}),
        newPassword: normalizedNewPassword,
      });

      // The session survives, so there is nothing to sign back in to — just
      // land on "/" and let normal routing take over.
      reset();
      onClose();
      router.replace("/");
    } catch (err) {
      console.error("Password change failed:", err);
      // The action's messages are the actionable ones ("Current password is
      // incorrect."). Prod redacts thrown Error text to "Server Error", so fall
      // back to something generic rather than showing that.
      const raw = err instanceof Error ? err.message : "";
      setError(
        /current password is incorrect/i.test(raw)
          ? "Current password is incorrect"
          : /at least \d+ characters/i.test(raw)
            ? raw
            : "Something went wrong. Please try again.",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open && !requireCurrentPassword) {
          // Non-dismissible for forced resets — do nothing
          return;
        }
        if (!e.open) {
          reset();
          onClose();
        }
      }}
      placement="center"
      closeOnInteractOutside={requireCurrentPassword}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent>
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                {requireCurrentPassword ? "Change Password" : "Set a New Password"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack gap={3} w="full">
                {!requireCurrentPassword && (
                  <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                    Your teacher has reset your password. Please set a new one to continue.
                  </Text>
                )}

                {requireCurrentPassword && (
                  <Box w="full">
                    <Text fontSize="xs" fontFamily="heading" color="charcoal.400" mb={1} fontWeight="500">
                      Current Password
                    </Text>
                    <Input
                      type="password"
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                      bg="gray.50"
                      border="1px solid"
                      borderColor="gray.300"
                      borderRadius="lg"
                      fontFamily="body"
                      h={10}
                      _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
                      _focusVisible={{ boxShadow: "none", outline: "none" }}
                      autoComplete="current-password"
                      autoFocus
                    />
                  </Box>
                )}

                <Box w="full">
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.400" mb={1} fontWeight="500">
                    New Password
                  </Text>
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                    bg="gray.50"
                    border="1px solid"
                    borderColor="gray.300"
                    borderRadius="lg"
                    fontFamily="body"
                    h={10}
                    _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
                    _focusVisible={{ boxShadow: "none", outline: "none" }}
                    autoComplete="new-password"
                    autoFocus={!requireCurrentPassword}
                  />
                  <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={1}>Must be at least 4 characters.</Text>
                </Box>

                <Box w="full">
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.400" mb={1} fontWeight="500">
                    Confirm New Password
                  </Text>
                  <Input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                    bg="gray.50"
                    border="1px solid"
                    borderColor="gray.300"
                    borderRadius="lg"
                    fontFamily="body"
                    h={10}
                    _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
                    _focusVisible={{ boxShadow: "none", outline: "none" }}
                    autoComplete="new-password"
                  />
                </Box>

                {error && (
                  <Text fontSize="sm" color="red.500" fontFamily="body">
                    {error}
                  </Text>
                )}

                {!requireCurrentPassword && (
                  <Text
                    fontSize="xs"
                    fontFamily="body"
                    color="charcoal.400"
                    alignSelf="flex-start"
                  >
                    Stuck? You can sign out and ask your teacher for help.
                  </Text>
                )}
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              {requireCurrentPassword ? (
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => {
                    reset();
                    onClose();
                  }}
                  disabled={isSubmitting}
                >
                  Cancel
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  color="charcoal.400"
                  mr="auto"
                  onClick={() => {
                    void signOutAndRedirect();
                  }}
                  disabled={isSubmitting || isSigningOut}
                >
                  {isSigningOut ? "Signing out..." : "Sign out"}
                </Button>
              )}
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={handleSubmit}
                disabled={isSubmitting || isSigningOut || !newPassword || !confirmPassword || (requireCurrentPassword && !currentPassword)}
              >
                {isSubmitting
                  ? "Saving..."
                  : requireCurrentPassword
                    ? "Change Password"
                    : "Set Password"}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

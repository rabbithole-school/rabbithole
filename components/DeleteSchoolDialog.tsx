"use client";

/**
 * DELETE SCHOOL — the confirmation surface for the most destructive operation
 * in the product. Deleting an institution cascade-deletes every scholar, staff
 * account, session, message, artifact, assignment, unit, guardianship link,
 * health record, invite, and usage event scoped to it. It is IRREVERSIBLE.
 *
 * The dialog enforces the safety model the server also enforces (defence in
 * depth — the button being disabled is never the only guard):
 *
 *   • PREVIEW BEFORE DESTROY — real counts from `previewDeletion`, not generic
 *     warning copy. The admin sees exactly what will be deleted.
 *   • TYPE-TO-CONFIRM — the destructive button stays disabled until the admin
 *     types the school's exact name (the server re-verifies it too).
 *   • PRIMARY IS UNDELETABLE — the primary school reports canDelete=false.
 *   • DELETING YOUR OWN SCHOOL — when this deletes the admin's own account
 *     (a school_admin removing their own school), we sign them out gracefully
 *     the instant the job is scheduled and land them on the unauthenticated
 *     /school-deleted confirmation page, rather than letting their next query
 *     crash against a vanished account. The delete runs server-side and cannot
 *     be interrupted by navigating away, so there is no second "Leave site?"
 *     prompt (Convex's beforeunload guard is disabled app-wide — see
 *     app/providers.tsx) and no spinner into nowhere.
 */
import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { useRouter } from "next/navigation";
import {
  Box,
  Button,
  Dialog,
  Grid,
  Heading,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Warning, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import {
  deleteSchoolCopy,
  type SchoolLifecycleNoun,
} from "@/components/schoolLifecycleCopy";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { toaster } from "@/lib/toaster";
import { useSignOut } from "@/hooks/useSignOut";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { postDeleteRedirect } from "@/lib/deleteSchoolNav";

interface DeleteSchoolDialogProps {
  open: boolean;
  onClose: () => void;
  institutionId: Id<"institutions">;
  schoolName: string;
  // The caller owns the vocabulary (T12): /school/settings passes "school",
  // /admin/institutions passes "institution". No default — every caller must
  // declare which word its surface speaks, so neither can silently inherit the
  // other's copy.
  noun: SchoolLifecycleNoun;
}

// The headline footprint rows the modal renders, in display order.
const FOOTPRINT_ROWS: Array<{
  key:
    | "scholars"
    | "staff"
    | "sessions"
    | "messages"
    | "artifacts"
    | "assignments"
    | "units"
    | "guardianships"
    | "healthRecords"
    | "invites"
    | "usageEvents"
    | "portfolioItems";
  label: string;
}> = [
  { key: "scholars", label: "Scholars" },
  { key: "staff", label: "Staff accounts" },
  { key: "sessions", label: "Sessions" },
  { key: "messages", label: "Messages" },
  { key: "artifacts", label: "Artifacts" },
  { key: "assignments", label: "Assignments" },
  { key: "units", label: "Curriculum units" },
  { key: "guardianships", label: "Guardian links" },
  { key: "healthRecords", label: "Health records" },
  { key: "invites", label: "Invites" },
  { key: "usageEvents", label: "AI usage events" },
  { key: "portfolioItems", label: "Portfolio items" },
];

export function DeleteSchoolDialog({
  open,
  onClose,
  institutionId,
  schoolName,
  noun,
}: DeleteSchoolDialogProps) {
  const copy = deleteSchoolCopy(noun);
  const router = useRouter();
  const [signOut] = useSignOut();
  const { user } = useCurrentUser();
  const isPlatformAdmin = isPlatformAdminRole(user?.role as Role | undefined);
  const preview = useQuery(
    api.institutionDeletion.previewDeletion,
    open ? { institutionId } : "skip",
  );
  const requestDeletion = useMutation(api.institutionDeletion.requestDeletion);

  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    if (submitting) return;
    setTyped("");
    onClose();
  };

  const nameMatches = typed.trim() === schoolName;
  const canSubmit =
    !!preview &&
    preview.canDelete &&
    nameMatches &&
    !submitting;

  const handleDelete = async () => {
    if (!canSubmit || !preview) return;
    setSubmitting(true);
    try {
      const res = await requestDeletion({
        institutionId,
        typedName: typed.trim(),
      });
      const destination = postDeleteRedirect({
        deletingSelf: res.deletingSelf,
        isPlatformAdmin,
      });
      if (res.deletingSelf) {
        // Deleting your own school deletes your own account — sign out before
        // the next query fires against a vanished user. The deletion is already
        // running server-side and CANNOT be interrupted by leaving, so we say
        // so and land on the calm, unauthenticated confirmation page instead of
        // /sign-in. useSignOut does a full-document navigation to `destination`.
        toaster.success({
          title: `Deleting ${schoolName}`,
          description:
            "This finishes on our servers even if you close this page. Signing you out…",
        });
        await signOut(destination);
        return;
      }
      toaster.success({
        title: `Deleting ${schoolName}`,
        description: copy.inProgressDescription,
      });
      handleClose();
      router.replace(destination);
    } catch (e) {
      toaster.error({
        title: copy.errorTitle,
        description: e instanceof Error ? e.message : String(e),
      });
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && handleClose()}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={6} pb={2}>
              <HStack gap={3} flex={1} minW={0} align="flex-start">
                <Box color="red.500" mt={1}>
                  <Warning size={24} weight="fill" />
                </Box>
                <Stack gap={0} flex={1} minW={0}>
                  <Text
                    fontSize="xs"
                    color="red.500"
                    fontFamily="heading"
                    fontWeight="700"
                    textTransform="uppercase"
                    letterSpacing="0.05em"
                  >
                    Danger — irreversible
                  </Text>
                  <Heading
                    size="md"
                    color="navy.500"
                    fontFamily="heading"
                    fontWeight="700"
                    lineClamp={2}
                  >
                    Delete {schoolName}
                  </Heading>
                </Stack>
              </HStack>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  onClick={handleClose}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body px={6} pb={6} pt={2}>
              {preview === undefined ? (
                <HStack py={8} justify="center" color="charcoal.400">
                  <Spinner size="sm" />
                  <Text fontFamily="body">Calculating what will be deleted…</Text>
                </HStack>
              ) : !preview.canDelete ? (
                <Box
                  bg="amber.50"
                  borderWidth="1px"
                  borderColor="amber.200"
                  borderRadius="lg"
                  p={4}
                >
                  <Text fontFamily="body" color="charcoal.600">
                    {preview.reason ?? copy.cannotDelete}
                  </Text>
                </Box>
              ) : (
                <VStack align="stretch" gap={4}>
                  <Text fontFamily="body" color="charcoal.600">
                    This permanently deletes <b>{schoolName}</b> and everything
                    below. This <b>cannot be undone</b>.
                  </Text>

                  <Box
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="lg"
                    overflow="hidden"
                  >
                    <Grid templateColumns="1fr auto" gap={0}>
                      {FOOTPRINT_ROWS.map((row, i) => (
                        <Box
                          key={row.key}
                          display="contents"
                        >
                          <Box
                            px={4}
                            py={2}
                            bg={i % 2 === 0 ? "gray.50" : "white"}
                            fontFamily="body"
                            fontSize="sm"
                            color="charcoal.500"
                          >
                            {row.label}
                          </Box>
                          <Box
                            px={4}
                            py={2}
                            bg={i % 2 === 0 ? "gray.50" : "white"}
                            fontFamily="heading"
                            fontWeight="700"
                            fontSize="sm"
                            color="navy.500"
                            textAlign="right"
                          >
                            {preview.footprint[row.key].toLocaleString()}
                            {preview.footprint.capped ? "+" : ""}
                          </Box>
                        </Box>
                      ))}
                    </Grid>
                  </Box>

                  {preview.footprint.survivingAccounts > 0 && (
                    <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                      {preview.footprint.survivingAccounts.toLocaleString()}{" "}
                      account
                      {preview.footprint.survivingAccounts === 1 ? "" : "s"} also{" "}
                      {copy.survivingAccountsClause}{" "}
                      and will be <b>kept</b> — only their {schoolName} membership
                      is removed.
                    </Text>
                  )}

                  {preview.deletingSelf && (
                    <Box
                      bg="amber.50"
                      borderWidth="1px"
                      borderColor="amber.200"
                      borderRadius="lg"
                      p={3}
                    >
                      <Text fontFamily="body" fontSize="sm" color="charcoal.600">
                        {copy.deletingSelf}
                      </Text>
                    </Box>
                  )}

                  <Box>
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize="sm"
                      color="charcoal.500"
                      mb={1}
                    >
                      Type <b>{schoolName}</b> to confirm
                    </Text>
                    <Input
                      value={typed}
                      onChange={(e) => setTyped(e.target.value)}
                      placeholder={schoolName}
                      disabled={submitting}
                      bg="gray.50"
                      fontFamily="body"
                      autoComplete="off"
                      aria-label={copy.confirmInputAriaLabel}
                    />
                  </Box>
                </VStack>
              )}
            </Dialog.Body>

            <Dialog.Footer px={6} pb={6} pt={0} gap={2}>
              <Button
                variant="ghost"
                fontFamily="heading"
                onClick={handleClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button
                bg="red.500"
                color="white"
                _hover={{ bg: "red.600" }}
                fontFamily="heading"
                onClick={() => void handleDelete()}
                disabled={!canSubmit}
                loading={submitting}
                loadingText="Deleting…"
              >
                {copy.confirmButton}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

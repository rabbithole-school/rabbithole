"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  HStack,
  IconButton,
  Input,
  Portal,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Trash, Plus, Link, Check } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";

/**
 * Scholar-admin (teacher / admin / operations staff) panel for a scholar's linked
 * parent accounts. Lives in the scholar's Account tab. Adding a parent and
 * generating a one-time sign-in link are both modals (the inline forms were
 * too cramped). A parent opens the link, sets up a passkey, and from then on
 * signs in passwordless — no email needed.
 */
export function ParentsManager({ scholarId }: { scholarId: Id<"users"> }) {
  const parents = useQuery(api.parents.listForScholar, { scholarId }) ?? [];
  const createParent = useMutation(api.parents.createParent);
  const unlinkGuardian = useMutation(api.parents.unlinkGuardian);
  const issueEnrollLink = useMutation(api.enrollment.issueParentEnrollLink);

  // Add-parent modal
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Sign-in-link modal
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const resetAdd = () => {
    setName("");
    setEmail("");
    setPhone("");
    setAddress("");
    setError("");
    setBusy(false);
  };

  const handleAdd = async () => {
    if (!name.trim() || !email.trim()) {
      setError("Name and email are required");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await createParent({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        address: address.trim() || undefined,
        scholarIds: [scholarId],
      });
      resetAdd();
      setAddOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const handleMakeLink = async (parentId: Id<"users">, parentName: string) => {
    setLinkBusy(true);
    setCopied(false);
    try {
      const res = await issueEnrollLink({ parentId });
      const url =
        (typeof window !== "undefined" ? window.location.origin : "") + res.path;
      setLink({ name: parentName, url });
    } catch (e) {
      console.error("Issue enroll link failed:", e);
    } finally {
      setLinkBusy(false);
    }
  };

  return (
    <Box bg="white" borderRadius="lg" p={5} shadow="xs">
      <HStack justify="space-between" mb={3}>
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm">
          Parents
        </Text>
        <Button
          size="2xs"
          variant="outline"
          fontFamily="heading"
          borderColor="gray.200"
          onClick={() => {
            resetAdd();
            setAddOpen(true);
          }}
        >
          <Plus style={{ marginRight: "4px" }} /> Add parent
        </Button>
      </HStack>

      {parents.length === 0 ? (
        <Text fontFamily="body" fontSize="xs" color="charcoal.300">
          No parents linked yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {parents.map((p) => (
            <HStack key={p.linkId} justify="space-between">
              <Box minW={0}>
                <Text fontFamily="body" fontSize="sm" color="charcoal.600" truncate>
                  {p.name ?? "Parent"}
                </Text>
                <Text fontFamily="body" fontSize="xs" color="charcoal.300" truncate>
                  {p.email ?? "no email"}
                </Text>
                {p.phone && (
                  <Text fontFamily="body" fontSize="xs" color="charcoal.300" truncate>
                    {p.phone}
                  </Text>
                )}
                {p.address && (
                  <Text fontFamily="body" fontSize="xs" color="charcoal.300" truncate>
                    {p.address}
                  </Text>
                )}
              </Box>
              <HStack gap={1} flexShrink={0}>
                <Button
                  size="2xs"
                  variant="outline"
                  fontFamily="heading"
                  borderColor="gray.200"
                  disabled={linkBusy}
                  onClick={() => handleMakeLink(p._id, p.name ?? "the parent")}
                >
                  <Link style={{ marginRight: "4px" }} /> Sign-in link
                </Button>
                <IconButton
                  aria-label="Unlink parent"
                  size="xs"
                  variant="ghost"
                  color="charcoal.300"
                  _hover={{ color: "red.500", bg: "red.50" }}
                  onClick={() =>
                    unlinkGuardian({ parentId: p._id, scholarId }).catch((e) =>
                      console.error("Unlink failed:", e),
                    )
                  }
                >
                  <Trash size={13} />
                </IconButton>
              </HStack>
            </HStack>
          ))}
        </VStack>
      )}

      {/* Add-parent modal */}
      <Dialog.Root
        open={addOpen}
        onOpenChange={(e) => {
          if (!e.open && !busy) setAddOpen(false);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="md">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Add a parent
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <VStack align="stretch" gap={3}>
                  <Box>
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      Parent name
                    </Text>
                    <Input
                      size="sm"
                      placeholder="e.g. Pat Nakamura"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      bg="gray.50"
                      fontFamily="body"
                      autoFocus
                    />
                  </Box>
                  <Box>
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      Email
                    </Text>
                    <Input
                      size="sm"
                      type="email"
                      placeholder="parent@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                      bg="gray.50"
                      fontFamily="body"
                    />
                    <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mt={1}>
                      Used to identify the account. They&apos;ll sign in with a
                      passkey via a link you generate next.
                    </Text>
                  </Box>
                  <Box>
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      Phone <Text as="span" color="charcoal.300">(optional)</Text>
                    </Text>
                    <Input
                      size="sm"
                      type="tel"
                      placeholder="(808) 555-0123"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      bg="gray.50"
                      fontFamily="body"
                    />
                  </Box>
                  <Box>
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      Address <Text as="span" color="charcoal.300">(optional)</Text>
                    </Text>
                    <Input
                      size="sm"
                      placeholder="123 Kalakaua Ave, Honolulu, HI 96815"
                      value={address}
                      onChange={(e) => setAddress(e.target.value)}
                      bg="gray.50"
                      fontFamily="body"
                    />
                  </Box>
                  {error && (
                    <Text fontSize="sm" color="red.500" fontFamily="body">
                      {error}
                    </Text>
                  )}
                </VStack>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
                <Button
                  variant="ghost"
                  fontFamily="heading"
                  size="sm"
                  color="charcoal.500"
                  onClick={() => setAddOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={handleAdd}
                  disabled={busy || !name.trim() || !email.trim()}
                  loading={busy}
                >
                  Add parent
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Sign-in-link modal */}
      <Dialog.Root
        open={!!link}
        onOpenChange={(e) => {
          if (!e.open) setLink(null);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="lg">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Sign-in link for {link?.name}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <VStack align="stretch" gap={3}>
                  <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                    Send this one-time link to {link?.name}. They open it, set up a
                    passkey (Face ID / Touch ID), and from then on sign in with no
                    password. <strong>Shown once.</strong>
                  </Text>
                  <HStack gap={2}>
                    <Input
                      value={link?.url ?? ""}
                      readOnly
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
                      onClick={() => {
                        if (link) navigator.clipboard.writeText(link.url);
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2000);
                      }}
                    >
                      {copied ? <Check style={{ marginRight: "4px" }} /> : <Link style={{ marginRight: "4px" }} />}
                      {copied ? "Copied" : "Copy"}
                    </Button>
                  </HStack>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2}>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={() => setLink(null)}
                >
                  Done
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}

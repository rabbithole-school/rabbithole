"use client";

// InvitesManager — the shared mint/list/lifecycle surface for institution invite
// codes, rendered on BOTH the platform-admin console (/admin/institutions —
// create-institution invites) and the school shell (/school/invites, join
// invites for the caller's own institution). One canonical rendering of an
// invite (link + status + uses) for both surfaces; the `variant` only swaps
// which backend functions it talks to and which kinds it can mint.
//
// Backend gates do the real enforcement: mintCreateInstitutionInvite /
// listInvites / revokeInvite / deleteInvite are platformAdminMutation|Query;
// mintJoinInvite / listJoinInvites / revokeJoinInvite / deleteJoinInvite are
// schoolAdminMutation|Query scoped to the caller's own institution.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  Heading,
  HStack,
  Input,
  Portal,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Copy, Prohibit, Ticket, Trash } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { TableRowsSkeleton } from "@/components/skeletons/PanelSkeletons";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { toaster } from "@/lib/toaster";
import {
  canRevokeInvite,
  type InviteStatus,
} from "@/components/invites/inviteStatus";
import { createdInstitutionLabel } from "@/components/invites/inviteInstitutionLabel";

type InviteRow = {
  _id: Id<"institutionInvites">;
  kind: "create_institution" | "join_institution";
  code: string;
  url: string;
  path: string;
  institutionId: Id<"institutions"> | null;
  createdInstitutionId: Id<"institutions"> | null;
  institutionName: string | null;
  redeemedBy: Id<"users"> | null;
  redeemedAt: number | null;
  role: string | null;
  label: string | null;
  createdAt: number;
  expiresAt: number | null;
  maxUses: number | null;
  usedCount: number;
  status: InviteStatus;
};

const STATUS_PALETTE: Record<InviteRow["status"], string> = {
  active: "green",
  revoked: "red",
  expired: "gray",
  exhausted: "orange",
};

const KIND_LABEL: Record<InviteRow["kind"], string> = {
  create_institution: "Create school",
  join_institution: "Join",
};

const EXPIRY_OPTIONS: Array<[string, number | null]> = [
  ["Never", null],
  ["7 days", 7],
  ["30 days", 30],
  ["90 days", 90],
];

async function copyLink(url: string) {
  try {
    await navigator.clipboard.writeText(url);
    toaster.success({ title: "Invite link copied" });
  } catch {
    toaster.error({
      title: "Copy failed",
      description: "Select the link and copy it manually.",
    });
  }
}

export function InvitesManager({ variant }: { variant: "admin" | "school" }) {
  const isAdmin = variant === "admin";

  // School variant honors the active institution lens; admin variant is global.
  const { scopeParam } = useActiveInstitution(!isAdmin);

  const adminRows = useQuery(
    api.institutionInvites.listInvites,
    isAdmin ? {} : "skip",
  );
  const schoolRows = useQuery(
    api.institutionInvites.listJoinInvites,
    isAdmin ? "skip" : { scope: scopeParam },
  );
  const rows = (isAdmin ? adminRows : schoolRows) as InviteRow[] | undefined;

  const revokeInvite = useMutation(api.institutionInvites.revokeInvite);
  const revokeJoinInvite = useMutation(api.institutionInvites.revokeJoinInvite);
  const deleteInvite = useMutation(api.institutionInvites.deleteInvite);
  const deleteJoinInvite = useMutation(api.institutionInvites.deleteJoinInvite);

  const [revokeBusy, setRevokeBusy] = useState<Id<"institutionInvites"> | null>(
    null,
  );
  const [deleteBusy, setDeleteBusy] = useState<Id<"institutionInvites"> | null>(
    null,
  );

  const handleRevoke = async (id: Id<"institutionInvites">) => {
    setRevokeBusy(id);
    try {
      if (isAdmin) await revokeInvite({ inviteId: id });
      else await revokeJoinInvite({ inviteId: id, scope: scopeParam });
      toaster.success({ title: "Invite revoked" });
    } catch (e) {
      toaster.error({
        title: "Failed to revoke",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setRevokeBusy(null);
    }
  };

  const handleDelete = async (id: Id<"institutionInvites">) => {
    if (
      !window.confirm(
        "Delete this invite permanently? The invite row will be gone for good.",
      )
    ) {
      return;
    }
    setDeleteBusy(id);
    try {
      if (isAdmin) await deleteInvite({ inviteId: id });
      else await deleteJoinInvite({ inviteId: id, scope: scopeParam });
      toaster.success({ title: "Invite deleted" });
    } catch (e) {
      toaster.error({
        title: "Failed to delete",
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setDeleteBusy(null);
    }
  };

  return (
    <VStack align="stretch" gap={5}>
      <HStack justify="space-between" align="center">
        <Box>
          <Heading size="md" fontFamily="heading" color="navy.500">
            {isAdmin ? "Institution invites" : "Invite links"}
          </Heading>
          <Text fontFamily="body" fontSize="sm" color="charcoal.400">
            {isAdmin
              ? "Mint a link that lets a partner create their own school and become its admin."
              : "Mint a link to add a teacher or scholar to your school."}
          </Text>
        </Box>
        <MintButton variant={variant} scope={scopeParam} />
      </HStack>

      <Box
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        overflow="hidden"
        bg="white"
      >
        <Table.Root size="sm">
          <Table.Header>
            <Table.Row bg="gray.50">
              <Table.ColumnHeader fontFamily="heading">Type</Table.ColumnHeader>
              {isAdmin && (
                <Table.ColumnHeader fontFamily="heading">Institution</Table.ColumnHeader>
              )}
              <Table.ColumnHeader fontFamily="heading">Role</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">Label</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">Uses</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">Status</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">Link</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading" textAlign="right">
                Actions
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows === undefined ? (
              <TableRowsSkeleton rows={3} columns={isAdmin ? 8 : 7} />
            ) : rows.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={isAdmin ? 8 : 7}>
                  <Text
                    fontFamily="body"
                    color="charcoal.400"
                    py={4}
                    textAlign="center"
                  >
                    No invites yet — mint your first link.
                  </Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              rows.map((r) => (
                <Table.Row key={r._id}>
                  <Table.Cell fontFamily="body">{KIND_LABEL[r.kind]}</Table.Cell>
                  {isAdmin && (
                    <Table.Cell fontFamily="body" color="charcoal.400">
                      {r.kind === "create_institution" &&
                      r.createdInstitutionId ? (
                        // A redeemed create-institution invite POINTS AT the
                        // school it produced (createdInstitutionId) — name it so
                        // the invite→institution relationship is legible.
                        <HStack gap={1}>
                          <Text as="span" fontSize="2xs" color="charcoal.300">
                            created
                          </Text>
                          <Text as="span" color="charcoal.500">
                            {createdInstitutionLabel(r.institutionName)}
                          </Text>
                        </HStack>
                      ) : (
                        (r.institutionName ?? "—")
                      )}
                    </Table.Cell>
                  )}
                  <Table.Cell fontFamily="body">
                    {r.role ?? (r.kind === "create_institution" ? "school admin" : "—")}
                  </Table.Cell>
                  <Table.Cell fontFamily="body" color="charcoal.400">
                    {r.label ?? "—"}
                  </Table.Cell>
                  <Table.Cell fontFamily="mono" fontSize="xs" color="charcoal.400">
                    {r.usedCount}
                    {r.maxUses != null ? ` / ${r.maxUses}` : ""}
                  </Table.Cell>
                  <Table.Cell>
                    <Badge size="xs" colorPalette={STATUS_PALETTE[r.status]}>
                      {r.status}
                    </Badge>
                  </Table.Cell>
                  <Table.Cell>
                    <Button
                      size="xs"
                      variant="ghost"
                      color="charcoal.500"
                      _hover={{ color: "violet.600", bg: "violet.50" }}
                      onClick={() => copyLink(r.url)}
                    >
                      <Copy size={13} /> Copy
                    </Button>
                  </Table.Cell>
                  <Table.Cell>
                    <HStack justify="flex-end">
                      {canRevokeInvite(r.status) ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          color="charcoal.500"
                          _hover={{ color: "red.500", bg: "red.50" }}
                          onClick={() => handleRevoke(r._id)}
                          disabled={revokeBusy === r._id}
                          loading={revokeBusy === r._id}
                        >
                          <Prohibit size={13} /> Revoke
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="ghost"
                          color="charcoal.400"
                          _hover={{ color: "red.500", bg: "red.50" }}
                          onClick={() => handleDelete(r._id)}
                          disabled={deleteBusy === r._id}
                          loading={deleteBusy === r._id}
                        >
                          <Trash size={13} /> Delete
                        </Button>
                      )}
                    </HStack>
                  </Table.Cell>
                </Table.Row>
              ))
            )}
          </Table.Body>
        </Table.Root>
      </Box>
    </VStack>
  );
}

/**
 * The mint dialog. Admin mints a create_institution invite; school mints a
 * join_institution invite (teacher | scholar). On success it shows the full,
 * shareable SITE_URL-based link to copy.
 */
function MintButton({
  variant,
  scope,
}: {
  variant: "admin" | "school";
  scope: string;
}) {
  const isAdmin = variant === "admin";
  const mintCreate = useMutation(
    api.institutionInvites.mintCreateInstitutionInvite,
  );
  const mintJoin = useMutation(api.institutionInvites.mintJoinInvite);

  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [role, setRole] = useState<"teacher" | "scholar">("teacher");
  const [maxUses, setMaxUses] = useState("");
  const [expiryDays, setExpiryDays] = useState<string>("Never");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);

  const reset = () => {
    setLabel("");
    setRole("teacher");
    setMaxUses("");
    setExpiryDays("Never");
    setError("");
    setLink(null);
    setBusy(false);
  };
  const close = () => {
    if (busy) return;
    reset();
    setOpen(false);
  };

  const handleMint = async () => {
    setBusy(true);
    setError("");
    try {
      const days = EXPIRY_OPTIONS.find(([l]) => l === expiryDays)?.[1] ?? null;
      const expiresAt =
        days != null ? Date.now() + days * 24 * 60 * 60 * 1000 : undefined;
      const max = maxUses.trim() ? Number(maxUses.trim()) : undefined;
      if (max != null && (!Number.isInteger(max) || max < 1)) {
        throw new Error("Max uses must be a positive whole number");
      }
      const common = {
        label: label.trim() || undefined,
        expiresAt,
        maxUses: max,
      };
      const res = isAdmin
        ? await mintCreate(common)
        : await mintJoin({ role, scope, ...common });
      setLink(res.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to mint invite");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        bg="violet.500"
        color="white"
        _hover={{ bg: "violet.600" }}
        fontFamily="heading"
        onClick={() => setOpen(true)}
      >
        <Ticket style={{ marginRight: 6 }} /> Mint invite
      </Button>

      <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  {link
                    ? "Invite ready"
                    : isAdmin
                      ? "Mint a create-school invite"
                      : "Mint a join invite"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {link ? (
                  <VStack align="stretch" gap={3}>
                    <Text fontFamily="body" color="charcoal.500" fontSize="sm">
                      Share this link with the person you&apos;re inviting:
                    </Text>
                    <Input
                      value={link}
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
                      borderColor="violet.300"
                      color="violet.600"
                      _hover={{ bg: "violet.50" }}
                      onClick={() => copyLink(link)}
                    >
                      <Copy size={14} /> Copy link
                    </Button>
                  </VStack>
                ) : (
                  <VStack align="stretch" gap={3}>
                    {!isAdmin && (
                      <Box>
                        <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                          Role
                        </Text>
                        <FieldSelect
                          value={role}
                          onChange={(v) => setRole(v as "teacher" | "scholar")}
                          disabled={busy}
                        >
                          <option value="teacher">Teacher</option>
                          <option value="scholar">Scholar</option>
                        </FieldSelect>
                      </Box>
                    )}
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Label{" "}
                        <Text as="span" color="charcoal.300">(optional)</Text>
                      </Text>
                      <Input
                        size="sm"
                        placeholder={
                          isAdmin
                            ? "e.g. James Wong — Prism Academy"
                            : "e.g. New 3rd-grade teacher"
                        }
                        value={label}
                        onChange={(e) => setLabel(e.target.value)}
                        disabled={busy}
                        bg="gray.50"
                        fontFamily="body"
                        autoFocus
                      />
                    </Box>
                    <HStack gap={3} align="flex-start">
                      <Box flex={1}>
                        <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                          Max uses{" "}
                          <Text as="span" color="charcoal.300">(optional)</Text>
                        </Text>
                        <Input
                          size="sm"
                          placeholder="unlimited"
                          inputMode="numeric"
                          value={maxUses}
                          onChange={(e) => setMaxUses(e.target.value)}
                          disabled={busy}
                          bg="gray.50"
                          fontFamily="body"
                        />
                      </Box>
                      <Box flex={1}>
                        <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                          Expires
                        </Text>
                        <FieldSelect
                          value={expiryDays}
                          onChange={setExpiryDays}
                          disabled={busy}
                        >
                          {EXPIRY_OPTIONS.map(([l]) => (
                            <option key={l} value={l}>
                              {l}
                            </option>
                          ))}
                        </FieldSelect>
                      </Box>
                    </HStack>
                    {error && (
                      <Text fontSize="sm" color="red.500" fontFamily="body">
                        {error}
                      </Text>
                    )}
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
                <Button variant="ghost" onClick={close} fontFamily="heading">
                  {link ? "Done" : "Cancel"}
                </Button>
                {!link && (
                  <Button
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    fontFamily="heading"
                    onClick={handleMint}
                    disabled={busy}
                    loading={busy}
                  >
                    Mint invite
                  </Button>
                )}
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

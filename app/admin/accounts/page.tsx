"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useQuery, useMutation, useAction } from "convex/react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Box,
  Button,
  HStack,
  IconButton,
  Input,
  Table,
  Text,
  VStack,
  Dialog,
  Portal,
} from "@chakra-ui/react";
import { Trash, UserPlus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { formatRelative } from "@/lib/relativeTime";
import { isStaffRole, isPasskeyRole, isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import {
  canonicalInstitutionScope,
  withInstitutionScope,
} from "@/lib/institutionLinks";
import { usernameError } from "@/convex/lib/username";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { TableRowsSkeleton } from "@/components/skeletons/PanelSkeletons";

type AssignableRole = Exclude<Role, "lifelong_learner">;

function RoleSelect({
  userId,
  currentRole,
}: {
  userId: Id<"users">;
  currentRole: string;
}) {
  const updateRole = useMutation(api.users.updateRole);

  return (
    <FieldSelect
      value={currentRole}
      onChange={async (role) => {
        await updateRole({
          userId,
          role: role as AssignableRole,
        });
      }}
      w="170px"
      fieldProps={{ "aria-label": "Role" }}
    >
      <option value="scholar">scholar</option>
      <option value="teacher">teacher</option>
      <option value="platform_admin">platform admin</option>
      <option value="school_admin">school admin</option>
      <option value="curriculum_designer">curriculum designer</option>
      <option value="staff">staff</option>
      <option value="parent">parent</option>
    </FieldSelect>
  );
}

function PasskeyAdminCell({
  userId,
  role,
  count,
  name,
}: {
  userId: Id<"users">;
  role: string;
  count: number;
  name: string;
}) {
  const issueToken = useMutation(api.enrollment.issueToken);
  const resetPasskeys = useMutation(api.enrollment.adminResetPasskeys);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  // Passkey-eligible = staff OR parent (parents enroll a passkey from an
  // admin/operations staff link — their email-free login). Scholars use passwords.
  const passkeyEligible = isPasskeyRole(role as Role);
  if (!passkeyEligible) {
    return (
      <Text fontFamily="body" fontSize="xs" color="charcoal.300">
        —
      </Text>
    );
  }

  const toLink = (path: string) =>
    (typeof window !== "undefined" ? window.location.origin : "") + path;

  const handleIssue = async () => {
    setBusy(true);
    try {
      const res = await issueToken({ userId });
      setLink(toLink(res.path));
    } catch (e) {
      console.error("Issue enrollment link failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    setBusy(true);
    try {
      const res = await resetPasskeys({ userId });
      setLink(toLink(res.path));
      setConfirmReset(false);
    } catch (e) {
      console.error("Reset passkeys failed:", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack align="start" gap={1}>
      <HStack gap={2}>
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          {count} key{count === 1 ? "" : "s"}
        </Text>
        <Button
          size="2xs"
          variant="outline"
          fontFamily="heading"
          disabled={busy}
          onClick={count > 0 ? () => setConfirmReset(true) : handleIssue}
        >
          {count > 0 ? "Reset" : "Enroll link"}
        </Button>
      </HStack>
      {link && (
        <Box maxW="260px">
          <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mb={1}>
            One-time link — share securely, shown once:
          </Text>
          <Input
            value={link}
            readOnly
            onFocus={(e) => e.target.select()}
            size="xs"
            fontSize="2xs"
            fontFamily="mono"
            borderColor="gray.300"
          />
        </Box>
      )}

      {/* Reset confirmation */}
      <Dialog.Root
        open={confirmReset}
        onOpenChange={(e) => {
          if (!e.open) setConfirmReset(false);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Reset {name}&apos;s passkeys?
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontFamily="body" color="charcoal.500">
                  This permanently removes <strong>all {count} passkey
                  {count === 1 ? "" : "s"}</strong> for <strong>{name}</strong>.
                  They won&apos;t be able to sign in until they enroll a new one.
                  You&apos;ll get a one-time enrollment link to send them. This
                  can&apos;t be undone.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={3} gap={3}>
                <Dialog.CloseTrigger asChild>
                  <Button variant="ghost" fontFamily="heading" size="sm" color="charcoal.500">
                    Cancel
                  </Button>
                </Dialog.CloseTrigger>
                <Button
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={handleReset}
                  disabled={busy}
                  loading={busy}
                  loadingText="Resetting..."
                >
                  Reset passkeys
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </VStack>
  );
}

/**
 * Sign-in setup for a SCHOLAR row. Scholars use a username + password (not a
 * passkey), so this mints a one-time enrollment link the scholar opens to
 * choose their password — which is then stored server-side. The SAME link works for
 * first-time setup and a forgotten-password reset (redeeming it clears any prior
 * credential first), so there's a single "Sign-in link" affordance rather than a
 * separate reset. Replaces the old broken "temp PIN" flow (that dead 4-digit
 * mechanism is where the "PIN" noun came from; the secret is a password).
 */
function ScholarSignInCell({ userId }: { userId: Id<"users"> }) {
  const issueLink = useMutation(api.enrollment.issueScholarEnrollLink);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const toLink = (path: string) =>
    (typeof window !== "undefined" ? window.location.origin : "") + path;

  const handleIssue = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await issueLink({ userId });
      setLink(toLink(res.path));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <VStack align="start" gap={1}>
      <Button
        size="2xs"
        variant="outline"
        fontFamily="heading"
        disabled={busy}
        onClick={handleIssue}
      >
        {link ? "New sign-in link" : "Sign-in link"}
      </Button>
      {error && (
        <Text fontFamily="body" fontSize="2xs" color="red.500" maxW="260px">
          {error}
        </Text>
      )}
      {link && (
        <Box maxW="260px">
          <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mb={1}>
            One-time link — the scholar opens it to set their password. Shown once:
          </Text>
          <Input
            value={link}
            readOnly
            onFocus={(e) => e.target.select()}
            size="xs"
            fontSize="2xs"
            fontFamily="mono"
            borderColor="gray.300"
          />
        </Box>
      )}
    </VStack>
  );
}

/**
 * Institution assignment for a SCHOLAR row. Moving a scholar between
 * institutions is an access-boundary change (it changes which staff can see
 * them), so the mutation is platform-admin-only — which this whole page already
 * is. Non-scholar rows show "—": staff institution membership lives in the
 * memberships table, managed from the school surfaces, not here.
 */
function InstitutionCell({
  userId,
  role,
  institutionId,
  institutions,
}: {
  userId: Id<"users">;
  role: string;
  institutionId: Id<"institutions"> | null;
  institutions:
    | { _id: Id<"institutions">; name: string; emoji: string | null }[]
    | undefined;
}) {
  const setInstitution = useMutation(api.institutions.setScholarInstitution);
  const [error, setError] = useState("");

  if (role !== "scholar") {
    return (
      <Text fontFamily="body" fontSize="xs" color="charcoal.300">
        —
      </Text>
    );
  }

  return (
    <VStack align="start" gap={1}>
    <FieldSelect
      value={institutionId ?? ""}
      onChange={async (val) => {
        if (!val) return;
        // The controlled value tracks the server, so a rejected change (e.g.
        // the row's role changed to non-scholar in another tab) snaps the
        // select back — surface why instead of failing silently.
        setError("");
        try {
          await setInstitution({
            scholarId: userId,
            institutionId: val as Id<"institutions">,
          });
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }}
      w="160px"
      fieldProps={{ "aria-label": "Institution" }}
    >
      <option value="" disabled>Select institution</option>
      {institutions?.map((inst) => (
        <option key={inst._id} value={inst._id}>
          {inst.emoji ? `${inst.emoji} ` : ""}
          {inst.name}
        </option>
      ))}
    </FieldSelect>
    {error && (
      <Text fontFamily="body" fontSize="2xs" color="red.500" maxW="160px">
        {error}
      </Text>
    )}
    </VStack>
  );
}

function LearnerInstitutionCell({
  userId,
  role,
  membershipId,
  institutionId,
  institutions,
}: {
  userId: Id<"users">;
  role: string;
  membershipId: Id<"memberships"> | null;
  institutionId: Id<"institutions"> | null;
  institutions:
    | { _id: Id<"institutions">; name: string; emoji: string | null }[]
    | undefined;
}) {
  const addMembership = useMutation(api.memberships.addMembership);
  const removeMembership = useMutation(api.memberships.removeMembership);
  const [error, setError] = useState("");

  if (role === "scholar") {
    return (
      <Text fontFamily="body" fontSize="xs" color="charcoal.300">
        —
      </Text>
    );
  }

  return (
    <VStack align="start" gap={1}>
      <FieldSelect
        value={institutionId ?? ""}
        onChange={async (val) => {
          setError("");
          try {
            if (!val) {
              if (membershipId) await removeMembership({ membershipId });
              return;
            }
            await addMembership({
              userId,
              role: "scholar",
              institutionId: val as Id<"institutions">,
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          }
        }}
        w="180px"
        fieldProps={{ "aria-label": "Learner institution" }}
      >
        <option value="">Not a learner</option>
        {institutions?.map((inst) => (
          <option key={inst._id} value={inst._id}>
            {inst.emoji ? `${inst.emoji} ` : ""}
            {inst.name}
          </option>
        ))}
      </FieldSelect>
      {error && (
        <Text fontFamily="body" fontSize="2xs" color="red.500" maxW="180px">
          {error}
        </Text>
      )}
    </VStack>
  );
}

/**
 * Inline editor for a user's email. An email typed here by an admin is
 * treated as pre-verified (the magic-link itself proves inbox control on
 * first use), so setting one immediately enables passwordless email login.
 * Available for ANY role — magic-link is capability-based now (any account
 * with an email can use it), so a scholar or parent can be given one too;
 * for scholars it's purely additive (their password still works).
 */
function EmailAdminCell({
  userId,
  email,
}: {
  userId: Id<"users">;
  email: string | null;
}) {
  const setEmail = useMutation(api.users.adminSetUserEmail);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(email ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setEmail({ userId, email: value.trim() });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <HStack gap={2}>
        <Text fontFamily="body" fontSize="sm" color={email ? "charcoal.500" : "charcoal.300"}>
          {email ?? "none"}
        </Text>
        <Button
          size="2xs"
          variant="outline"
          fontFamily="heading"
          onClick={() => {
            setValue(email ?? "");
            setEditing(true);
          }}
        >
          {email ? "Edit" : "Set"}
        </Button>
      </HStack>
    );
  }

  return (
    <VStack align="start" gap={1} maxW="240px">
      <Input
        type="email"
        size="xs"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && save()}
        placeholder="name@example.com"
        fontFamily="body"
        borderColor="gray.300"
        autoFocus
      />
      {error && (
        <Text fontFamily="body" fontSize="2xs" color="red.500">
          {error}
        </Text>
      )}
      <HStack gap={2}>
        <Button size="2xs" variant="ghost" fontFamily="heading" color="charcoal.400" onClick={() => setEditing(false)} disabled={busy}>
          Cancel
        </Button>
        <Button size="2xs" bg="violet.500" color="white" _hover={{ bg: "violet.600" }} fontFamily="heading" onClick={save} disabled={busy || !value.trim()} loading={busy}>
          Save
        </Button>
      </HStack>
    </VStack>
  );
}

/**
 * Slack column: shows the linked Slack member id, with one-click
 * auto-link-by-email (needs the Email column set) and a manual id
 * fallback. Staff-only — the Slack bot surface fails closed for
 * everyone else, so linking non-staff would be misleading.
 */
function SlackAdminCell({
  userId,
  role,
  email,
  slackUserId,
}: {
  userId: Id<"users">;
  role: string;
  email: string | null;
  slackUserId: string | null;
}) {
  const setSlackId = useMutation(api.users.adminSetSlackUserId);
  const autoLink = useAction(api.slackAdmin.autoLinkByEmail);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(slackUserId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const staff = role === "staff" || isStaffRole(role as Role);
  if (!staff) {
    return (
      <Text fontFamily="body" fontSize="xs" color="charcoal.300">
        —
      </Text>
    );
  }

  const saveManual = async () => {
    setBusy(true);
    setError("");
    try {
      await setSlackId({ userId, slackUserId: value.trim() || undefined });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runAutoLink = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await autoLink({ userId });
      if (!res.ok) setError(res.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <VStack align="start" gap={1} maxW="200px">
        <Input
          size="xs"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && saveManual()}
          placeholder="U07ABCDEF"
          fontFamily="body"
          borderColor="gray.300"
          autoFocus
        />
        {error && (
          <Text fontFamily="body" fontSize="2xs" color="red.500">
            {error}
          </Text>
        )}
        <HStack gap={2}>
          <Button size="2xs" variant="ghost" fontFamily="heading" color="charcoal.400" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="2xs" bg="violet.500" color="white" _hover={{ bg: "violet.600" }} fontFamily="heading" onClick={saveManual} disabled={busy} loading={busy}>
            Save
          </Button>
        </HStack>
      </VStack>
    );
  }

  return (
    <VStack align="start" gap={0.5}>
      <HStack gap={2}>
        <Text fontFamily="body" fontSize="sm" color={slackUserId ? "charcoal.500" : "charcoal.300"}>
          {slackUserId ?? "none"}
        </Text>
        {!slackUserId && email && (
          <Button size="2xs" variant="outline" fontFamily="heading" onClick={runAutoLink} disabled={busy} loading={busy}>
            Auto-link
          </Button>
        )}
        <Button
          size="2xs"
          variant="outline"
          fontFamily="heading"
          onClick={() => {
            setValue(slackUserId ?? "");
            setEditing(true);
          }}
          disabled={busy}
        >
          {slackUserId ? "Edit" : "Set"}
        </Button>
      </HStack>
      {error && (
        <Text fontFamily="body" fontSize="2xs" color="red.500">
          {error}
        </Text>
      )}
    </VStack>
  );
}

type StaffRole = "scholar" | "teacher" | "platform_admin" | "school_admin" | "curriculum_designer" | "staff";

/**
 * Create a new account (username + optional name + role). For staff roles it
 * then mints a one-time passkey enrollment link to hand off; scholars need no
 * enrollment so the dialog just closes.
 */
function AddUserButton({
  institutions,
}: {
  institutions:
    | { _id: Id<"institutions">; name: string; emoji: string | null }[]
    | undefined;
}) {
  const createUser = useMutation(api.users.adminCreateUser);
  const issueToken = useMutation(api.enrollment.issueToken);
  const issueScholarLink = useMutation(api.enrollment.issueScholarEnrollLink);

  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<StaffRole>("teacher");
  const [institutionId, setInstitutionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState("");
  // Derived, not state: the role select is unmounted while the link panel is
  // shown, so `role` can't change under it — keeping a separate `linkKind` in
  // state just risks the two drifting (a scholar's sign-in link captioned
  // "passkey").
  const linkKind: "passkey" | "pin" =
    role === "staff" || isStaffRole(role as Role) ? "passkey" : "pin";

  const reset = () => {
    setUsername("");
    setName("");
    setRole("teacher");
    setInstitutionId("");
    setError("");
    setLink(null);
    setCreatedName("");
    setBusy(false);
  };
  const close = () => {
    if (busy) return;
    reset();
    setOpen(false);
  };

  const handleCreate = async () => {
    const u = username.trim();
    const problem = usernameError(username);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { userId } = await (createUser as unknown as (args: {
        username: string;
        name?: string;
        role: StaffRole;
        institutionId?: Id<"institutions">;
      }) => Promise<{ userId: Id<"users"> }>)({
        username: u,
        name: name.trim() || undefined,
        role,
        ...(role === "scholar" && institutionId
          ? { institutionId: institutionId as Id<"institutions"> }
          : {}),
      });
      const origin =
        typeof window !== "undefined" ? window.location.origin : "";
      if (role === "staff" || isStaffRole(role as Role)) {
        // Staff set up a passkey.
        const res = await issueToken({ userId });
        setCreatedName(name.trim() || u);
        setLink(origin + res.path);
      } else {
        // Scholars set a password via a one-time link (username + password login).
        const res = await issueScholarLink({ userId });
        setCreatedName(name.trim() || u);
        setLink(origin + res.path);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
        <UserPlus style={{ marginRight: "6px" }} /> Add User
      </Button>

      <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  {link ? "Account created" : "Add user"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {link ? (
                  <VStack align="stretch" gap={3}>
                    <Text fontFamily="body" color="charcoal.500" fontSize="sm">
                      Created <strong>{createdName}</strong>. Send them this
                      one-time link to{" "}
                      {linkKind === "pin"
                        ? "set their sign-in password"
                        : "set up their passkey"}
                      :
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
                    <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
                      Shown once — copy it now. (Expires per the enrollment-token
                      window.)
                    </Text>
                  </VStack>
                ) : (
                  <VStack align="stretch" gap={3}>
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Username
                      </Text>
                      <Input
                        size="sm"
                        placeholder="e.g. jdoe"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        disabled={busy}
                        bg="gray.50"
                        fontFamily="body"
                        autoFocus
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Name <Text as="span" color="charcoal.300">(optional)</Text>
                      </Text>
                      <Input
                        size="sm"
                        placeholder="e.g. Jane Doe"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                        bg="gray.50"
                        fontFamily="body"
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Role
                      </Text>
                      <FieldSelect
                        value={role}
                        onChange={(v) => setRole(v as StaffRole)}
                        disabled={busy}
                        w="full"
                        fieldProps={{ "aria-label": "Role" }}
                      >
                        <option value="scholar">scholar</option>
                        <option value="teacher">teacher</option>
                        <option value="platform_admin">platform admin</option>
                        <option value="school_admin">school admin</option>
                        <option value="curriculum_designer">curriculum designer</option>
                        <option value="staff">staff</option>
                      </FieldSelect>
                      <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mt={1}>
                        Staff roles get a passkey enrollment link; scholars get a
                        one-time link to set a sign-in password.
                      </Text>
                    </Box>
                    {role === "scholar" && (
                      <Box>
                        <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                          Institution
                        </Text>
                        <FieldSelect
                          value={institutionId}
                          onChange={(v) => setInstitutionId(v)}
                          disabled={busy}
                          w="full"
                          fieldProps={{ "aria-label": "Institution" }}
                        >
                          <option value="">
                            Default (primary institution)
                          </option>
                          {institutions?.map((inst) => (
                            <option key={inst._id} value={inst._id}>
                              {inst.emoji ? `${inst.emoji} ` : ""}
                              {inst.name}
                            </option>
                          ))}
                        </FieldSelect>
                      </Box>
                    )}
                    {error && (
                      <Text fontSize="sm" color="red.500" fontFamily="body">
                        {error}
                      </Text>
                    )}
                  </VStack>
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
                {link ? (
                  <Button
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    fontFamily="heading"
                    size="sm"
                    onClick={close}
                  >
                    Done
                  </Button>
                ) : (
                  <>
                    <Button variant="ghost" fontFamily="heading" size="sm" color="charcoal.500" onClick={close} disabled={busy}>
                      Cancel
                    </Button>
                    <Button
                      bg="violet.500"
                      color="white"
                      _hover={{ bg: "violet.600" }}
                      fontFamily="heading"
                      size="sm"
                      onClick={handleCreate}
                      disabled={busy || !username.trim()}
                      loading={busy}
                    >
                      Create
                    </Button>
                  </>
                )}
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

export default function AccountsPage() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  // Account/role administration is PLATFORM-ADMIN-ONLY. A non-platform-admin
  // who deep-links here is bounced home. Platform-only queries stay skipped
  // until we know the caller is a platform admin (otherwise they'd trip the
  // ErrorBoundary with "Forbidden" before the bounce).
  const isAdmin = isPlatformAdminRole(user?.role as Role | undefined);
  const users = useQuery(api.users.listAllUsers, isAdmin ? {} : "skip");
  const passkeyCounts = useQuery(api.passkeys.adminCounts, isAdmin ? {} : "skip");
  // listForStaff (not list) — the pickers only need id/name/emoji; `list`
  // additionally collects every scholar per institution to compute counts this
  // page never shows, re-running on nearly any users-table write (including the
  // inline edits made here).
  const institutions = useQuery(api.institutions.listForStaff, isAdmin ? {} : "skip");
  const deleteUser = useMutation(api.users.deleteUser);

  // Institution filter — uses the shared lens path (resolveActiveInstitution →
  // resolveInstitutionLens → institutionLensClientPayload). Default is "All
  // institutions" (no ?inst= in the URL = no filter applied).
  const { requestedScope, activeInstitution } = useActiveInstitution(isAdmin);
  // Only scope the list when a specific institution slug is in the URL; "" and
  // "all" both mean "show every account".
  const filterInstId =
    requestedScope !== "" && requestedScope !== "all" && activeInstitution?.scope === "institution"
      ? activeInstitution.institutionId
      : null;
  const filteredUsers = filterInstId
    ? users?.filter(
        (u) =>
          u.institutionId === filterInstId ||
          u.learnerInstitutionId === filterInstId,
      )
    : users;
  // Show the picker only when the admin can see more than one institution.
  const showInstPicker = (institutions?.length ?? 0) >= 2;
  const selectedInstitutionScope =
    institutions === undefined
      ? requestedScope
      : canonicalInstitutionScope(
          requestedScope,
          activeInstitution,
          institutions,
          "all",
        );

  const [deleteTarget, setDeleteTarget] = useState<{
    id: Id<"users">;
    name: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isAdmin) {
      router.replace("/");
    }
  }, [user, isAdmin, isLoading, router]);

  if (isLoading || !user || !isAdmin) {
    return null;
  }

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await deleteUser({ userId: deleteTarget.id });
    } catch (error) {
      console.error("Error deleting user:", error);
    } finally {
      setIsDeleting(false);
      setDeleteTarget(null);
    }
  };

  return (
    <>
      <HStack justify="flex-end" mb={3} gap={3}>
        {showInstPicker && (
          <FieldSelect
            value={selectedInstitutionScope}
            onChange={(val) =>
              router.push(withInstitutionScope("/admin/accounts", val), {
                scroll: false,
              })
            }
            w="180px"
            fieldProps={{ "aria-label": "Filter by institution" }}
          >
            <option value="">All institutions</option>
            {institutions?.map((inst) => (
              <option key={inst._id} value={inst.slug}>
                {inst.emoji ? `${inst.emoji} ` : ""}
                {inst.name}
                {inst.disabled ? " (paused)" : ""}
              </option>
            ))}
          </FieldSelect>
        )}
        <AddUserButton institutions={institutions} />
      </HStack>
              {/* overflowX so the 9-column table scrolls horizontally on
                  narrow viewports instead of clipping the right columns;
                  minW keeps the columns from crushing before it scrolls. */}
              <Box bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200" shadow="xs" overflowX="auto">
                <Table.Root size="sm" minW="1360px">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader fontFamily="heading" pl={4}>Username</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Name</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Role</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Institution</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Learner at</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Email</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Slack</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Sign-in</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Created</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading" w="50px"></Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredUsers === undefined ? (
                  <TableRowsSkeleton columns={10} />
                ) : filteredUsers.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={10} fontFamily="body" color="charcoal.300" pl={4} py={6}>
                      No users yet.
                    </Table.Cell>
                  </Table.Row>
                ) : (
                  filteredUsers.map((u) => {
                  const isSelf = u._id === user._id;
                  return (
                    <Table.Row key={u._id}>
                      <Table.Cell fontFamily="body" pl={4}>
                        <Text fontWeight="500">{u.username ?? "—"}</Text>
                      </Table.Cell>
                      <Table.Cell fontFamily="body">{u.name ?? "—"}</Table.Cell>
                      <Table.Cell>
                        <RoleSelect userId={u._id} currentRole={u.role} />
                      </Table.Cell>
                      <Table.Cell>
                        <InstitutionCell
                          userId={u._id}
                          role={u.role}
                          institutionId={u.institutionId}
                          institutions={institutions}
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <LearnerInstitutionCell
                          userId={u._id}
                          role={u.role}
                          membershipId={u.learnerMembershipId}
                          institutionId={u.learnerInstitutionId}
                          institutions={institutions}
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <EmailAdminCell userId={u._id} email={u.email} />
                      </Table.Cell>
                      <Table.Cell>
                        <SlackAdminCell
                          userId={u._id}
                          role={u.role}
                          email={u.email}
                          slackUserId={u.slackUserId}
                        />
                      </Table.Cell>
                      <Table.Cell>
                        {u.role === "scholar" ? (
                          <ScholarSignInCell userId={u._id} />
                        ) : (
                          <PasskeyAdminCell
                            userId={u._id}
                            role={u.role}
                            count={passkeyCounts?.[u._id] ?? 0}
                            name={u.name ?? u.username ?? "this user"}
                          />
                        )}
                      </Table.Cell>
                      <Table.Cell fontFamily="body" fontSize="sm" color="charcoal.400">
                        {formatRelative(u._creationTime)}
                      </Table.Cell>
                      <Table.Cell>
                        {!isSelf && (
                          <IconButton
                            aria-label="Delete user"
                            size="xs"
                            variant="ghost"
                            color="charcoal.300"
                            _hover={{ color: "red.500", bg: "red.50" }}
                            onClick={() =>
                              setDeleteTarget({
                                id: u._id,
                                name: u.name ?? u.username ?? "this user",
                              })
                            }
                          >
                            <Trash size={14} />
                          </IconButton>
                        )}
                      </Table.Cell>
                    </Table.Row>
                  );
                  })
                )}
              </Table.Body>
                </Table.Root>
              </Box>

      {/* Delete confirmation dialog */}
      <Dialog.Root
        open={!!deleteTarget}
        onOpenChange={(e) => {
          if (!e.open) setDeleteTarget(null);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Delete User
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontFamily="body" color="charcoal.500">
                  Permanently delete <strong>{deleteTarget?.name}</strong> and all their sessions,
                  messages, and data? This cannot be undone.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={3} gap={3}>
                <Dialog.CloseTrigger asChild>
                  <Button
                    variant="ghost"
                    fontFamily="heading"
                    size="sm"
                    color="charcoal.500"
                  >
                    Cancel
                  </Button>
                </Dialog.CloseTrigger>
                <Button
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  loading={isDeleting}
                  loadingText="Deleting..."
                >
                  Delete
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

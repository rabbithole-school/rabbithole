"use client";

// School staff directory. READ is open to any scholar-admin (teacher /
// operations staff / school_admin / platform_admin) — the roster mirrors the sibling
// Scholars/Guardians directory reads. MANAGING staff (add / remove / grant a
// role via the enrollment link) stays the institution leader's job: the
// school_admin (or platform_admin) adds staff scoped to THEIR institution and
// hands off a one-time passkey enrollment link. Backend gates: the read is
// scholarAdminQuery (users.listInstitutionStaff); every write is
// schoolAdminMutation + the grant-matrix checks in users.createInstitutionStaff /
// users.removeStaffFromInstitution / enrollment.issueStaffEnrollLink.

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { useQuery, useMutation } from "convex/react";
import { useState } from "react";
import {
  Box,
  Button,
  Badge,
  Heading,
  HStack,
  Checkbox,
  Input,
  Table,
  Text,
  VStack,
  Dialog,
  Portal,
  Spinner,
} from "@chakra-ui/react";
import { Copy, LinkSimple, Trash, UserPlus } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import {
  hasOperationsAccessForInstitution,
  useSchoolOperationsAccess,
} from "@/hooks/useSchoolOperationsAccess";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { TableRowsSkeleton } from "@/components/skeletons/PanelSkeletons";
import { PersonCell } from "@/components/PersonCell";
import { toaster } from "@/lib/toaster";
import { usernameError } from "@/convex/lib/username";

type StaffRole = "teacher" | "staff" | "curriculum_designer";
type StaffRow = {
  id: Id<"users">;
  name: string | null;
  username: string | null;
  email: string | null;
  // Optional so the cast compiles both before and after the staff-directory
  // query gains `image` (backend landing in parallel). PersonCell treats a
  // missing photo as an initials fallback.
  image?: string | null;
  role: string;
  institutionName: string | null;
};

type StaffCapabilityEditor = {
  canEditCurriculum: boolean;
  curriculumAccessIncludedInRole: boolean;
  canManageSchoolOperations: boolean;
  schoolOperationsIncludedInRole: boolean;
  canManageHealthRecords: boolean;
  healthAccessIncludedInRole: boolean;
  programGroups: Array<{
    groupId: Id<"scholarGroups">;
    name: string;
    canPublish: boolean;
    canReviewCaptures: boolean;
  }>;
};

function canManageStaff(role: Role | string | undefined): boolean {
  return role === "school_admin" || isPlatformAdminRole(role as Role | undefined);
}

function isGrantableStaffRole(role: string): boolean {
  return role === "teacher" || role === "staff" || role === "curriculum_designer";
}

function isProtectedStaffRole(role: string): boolean {
  return role === "school_admin" || isPlatformAdminRole(role as Role | undefined);
}

const ROLE_LABEL: Record<string, string> = {
  teacher: "Teacher",
  staff: "Staff",
  curriculum_designer: "Curriculum designer",
  school_admin: "School admin",
  platform_admin: "Platform admin",
};

export default function SchoolStaffPage() {
  const { user, isLoading } = useCurrentUser();
  // READ is open to any scholar-admin; MANAGING (add / remove / send link) is
  // school-admin-only. Split the two so an operations staffer/teacher sees the roster but
  // not the write affordances.
  const { activeInstitution, scopeParam } = useSchoolOperationsAccess(user, !!user);
  const canView = hasOperationsAccessForInstitution(
    user,
    activeInstitution?.institutionId,
  );
  const canManage = canManageStaff(user?.role);
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || activeInstitution === undefined,
    hasUser: !!user,
    isAllowed: canView,
    unauthorizedRedirect: "/",
  });

  // Honor the active institution lens (?inst=): a platform admin sees the
  // lensed school's staff (primary by default, one school when picked, all with
  // ?inst=all); an institution-scoped staffer's scope resolves to their own
  // school(s).
  const staff = useQuery(
    api.users.listInstitutionStaff,
    canView ? { scope: scopeParam } : "skip",
  );
  const issueLink = useMutation(api.enrollment.issueStaffEnrollLink);
  const removeStaff = useMutation(api.users.removeStaffFromInstitution);

  const [linkDialog, setLinkDialog] = useState<{ name: string; link: string } | null>(null);
  const [linkBusyId, setLinkBusyId] = useState<Id<"users"> | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ id: Id<"users">; name: string } | null>(null);
  const [isRemoving, setIsRemoving] = useState(false);
  const [accessTarget, setAccessTarget] = useState<StaffRow | null>(null);

  if (authorization !== "allowed" || !user) {
    return <AuthorizationPending />;
  }

  const sendEnrollmentLink = async (staffer: StaffRow) => {
    setLinkBusyId(staffer.id);
    try {
      const res = await issueLink({ userId: staffer.id });
      setLinkDialog({
        name: staffer.name ?? staffer.username ?? "this staff member",
        link: (typeof window !== "undefined" ? window.location.origin : "") + res.path,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to issue enrollment link";
      toaster.error({ title: "Failed to issue link", description: message });
    } finally {
      setLinkBusyId(null);
    }
  };

  const copyEnrollmentLink = async () => {
    if (!linkDialog) return;
    try {
      await navigator.clipboard.writeText(linkDialog.link);
      toaster.success({ title: "Enrollment link copied" });
    } catch {
      toaster.error({ title: "Copy failed", description: "Select the link and copy it manually." });
    }
  };

  const confirmRemoveStaff = async () => {
    if (!removeTarget) return;
    setIsRemoving(true);
    try {
      await removeStaff({ userId: removeTarget.id });
      toaster.success({ title: "Staff member removed from school" });
      setRemoveTarget(null);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to remove staff member";
      toaster.error({ title: "Failed to remove staff member", description: message });
    } finally {
      setIsRemoving(false);
    }
  };

  return (
    <>
      <VStack align="stretch" gap={5}>
        <HStack justify="space-between" align="center">
          <Box>
            <Heading size="md" fontFamily="heading" color="navy.500">
              Staff
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              Everyone with a staff account at your school.
            </Text>
          </Box>
          {canManage && <AddStaffButton />}
        </HStack>

        <Box borderWidth="1px" borderColor="gray.200" borderRadius="xl" overflow="hidden" bg="white">
          <Table.Root size="sm">
            <Table.Header>
              <Table.Row bg="gray.50">
                <Table.ColumnHeader fontFamily="heading">Name</Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading">Username</Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading">Role</Table.ColumnHeader>
                <Table.ColumnHeader fontFamily="heading">Institution</Table.ColumnHeader>
                {canManage && (
                  <Table.ColumnHeader fontFamily="heading" textAlign="right">Actions</Table.ColumnHeader>
                )}
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {staff === undefined ? (
                <TableRowsSkeleton rows={4} columns={canManage ? 5 : 4} />
              ) : staff.length === 0 ? (
                <Table.Row>
                  <Table.Cell colSpan={canManage ? 5 : 4}>
                    <Text fontFamily="body" color="charcoal.400" py={4} textAlign="center">
                      {canManage ? "No staff yet — add your first teacher." : "No staff yet."}
                    </Text>
                  </Table.Cell>
                </Table.Row>
              ) : (
                staff.map((s) => {
                  const staffer = s as StaffRow;
                  const displayName = staffer.name ?? staffer.username ?? "this staff member";
                  const isSelf = staffer.id === user._id;
                  const grantable = isGrantableStaffRole(staffer.role);
                  const removable = !isSelf && !isProtectedStaffRole(staffer.role) && grantable;
                  const accessManageable =
                    !isSelf && grantable && !!activeInstitution?.institutionId;
                  return (
                    <Table.Row key={staffer.id}>
                      <Table.Cell fontFamily="body">
                        <VStack align="start" gap={0.5}>
                          <PersonCell
                            name={staffer.name ?? "—"}
                            image={staffer.image}
                            colorKey={staffer.id}
                            size="xs"
                          />
                          {staffer.email && (
                            <Text fontSize="2xs" color="charcoal.400" fontFamily="mono" pl={8}>
                              {staffer.email}
                            </Text>
                          )}
                        </VStack>
                      </Table.Cell>
                      <Table.Cell fontFamily="mono" fontSize="xs" color="charcoal.400">
                        {staffer.username ?? "—"}
                      </Table.Cell>
                      <Table.Cell fontFamily="body">
                        <HStack gap={2}>
                          <Text>{ROLE_LABEL[staffer.role] ?? staffer.role}</Text>
                          {isProtectedStaffRole(staffer.role) && (
                            <Badge size="xs" colorPalette="gray">
                              Protected
                            </Badge>
                          )}
                        </HStack>
                      </Table.Cell>
                      <Table.Cell fontFamily="body" color="charcoal.400">
                        {staffer.institutionName ?? "—"}
                      </Table.Cell>
                      {canManage && (
                        <Table.Cell>
                          <HStack justify="flex-end" gap={2}>
                            <Button
                              size="xs"
                              variant="ghost"
                             color="charcoal.500"
                             _hover={{ color: "violet.600", bg: "violet.50" }}
                             onClick={() => setAccessTarget(staffer)}
                             disabled={!accessManageable}
                            >
                             Manage access
                            </Button>
                            <Button
                             size="xs"
                             variant="ghost"
                              color="charcoal.500"
                              _hover={{ color: "violet.600", bg: "violet.50" }}
                              onClick={() => sendEnrollmentLink(staffer)}
                              disabled={!grantable || linkBusyId === staffer.id}
                              loading={linkBusyId === staffer.id}
                            >
                              <LinkSimple size={13} /> Send link
                            </Button>
                            <Button
                              size="xs"
                              variant="ghost"
                              color="charcoal.500"
                              _hover={{ color: "red.500", bg: "red.50" }}
                              onClick={() => setRemoveTarget({ id: staffer.id, name: displayName })}
                              disabled={!removable}
                            >
                              <Trash size={13} /> Remove
                            </Button>
                          </HStack>
                        </Table.Cell>
                      )}
                    </Table.Row>
                  );
                })
              )}
            </Table.Body>
          </Table.Root>
        </Box>
      </VStack>

      <ManageStaffAccessDialog
        staffer={accessTarget}
        institutionId={activeInstitution?.institutionId ?? null}
        onClose={() => setAccessTarget(null)}
      />

      <Dialog.Root
        open={!!linkDialog}
        onOpenChange={(e) => {
          if (!e.open) setLinkDialog(null);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Enrollment link
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <VStack align="stretch" gap={3}>
                  <Text fontFamily="body" color="charcoal.500" fontSize="sm">
                    Send <strong>{linkDialog?.name}</strong> this one-time link to set up their passkey:
                  </Text>
                  <Input
                    value={linkDialog?.link ?? ""}
                    readOnly
                    onFocus={(e) => e.target.select()}
                    size="sm"
                    fontFamily="mono"
                    fontSize="xs"
                    borderColor="gray.300"
                  />
                  <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
                    Issuing a new link invalidates any prior unused enrollment link for this staff member.
                  </Text>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={3}>
                <Button
                  variant="ghost"
                  fontFamily="heading"
                  size="sm"
                  color="charcoal.500"
                  onClick={() => setLinkDialog(null)}
                >
                  Done
                </Button>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={copyEnrollmentLink}
                >
                  <Copy size={14} /> Copy link
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      <Dialog.Root
        open={!!removeTarget}
        onOpenChange={(e) => {
          if (!e.open && !isRemoving) setRemoveTarget(null);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="sm" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Remove from school
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontFamily="body" color="charcoal.500">
                  Remove <strong>{removeTarget?.name}</strong> from this school? Their account stays intact, but they lose this school membership.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={3} gap={3}>
                <Button
                  variant="ghost"
                  fontFamily="heading"
                  size="sm"
                  color="charcoal.500"
                  onClick={() => setRemoveTarget(null)}
                  disabled={isRemoving}
                >
                  Cancel
                </Button>
                <Button
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={confirmRemoveStaff}
                  disabled={isRemoving}
                  loading={isRemoving}
                >
                  Remove
                </Button>
              </Dialog.Footer>
            </Dialog.Content>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

function ManageStaffAccessDialog({
  staffer,
  institutionId,
  onClose,
}: {
  staffer: StaffRow | null;
  institutionId: Id<"institutions"> | null;
  onClose: () => void;
}) {
  const editor = useQuery(
    api.staffCapabilities.editorForStaff,
    staffer && institutionId ? { userId: staffer.id, institutionId } : "skip",
  );

  const staffName = staffer?.name ?? staffer?.username ?? "Staff member";
  return (
    <Dialog.Root
      open={!!staffer}
      onOpenChange={(event) => {
        if (!event.open) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="lg" mx={4} borderRadius="xl">
            <Dialog.Header px={{ base: 4, md: 6 }} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                Manage access
              </Dialog.Title>
            </Dialog.Header>
            {editor === undefined || !staffer || !institutionId ? (
              <>
                <Dialog.Body px={{ base: 4, md: 6 }} py={3}>
                  <HStack color="charcoal.400" py={4}>
                    <Spinner size="sm" />
                    <Text fontSize="sm">Loading access…</Text>
                  </HStack>
                </Dialog.Body>
                <Dialog.Footer px={{ base: 4, md: 6 }} pb={5} pt={2}>
                  <Button variant="ghost" onClick={onClose}>
                    Cancel
                  </Button>
                </Dialog.Footer>
              </>
            ) : (
              <StaffAccessEditor
                key={`${staffer.id}:${institutionId}`}
                staffer={staffer}
                staffName={staffName}
                institutionId={institutionId}
                editor={editor}
                onClose={onClose}
              />
            )}
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function StaffAccessEditor({
  staffer,
  staffName,
  institutionId,
  editor,
  onClose,
}: {
  staffer: StaffRow;
  staffName: string;
  institutionId: Id<"institutions">;
  editor: StaffCapabilityEditor;
  onClose: () => void;
}) {
  const updateAccess = useMutation(api.staffCapabilities.updateForStaff);
  let schoolOperationsDescription =
    "Manage scholar accounts, families, forms, portfolios, devices, and attendance — not learning records or curriculum.";
  const [canEditCurriculum, setCanEditCurriculum] = useState(
    editor.canEditCurriculum,
  );
  const [canManageSchoolOperations, setCanManageSchoolOperations] = useState(
    editor.canManageSchoolOperations,
  );
  const [canManageHealthRecords, setCanManageHealthRecords] = useState(
    editor.canManageHealthRecords,
  );
  const [programGroupAccess, setProgramGroupAccess] = useState(() =>
    Object.fromEntries(
      editor.programGroups.map((group) => [
        group.groupId,
        {
          canPublish: group.canPublish,
          canReviewCaptures: group.canReviewCaptures,
        },
      ]),
    ) as Record<string, { canPublish: boolean; canReviewCaptures: boolean }>,
  );
  const [isSaving, setIsSaving] = useState(false);

  const updateGroup = (
    groupId: string,
    field: "canPublish" | "canReviewCaptures",
    value: boolean,
  ) => {
    if (
      field === "canPublish" &&
      value &&
      !editor.curriculumAccessIncludedInRole
    ) {
      setCanEditCurriculum(true);
    }
    setProgramGroupAccess((current) => ({
      ...current,
      [groupId]: {
        canPublish: current[groupId]?.canPublish ?? false,
        canReviewCaptures: current[groupId]?.canReviewCaptures ?? false,
        [field]: value,
      },
    }));
  };

  const updateCurriculumAccess = (value: boolean) => {
    if (editor.curriculumAccessIncludedInRole) return;
    setCanEditCurriculum(value);
    if (value) return;
    setProgramGroupAccess((current) =>
      Object.fromEntries(
        Object.entries(current).map(([groupId, access]) => [
          groupId,
          { ...access, canPublish: false },
        ]),
      ),
    );
  };

  const updateSchoolOperationsAccess = (value: boolean) => {
    if (editor.schoolOperationsIncludedInRole) return;
    setCanManageSchoolOperations(value);
  };

  const updateHealthAccess = (value: boolean) => {
    if (editor.healthAccessIncludedInRole) return;
    setCanManageHealthRecords(value);
  };

  const save = async () => {
    setIsSaving(true);
    try {
      await updateAccess({
        userId: staffer.id,
        institutionId,
        canEditCurriculum,
        canManageSchoolOperations,
        canManageHealthRecords,
        programGroupAccess: editor.programGroups.map((group) => ({
          groupId: group.groupId,
          canPublish: programGroupAccess[group.groupId]?.canPublish ?? false,
          canReviewCaptures:
            programGroupAccess[group.groupId]?.canReviewCaptures ?? false,
        })),
      });
      toaster.success({ title: "Access updated" });
      onClose();
    } catch (error) {
      toaster.error({
        title: "Could not update access",
        description:
          error instanceof Error ? error.message : "Please try again.",
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Dialog.Body px={{ base: 4, md: 6 }} py={3}>
        <VStack align="stretch" gap={5}>
          <Box>
            <Text fontFamily="body" color="charcoal.600">
              Set what <strong>{staffName}</strong> can do in this school.
            </Text>
            <Text mt={1} fontSize="sm" color="charcoal.400">
              Base role: {ROLE_LABEL[staffer.role] ?? staffer.role}
            </Text>
          </Box>

          <Box>
            <Text fontFamily="heading" fontWeight="600" color="navy.500">
              School-wide access
            </Text>
            <VStack align="stretch" gap={4} mt={3}>
              <Box>
                <Checkbox.Root
                  checked={
                    canEditCurriculum || editor.curriculumAccessIncludedInRole
                  }
                  disabled={editor.curriculumAccessIncludedInRole}
                  onCheckedChange={(details) =>
                    updateCurriculumAccess(details.checked === true)
                  }
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontFamily="heading" fontWeight="600">
                    Build units and materials
                  </Checkbox.Label>
                </Checkbox.Root>
                <Text mt={1} ml={6} fontSize="sm" color="charcoal.400">
                  {editor.curriculumAccessIncludedInRole
                    ? "Included in their base role."
                    : "Create and edit the activities that can be assigned to programs."}
                </Text>
              </Box>
              <Box>
                <Checkbox.Root
                  checked={
                    canManageHealthRecords || editor.healthAccessIncludedInRole
                  }
                  disabled={editor.healthAccessIncludedInRole}
                  onCheckedChange={(details) =>
                    updateHealthAccess(details.checked === true)
                  }
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontFamily="heading" fontWeight="600">
                    Manage health records
                  </Checkbox.Label>
                </Checkbox.Root>
                <Text mt={1} ml={6} fontSize="sm" color="charcoal.400">
                  {editor.healthAccessIncludedInRole
                    ? "Included in their base role."
                    : "Read and manage health records, physician documents, and medical clearances in this school."}
                </Text>
              </Box>
              <Box>
                <Checkbox.Root
                  checked={
                    canManageSchoolOperations ||
                    editor.schoolOperationsIncludedInRole
                  }
                  disabled={editor.schoolOperationsIncludedInRole}
                  onCheckedChange={(details) =>
                    updateSchoolOperationsAccess(details.checked === true)
                  }
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label fontFamily="heading" fontWeight="600">
                    Manage school operations
                  </Checkbox.Label>
                </Checkbox.Root>
                <Text mt={1} ml={6} fontSize="sm" color="charcoal.400">
                  {editor.schoolOperationsIncludedInRole
                    ? "Included in their base role."
                    : schoolOperationsDescription}
                </Text>
              </Box>
            </VStack>
          </Box>

          <Box>
            <Text fontFamily="heading" fontWeight="600" color="navy.500">
              Extended education programs
            </Text>
            <Text mt={1} fontSize="sm" color="charcoal.400">
              Give access only to the programs this staff member supports.
            </Text>
            {editor.programGroups.length ? (
              <VStack align="stretch" gap={3} mt={3}>
                {editor.programGroups.map((group) => {
                  const access = programGroupAccess[group.groupId] ?? {
                    canPublish: false,
                    canReviewCaptures: false,
                  };
                  return (
                    <Box
                      key={group.groupId}
                      borderWidth="1px"
                      borderColor="gray.200"
                      borderRadius="lg"
                      p={3}
                    >
                      <Text fontFamily="heading" fontWeight="600" mb={3}>
                        {group.name}
                      </Text>
                      <HStack gap={{ base: 4, md: 6 }} flexWrap="wrap">
                        <Checkbox.Root
                          size="sm"
                          checked={access.canPublish}
                          onCheckedChange={(details) =>
                            updateGroup(
                              group.groupId,
                              "canPublish",
                              details.checked === true,
                            )
                          }
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                          <Checkbox.Label>Assign activities</Checkbox.Label>
                        </Checkbox.Root>
                        <Checkbox.Root
                          size="sm"
                          checked={access.canReviewCaptures}
                          onCheckedChange={(details) =>
                            updateGroup(
                              group.groupId,
                              "canReviewCaptures",
                              details.checked === true,
                            )
                          }
                        >
                          <Checkbox.HiddenInput />
                          <Checkbox.Control />
                          <Checkbox.Label>Review captures</Checkbox.Label>
                        </Checkbox.Root>
                      </HStack>
                    </Box>
                  );
                })}
              </VStack>
            ) : (
              <Text mt={3} fontSize="sm" color="charcoal.400">
                No Extended education programs are available in this school.
              </Text>
            )}
          </Box>
        </VStack>
      </Dialog.Body>
      <Dialog.Footer px={{ base: 4, md: 6 }} pb={5} pt={2} gap={3}>
        <Button variant="ghost" onClick={onClose} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          colorPalette="violet"
          onClick={() => void save()}
          disabled={isSaving}
          loading={isSaving}
        >
          Save access
        </Button>
      </Dialog.Footer>
    </>
  );
}

/**
 * Create a staff account in the caller's institution, then surface the one-time
 * passkey enrollment link to hand off.
 */
function AddStaffButton() {
  const createStaff = useMutation(api.users.createInstitutionStaff);
  const issueLink = useMutation(api.enrollment.issueStaffEnrollLink);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<StaffRole>("teacher");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [createdName, setCreatedName] = useState("");

  const reset = () => {
    setName("");
    setUsername("");
    setEmail("");
    setRole("teacher");
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
    const n = name.trim();
    if (!n) {
      setError("Name is required");
      return;
    }
    // Username is optional here, so only validate a non-empty one — but do it
    // client-side, or the server's rejection arrives as a raw (production-
    // redacted) Convex error with no actionable guidance.
    const problem = username.trim() ? usernameError(username) : null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { userId } = await createStaff({
        name: n,
        username: username.trim() || undefined,
        email: email.trim() || undefined,
        role,
      });
      const res = await issueLink({ userId });
      setCreatedName(n);
      setLink(
        (typeof window !== "undefined" ? window.location.origin : "") + res.path,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create staff");
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
        <UserPlus style={{ marginRight: "6px" }} /> Add staff
      </Button>

      <Dialog.Root open={open} onOpenChange={(e) => !e.open && close()} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <Dialog.Content maxW="md" mx={4} borderRadius="xl">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  {link ? "Staff member created" : "Add staff"}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {link ? (
                  <VStack align="stretch" gap={3}>
                    <Text fontFamily="body" color="charcoal.500" fontSize="sm">
                      Created <strong>{createdName}</strong>. Send them this
                      one-time enrollment link to set up their passkey:
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
                        Name
                      </Text>
                      <Input
                        size="sm"
                        placeholder="e.g. Jane Doe"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        disabled={busy}
                        bg="gray.50"
                        fontFamily="body"
                        autoFocus
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Username <Text as="span" color="charcoal.300">(optional)</Text>
                      </Text>
                      <Input
                        size="sm"
                        placeholder="e.g. jdoe"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        disabled={busy}
                        bg="gray.50"
                        fontFamily="body"
                      />
                    </Box>
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Email <Text as="span" color="charcoal.300">(optional)</Text>
                      </Text>
                      <Input
                        size="sm"
                        placeholder="e.g. jane@school.edu"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
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
                        <option value="teacher">teacher</option>
                        <option value="staff">staff</option>
                        <option value="curriculum_designer">curriculum designer</option>
                      </FieldSelect>
                      <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mt={1}>
                        Added to your school. They&apos;ll get a one-time passkey
                        enrollment link to set up sign-in. Grant access per
                        person from Manage access after they&apos;re added.
                      </Text>
                    </Box>
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
                      disabled={busy || !name.trim()}
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

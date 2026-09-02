"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  HStack,
  Input,
  Portal,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Plus, PencilSimple, Copy, Check, LinkSimple, EnvelopeSimple, Printer, Camera, DownloadSimple, Upload, Key } from "@phosphor-icons/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { Avatar } from "@/components/Avatar";
import { PersonCell } from "@/components/PersonCell";
import { ScholarPhotoDialog } from "@/components/ScholarPhotoDialog";
import { ScholarDocumentUploadModal } from "@/components/ScholarDocumentUploadModal";
import { ScholarPicker } from "@/components/ScholarPicker";
import { ScholarParticipationFilter } from "@/components/ScholarParticipationFilter";
import {
  ScholarSignInLinkPanel,
  ScholarSignInLinkDialog,
} from "@/components/ScholarSignInLink";
import { passwordActionLabel } from "@/components/scholarSignInLinkUtils";
import { TableRowsSkeleton } from "@/components/skeletons/PanelSkeletons";
import { EmptyState } from "@/components/ui/EmptyState";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { hasHealthAccessForInstitution } from "@/hooks/useSchoolOperationsAccess";
import { scholarSlug } from "@/convex/lib/channels";
import { usernameError } from "@/convex/lib/username";
import {
  DEFAULT_SCHOLAR_PARTICIPATION,
  scholarMatchesParticipation,
  type ScholarParticipationSelection,
} from "@/shared/scholarParticipation";
import { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";
import type { EnrollmentStanding } from "@/convex/lib/enrollmentStanding";
import {
  type FamiliesDirectoryView,
  type ParentRowLike,
  type ScholarRowLike,
  buildGuardiansCsv,
  canUploadDirectoryDocuments,
  deriveScholarRows,
  filterParents,
  filterScholarRows,
  guardianAddressParts,
  guardianNameParts,
  mergeScholarRows,
  parentLabel,
  scholarIdsFromParents,
} from "@/components/adminParentsManagerUtils";
import { downloadBlob } from "./downloadFile";

type ParentRow = ParentRowLike<Id<"users">> & {
  phone: string | null;
  address: string | null;
};

type ScholarRow = ScholarRowLike<Id<"users">>;

// The Guardians lens lives at /school/directory/guardians; a scholar's
// guardian tag (in the Scholars view) deep-links here with ?parent= to
// scroll + highlight.
const GUARDIANS_PATH = "/school/directory/guardians";

function guardianHref(search: string, parentId: Id<"users">): string {
  const params = new URLSearchParams(search);
  params.delete("view");
  params.set("parent", parentId);
  const qs = params.toString();
  return qs ? `${GUARDIANS_PATH}?${qs}` : GUARDIANS_PATH;
}

function scholarProfileHref(scholar: { _id: Id<"users">; username?: string | null }): string {
  return `/teacher/scholars/${scholarSlug(scholar.username, scholar._id)}`;
}

type LegacyParentRow = {
  _id: Id<"users">;
  name: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string | null;
  image?: string | null;
  phone: string | null;
  address: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  children: {
    _id: Id<"users">;
    name: string;
    gradeLevel?: string | null;
    image?: string | null;
    username?: string | null;
    enrollmentStanding?: "enrolled" | "program_guest";
  }[];
};

/** Format one parent as an email "To"-field recipient: `"Name" <email>`. */
function toRecipient(p: { name: string | null; email: string | null }): string | null {
  if (!p.email) return null;
  return p.name ? `"${p.name}" <${p.email}>` : p.email;
}

/**
 * Admin Parents directory: Rabbithole is the school's system of record for
 * parent contact info (email / phone / address) and parent↔child links. This
 * is a STAFF-ONLY surface — addresses shown here never reach a parent (a
 * parent must not see another parent's address: custody / safety). Add, edit,
 * and (un)link children all live here.
 *
 * `view` selects the lens: "guardians" (the parent-contact table) or "scholars"
 * (a scholar roster with linked guardians). The two are sibling routes
 * (/school/directory/guardians and /school/directory/scholars), surfaced as
 * top-level tabs — not an in-page toggle.
 */
export function AdminParentsManager({ view }: { view: FamiliesDirectoryView }) {
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const highlightedParentId = searchParams.get("parent");
  // Honor the active institution lens (?inst=) — this directory renders on the
  // /school Families surface, where the account-menu switcher is live. The
  // backend scopes to parents whose linked children fall within the lens and
  // only honors a school the caller may see (an operations staffer/school_admin can't use
  // the lens to reach another school's families).
  const { activeInstitution, scopeParam } = useActiveInstitution();
  const parents =
    (useQuery(api.parents.listAllParents, { scope: scopeParam }) as
      | LegacyParentRow[]
      | undefined) ?? undefined;

  // The authoritative, lens-scoped scholar set for the Scholars roster. The
  // guardian-derived list (deriveScholarRows, below) only knows scholars who
  // already have a guardian linked — so a scholar added via the new "Add
  // scholar" button (or any scholar without a guardian yet) would be invisible.
  // The directory-specific query returns only the row fields this surface uses.
  // Skipped entirely on the Guardians lens (it doesn't need it).
  const scholarList = useQuery(
    api.users.listDirectoryScholars,
    view === "scholars" ? { institutionScope: scopeParam } : "skip",
  ) as
    | {
        _id: Id<"users">;
        name: string | null;
        image?: string | null;
        username?: string | null;
        enrollmentStanding: EnrollmentStanding;
        hasCredential?: boolean;
      }[]
    | undefined;

  const [editing, setEditing] = useState<ParentRow | null>(null);
  const [adding, setAdding] = useState(false);
  const [addingScholar, setAddingScholar] = useState(false);
  const [query, setQuery] = useState("");
  const [participation, setParticipation] =
    useState<ScholarParticipationSelection>(DEFAULT_SCHOLAR_PARTICIPATION);
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedId, setCopiedId] = useState<Id<"users"> | null>(null);
  // One dialog for the whole scholars table — state holds which scholar's photo
  // is being edited (not one dialog per row).
  const [photoScholar, setPhotoScholar] = useState<ScholarRow | null>(null);
  // Likewise one upload modal for the table, holding the row it was opened
  // from. It takes the SAME `scopeParam` the row list was built with: the rows
  // are lens-scoped, so a modal that fell back to the caller's home lens would
  // refuse (or throw for an operations staffer) on any row from another institution the
  // caller may legitimately see.
  const [uploadScholar, setUploadScholar] = useState<ScholarRow | null>(null);
  // The row whose one-time sign-in link is being (re-)issued — "kid forgot
  // their password" / "I created them yesterday". One dialog for the whole table.
  const [signInLinkScholar, setSignInLinkScholar] = useState<ScholarRow | null>(
    null,
  );
  const { user } = useCurrentUser();
  const canUploadDocuments = canUploadDirectoryDocuments(
    user?.role,
    hasHealthAccessForInstitution(
      user,
      activeInstitution?.institutionId,
    ),
  );
  const adminUpdateScholarProfile = useMutation(
    api.users.adminUpdateScholarProfile,
  );

  // Filter by name / email / child name (so an operations staffer can copy a SUBSET —
  // e.g. one family or a grade — into an email "To" field).
  const filtered = useMemo(() => {
    return filterParents(parents ?? [], query) as ParentRow[];
  }, [parents, query]);

  const scholars = useMemo(() => {
    const guardianDerived = deriveScholarRows(parents ?? []) as ScholarRow[];
    return view === "scholars"
      ? (mergeScholarRows(scholarList ?? [], guardianDerived) as ScholarRow[])
      : guardianDerived;
  }, [view, scholarList, parents]);

  // Scholars-roster loading: gate on BOTH the scholar set and the parents
  // (guardian tags) so rows don't render with guardians briefly missing.
  const scholarsLoading =
    view === "scholars" && (scholarList === undefined || parents === undefined);

  const participationScholars = useMemo(
    () =>
      scholars.filter((scholar) =>
        scholarMatchesParticipation(scholar, participation),
      ),
    [scholars, participation],
  );

  const filteredScholars = useMemo(
    () => filterScholarRows(participationScholars, query) as ScholarRow[],
    [participationScholars, query],
  );

  const recipients = useMemo(
    () => filtered.map(toRecipient).filter((r): r is string => r !== null),
    [filtered],
  );

  const guardianExportRowCount = useMemo(
    () => filtered.reduce((total, row) => total + row.children.length, 0),
    [filtered],
  );

  // Unique scholar IDs across all currently-filtered parent rows — used for
  // the batch one-sheet print action. Deduplication handles the case where a
  // scholar is linked to multiple parents.
  const filteredScholarIds = useMemo(() => {
    return view === "scholars"
      ? filteredScholars.map((scholar) => scholar._id)
      : scholarIdsFromParents(filtered) as Id<"users">[];
  }, [filtered, filteredScholars, view]);

  useEffect(() => {
    if (view !== "guardians" || !highlightedParentId || parents === undefined) return;
    const row = document.getElementById(`family-${highlightedParentId}`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
  }, [highlightedParentId, parents, view]);

  const copy = async (text: string, onDone: () => void) => {
    try {
      await navigator.clipboard.writeText(text);
      onDone();
      setTimeout(() => {
        setCopiedAll(false);
        setCopiedId(null);
      }, 1500);
    } catch {
      // Clipboard can fail (permissions / insecure context) — no-op; the
      // values are still visible in the table.
    }
  };

  const handleExportCsv = () => {
    const csv = buildGuardiansCsv(filtered);
    downloadBlob(
      new Blob([csv], { type: "text/csv;charset=utf-8;" }),
      `guardians-${new Date().toISOString().slice(0, 10)}.csv`,
    );
  };

  return (
    <Box>
      <HStack justify="space-between" mb={3} align="start" gap={3} wrap="wrap">
        <Text fontFamily="body" fontSize="sm" color="charcoal.400" flex={1} minW="240px">
          {view === "scholars"
            ? "Scholars and their linked guardians — print an emergency one-pager for any scholar."
            : "Guardian accounts — contact info and linked children. Guardians sign in passwordless; generate a sign-in link from a scholar's profile."}
        </Text>
        <HStack gap={2} flexShrink={0}>
          {view === "guardians" && (
            <Button
              size="sm"
              variant="outline"
              borderColor="gray.200"
              fontFamily="heading"
              disabled={recipients.length === 0}
              onClick={() =>
                copy(recipients.join(", "), () => setCopiedAll(true))
              }
              title={`Copy ${recipients.length} email recipient${recipients.length === 1 ? "" : "s"} for an email "To" field`}
            >
              {copiedAll ? (
                <Check style={{ marginRight: "6px" }} />
              ) : (
                <Copy style={{ marginRight: "6px" }} />
              )}
              {copiedAll
                ? "Copied!"
                : `Copy emails${query.trim() ? ` (${recipients.length})` : ""}`}
            </Button>
          )}
          {/* Batch one-sheet: opens a print page for every scholar currently
              visible (respects the active filter). Trip roster use case. */}
          {view === "scholars" && (
            <Button
              size="sm"
              variant="outline"
              borderColor="gray.200"
              fontFamily="heading"
              disabled={filteredScholarIds.length === 0}
              title={`Print emergency one-pagers for ${filteredScholarIds.length} scholar${filteredScholarIds.length === 1 ? "" : "s"}`}
              onClick={() => {
                if (filteredScholarIds.length === 0) return;
                window.open(
                  `/print/one-sheet/batch?ids=${filteredScholarIds.join(",")}`,
                  "_blank",
                );
              }}
            >
              <Printer style={{ marginRight: "6px" }} />
              {`One-pagers${query.trim() ? ` (${filteredScholarIds.length})` : ""}`}
            </Button>
          )}
          {view === "scholars" && (
            <Button
              size="sm"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              onClick={() => setAddingScholar(true)}
            >
              <Plus style={{ marginRight: "6px" }} /> Add scholar
            </Button>
          )}
          {view === "guardians" && (
            <Button
              size="sm"
              variant="outline"
              borderColor="gray.200"
              fontFamily="heading"
              disabled={guardianExportRowCount === 0}
              onClick={handleExportCsv}
              title={`Export ${guardianExportRowCount} guardian-student row${guardianExportRowCount === 1 ? "" : "s"} to CSV`}
            >
              <DownloadSimple style={{ marginRight: "6px" }} />
              {`Export CSV${query.trim() ? ` (${guardianExportRowCount})` : ""}`}
            </Button>
          )}
          {view === "guardians" && (
            <Button
              size="sm"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              onClick={() => setAdding(true)}
            >
              <Plus style={{ marginRight: "6px" }} /> Add Guardian
            </Button>
          )}
        </HStack>
      </HStack>

      <HStack mb={3} justify="space-between" align="end" gap={3} wrap="wrap">
        {view === "scholars" && (
          <ScholarParticipationFilter
            selection={participation}
            onChange={setParticipation}
          />
        )}
        <HStack justify="flex-end" align="center" gap={3} flex={1} minW="280px">
          <Input
            size="sm"
            maxW="360px"
            placeholder={
              view === "scholars"
                ? "Filter by scholar or guardian…"
                : "Filter by guardian, email, or child…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            bg="white"
            fontFamily="body"
          />
          {query.trim() && parents && (
            <Text fontSize="xs" color="charcoal.300" fontFamily="body">
              {view === "scholars"
                ? `${filteredScholars.length} of ${participationScholars.length}`
                : `${filtered.length} of ${parents.length}`}
            </Text>
          )}
        </HStack>
      </HStack>

      {view === "scholars" ? (
        <Box
          bg="white"
          borderRadius="lg"
          borderWidth="1px"
          borderColor="gray.200"
          shadow="xs"
          overflowX="auto"
        >
          {scholarsLoading ? (
            <Table.Root size="sm" minW="820px">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader fontFamily="heading" pl={4}>
                    Scholar
                  </Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">
                    Guardians
                  </Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading" w="264px"></Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                <TableRowsSkeleton columns={3} />
              </Table.Body>
            </Table.Root>
          ) : scholars.length === 0 ? (
            <Box px={6}>
              <EmptyState
                size="lg"
                title="No scholars yet."
                hint="Add a scholar with the button above, or send a join link from the Invites tab."
              />
            </Box>
          ) : (
            <Table.Root size="sm" minW="820px">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader fontFamily="heading" pl={4}>
                    Scholar
                  </Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">
                    Guardians
                  </Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading" w="264px"></Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {filteredScholars.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={3} fontFamily="body" color="charcoal.300" pl={4} py={6}>
                      No scholars match your filter.
                    </Table.Cell>
                  </Table.Row>
                ) : (
                  filteredScholars.map((scholar) => (
                    <Table.Row key={scholar._id}>
                      <Table.Cell fontFamily="body" pl={4}>
                        <HStack gap={3}>
                          {/* The real photo (or initials), clickable to set /
                              change it. A camera badge marks it as editable. */}
                          <Box
                            as="button"
                            position="relative"
                            flexShrink={0}
                            cursor="pointer"
                            borderRadius="full"
                            aria-label={`Set ${scholar.name}'s photo`}
                            title={`Set ${scholar.name}'s photo`}
                            onClick={() => setPhotoScholar(scholar)}
                          >
                            <Avatar
                              name={scholar.name}
                              src={scholar.image ?? undefined}
                              size="sm"
                              colorKey={scholar._id}
                            />
                            <Box
                              position="absolute"
                              bottom={-0.5}
                              right={-0.5}
                              bg="violet.500"
                              borderRadius="full"
                              w={4}
                              h={4}
                              display="flex"
                              alignItems="center"
                              justifyContent="center"
                              border="2px solid white"
                            >
                              <Camera size={9} color="white" />
                            </Box>
                          </Box>
                          <Link
                            href={scholarProfileHref(scholar)}
                            style={{ textDecoration: "none" }}
                          >
                            <VStack gap={0} align="start">
                              <Text
                                fontWeight="500"
                                _hover={{ textDecoration: "underline" }}
                              >
                                {scholar.name}
                              </Text>
                              {scholar.enrollmentStanding === "program_guest" && (
                                <Text
                                  fontFamily="body"
                                  fontSize="xs"
                                  color="violet.600"
                                >
                                  {EXTENDED_EDUCATION_LABEL}
                                </Text>
                              )}
                            </VStack>
                          </Link>
                        </HStack>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap={2} wrap="wrap">
                          {scholar.parents.map((parent) => (
                            <PersonCell
                              key={parent._id}
                              name={parentLabel(parent)}
                              image={parent.image}
                              colorKey={parent._id}
                              href={guardianHref(search, parent._id)}
                              title={`Show ${parentLabel(parent)} in Guardians view`}
                            />
                          ))}
                        </HStack>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap={0}>
                          <Button
                            variant="ghost"
                            size="sm"
                            color="charcoal.500"
                            fontFamily="heading"
                            fontWeight="500"
                            _hover={{ color: "violet.600", bg: "violet.50" }}
                            title={
                              scholar.hasCredential
                                ? `Reset ${scholar.name}'s password`
                                : `Create a password for ${scholar.name}`
                            }
                            onClick={() => setSignInLinkScholar(scholar)}
                          >
                            <Key style={{ marginRight: "6px" }} />
                            {passwordActionLabel(scholar.hasCredential)}
                          </Button>
                          {canUploadDocuments && (
                            <Button
                              variant="ghost"
                              size="sm"
                              color="charcoal.500"
                              fontFamily="heading"
                              fontWeight="500"
                              _hover={{ color: "violet.600", bg: "violet.50" }}
                              title={`Upload a document for ${scholar.name}`}
                              onClick={() => setUploadScholar(scholar)}
                            >
                              <Upload style={{ marginRight: "6px" }} />
                              Upload
                            </Button>
                          )}
                          <Button
                            asChild
                            variant="ghost"
                            size="sm"
                            color="charcoal.500"
                            fontFamily="heading"
                            fontWeight="500"
                            _hover={{ color: "violet.600", bg: "violet.50" }}
                          >
                            <Link
                              href={`/print/one-sheet/${scholar._id}`}
                              target="_blank"
                              title={`Print emergency one-pager for ${scholar.name}`}
                            >
                              <Printer style={{ marginRight: "6px" }} />
                              One-pager
                            </Link>
                          </Button>
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  ))
                )}
              </Table.Body>
            </Table.Root>
          )}
        </Box>
      ) : (
        <Box
          bg="white"
          borderRadius="lg"
          borderWidth="1px"
          borderColor="gray.200"
          shadow="xs"
          overflowX="auto"
        >
            <Table.Root size="sm" minW="620px">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader fontFamily="heading" pl={4} minW="200px">
                    Name
                  </Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Contact</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading">Children</Table.ColumnHeader>
                  <Table.ColumnHeader fontFamily="heading" w="90px"></Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {parents === undefined ? (
                  <TableRowsSkeleton columns={4} />
                ) : filtered.length === 0 ? (
                  <Table.Row>
                    <Table.Cell colSpan={4} fontFamily="body" color="charcoal.300" pl={4} py={6}>
                      {parents.length > 0
                        ? "No guardians match your filter."
                        : "No guardians yet. Add one, or link guardians from a scholar's profile."}
                    </Table.Cell>
                  </Table.Row>
                ) : (
                  filtered.map((p) => (
                    <Table.Row
                      key={p._id}
                      id={`family-${p._id}`}
                      bg={highlightedParentId === p._id ? "violet.50" : undefined}
                    >
                      <Table.Cell fontFamily="body" pl={4}>
                        <PersonCell
                          name={p.name ?? "—"}
                          image={p.image}
                          colorKey={p._id}
                        />
                      </Table.Cell>
                      <Table.Cell fontFamily="body" color="charcoal.500">
                        {p.email || p.phone || p.address ? (
                          <VStack align="start" gap={0.5}>
                            {p.email && (
                              <Text fontFamily="body" fontSize="sm" color="charcoal.500" overflowWrap="anywhere">
                                {p.email}
                              </Text>
                            )}
                            {p.phone && (
                              <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                                {p.phone}
                              </Text>
                            )}
                            {p.address && (
                              <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                                {p.address}
                              </Text>
                            )}
                          </VStack>
                        ) : (
                          "—"
                        )}
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap={3} wrap="wrap">
                          {p.children.length === 0 ? (
                            <Text fontFamily="body" fontSize="sm" color="charcoal.300">
                              none
                            </Text>
                          ) : (
                            p.children.map((c) => (
                              <VStack key={c._id} align="start" gap={0}>
                                <PersonCell
                                  name={c.name}
                                  image={c.image}
                                  colorKey={c._id}
                                />
                                {c.enrollmentStanding === "program_guest" && (
                                  <Text
                                    fontFamily="body"
                                    fontSize="xs"
                                    color="charcoal.400"
                                    pl={7}
                                  >
                                    {EXTENDED_EDUCATION_LABEL}
                                  </Text>
                                )}
                              </VStack>
                            ))
                          )}
                        </HStack>
                      </Table.Cell>
                      <Table.Cell>
                        <HStack gap={1}>
                          {p.email && (
                            <Button
                              size="2xs"
                              variant="ghost"
                              color="charcoal.400"
                              fontFamily="heading"
                              onClick={() => {
                                const r = toRecipient(p);
                                if (r) copy(r, () => setCopiedId(p._id));
                              }}
                              title={`Copy "${p.name ?? p.email}" <${p.email}>`}
                            >
                              {copiedId === p._id ? <Check /> : <Copy />}
                            </Button>
                          )}
                          <Button
                            size="2xs"
                            variant="outline"
                            borderColor="gray.200"
                            fontFamily="heading"
                            onClick={() => setEditing(p)}
                          >
                            <PencilSimple style={{ marginRight: "4px" }} /> Edit
                          </Button>
                          <ParentLinkButton parentId={p._id} parentName={p.name} />
                          <InviteParentButton parentId={p._id} email={p.email} />
                        </HStack>
                      </Table.Cell>
                    </Table.Row>
                  ))
                )}
              </Table.Body>
            </Table.Root>
        </Box>
      )}

      {adding && (
        <ParentDialog mode="add" onClose={() => setAdding(false)} />
      )}
      {addingScholar && (
        <AddScholarDialog
          scope={scopeParam}
          onClose={() => setAddingScholar(false)}
        />
      )}
      {editing && (
        <ParentDialog
          mode="edit"
          parent={editing}
          onClose={() => setEditing(null)}
        />
      )}
      <ScholarPhotoDialog
        open={photoScholar !== null}
        onClose={() => setPhotoScholar(null)}
        scholarName={photoScholar?.name ?? ""}
        currentImage={photoScholar?.image}
        onSave={async (imageStorageId) => {
          if (!photoScholar) return;
          await adminUpdateScholarProfile({
            scholarId: photoScholar._id,
            imageStorageId,
          });
        }}
      />

      <ScholarDocumentUploadModal
        scholarId={uploadScholar?._id ?? ""}
        scholarName={uploadScholar?.name}
        institutionScope={scopeParam}
        open={uploadScholar !== null}
        onClose={() => setUploadScholar(null)}
      />

      <ScholarSignInLinkDialog
        scholarId={(signInLinkScholar?._id ?? "") as Id<"users">}
        scholarName={signInLinkScholar?.name ?? "this scholar"}
        username={signInLinkScholar?.username}
        hasCredential={signInLinkScholar?.hasCredential}
        open={signInLinkScholar !== null}
        onClose={() => setSignInLinkScholar(null)}
      />
    </Box>
  );
}

/**
 * Add-scholar dialog. Sibling of `ParentDialog`'s "add" mode one tab over, so
 * the three directory tabs (Scholars / Guardians / Staff) share the same Add
 * affordance. Collects the scholar's name + optional login username and creates
 * the account via `users.createScholar`, which stamps the caller's institution
 * (see convex/users.ts) — the reactive roster then shows the new scholar with
 * no manual refresh. Guardian linking stays on the guardian side (Add Guardian
 * / a scholar's profile), matching where it already lives.
 */
function AddScholarDialog({
  scope,
  onClose,
}: {
  scope: string;
  onClose: () => void;
}) {
  const createScholar = useMutation(api.users.createScholar);
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Once created, we swap the form for a success state that hands the operator
  // the sign-in link they need to actually get the scholar signed in — the
  // dialog no longer just closes on success.
  const [created, setCreated] = useState<{
    userId: Id<"users">;
    name: string;
    username: string | null;
  } | null>(null);

  const handleSave = async () => {
    if (!name.trim()) {
      setError("Name is required");
      return;
    }
    const u = username.trim();
    const problem = u ? usernameError(username) : null;
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    const cleanName = name.trim();
    const cleanUsername = username.trim() || null;
    try {
      const { userId } = await createScholar({
        name: cleanName,
        username: cleanUsername ?? undefined,
        scope,
      });
      setCreated({ userId, name: cleanName, username: cleanUsername });
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => {
        if (!e.open && !busy) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                {created ? `${created.name} was added` : "Add a scholar"}
              </Dialog.Title>
            </Dialog.Header>
            {created ? (
              <>
                <Dialog.Body px={6} py={3}>
                  <ScholarSignInLinkPanel
                    scholarId={created.userId}
                    scholarName={created.name}
                    username={created.username}
                    hasCredential={false}
                  />
                </Dialog.Body>
                <Dialog.Footer px={6} pb={5} pt={2}>
                  <Button
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    fontFamily="heading"
                    size="sm"
                    onClick={onClose}
                  >
                    Done
                  </Button>
                </Dialog.Footer>
              </>
            ) : (
              <>
                <Dialog.Body px={6} py={3}>
                  <VStack align="stretch" gap={3}>
                    <Box>
                      <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                        Name
                      </Text>
                      <Input
                        size="sm"
                        aria-label="Name"
                        placeholder="e.g. Kai Nakamura"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
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
                        aria-label="Username (optional)"
                        placeholder="e.g. kai"
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        bg="gray.50"
                        fontFamily="body"
                      />
                      <Text fontSize="2xs" color="charcoal.300" mt={1} fontFamily="body">
                        The name they sign in with — needed to create their password.
                      </Text>
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
                    onClick={onClose}
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
                    onClick={handleSave}
                    disabled={busy || !name.trim()}
                    loading={busy}
                  >
                    Add scholar
                  </Button>
                </Dialog.Footer>
              </>
            )}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Shared add/edit dialog. In "add" mode it creates the parent + links the
 * selected children in one call; in "edit" mode it patches contact fields and
 * diffs the child set into link/unlink mutations. The child multi-select is
 * the shared `ScholarPicker` (search / avatars / reading level) — the same
 * primitive used by assignment targeting and scholar-group membership.
 */
function ParentDialog({
  mode,
  parent,
  onClose,
}: {
  mode: "add" | "edit";
  parent?: ParentRow;
  onClose: () => void;
}) {
  const createParent = useMutation(api.parents.createParent);
  const updateParent = useMutation(api.parents.updateParent);
  const linkGuardian = useMutation(api.parents.linkGuardian);
  const unlinkGuardian = useMutation(api.parents.unlinkGuardian);

  const initialName = guardianNameParts(parent ?? { name: null });
  const initialAddress = guardianAddressParts(parent ?? { address: null });
  const [firstName, setFirstName] = useState(initialName.firstName);
  const [lastName, setLastName] = useState(initialName.lastName);
  const [email, setEmail] = useState(parent?.email ?? "");
  const [phone, setPhone] = useState(parent?.phone ?? "");
  const [streetAddress, setStreetAddress] = useState(initialAddress.streetAddress);
  const [city, setCity] = useState(initialAddress.city);
  const [state, setState] = useState(initialAddress.state);
  const [zip, setZip] = useState(initialAddress.zip);
  // ScholarPicker keys on string ids (they ARE the user ids); cast at the
  // mutation boundary.
  const initialChildIds = useMemo(
    () => new Set((parent?.children ?? []).map((c) => c._id as string)),
    [parent],
  );
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(initialChildIds),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const handleSave = async () => {
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError("First name, last name, and email are required");
      return;
    }
    if (checked.size === 0) {
      setError("Choose at least one child");
      return;
    }
    setBusy(true);
    setError("");
    const displayName = `${firstName.trim()} ${lastName.trim()}`;
    try {
      if (mode === "add") {
        await createParent({
          name: displayName,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          streetAddress: streetAddress.trim() || undefined,
          city: city.trim() || undefined,
          state: state.trim() || undefined,
          zip: zip.trim() || undefined,
          scholarIds: Array.from(checked) as Id<"users">[],
        });
      } else if (parent) {
        await updateParent({
          parentId: parent._id,
          name: displayName,
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim(),
          phone: phone.trim(),
          streetAddress: streetAddress.trim(),
          city: city.trim(),
          state: state.trim(),
          zip: zip.trim(),
        });
        // Diff the child set → link/unlink only what changed.
        for (const id of checked) {
          if (!initialChildIds.has(id))
            await linkGuardian({
              parentId: parent._id,
              scholarId: id as Id<"users">,
            });
        }
        for (const id of initialChildIds) {
          if (!checked.has(id))
            await unlinkGuardian({
              parentId: parent._id,
              scholarId: id as Id<"users">,
            });
        }
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(e) => {
        if (!e.open && !busy) onClose();
      }}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                {mode === "add" ? "Add a guardian" : "Edit guardian"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack align="stretch" gap={3}>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    First name
                  </Text>
                  <Input
                    size="sm"
                    placeholder="e.g. Pat"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    bg="gray.50"
                    fontFamily="body"
                    autoFocus
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Last name
                  </Text>
                  <Input
                    size="sm"
                    placeholder="e.g. Nakamura"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    bg="gray.50"
                    fontFamily="body"
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
                    bg="gray.50"
                    fontFamily="body"
                  />
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
                    Street address <Text as="span" color="charcoal.300">(optional)</Text>
                  </Text>
                  <Input
                    size="sm"
                    placeholder="123 Kalakaua Ave"
                    value={streetAddress}
                    onChange={(e) => setStreetAddress(e.target.value)}
                    bg="gray.50"
                    fontFamily="body"
                  />
                </Box>
                <HStack align="start" gap={3}>
                  <Box flex={1}>
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      City <Text as="span" color="charcoal.300">(optional)</Text>
                    </Text>
                    <Input
                      size="sm"
                      placeholder="Honolulu"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      bg="gray.50"
                      fontFamily="body"
                    />
                  </Box>
                  <Box w="88px">
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      State
                    </Text>
                    <Input
                      size="sm"
                      placeholder="HI"
                      value={state}
                      onChange={(e) => setState(e.target.value)}
                      bg="gray.50"
                      fontFamily="body"
                    />
                  </Box>
                  <Box w="128px">
                    <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                      ZIP
                    </Text>
                    <Input
                      size="sm"
                      placeholder="96816"
                      value={zip}
                      onChange={(e) => setZip(e.target.value)}
                      bg="gray.50"
                      fontFamily="body"
                    />
                  </Box>
                </HStack>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={2} fontFamily="heading">
                    Children
                  </Text>
                  <Box borderWidth="1px" borderColor="gray.200" borderRadius="md" p={2}>
                    <ScholarPicker
                      mode="multi"
                      selected={checked}
                      onChange={setChecked}
                      showGroups={false}
                      showAffinityToggle={false}
                      showSelectAll={false}
                      maxH="200px"
                      emptyHint="No scholars to link."
                      // A guardian is a guardian whether their child is
                      // enrolled or visiting: Extended Education scholars must
                      // be attachable from the guardian side too, labeled so
                      // staff can tell them apart from enrolled scholars.
                      includeProgramGuests
                      showEnrollmentStanding
                    />
                  </Box>
                  {checked.size === 0 && (
                    <Text
                      fontSize="xs"
                      color="red.500"
                      fontFamily="body"
                      mt={1.5}
                    >
                      Choose at least one child.
                    </Text>
                  )}
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
                onClick={onClose}
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
                onClick={handleSave}
                disabled={
                  busy ||
                  !firstName.trim() ||
                  !lastName.trim() ||
                  !email.trim() ||
                  checked.size === 0
                }
                loading={busy}
              >
                {mode === "add" ? "Add guardian" : "Save"}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/**
 * Email a parent their "claim your account" Welcome invite (an inert link to
 * the /claim landing page; the parent requests a fresh magic sign-in link
 * there). Backend gate: parents.sendClaimInvite (scholar-admin), which also
 * enforces the family-comms kill-switch + pilot allow-list — so this surfaces a
 * clear error if the recipient isn't enabled for sends yet.
 */
function InviteParentButton({
  parentId,
  email,
}: {
  parentId: Id<"users">;
  email: string | null;
}) {
  const sendInvite = useMutation(api.parents.sendClaimInvite);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(
    null,
  );

  const handleClick = async () => {
    setOpen(true);
    setBusy(true);
    setResult(null);
    try {
      const res = await sendInvite({ parentId });
      setResult({ ok: true, msg: `Welcome invite sent to ${res.email}.` });
    } catch (e) {
      setResult({
        ok: false,
        msg: e instanceof Error ? e.message : "Failed to send invite",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="2xs"
        variant="outline"
        borderColor="gray.200"
        fontFamily="heading"
        onClick={handleClick}
        disabled={!email}
        title={
          email
            ? "Email a claim-your-account invite"
            : "No email on file for this parent"
        }
      >
        <EnvelopeSimple style={{ marginRight: "4px" }} /> Invite
      </Button>

      <Dialog.Root
        open={open}
        onOpenChange={(e) => !e.open && !busy && setOpen(false)}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="md">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title
                  fontFamily="heading"
                  fontWeight="700"
                  color="navy.500"
                >
                  Claim invite
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {busy || !result ? (
                  <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                    Sending…
                  </Text>
                ) : (
                  <Text
                    fontFamily="body"
                    fontSize="sm"
                    color={result.ok ? "charcoal.500" : "red.500"}
                  >
                    {result.msg}
                  </Text>
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2}>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  Done
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

/**
 * Issue a one-time passkey enrollment link for a parent and surface it to copy.
 * Backend gate: enrollment.issueParentEnrollLink (scholar-admin — operations staff +
 * school_admin), so this is how an operations staffer/school_admin gets a parent signed in
 * to the parent portal without a password.
 */
function ParentLinkButton({
  parentId,
  parentName,
}: {
  parentId: Id<"users">;
  parentName: string | null;
}) {
  const issueLink = useMutation(api.enrollment.issueParentEnrollLink);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState("");

  const handleClick = async () => {
    setOpen(true);
    setBusy(true);
    setError("");
    setLink(null);
    try {
      const res = await issueLink({ parentId });
      setLink(
        (typeof window !== "undefined" ? window.location.origin : "") + res.path,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to issue link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="2xs"
        variant="outline"
        borderColor="gray.200"
        fontFamily="heading"
        onClick={handleClick}
        title="Send a one-time passkey enrollment link"
      >
        <LinkSimple style={{ marginRight: "4px" }} /> Link
      </Button>

      <Dialog.Root open={open} onOpenChange={(e) => !e.open && !busy && setOpen(false)} placement="center">
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="md">
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                  Account link
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {error ? (
                  <Text fontFamily="body" fontSize="sm" color="red.500">
                    {error}
                  </Text>
                ) : busy || !link ? (
                  <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                    Generating link…
                  </Text>
                ) : (
                  <VStack align="stretch" gap={3}>
                    <Text fontFamily="body" color="charcoal.500" fontSize="sm">
                      Send <strong>{parentName ?? "this parent"}</strong> this
                      one-time link to set up their passkey and access the parent
                      portal:
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
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2}>
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={busy}
                >
                  Done
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

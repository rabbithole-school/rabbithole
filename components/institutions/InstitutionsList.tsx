"use client";

// InstitutionsList — the platform-admin's central roster of every institution on
// Rabbithole, with all three lifecycle actions in ONE place: pause / resume
// (reversible billing suspension) and the cascading delete. Until now a platform
// admin could only pause or delete from inside a single school's
// /school/settings, so the operator view could neither SEE which schools were
// paused nor act on them centrally. This surfaces both.
//
// It adds a view, not a second vocabulary: it reuses the canonical institution
// read model (`api.institutions.list` — the SAME batched query the account-menu
// institution lens already uses: mark data + a live scholar count, one query for
// the whole table, no per-row query) and the two shared confirmation dialogs
// (DisableSchoolDialog / DeleteSchoolDialog, already used by /school/settings).
//
// The PRIMARY institution is shown but offers NEITHER pause nor delete — the
// server hard-refuses both (institutionLifecycle.ts / institutionDeletion.ts),
// and `institutionActions` keeps the UI from ever offering a control the server
// would reject.

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Heading,
  HStack,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import { PauseCircle, PlayCircle, Trash } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { InstitutionMark } from "@/components/InstitutionMark";
import { DeleteSchoolDialog } from "@/components/DeleteSchoolDialog";
import { DisableSchoolDialog } from "@/components/DisableSchoolDialog";
import { TableRowsSkeleton } from "@/components/skeletons/PanelSkeletons";
import { toaster } from "@/lib/toaster";
import {
  institutionActions,
  institutionStatus,
  scholarCountLabel,
} from "@/components/institutions/institutionRow";

type InstitutionRow = {
  _id: Id<"institutions">;
  slug: string;
  name: string;
  kind: string;
  emoji: string | null;
  logoUrl: string | null;
  isPrimary: boolean;
  disabled: boolean;
  disabledAt: number | null;
  scholarCount: number;
};

type Target = { id: Id<"institutions">; name: string };

export function InstitutionsList() {
  const rows = useQuery(api.institutions.list, {}) as
    | InstitutionRow[]
    | undefined;
  const enableInstitution = useMutation(
    api.institutionLifecycle.enableInstitution,
  );

  const [pauseTarget, setPauseTarget] = useState<Target | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Target | null>(null);
  const [resumingId, setResumingId] = useState<Id<"institutions"> | null>(null);

  const handleResume = async (id: Id<"institutions">, name: string) => {
    setResumingId(id);
    try {
      await enableInstitution({ institutionId: id });
      toaster.success({
        title: `Resumed ${name}`,
        description: "Members can use Rabbithole again.",
      });
    } catch (e) {
      toaster.error({
        title: "Couldn't resume institution",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setResumingId(null);
    }
  };

  return (
    <VStack align="stretch" gap={5}>
      <Box>
        <Heading size="md" fontFamily="heading" color="navy.500">
          Institutions
        </Heading>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Every institution on Rabbithole. Pause access without deleting data,
          then resume it at any time. Deleting an institution and everything
          scoped to it is permanent. The primary institution can&apos;t be paused
          or deleted.
        </Text>
      </Box>

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
              <Table.ColumnHeader fontFamily="heading">
                Institution
              </Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">Kind</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">Size</Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading">
                Status
              </Table.ColumnHeader>
              <Table.ColumnHeader fontFamily="heading" textAlign="right">
                Actions
              </Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {rows === undefined ? (
              <TableRowsSkeleton rows={3} columns={5} />
            ) : rows.length === 0 ? (
              <Table.Row>
                <Table.Cell colSpan={5}>
                  <Text
                    fontFamily="body"
                    color="charcoal.400"
                    py={4}
                    textAlign="center"
                  >
                    No institutions yet.
                  </Text>
                </Table.Cell>
              </Table.Row>
            ) : (
              rows.map((r) => {
                const actions = institutionActions({
                  isPrimary: r.isPrimary,
                  disabled: r.disabled,
                });
                const status = institutionStatus({ disabled: r.disabled });
                return (
                  <Table.Row key={r._id}>
                    <Table.Cell>
                      <HStack gap={3} minW={0}>
                        <InstitutionMark
                          logoUrl={r.logoUrl}
                          emoji={r.emoji}
                          name={r.name}
                          size={26}
                        />
                        <Box minW={0}>
                          <HStack gap={2}>
                            <Text
                              fontFamily="heading"
                              fontWeight="600"
                              color="navy.600"
                            >
                              {r.name}
                            </Text>
                            {r.isPrimary && (
                              <Badge size="xs" colorPalette="violet">
                                Primary
                              </Badge>
                            )}
                          </HStack>
                          <Text
                            fontFamily="mono"
                            fontSize="2xs"
                            color="charcoal.400"
                          >
                            {r.slug}
                          </Text>
                        </Box>
                      </HStack>
                    </Table.Cell>
                    <Table.Cell fontFamily="body" color="charcoal.500">
                      {r.kind}
                    </Table.Cell>
                    <Table.Cell fontFamily="body" color="charcoal.500">
                      {scholarCountLabel(r.scholarCount)}
                    </Table.Cell>
                    <Table.Cell>
                      <Badge size="xs" colorPalette={status.palette}>
                        {status.label}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <HStack justify="flex-end" gap={1}>
                        {actions.canPause && (
                          <Button
                            size="xs"
                            variant="ghost"
                            color="charcoal.500"
                            _hover={{ color: "amber.600", bg: "amber.50" }}
                            fontFamily="heading"
                            onClick={() =>
                              setPauseTarget({ id: r._id, name: r.name })
                            }
                          >
                            <PauseCircle size={14} /> Pause
                          </Button>
                        )}
                        {actions.canResume && (
                          <Button
                            size="xs"
                            variant="ghost"
                            color="green.600"
                            _hover={{ bg: "green.50" }}
                            fontFamily="heading"
                            onClick={() => void handleResume(r._id, r.name)}
                            loading={resumingId === r._id}
                            disabled={resumingId === r._id}
                          >
                            <PlayCircle size={14} /> Resume
                          </Button>
                        )}
                        {actions.canDelete && (
                          <Button
                            size="xs"
                            variant="ghost"
                            color="charcoal.400"
                            _hover={{ color: "red.500", bg: "red.50" }}
                            fontFamily="heading"
                            onClick={() =>
                              setDeleteTarget({ id: r._id, name: r.name })
                            }
                          >
                            <Trash size={14} /> Delete
                          </Button>
                        )}
                        {r.isPrimary && (
                          <Text
                            fontFamily="body"
                            fontSize="xs"
                            color="charcoal.300"
                          >
                            Primary institution
                          </Text>
                        )}
                      </HStack>
                    </Table.Cell>
                  </Table.Row>
                );
              })
            )}
          </Table.Body>
        </Table.Root>
      </Box>

      {pauseTarget && (
        <DisableSchoolDialog
          open
          onClose={() => setPauseTarget(null)}
          institutionId={pauseTarget.id}
          schoolName={pauseTarget.name}
          noun="institution"
        />
      )}
      {deleteTarget && (
        <DeleteSchoolDialog
          open
          onClose={() => setDeleteTarget(null)}
          institutionId={deleteTarget.id}
          schoolName={deleteTarget.name}
          noun="institution"
        />
      )}
    </VStack>
  );
}

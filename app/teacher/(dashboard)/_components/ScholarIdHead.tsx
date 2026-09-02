"use client";

import { HStack, Box, Text, Button, Menu } from "@chakra-ui/react";
import { Eye, Plus, PencilSimple, NotePencil, Upload, FileDoc, Medal } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { GooglePickerButton } from "@/components/GooglePickerButton";
import type { ScholarAddAction } from "@/components/ScholarProfile";
import { EXTENDED_EDUCATION_LABEL } from "@/components/ScholarParticipationFilter";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ScholarFocusHeader } from "./ScholarFocusHeader";
import { type Scholar, timeAgo } from "./types";

// ── Scholar Id Head ───────────────────────────────────────────────────────
// The slim identity header atop a scholar's main column: the shared
// ScholarFocusHeader (avatar · name · age · grade) at its compact scale, with
// this surface's own subordinate facts — @username · status · reading level —
// and the single first-class "+ Add" menu (note / report / upload / link
// Google Doc / award badge) plus "View as" in its actions slot. This is the
// per-scholar identity that used to live in the left rail before the rail
// became a scholar switcher. (The aide is now the global header Robot →
// docked panel, not a per-scholar toggle here.)

function fmtReading(level: string | null | undefined): string | null {
  if (!level) return null;
  if (level === "college") return "College reading";
  if (level === "K") return "K reading";
  return `Gr ${level} reading`;
}

export function ScholarIdHead({
  scholar,
  scholarId,
  isOperationsOnly,
  canFileHealthDocuments,
  onAdd,
  onPickedGoogleDoc,
}: {
  scholar:
    | (Pick<
        Scholar,
        "name" | "image" | "username" | "enrollmentStanding"
      > &
        Partial<Pick<Scholar, "lastActive" | "readingLevel">>)
    | undefined;
  scholarId: string;
  isOperationsOnly: boolean;
  /**
   * Whether this staff viewer can actually FILE a health document for this
   * scholar right now — the health half is visible to them (health capability +
   * this scholar in their institution lens). Gates the Add affordance in
   * operations staff/ops mode: their only Add kind is a health document, so without
   * this the menu opens an upload dialog that computes ZERO kinds (the empty,
   * unusable dialog an operations-only staffer used to hit). Undefined while the
   * signal is still loading, and unused in teacher mode (they always get Add).
   */
  canFileHealthDocuments: boolean | undefined;
  onAdd: (action: ScholarAddAction) => void;
  onPickedGoogleDoc: (picked: { id: string; name?: string; url?: string; mimeType?: string }) => void;
}) {
  // Direct links to an Extended Education scholar intentionally leave that
  // scholar out of the enrolled-only rail. Reuse ScholarProfile's cached query
  // so the identity header still has a name and enrollment standing.
  const profile = useQuery(api.scholars.getProfile, {
    scholarId: scholarId as Id<"users">,
  });
  const identity = scholar ?? profile?.scholar;
  const reading = fmtReading(identity?.readingLevel);
  const active = scholar?.lastActive ? `active ${timeAgo(scholar.lastActive)}` : "no activity yet";
  const detail = [
    identity?.username ? `@${identity.username}` : null,
    identity?.enrollmentStanding === "program_guest" ? EXTENDED_EDUCATION_LABEL : null,
    active,
    reading,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <ScholarFocusHeader
      scholarId={scholarId}
      name={identity?.name}
      image={identity?.image ?? null}
      dateOfBirth={profile?.scholar.dateOfBirth ?? null}
      gradeLevel={profile?.scholar.gradeLevel ?? null}
      scale="compact"
      detail={<Text lineClamp={1}>{detail}</Text>}
      actions={
        <HStack gap={2} flexShrink={0}>
        {/* One canonical Add affordance at every altitude. An operations staffer / ops
            staffer sees it only when they can actually FILE a health document
            for this scholar — the one Add kind they get. Gating on
            healthFormsAvailable alone opened an empty dialog (zero kinds) for an
            operations-only staffer, who has scholar access but no health
            capability. */}
        {(!isOperationsOnly || canFileHealthDocuments === true) && (
          <Menu.Root positioning={{ placement: "bottom-end" }}>
          <Menu.Trigger asChild>
            <Button
              size="xs"
              bg="violet.500"
              color="white"
              _hover={{ bg: "violet.600" }}
              fontFamily="heading"
              fontWeight="600"
            >
              <Plus />
              Add
            </Button>
          </Menu.Trigger>
          <Menu.Positioner>
            <Menu.Content minW="264px">
              {!isOperationsOnly && (
                <>
                  <Menu.Item value="note" cursor="pointer" onClick={() => onAdd("note")}>
                    <PencilSimple />
                    <Box>
                      <Text fontWeight="600" fontSize="sm" color="navy.500">Note</Text>
                      <Text fontSize="xs" color="charcoal.400">A quick observation.</Text>
                    </Box>
                  </Menu.Item>
                  <Menu.Separator />
                </>
              )}
              <Menu.ItemGroup>
                <Menu.ItemGroupLabel>Add a document</Menu.ItemGroupLabel>
                {!isOperationsOnly && (
                  <Menu.Item value="doc-text" cursor="pointer" onClick={() => onAdd("report")}>
                    <NotePencil />
                    <Box>
                      <Text fontWeight="600" fontSize="sm" color="navy.500">Write text</Text>
                      <Text fontSize="xs" color="charcoal.400">A note or write-up.</Text>
                    </Box>
                  </Menu.Item>
                )}
                <Menu.Item value="doc-file" cursor="pointer" onClick={() => onAdd("file")}>
                  <Upload />
                  <Box>
                    <Text fontWeight="600" fontSize="sm" color="navy.500">Upload a file</Text>
                    <Text fontSize="xs" color="charcoal.400">
                      {isOperationsOnly
                        ? "A health record document — PDF or photo."
                        : "PDF or image."}
                    </Text>
                  </Box>
                </Menu.Item>
                {!isOperationsOnly && (
                  <GooglePickerButton
                    mode="documents"
                    onPicked={onPickedGoogleDoc}
                    renderTrigger={({ onClick }) => (
                      <Menu.Item value="doc-gdoc" cursor="pointer" onClick={onClick}>
                        <FileDoc />
                        <Box>
                          <Text fontWeight="600" fontSize="sm" color="navy.500">Link a Google Doc</Text>
                          <Text fontSize="xs" color="charcoal.400">From Drive.</Text>
                        </Box>
                      </Menu.Item>
                    )}
                  />
                )}
              </Menu.ItemGroup>
              {!isOperationsOnly && (
                <>
                  <Menu.Separator />
                  <Menu.Item value="badge" cursor="pointer" onClick={() => onAdd("badge")}>
                    <Medal />
                    <Box>
                      <Text fontWeight="600" fontSize="sm" color="navy.500">Award badge</Text>
                      <Text fontSize="xs" color="charcoal.400">Recognize a milestone.</Text>
                    </Box>
                  </Menu.Item>
                </>
              )}
            </Menu.Content>
          </Menu.Positioner>
          </Menu.Root>
        )}
        {!isOperationsOnly && (
          <a href={`/scholar?remote=${scholarId}`} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>
            <Button
              size="xs"
              variant="outline"
              color="charcoal.500"
              borderColor="gray.200"
              fontFamily="heading"
              fontWeight="600"
              _hover={{ bg: "gray.50" }}
            >
              <Eye />
              View as
            </Button>
          </a>
        )}
        </HStack>
      }
    />
  );
}

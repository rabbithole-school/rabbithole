"use client";

// The program schedule / Handout mode's own rendering: the curriculum search
// box, the handout composer that replaces the picker, and the mode's settings
// boxes. Split out of StartAssignmentDialog so a third scheduling mode is a
// sibling module rather than another branch in the shared shell (TRA-21).

import type { Dispatch, SetStateAction } from "react";
import {
  Box,
  Button,
  Flex,
  IconButton,
  Input,
  Spinner,
  Text,
  Tooltip,
} from "@chakra-ui/react";
import type { FunctionReturnType } from "convex/server";
import { ArrowLeft, FileText, MagnifyingGlass, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ResourcesEditor } from "@/components/nodeEditor/ResourcesSection";
import { CalendarDatePicker } from "@/components/ui/CalendarDatePicker";
import { toaster } from "@/lib/toaster";
import type { StartAssignmentProgramTarget } from "./types";

export type ProgramSearchResult = FunctionReturnType<
  typeof api.masterSchedule.searchProgramCurriculum
>[number];

export function ProgramSearchBar({
  programSearch,
  setProgramSearch,
  programSearchIndex,
  setProgramSearchIndex,
  programSearchResults,
  curriculumAccessDenied,
  chooseProgramSearchResult,
  viewingAsReadOnly,
  creatingHandout,
  createdHandoutId,
  handleCreateHandout,
}: {
  programSearch: string;
  setProgramSearch: (value: string) => void;
  programSearchIndex: number;
  setProgramSearchIndex: Dispatch<SetStateAction<number>>;
  programSearchResults: ProgramSearchResult[] | undefined;
  /** Set once we know the caller lacks curriculum access at the group's
   *  school — names the reason instead of letting the box read as "no
   *  matches" (TRA-327). */
  curriculumAccessDenied: { institutionName: string } | null;
  chooseProgramSearchResult: (result: ProgramSearchResult) => void;
  viewingAsReadOnly: boolean;
  creatingHandout: boolean;
  createdHandoutId: Id<"activities"> | null;
  handleCreateHandout: () => void;
}) {
  return (
    <Flex
      direction={{ base: "column", md: "row" }}
      gap={2}
      px={4}
      py={3}
      borderTopWidth="1px"
      borderColor="gray.200"
      bg="white"
      align={{ base: "stretch", md: "center" }}
    >
      <Box position="relative" flex={1}>
        <Box
          position="absolute"
          left={3}
          top="50%"
          transform="translateY(-50%)"
          color="charcoal.300"
          zIndex={1}
          pointerEvents="none"
        >
          <MagnifyingGlass size={16} />
        </Box>
        <Input
          value={programSearch}
          disabled={!!curriculumAccessDenied}
          onChange={(event) => {
            setProgramSearch(event.target.value);
            setProgramSearchIndex(0);
          }}
          onKeyDown={(event) => {
            const results = programSearchResults ?? [];
            if (event.key === "Escape" && programSearch) {
              event.preventDefault();
              event.stopPropagation();
              setProgramSearch("");
              setProgramSearchIndex(0);
            } else if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setProgramSearchIndex((index) =>
                Math.min(index + 1, results.length - 1),
              );
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setProgramSearchIndex((index) => Math.max(index - 1, 0));
            } else if (event.key === "Enter" && results[programSearchIndex]) {
              event.preventDefault();
              chooseProgramSearchResult(results[programSearchIndex]);
            }
          }}
          placeholder={
            curriculumAccessDenied
              ? "Curriculum search unavailable"
              : "Search units, lessons, or activities"
          }
          aria-label="Search units, lessons, or activities"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={
            !!curriculumAccessDenied || programSearch.trim().length >= 2
          }
          aria-controls="program-curriculum-results"
          aria-activedescendant={
            programSearchResults?.[programSearchIndex]
              ? `program-result-${programSearchIndex}`
              : undefined
          }
          ps={9}
          pe={9}
          autoFocus
        />
        {programSearch && !curriculumAccessDenied && (
          <IconButton
            aria-label="Clear curriculum search"
            size="xs"
            variant="ghost"
            position="absolute"
            right={1.5}
            top="50%"
            transform="translateY(-50%)"
            zIndex={2}
            onClick={() => {
              setProgramSearch("");
              setProgramSearchIndex(0);
            }}
          >
            <X size={14} />
          </IconButton>
        )}
        {(curriculumAccessDenied || programSearch.trim().length >= 2) && (
          <Box
            id="program-curriculum-results"
            role="listbox"
            position="absolute"
            top="calc(100% + 6px)"
            left={0}
            right={0}
            zIndex={20}
            bg="white"
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            boxShadow="lg"
            maxH="240px"
            overflowY="auto"
          >
            {curriculumAccessDenied ? (
              <Text px={4} py={4} fontSize="sm" color="charcoal.500">
                You don’t have curriculum access at{" "}
                {curriculumAccessDenied.institutionName}, so you can’t add
                existing work here. Ask an admin for curriculum access.
              </Text>
            ) : programSearchResults === undefined ? (
              <Flex justify="center" py={5}>
                <Spinner size="sm" color="violet.500" />
              </Flex>
            ) : programSearchResults.length === 0 ? (
              <Text px={4} py={4} fontSize="sm" color="charcoal.400">
                No matching curriculum
              </Text>
            ) : (
              programSearchResults.map((result, index) => {
                const title =
                  result.kind === "unit"
                    ? result.unitTitle
                    : result.kind === "lesson"
                      ? result.lessonTitle
                      : result.activityTitle;
                const context =
                  result.kind === "unit"
                    ? "Unit"
                    : result.kind === "lesson"
                      ? `Lesson · ${result.unitTitle}`
                      : `Activity · ${result.unitTitle} → ${result.lessonTitle}`;
                const key =
                  result.kind === "unit"
                    ? `unit-${result.unitId}`
                    : result.kind === "lesson"
                      ? `lesson-${result.lessonId}`
                      : `activity-${result.activityId}`;
                return (
                  <Box
                    as="button"
                    id={`program-result-${index}`}
                    role="option"
                    aria-selected={programSearchIndex === index}
                    key={key}
                    display="block"
                    w="full"
                    px={4}
                    py={2.5}
                    textAlign="left"
                    borderBottomWidth="1px"
                    borderColor="gray.100"
                    _last={{ borderBottomWidth: 0 }}
                    bg={programSearchIndex === index ? "violet.50" : "white"}
                    _hover={{ bg: "gray.50" }}
                    onMouseEnter={() => setProgramSearchIndex(index)}
                    onClick={() => chooseProgramSearchResult(result)}
                  >
                    <Text
                      fontFamily="heading"
                      fontSize="sm"
                      fontWeight="600"
                      color="navy.500"
                    >
                      {title}
                    </Text>
                    <Text fontSize="xs" color="charcoal.400">
                      {context}
                    </Text>
                  </Box>
                );
              })
            )}
          </Box>
        )}
      </Box>
      {viewingAsReadOnly ? (
        <Tooltip.Root openDelay={300} closeDelay={0}>
          <Tooltip.Trigger asChild>
            <Box display={{ base: "block", md: "inline-flex" }}>
              <Button
                variant="outline"
                colorPalette="violet"
                disabled
                flexShrink={0}
                w={{ base: "full", md: "auto" }}
              >
                <FileText size={18} />
                New handout
              </Button>
            </Box>
          </Tooltip.Trigger>
          <Tooltip.Positioner>
            <Tooltip.Content fontSize="xs">
              Exit view-as to create a handout.
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Tooltip.Root>
      ) : (
        <Button
          variant="outline"
          colorPalette="violet"
          onClick={() => void handleCreateHandout()}
          disabled={creatingHandout}
          flexShrink={0}
          w={{ base: "full", md: "auto" }}
        >
          {creatingHandout ? <Spinner size="xs" /> : <FileText size={18} />}
          {createdHandoutId ? "Back to handout" : "New handout"}
        </Button>
      )}
    </Flex>
  );
}

export function ProgramHandoutComposer({
  createdHandoutId,
  createdHandoutAssignmentId,
  createdHandoutTitle,
  setCreatedHandoutTitle,
  viewingAsReadOnly,
  saveCreatedHandoutTitle,
  setShowCreatedHandoutComposer,
  setPickedActivityId,
}: {
  createdHandoutId: Id<"activities">;
  createdHandoutAssignmentId: Id<"assignments"> | null;
  createdHandoutTitle: string;
  setCreatedHandoutTitle: Dispatch<SetStateAction<string>>;
  viewingAsReadOnly: boolean;
  saveCreatedHandoutTitle: () => Promise<void>;
  setShowCreatedHandoutComposer: (value: boolean) => void;
  setPickedActivityId: (value: Id<"activities"> | null | undefined) => void;
}) {
  return (
    <Flex direction="column" flex={1} minW="420px" minH={0} bg="white">
      <Flex
        px={4}
        py={2}
        align="center"
        justify="space-between"
        borderBottom="1px solid"
        borderBottomColor="gray.100"
        bg="gray.50"
      >
        <Text
          fontSize="2xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          Handout
        </Text>
        <Button
          size="xs"
          variant="ghost"
          color="charcoal.500"
          onClick={() => {
            setShowCreatedHandoutComposer(false);
            setPickedActivityId(undefined);
          }}
        >
          <ArrowLeft />
          Choose different work
        </Button>
      </Flex>
      <Box overflowY="auto" minH={0}>
        <Box px={6} py={4} borderBottomWidth="1px" borderColor="gray.100">
          <Text
            fontFamily="heading"
            fontSize="sm"
            fontWeight="600"
            color="navy.500"
            mb={2}
          >
            Handout name
          </Text>
          <Input
            value={createdHandoutTitle}
            disabled={viewingAsReadOnly}
            onChange={(event) => setCreatedHandoutTitle(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            onBlur={() => {
              if (!createdHandoutTitle.trim()) return;
              void saveCreatedHandoutTitle().catch((error) => {
                toaster.error({
                  title: "Couldn’t rename handout",
                  description:
                    error instanceof Error ? error.message : String(error),
                });
              });
            }}
            placeholder="e.g. Robotics safety checklist"
            aria-label="Handout name"
          />
        </Box>
        {viewingAsReadOnly ? (
          <Text px={6} py={4} fontSize="sm" color="charcoal.500">
            Exit view-as to manage handout materials.
          </Text>
        ) : (
          <ResourcesEditor
            activityId={createdHandoutId}
            assignmentId={createdHandoutAssignmentId ?? undefined}
            onSuggestedTitle={(suggestedTitle) =>
              setCreatedHandoutTitle((currentTitle) =>
                currentTitle.trim() ? currentTitle : suggestedTitle,
              )
            }
          />
        )}
      </Box>
    </Flex>
  );
}

export function ProgramSettings({
  programTarget,
  homeworkDate,
  setHomeworkDate,
}: {
  programTarget: StartAssignmentProgramTarget;
  homeworkDate: Date;
  setHomeworkDate: (value: Date) => void;
}) {
  return (
    <>
      {programTarget.scheduleTarget.mode === "homework" && (
        <Box>
          <Text
            fontSize="xs"
            color="charcoal.400"
            fontFamily="heading"
            fontWeight="600"
            textTransform="uppercase"
            letterSpacing="0.04em"
            mb={2}
          >
            Timing
          </Text>
          <CalendarDatePicker
            value={homeworkDate}
            onChange={setHomeworkDate}
            ariaLabel="Choose homework due date"
          />
          <Text fontSize="xs" color="charcoal.400" mt={2}>
            Available at 8:00 AM and due at the end of that day.
          </Text>
        </Box>
      )}

      <Box>
        <Text
          fontSize="xs"
          color="charcoal.400"
          fontFamily="heading"
          fontWeight="600"
          textTransform="uppercase"
          letterSpacing="0.04em"
          mb={1}
        >
          Program
        </Text>
        <Text
          fontSize="sm"
          fontFamily="heading"
          color="navy.500"
          fontWeight="600"
        >
          {programTarget.groupName}
        </Text>
        <Text fontSize="xs" color="charcoal.400" mt={1}>
          Everyone currently in this program gets this work and its materials.
          The roster stays managed in School.
        </Text>
      </Box>
    </>
  );
}

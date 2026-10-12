"use client";

import { useMemo, useState } from "react";
import {
  Box,
  Button,
  CloseButton,
  Dialog,
  Flex,
  Portal,
  SimpleGrid,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { Cake, DownloadSimple, Printer } from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { downloadBlob } from "@/components/downloadFile";
import {
  buildBirthdayRosterCsv,
  groupBirthdayRows,
  type BirthdayRosterSort,
} from "@/components/MasterSchedule/birthdayRoster";
import { EmptyState } from "@/components/ui/EmptyState";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { ViewToggle } from "@/components/ui/ViewToggle";

export function BirthdayRosterDialog({
  institutionScope,
}: {
  institutionScope: string;
}) {
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<BirthdayRosterSort>("date");
  const birthdays = useQuery(
    api.birthdays.birthdaysForRoster,
    open ? { institutionScope } : "skip",
  );
  const groups = useMemo(
    () => groupBirthdayRows(birthdays ?? [], sort),
    [birthdays, sort],
  );

  // Print goes through a dedicated route rather than window.print() here: this
  // dialog is a fixed overlay with overflow hidden, so a print stylesheet that
  // pins it to the page prints one viewport and drops the rest of the roster.
  const openPrintView = () => {
    window.open(
      `/print/birthdays?scope=${encodeURIComponent(institutionScope)}`,
      "_blank",
    );
  };

  const downloadCsv = () => {
    if (!birthdays) return;
    downloadBlob(
      new Blob([buildBirthdayRosterCsv(birthdays)], {
        type: "text/csv;charset=utf-8",
      }),
      "scholar-birthdays.csv",
    );
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => setOpen(details.open)}
      size="lg"
      scrollBehavior="inside"
    >
      <Dialog.Trigger asChild>
        <Button
          size="xs"
          variant="outline"
          colorPalette="violet"
          aria-label="View roster birthdays"
        >
          <Cake size={14} />
          Birthdays
        </Button>
      </Dialog.Trigger>
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="4xl" maxH="calc(100vh - 2rem)">
            <Dialog.Header
              borderBottomWidth="1px"
              borderColor="gray.100"
              alignItems="center"
            >
              <Box flex={1}>
                <Dialog.Title fontFamily="heading" color="navy.600">
                  Roster birthdays
                </Dialog.Title>
                <Text mt={1} fontSize="sm" color="charcoal.400">
                  Enrolled scholars in the current institution.
                </Text>
              </Box>
              <Dialog.CloseTrigger asChild>
                <CloseButton
                  size="sm"
                  aria-label="Close roster birthdays"
                />
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body py={5}>
              {birthdays === undefined ? (
                <Flex minH="240px" align="center" justify="center">
                  <Spinner color="violet.500" />
                </Flex>
              ) : birthdays.length === 0 ? (
                <EmptyState
                  icon={<Cake weight="duotone" />}
                  title="No birthdays to show"
                  hint="No enrolled scholars in this institution have a birthday on file."
                />
              ) : (
                <Stack gap={5}>
                  <Flex
                    align={{ base: "flex-start", md: "center" }}
                    justify="space-between"
                    direction={{ base: "column", md: "row" }}
                    gap={3}
                  >
                    <Box>
                      <Text
                        fontFamily="heading"
                        fontSize="sm"
                        fontWeight="700"
                        color="navy.600"
                      >
                        {birthdays.length} birthdays
                      </Text>
                      <Text fontSize="sm" color="charcoal.400">
                        Birth years are omitted from this roster view and export.
                      </Text>
                    </Box>
                    <ViewToggle<BirthdayRosterSort>
                      items={[
                        { value: "date", label: "Date" },
                        { value: "name", label: "Name" },
                      ]}
                      value={sort}
                      onChange={setSort}
                      ariaLabel="Sort birthdays within each month"
                    />
                  </Flex>

                  <SimpleGrid
                    columns={{ base: 1, md: 2 }}
                    gap={4}
                    alignItems="start"
                  >
                    {groups.map((group) => (
                      <Box
                        as="section"
                        key={group.month}
                        borderWidth="1px"
                        borderColor="gray.200"
                        borderRadius="lg"
                        overflow="hidden"
                        breakInside="avoid"
                      >
                        <Text
                          as="h3"
                          px={4}
                          py={2.5}
                          bg="gray.50"
                          borderBottomWidth="1px"
                          borderColor="gray.100"
                          fontFamily="heading"
                          fontSize="sm"
                          fontWeight="700"
                          color="navy.600"
                        >
                          {group.label}
                        </Text>
                        <Stack gap={0}>
                          {group.rows.map((row, index) => (
                            <Flex
                              key={row.scholarId}
                              align="baseline"
                              justify="space-between"
                              gap={3}
                              px={4}
                              py={2.5}
                              borderTopWidth={index === 0 ? "0" : "1px"}
                              borderColor="gray.100"
                            >
                              <Text fontSize="sm" color="charcoal.600">
                                {row.name}
                              </Text>
                              <Text
                                flexShrink={0}
                                fontFamily="heading"
                                fontSize="sm"
                                fontWeight="600"
                                color="charcoal.400"
                              >
                                {group.label} {row.day}
                              </Text>
                            </Flex>
                          ))}
                        </Stack>
                      </Box>
                    ))}
                  </SimpleGrid>
                </Stack>
              )}
            </Dialog.Body>

            <Dialog.Footer
              borderTopWidth="1px"
              borderColor="gray.100"
            >
              <Button
                variant="outline"
                size="sm"
                onClick={downloadCsv}
                disabled={!birthdays?.length}
              >
                <DownloadSimple size={16} />
                Download CSV
              </Button>
              <Button
                colorPalette="violet"
                size="sm"
                onClick={openPrintView}
                disabled={!birthdays?.length}
              >
                <Printer size={16} />
                Print
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

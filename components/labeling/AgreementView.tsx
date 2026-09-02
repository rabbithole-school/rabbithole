"use client";

/**
 * The agreement / calibration view — the ONE surface where every rater's scores
 * are revealed (after blind labeling). Per-dimension means + max disagreement,
 * turns flagged where raters diverge (spread ≥ 2) with a jump-to-turn link, the
 * whole-transcript overall spread, and a "copy export JSON" for the calibration
 * script. All arithmetic comes from the backend query. WEB-ONLY (staff tool).
 */
import { useState } from "react";
import { useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  HStack,
  Spinner,
  Table,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Copy, Check, Warning, ArrowRight } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DIMENSION_BY_KEY } from "@/shared/tutorQualityRubric";
import { Surface } from "@/components/ui/Surface";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";

function dimLabel(key: string): string {
  return DIMENSION_BY_KEY[key]?.label ?? key;
}

export function AgreementView({
  onNavigateToTurn,
}: {
  onNavigateToTurn: (sessionId: Id<"sessions">, messageId: string) => void;
}) {
  const report = useQuery(api.qualityLabeling.agreementReport, {});
  const [copied, setCopied] = useState(false);

  const copyExport = async () => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(report.exportJson, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  if (report === undefined) {
    return (
      <Flex justify="center" py={16}>
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  const raterCount = Object.keys(report.raters).length;
  const hasData = report.sessions.length > 0;

  return (
    <Box maxW="900px" mx="auto" px={{ base: 4, md: 6 }} py={6}>
      <PageHeader
        title="Agreement"
        subtitle={
          hasData
            ? `${report.sessions.length} session${report.sessions.length === 1 ? "" : "s"} · ${raterCount} rater${raterCount === 1 ? "" : "s"}`
            : undefined
        }
        rightSlot={
          hasData ? (
            <Button size="sm" variant="outline" onClick={copyExport}>
              {copied ? <Check size={14} style={{ marginRight: 6 }} /> : <Copy size={14} style={{ marginRight: 6 }} />}
              {copied ? "Copied" : "Copy export JSON"}
            </Button>
          ) : undefined
        }
      />

      {!hasData ? (
        <Surface p={8} mt={5}>
          <Text fontSize="sm" color="charcoal.500" textAlign="center" maxW="440px" mx="auto">
            No labels yet. Once raters have scored turns, this view shows where they
            agree and where they diverge (so you can calibrate the rubric + the judge).
          </Text>
        </Surface>
      ) : (
        <VStack gap={4} align="stretch" mt={5}>
          {report.sessions.map((s) => {
            const flagged = s.matrix.flaggedCells;
            return (
              <Surface key={String(s.sessionId)} p={5}>
                <Text fontSize="sm" fontWeight="700" color="navy.600" fontFamily="heading" mb={3}>
                  {s.title}
                </Text>

                {/* Per-dimension means + disagreement */}
                <SectionEyebrow>Per-dimension</SectionEyebrow>
                <Box mt={2} mb={4} overflowX="auto">
                  <Table.Root size="sm" variant="line">
                    <Table.Header>
                      <Table.Row>
                        <Table.ColumnHeader>Dimension</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="end">Mean</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="end">Scores</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="end">Max spread</Table.ColumnHeader>
                        <Table.ColumnHeader textAlign="end">Flagged</Table.ColumnHeader>
                      </Table.Row>
                    </Table.Header>
                    <Table.Body>
                      {s.matrix.dimSummaries
                        .filter((d) => d.count > 0)
                        .map((d) => (
                          <Table.Row key={d.dimKey}>
                            <Table.Cell>
                              <Text fontSize="xs" color="charcoal.600" fontWeight="600">
                                {dimLabel(d.dimKey)}
                              </Text>
                            </Table.Cell>
                            <Table.Cell textAlign="end">
                              <Text fontSize="xs" color="charcoal.700" fontWeight="700" fontFamily="heading">
                                {d.mean ?? "—"}
                              </Text>
                            </Table.Cell>
                            <Table.Cell textAlign="end">
                              <Text fontSize="xs" color="charcoal.400">{d.count}</Text>
                            </Table.Cell>
                            <Table.Cell textAlign="end">
                              <Text
                                fontSize="xs"
                                fontWeight="700"
                                fontFamily="heading"
                                color={d.maxDisagreement >= 2 ? "orange.600" : "charcoal.400"}
                              >
                                {d.maxDisagreement}
                              </Text>
                            </Table.Cell>
                            <Table.Cell textAlign="end">
                              <Text fontSize="xs" color={d.flaggedTurnCount > 0 ? "orange.600" : "charcoal.300"} fontWeight="600">
                                {d.flaggedTurnCount}
                              </Text>
                            </Table.Cell>
                          </Table.Row>
                        ))}
                    </Table.Body>
                  </Table.Root>
                </Box>

                {/* Flagged turns */}
                {flagged.length > 0 && (
                  <Box mb={4}>
                    <HStack gap={1.5} mb={2} color="orange.600">
                      <Warning size={14} weight="fill" />
                      <SectionEyebrow>
                        {`Disagreements (${flagged.length})`}
                      </SectionEyebrow>
                    </HStack>
                    <VStack gap={0} align="stretch">
                      {flagged.map((cell, i) => (
                        <Flex
                          key={`${cell.messageId}-${cell.dimKey}`}
                          align="center"
                          gap={3}
                          py={2}
                          borderTopWidth={i === 0 ? "0" : "1px"}
                          borderColor="gray.100"
                        >
                          <Box flex={1} minW={0}>
                            <HStack gap={2} wrap="wrap">
                              <Text fontSize="xs" fontWeight="700" color="charcoal.600" fontFamily="heading">
                                {dimLabel(cell.dimKey)}
                              </Text>
                              <Text fontSize="2xs" color="charcoal.300" fontFamily="heading">
                                turn {cell.turnIndex >= 0 ? cell.turnIndex + 1 : "?"}
                              </Text>
                              <Text fontSize="2xs" color="orange.600" fontFamily="heading" fontWeight="700">
                                spread {cell.spread}
                              </Text>
                            </HStack>
                            <HStack gap={2} mt={0.5} wrap="wrap">
                              {cell.scores.map((sc) => (
                                <Text key={sc.raterId} fontSize="2xs" color="charcoal.400">
                                  {report.raters[sc.raterId] ?? sc.raterId}: <b>{sc.score}</b>
                                </Text>
                              ))}
                            </HStack>
                          </Box>
                          <Box
                            as="button"
                            aria-label="Go to turn"
                            flexShrink={0}
                            display="flex"
                            alignItems="center"
                            gap={1}
                            px={2}
                            py={1}
                            borderRadius="md"
                            color="violet.600"
                            cursor="pointer"
                            _hover={{ bg: "violet.50" }}
                            onClick={() => onNavigateToTurn(s.sessionId, cell.messageId)}
                          >
                            <Text fontSize="2xs" fontFamily="heading" fontWeight="700">
                              View turn
                            </Text>
                            <ArrowRight size={12} weight="bold" />
                          </Box>
                        </Flex>
                      ))}
                    </VStack>
                  </Box>
                )}

                {/* Transcript-level overall */}
                {s.transcript.scores.length > 0 && (
                  <Box>
                    <SectionEyebrow>Overall (whole transcript)</SectionEyebrow>
                    <HStack gap={3} mt={1} wrap="wrap">
                      <Text fontSize="xs" color="charcoal.600">
                        mean <b>{s.transcript.mean ?? "—"}</b>
                      </Text>
                      <Text
                        fontSize="xs"
                        color={s.transcript.flagged ? "orange.600" : "charcoal.400"}
                        fontWeight={s.transcript.flagged ? "700" : "400"}
                      >
                        spread {s.transcript.spread}
                      </Text>
                      {s.transcript.scores.map((sc) => (
                        <Text key={sc.raterId} fontSize="2xs" color="charcoal.400">
                          {report.raters[sc.raterId] ?? sc.raterId}: <b>{sc.score}</b>
                        </Text>
                      ))}
                    </HStack>
                  </Box>
                )}
              </Surface>
            );
          })}
        </VStack>
      )}
    </Box>
  );
}

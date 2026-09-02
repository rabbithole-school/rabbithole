"use client";

/**
 * Per-activity teacher-facing panels: scholar angles + submissions.
 * Mounted in the Unit Designer's activity edit pane beneath the form
 * fields, so the teacher sees what scholars have submitted without
 * leaving the designer.
 *
 * Note: "Share Back" is now a distinct feature — an offline activity
 * type that collates ACROSS activities into an AI digest (see
 * convex/shareBack.ts + components/nodeEditor/ShareBackSection.tsx).
 * The panel below is the single-activity "Submissions" view; it kept
 * its old export name (`DeliverableCollationPanel`) for import
 * stability but is re-exported as `SubmissionsPanel`.
 *
 * Both panels silently render nothing when there's no data to show
 * (angles disabled / no submissions yet), so they don't add noise on
 * activities that aren't being worked on yet.
 */
import Link from "next/link";
import { useQuery } from "convex/react";
import { Box, HStack, IconButton, Stack, Text } from "@chakra-ui/react";
import { Download, Sparkle } from "@phosphor-icons/react";
import { ScholarAngleIcon } from "@/lib/scholarAngle";
import { TutorTranscriptionChip } from "@/components/TutorTranscriptionChip";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

/**
 * Per-scholar angles for a hasScholarAngles activity. Shows nothing
 * if the activity doesn't have scholar angles enabled (the underlying
 * query returns []).
 */
export function ScholarAnglesPanel({
  activityId,
}: {
  activityId: Id<"activities">;
}) {
  const angles = useQuery(
    api.scholarActivityAngles.listAnglesForActivity,
    { activityId },
  );
  if (!angles || angles.length === 0) return null;
  return (
    <Stack gap={2}>
      <HStack gap={1.5} color="charcoal.400">
        <ScholarAngleIcon size={13} />
        <Text
          fontSize="xs"
          fontFamily="heading"
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.05em"
        >
          Scholar angles · {angles.length}
        </Text>
      </HStack>
      <Stack gap={1.5}>
        {angles.map((a) => (
          <Box
            key={a._id}
            p={2.5}
            bg="violet.50"
            borderRadius="md"
            borderWidth="1px"
            borderColor="violet.200"
          >
            <Text
              fontFamily="heading"
              fontWeight="700"
              color="navy.500"
              fontSize="sm"
            >
              {a.scholarName} — {a.title}
            </Text>
            {a.description && (
              <Text fontSize="xs" color="charcoal.500" mt={0.5}>
                {a.description}
              </Text>
            )}
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}

/**
 * Submissions panel — every scholar's most-recent submission for this
 * activity, with a status pip, short preview, click-through into the
 * project, and a per-submission download. (Distinct from the Share
 * Back feature, which collates ACROSS activities into a digest — this
 * is the single-activity "see + download everyone's work" view.)
 *
 * Hidden when no deliverables exist (silent on activities scholars
 * haven't submitted to yet).
 */
export function DeliverableCollationPanel({
  activityId,
}: {
  activityId: Id<"activities">;
}) {
  const rows = useQuery(
    api.activities.collateDeliverablesForActivity,
    { activityId },
  );
  if (!rows || rows.length === 0) return null;
  const passedCount = rows.filter((r) => r.rubricPassed === true).length;

  const downloadText = (filename: string, body: string) => {
    const blob = new Blob([body], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const safeName = (s: string) =>
    s.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();

  return (
    <Stack gap={2}>
      <Text
        fontSize="xs"
        color="charcoal.400"
        fontFamily="heading"
        fontWeight="700"
        textTransform="uppercase"
        letterSpacing="0.05em"
      >
        📥 Submissions · {passedCount} of {rows.length} passed
      </Text>
      <Stack gap={1.5}>
        {rows.map((r) => {
          const pip =
            r.rubricPassed === true
              ? "✓"
              : r.overall === "half"
                ? "~"
                : r.overall === "not"
                  ? "✗"
                  : "·";
          const pipColor =
            r.rubricPassed === true
              ? "green.600"
              : r.overall === "half"
                ? "orange.600"
                : r.overall === "not"
                  ? "red.600"
                  : "charcoal.400";
          return (
            <Box
              key={r._id}
              p={2.5}
              bg="white"
              borderRadius="md"
              borderWidth="1px"
              borderColor="gray.200"
              transition="all 0.12s"
              _hover={{ borderColor: "violet.300" }}
            >
              <HStack gap={2} align="flex-start">
                <Box
                  color={pipColor}
                  fontWeight="700"
                  fontSize="md"
                  minW="14px"
                  mt="-2px"
                >
                  {pip}
                </Box>
                <Link
                  href={`/scholar/${r.sessionId}`}
                  style={{ flex: 1, minWidth: 0, textDecoration: "none" }}
                >
                <Stack
                  gap={0.5}
                  w="full"
                  minW={0}
                  textAlign="left"
                  cursor="pointer"
                >
                  <Text
                    fontFamily="heading"
                    fontWeight="700"
                    color="navy.500"
                    fontSize="sm"
                  >
                    {r.scholarName}
                  </Text>
                  {r.textContent ? (
                    <Text
                      fontSize="xs"
                      color="charcoal.500"
                      overflow="hidden"
                      css={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {r.textContent.slice(0, 240)}
                    </Text>
                  ) : r.contentKind === "portfolio" ? (
                    <Text fontSize="xs" color="charcoal.400" fontStyle="italic">
                      Scanned work
                    </Text>
                  ) : r.contentKind === "file" ? (
                    <Text fontSize="xs" color="charcoal.400" fontStyle="italic">
                      File submission
                    </Text>
                  ) : null}
                  {r.hasTutorTranscription && (
                    <TutorTranscriptionChip size="xs" />
                  )}
                </Stack>
                </Link>
                {/* Download — text bodies as .txt, files via storage URL. */}
                {r.contentKind === "text" && r.textContent && (
                  <IconButton
                    aria-label={`Download ${r.scholarName}'s submission`}
                    title="Download"
                    size="xs"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ color: "violet.500", bg: "violet.50" }}
                    onClick={() =>
                      downloadText(
                        `${safeName(r.scholarName)}.txt`,
                        r.textContent!,
                      )
                    }
                  >
                    <Download size={13} />
                  </IconButton>
                )}
                {r.contentKind === "portfolio" && r.magicUrl && (
                  <IconButton
                    aria-label={`View the magic version of ${r.scholarName}'s work`}
                    title="✨ View magic version (the original is downloaded below)"
                    size="xs"
                    variant="ghost"
                    color="violet.500"
                    _hover={{ color: "violet.600", bg: "violet.50" }}
                    asChild
                  >
                    <a href={r.magicUrl} target="_blank" rel="noopener noreferrer">
                      <Sparkle size={13} weight="fill" />
                    </a>
                  </IconButton>
                )}
                {(r.contentKind === "file" || r.contentKind === "portfolio") && r.fileUrl && (
                  <IconButton
                    aria-label={`Download ${r.scholarName}'s file`}
                    title="Download file"
                    size="xs"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ color: "violet.500", bg: "violet.50" }}
                    asChild
                  >
                    <a href={r.fileUrl} download target="_blank" rel="noopener noreferrer">
                      <Download size={13} />
                    </a>
                  </IconButton>
                )}
              </HStack>
            </Box>
          );
        })}
      </Stack>
    </Stack>
  );
}

/** Clearer name for the single-activity submissions view. */
export const SubmissionsPanel = DeliverableCollationPanel;

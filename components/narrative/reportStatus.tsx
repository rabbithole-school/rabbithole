/**
 * The two orthogonal axes of a report's lifecycle, and the DRY UI bits that
 * render them. "Final" is not a third thing — it IS the completion axis:
 *
 *   • done   — has the author finished writing?  (draft ↔ final)
 *   • shared — has it been published to parents?  (shared / sharedAt)
 *
 * The completion axis is shown with the same 3-state SectionStatusIcon used for
 * sections (empty / content / done) on the LEFT of a row. The sharing axis gets
 * a tag on the RIGHT. Both course + whole-child narratives use the same `status`
 * enum, so these helpers work across both.
 */
import { Box, Switch } from "@chakra-ui/react";
import { Users } from "@phosphor-icons/react";
import { sectionState, type SectionState } from "@/components/narrative/SectionStatusIcon";

/** done = the completion axis. "final" and "shared" both mean the write-up is finished. */
export function reportDone(status: string): boolean {
  return status === "final" || status === "shared";
}

/** shared = the sharing axis. Only "shared" narratives are visible to parents. */
export function reportShared(status: string): boolean {
  return status === "shared";
}

/** Left-of-row completion glyph state: empty (nothing written) → content → done. */
export function reportSectionState(status: string, hasContent: boolean): SectionState {
  return sectionState(hasContent, reportDone(status));
}

/** Right-of-row publish tag: muted "Not yet published" vs solid "Published to parents". */
export function SharedTag({ status }: { status: string }) {
  const shared = reportShared(status);
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap={1}
      bg={shared ? "green.50" : "gray.100"}
      color={shared ? "green.700" : "charcoal.400"}
      fontFamily="heading"
      fontWeight="600"
      fontSize="2xs"
      textTransform="uppercase"
      letterSpacing="0.03em"
      px={2}
      py={0.5}
      borderRadius="full"
      flexShrink={0}
      whiteSpace="nowrap"
    >
      {shared && <Users size={11} weight="fill" />}
      {shared ? "Published to parents" : "Not yet published"}
    </Box>
  );
}

/** Right-of-card publish rollup for a scholar: "N published" (or nothing at 0). */
export function SharedCountTag({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Box
      as="span"
      display="inline-flex"
      alignItems="center"
      gap={1}
      bg="green.50"
      color="green.700"
      fontFamily="heading"
      fontWeight="600"
      fontSize="2xs"
      textTransform="uppercase"
      letterSpacing="0.03em"
      px={2}
      py={0.5}
      borderRadius="full"
      flexShrink={0}
      whiteSpace="nowrap"
    >
      <Users size={11} weight="fill" />
      {count} published
    </Box>
  );
}

/** The report-level "Mark as done" toggle — mirrors the per-section Switch. */
export function MarkReportDoneToggle({
  done,
  onToggle,
  disabled,
  label = "Mark as done",
}: {
  done: boolean;
  onToggle: (done: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <Switch.Root
      checked={done}
      onCheckedChange={(d) => onToggle(!!d.checked)}
      colorPalette="green"
      size="sm"
      disabled={disabled}
    >
      <Switch.HiddenInput />
      <Switch.Control>
        <Switch.Thumb />
      </Switch.Control>
      <Switch.Label fontSize="xs" fontFamily="heading" color="charcoal.500">
        {label}
      </Switch.Label>
    </Switch.Root>
  );
}

"use client";

/**
 * The "new reporting period" dialog, shared by Reports and the master schedule.
 */
import { useState } from "react";
import { useMutation } from "convex/react";
import { Button, Dialog, Flex, Heading, IconButton, Portal, Stack, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { toaster } from "@/lib/toaster";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { FieldSelect } from "@/components/ui/FieldSelect";

/** Sensible default label from today's date, e.g. "Fall 2026". */
function defaultPeriodLabel(d = new Date()): string {
  const m = d.getMonth();
  const season = m <= 1 ? "Winter" : m <= 4 ? "Spring" : m <= 7 ? "Summer" : "Fall";
  return `${season} ${d.getFullYear()}`;
}

/** epoch ms → "YYYY-MM-DD" (local) for a native date input. */
function toDateInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "YYYY-MM-DD" → epoch ms at local midnight (0 if empty/invalid). */
function fromDateInput(s: string): number {
  if (!s) return 0;
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const DAY = 86_400_000;

const dateInputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 13,
  padding: "6px 8px",
  borderRadius: 8,
  border: "1px solid #e2e8f0",
  fontFamily: "inherit",
};

/**
 * Create a reporting period (assessment-and-goals §13). The narrative queue is
 * useless without one, and there was no other UI to make the first period — so
 * any staffer can set one up here. Defaults to an OPEN 4-month window (open =
 * the period you write into, so it immediately becomes `current`).
 */
export function CreatePeriodDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (periodId: Id<"reportingPeriods">) => void;
}) {
  const create = useMutation(api.reportingPeriods.create);
  // The period belongs to the school the page is scoped to.
  const { scopeParam } = useActiveInstitution();

  const [label, setLabel] = useState(defaultPeriodLabel());
  const [startsAt, setStartsAt] = useState(() => toDateInput(Date.now()));
  const [endsAt, setEndsAt] = useState(() => toDateInput(Date.now() + 120 * DAY));
  const [status, setStatus] = useState<"upcoming" | "open" | "writing" | "closed">("open");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setLabel(defaultPeriodLabel());
    setStartsAt(toDateInput(Date.now()));
    setEndsAt(toDateInput(Date.now() + 120 * DAY));
    setStatus("open");
  };
  const handleClose = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const startMs = fromDateInput(startsAt);
  const endMs = fromDateInput(endsAt);
  const valid = !!label.trim() && startMs > 0 && endMs > startMs;

  const handleCreate = async () => {
    if (!valid) return;
    setSubmitting(true);
    try {
      const period = await create({
        label: label.trim(),
        startsAt: startMs,
        endsAt: endMs,
        status,
        scope: scopeParam,
      });
      toaster.success({ title: "Reporting period created" });
      if (period?._id) onCreated(period._id);
      reset();
    } catch (e) {
      toaster.error({
        title: "Couldn't create the period",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(d) => !d.open && handleClose()} placement="center" motionPreset="slide-in-bottom">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Reporting period
                </Text>
                <Heading size="md" color="navy.500" fontFamily="heading" fontWeight="700">
                  New reporting period
                </Heading>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton aria-label="Close" size="sm" variant="ghost" color="charcoal.400" _hover={{ bg: "gray.100" }}>
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            <Dialog.Body px={6} pb={6}>
              <Stack gap={4}>
                <Stack gap={2}>
                  <FieldLabel>Label</FieldLabel>
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="Fall 2026"
                    style={dateInputStyle}
                  />
                </Stack>
                <Flex gap={3}>
                  <Stack gap={2} flex={1}>
                    <FieldLabel>Starts</FieldLabel>
                    <input type="date" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} style={dateInputStyle} />
                  </Stack>
                  <Stack gap={2} flex={1}>
                    <FieldLabel>Ends</FieldLabel>
                    <input type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} style={dateInputStyle} />
                  </Stack>
                </Flex>
                <Stack gap={2}>
                  <FieldLabel>Status</FieldLabel>
                  <FieldSelect
                    value={status}
                    onChange={(v) => setStatus(v as typeof status)}
                    size="sm"
                    fieldProps={{ "aria-label": "Period status" }}
                  >
                    <option value="open">Open (write into this one)</option>
                    <option value="writing">Writing</option>
                    <option value="upcoming">Upcoming</option>
                    <option value="closed">Closed</option>
                  </FieldSelect>
                </Stack>
                {startMs > 0 && endMs > 0 && endMs <= startMs && (
                  <Text fontSize="2xs" color="red.500" fontFamily="body">
                    End date must be after the start date.
                  </Text>
                )}

                <Flex justify="flex-end" gap={2} pt={1}>
                  <Button variant="ghost" size="sm" fontFamily="heading" onClick={handleClose} disabled={submitting}>
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={handleCreate}
                    loading={submitting}
                    disabled={!valid}
                  >
                    Create period
                  </Button>
                </Flex>
              </Stack>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="xs"
      color="charcoal.400"
      fontFamily="heading"
      fontWeight="600"
      textTransform="uppercase"
      letterSpacing="0.04em"
    >
      {children}
    </Text>
  );
}

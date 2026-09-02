"use client";

/**
 * EditMathPlanDialog — one focused editor for ONE scholar's Math plan, holding
 * exactly the two authored controls: Practice scope (a hierarchical hard
 * allowlist) and Checkpoint (domain × optional strand × grade). Nothing else is
 * authored here — the derived mode is shown and never editable, and mastery,
 * mapping, placement and focus-next are not settings.
 *
 * Both controls save in ONE atomic call (`api.mathPlans.saveForScholar`), and a
 * checkpoint that its scope would exclude is an invalid plan, not a precedence
 * question: the save is blocked until the teacher takes one of three named
 * exits, so neither control ever silently wins.
 */

import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  Flex,
  Heading,
  Portal,
  RadioGroup,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { CaretDown, CaretRight, WarningCircle } from "@phosphor-icons/react";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { CheckpointModePill } from "@/components/practice/MathPlanMarks";
import {
  CheckpointBandGrid,
  firstSelectableBand,
} from "@/components/practice/CheckpointBandGrid";
import { toaster } from "@/lib/toaster";
import {
  checkpointDomainChoices,
  domainCheckState,
  draftProblem,
  keepCheckpointInScope,
  nextScopeUndo,
  scopeAllowsDomain,
  toggleDraftDomain,
  toggleDraftStrand,
  type CheckpointCatalogDomain,
  type MathPlanDraft,
  type MathPlanRow,
  type PracticeScope,
} from "@/components/practice/mathPlanProjection";

type EditorDomain = CheckpointCatalogDomain;

type DraftCheckpoint = NonNullable<MathPlanDraft["checkpoint"]>;

/** Seed a Limited draft from whatever is effective now — switching the mode
 *  must never silently narrow a scholar to nothing. */
function limitedSeed(scope: PracticeScope, domains: EditorDomain[]): PracticeScope {
  if (scope.kind === "limited") return scope;
  return { kind: "limited", domains: domains.map((entry) => ({ domain: entry.domain })) };
}

/** The two Practice-scope choices, each a full-width row: label plus the
 *  consequence of choosing it. Authored here so the rows cannot drift apart. */
const SCOPE_CHOICES = [
  {
    value: "open",
    label: "Open",
    description:
      "Every domain and strand appropriate for this scholar may be served.",
  },
  {
    value: "limited",
    label: "Limited",
    description:
      "Only the domains and strands checked below may be served. Everything unchecked is not served anywhere in Math skills while this plan is active.",
  },
] as const;

function sameTarget(
  a: DraftCheckpoint | null | undefined,
  b: { domain: string; strand?: string; grade: string } | null | undefined,
) {
  if (!a || !b) return a == null && b == null;
  return a.domain === b.domain && a.strand === b.strand && a.grade === b.grade;
}

export function EditMathPlanDialog({
  open,
  scholarId,
  scholarName,
  plan,
  onClose,
}: {
  open: boolean;
  scholarId: string | null;
  scholarName: string;
  /** The scholar's row from `forScholars`, for the read-only derived mode. */
  plan: MathPlanRow | undefined;
  onClose: () => void;
}) {
  const data = useQuery(
    api.mathPlans.planEditor,
    open && scholarId ? { scholarId: scholarId as Id<"users"> } : "skip",
  );
  const save = useMutation(api.mathPlans.saveForScholar);

  // The draft is DERIVED from the stored plan until the teacher edits it, so
  // nothing has to be synchronised in an effect: `edit` is null until the first
  // change, and closing throws the edit away.
  const [edit, setEdit] = useState<MathPlanDraft | null>(null);
  const [expandedEdit, setExpandedEdit] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The scope edit that put the checkpoint out of scope, so "keep it in scope"
  // can undo exactly that step rather than resetting the whole draft.
  const [scopeUndo, setScopeUndo] = useState<PracticeScope | null>(null);

  const domains: EditorDomain[] = useMemo(() => data?.domains ?? [], [data]);

  // Seeded from the stored plan (a conflict must survive into the draft — the
  // editor is where it gets repaired).
  const seeded = useMemo<MathPlanDraft | null>(() => {
    if (!open || !data) return null;
    return {
      scope: data.practiceScope,
      checkpoint: data.checkpoint
        ? {
            domain: data.checkpoint.domain,
            ...(data.checkpoint.strand === undefined
              ? {}
              : { strand: data.checkpoint.strand }),
            grade: data.checkpoint.grade,
          }
        : null,
    };
  }, [open, data]);

  const seededExpanded = useMemo<Set<string>>(() => {
    if (!seeded || seeded.scope.kind !== "limited") return new Set<string>();
    return new Set(
      seeded.scope.domains
        .filter((entry) => entry.strands !== undefined)
        .map((entry) => entry.domain),
    );
  }, [seeded]);

  const draft = edit ?? seeded;
  const expanded = expandedEdit ?? seededExpanded;

  const setExpanded = (next: (current: Set<string>) => Set<string>) =>
    setExpandedEdit((current) => next(current ?? seededExpanded));

  /** Closing discards the draft — nothing is saved until Save math plan. */
  const closeAndReset = useCallback(() => {
    setEdit(null);
    setExpandedEdit(null);
    setError(null);
    setScopeUndo(null);
    onClose();
  }, [onClose]);

  const problem = draft ? draftProblem(draft) : null;
  const storedGroupCheckpoint = data?.groupCheckpoint ?? null;
  const inheritsGroupTarget =
    !!draft?.checkpoint && sameTarget(draft.checkpoint, storedGroupCheckpoint);

  const updateScope = (next: PracticeScope) => {
    if (!draft) return;
    // Remember the scope this edit replaced, so "keep the checkpoint in scope"
    // can undo exactly this step instead of resetting the whole draft. Captured
    // only on the valid → invalid transition; a second breaking edit must not
    // overwrite it with an already-broken scope.
    setScopeUndo((current) => nextScopeUndo(draft, next, current));
    setEdit({ ...draft, scope: next });
  };

  const setCheckpoint = (next: DraftCheckpoint | null) => {
    if (!draft) return;
    setEdit({ ...draft, checkpoint: next });
    setScopeUndo(null);
  };

  const checkpointDomain = draft?.checkpoint
    ? domains.find((entry) => entry.domain === draft.checkpoint!.domain)
    : undefined;

  /**
   * The checkpoint DOMAIN select is the one list that survives: it is the
   * grid's axis, and it still has to render the held domain when the draft
   * scope excludes it (marked out of scope and unselectable), because a native
   * `<select>` with no matching option silently displays its first one ("No
   * checkpoint") — hiding the very target the teacher opened this dialog to
   * repair. Strand and grade are no longer lists at all: the band grid states
   * both in one gesture, so there is nothing left to re-derive.
   */
  const checkpointDomainOptions = useMemo(
    () => (draft ? checkpointDomainChoices(draft, domains) : []),
    [domains, draft],
  );

  /** Domains a checkpoint can actually be moved INTO under the draft scope. */
  const inScopeDomains = useMemo(
    () =>
      draft
        ? domains.filter((entry) => scopeAllowsDomain(draft.scope, entry.domain))
        : [],
    [domains, draft],
  );

  const moveCheckpointIntoScope = () => {
    const target = inScopeDomains[0];
    if (!target || !draft?.checkpoint) return;
    const entry =
      draft.scope.kind === "limited"
        ? draft.scope.domains.find((item) => item.domain === target.domain)
        : undefined;
    const strand = entry?.strands?.[0];
    const grades = strand
      ? (target.strands.find((item) => item.strand === strand)?.grades ?? [])
      : target.grades;
    const grade = grades.includes(draft.checkpoint.grade)
      ? draft.checkpoint.grade
      : grades[0];
    if (!grade) return;
    setCheckpoint({
      domain: target.domain,
      ...(strand === undefined ? {} : { strand }),
      grade,
    });
  };

  /**
   * Widen the scope to admit the held checkpoint. Undoes the breaking edit when
   * there was one, and otherwise widens — so the exit is offered on the repair
   * path too, where the plan ARRIVED conflicted and there is nothing to undo.
   */
  const keepCheckpoint = () => {
    if (!draft?.checkpoint) return;
    const allStrands = domains
      .find((entry) => entry.domain === draft.checkpoint!.domain)
      ?.strands.map((strand) => strand.strand);
    updateScope(
      keepCheckpointInScope(
        draft.scope,
        draft.checkpoint,
        scopeUndo,
        allStrands,
      ),
    );
    setScopeUndo(null);
  };

  const onSave = async () => {
    if (!draft || !scholarId || problem) return;
    setSaving(true);
    setError(null);
    try {
      await save({
        scholarId: scholarId as Id<"users">,
        practiceScope: draft.scope,
        checkpoint: draft.checkpoint,
      });
      toaster.create({ description: "Math plan saved", type: "success" });
      closeAndReset();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not save the Math plan.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(details) => {
        if (!details.open && !saving) closeAndReset();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="620px" w="95vw">
            <Dialog.Header px={6} pt={6} pb={3}>
              <Stack gap={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Math plan
                </Text>
                <Dialog.Title asChild>
                  <Heading size="md" color="navy.500" fontFamily="heading">
                    Edit math plan — {scholarName}
                  </Heading>
                </Dialog.Title>
                <Text fontSize="sm" color="charcoal.500" mt={1}>
                  Two controls: what may be served, and where this scholar is
                  headed inside it.
                </Text>
              </Stack>
            </Dialog.Header>

            <Dialog.Body px={6} pb={2} maxH="62vh" overflowY="auto">
              {!data || !draft ? (
                <Flex align="center" justify="center" gap={2} py={10}>
                  <Spinner size="sm" color="violet.500" />
                  <Text fontSize="sm" color="charcoal.400">
                    Loading this scholar&rsquo;s plan…
                  </Text>
                </Flex>
              ) : (
                <Stack gap={5}>
                  {problem?.kind === "checkpointOutOfScope" && (
                    <Box
                      px={3}
                      py={3}
                      borderWidth="1px"
                      borderColor="red.200"
                      borderRadius="md"
                      bg="red.50"
                      data-testid="math-plan-editor-conflict"
                    >
                      <Flex align="center" gap={1.5} mb={1}>
                        <Box color="red.600" display="flex">
                          <WarningCircle size={14} weight="fill" />
                        </Box>
                        <Text fontSize="sm" fontWeight="700" color="red.700">
                          This would put the checkpoint outside practice scope
                        </Text>
                      </Flex>
                      <Text fontSize="xs" color="charcoal.600" lineHeight="1.5">
                        {domains.find((entry) => entry.domain === problem.domain)
                          ?.label ?? problem.domain}{" "}
                        holds this scholar&rsquo;s checkpoint. Keep it in scope,
                        move the checkpoint somewhere that is in scope, or clear
                        the checkpoint — then save.
                      </Text>
                      <Flex gap={2} mt={2} flexWrap="wrap">
                        {draft.checkpoint && (
                          <Button
                            size="xs"
                            variant="outline"
                            onClick={keepCheckpoint}
                          >
                            Keep it in scope
                          </Button>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={inScopeDomains.length === 0}
                          onClick={moveCheckpointIntoScope}
                        >
                          Move checkpoint
                        </Button>
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => setCheckpoint(null)}
                        >
                          Clear checkpoint
                        </Button>
                      </Flex>
                    </Box>
                  )}

                  {/* ── Practice scope ─────────────────────────────────── */}
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
                      Practice scope
                    </Text>
                    {/* Two stacked full-width rows, not two words side by side:
                        this is the decision that bounds everything served, so
                        each choice gets its own row in the main flow with its
                        consequence stated under the label. */}
                    <RadioGroup.Root
                      value={draft.scope.kind}
                      onValueChange={(details) =>
                        updateScope(
                          details.value === "open"
                            ? { kind: "open" }
                            : limitedSeed(draft.scope, domains),
                        )
                      }
                      size="sm"
                      aria-label="Practice scope"
                      data-testid="math-plan-scope-kind"
                      w="100%"
                    >
                      <Stack gap={2} w="100%">
                        {SCOPE_CHOICES.map((choice) => {
                          const chosen = draft.scope.kind === choice.value;
                          return (
                            <RadioGroup.Item
                              key={choice.value}
                              value={choice.value}
                              w="100%"
                              alignItems="flex-start"
                              gap={3}
                              px={3}
                              py={3}
                              borderWidth="1px"
                              borderColor={chosen ? "violet.300" : "gray.200"}
                              borderRadius="md"
                              bg={chosen ? "violet.50" : "white"}
                              cursor="pointer"
                              _hover={{ bg: chosen ? "violet.50" : "gray.50" }}
                              data-testid={`math-plan-scope-${choice.value}`}
                            >
                              <RadioGroup.ItemHiddenInput />
                              <RadioGroup.ItemIndicator mt="2px" />
                              <Box as="span" display="block">
                                <RadioGroup.ItemText
                                  fontSize="sm"
                                  fontWeight={chosen ? "700" : "600"}
                                  color="charcoal.700"
                                >
                                  {choice.label}
                                </RadioGroup.ItemText>
                                <Text
                                  as="span"
                                  display="block"
                                  fontSize="xs"
                                  color="charcoal.400"
                                  lineHeight="1.5"
                                >
                                  {choice.description}
                                </Text>
                              </Box>
                            </RadioGroup.Item>
                          );
                        })}
                      </Stack>
                    </RadioGroup.Root>

                    {draft.scope.kind === "limited" && (
                      <Stack gap={0} mt={3} data-testid="math-plan-scope-tree">
                        {domains.map((entry) => {
                          const state = domainCheckState(
                            draft.scope,
                            entry.domain,
                          );
                          const scopeEntry =
                            draft.scope.kind === "limited"
                              ? draft.scope.domains.find(
                                  (item) => item.domain === entry.domain,
                                )
                              : undefined;
                          const checkedStrands =
                            scopeEntry?.strands ??
                            (state === "checked"
                              ? entry.strands.map((strand) => strand.strand)
                              : []);
                          const isOpen = expanded.has(entry.domain);
                          const holdsCheckpoint =
                            draft.checkpoint?.domain === entry.domain;
                          return (
                            <Box key={entry.domain}>
                              <Flex align="center" gap={2} py={1}>
                                <Checkbox.Root
                                  size="sm"
                                  checked={
                                    state === "indeterminate"
                                      ? "indeterminate"
                                      : state === "checked"
                                  }
                                  onCheckedChange={(details) =>
                                    updateScope(
                                      toggleDraftDomain(
                                        draft.scope,
                                        entry.domain,
                                        details.checked === true,
                                      ),
                                    )
                                  }
                                >
                                  <Checkbox.HiddenInput />
                                  <Checkbox.Control />
                                  <Checkbox.Label
                                    fontSize="sm"
                                    color="charcoal.700"
                                  >
                                    {entry.label}
                                  </Checkbox.Label>
                                </Checkbox.Root>
                                {state === "indeterminate" && (
                                  <Text fontSize="2xs" color="charcoal.400">
                                    {checkedStrands.length} of{" "}
                                    {entry.strands.length} strands
                                  </Text>
                                )}
                                {holdsCheckpoint && (
                                  <Text fontSize="2xs" color="charcoal.400">
                                    Holds the checkpoint
                                  </Text>
                                )}
                                {entry.strands.length > 0 && (
                                  <Box
                                    as="button"
                                    ml="auto"
                                    display="inline-flex"
                                    alignItems="center"
                                    gap={1}
                                    fontSize="2xs"
                                    color="charcoal.400"
                                    _hover={{ color: "violet.600" }}
                                    onClick={() =>
                                      setExpanded((current) => {
                                        const next = new Set(current);
                                        if (next.has(entry.domain)) {
                                          next.delete(entry.domain);
                                        } else next.add(entry.domain);
                                        return next;
                                      })
                                    }
                                    aria-expanded={isOpen}
                                    aria-label={`${isOpen ? "Hide" : "Show"} strands in ${entry.label}`}
                                  >
                                    {isOpen ? (
                                      <CaretDown size={11} weight="bold" />
                                    ) : (
                                      <CaretRight size={11} weight="bold" />
                                    )}
                                    Strands
                                  </Box>
                                )}
                              </Flex>
                              {isOpen && entry.strands.length > 0 && (
                                <Flex
                                  wrap="wrap"
                                  columnGap={4}
                                  rowGap={1}
                                  pl={6}
                                  pb={2}
                                >
                                  {entry.strands.map((strand) => (
                                    <Checkbox.Root
                                      key={strand.strand}
                                      size="sm"
                                      checked={checkedStrands.includes(
                                        strand.strand,
                                      )}
                                      onCheckedChange={(details) =>
                                        updateScope(
                                          toggleDraftStrand(
                                            draft.scope,
                                            entry.domain,
                                            strand.strand,
                                            details.checked === true,
                                            entry.strands.map(
                                              (item) => item.strand,
                                            ),
                                          ),
                                        )
                                      }
                                    >
                                      <Checkbox.HiddenInput />
                                      <Checkbox.Control />
                                      <Checkbox.Label
                                        fontSize="xs"
                                        color="charcoal.500"
                                      >
                                        {strand.label}
                                      </Checkbox.Label>
                                    </Checkbox.Root>
                                  ))}
                                </Flex>
                              )}
                            </Box>
                          );
                        })}
                        {problem?.kind === "emptyScope" && (
                          <Text
                            fontSize="xs"
                            color="red.600"
                            mt={1}
                            data-testid="math-plan-empty-scope"
                          >
                            A limited scope needs at least one domain or strand —
                            otherwise no math can be served at all.
                          </Text>
                        )}
                      </Stack>
                    )}
                  </Box>

                  {/* ── Checkpoint ─────────────────────────────────────── */}
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
                      Checkpoint
                    </Text>
                    <Flex gap={2} align="center" flexWrap="wrap">
                      <FieldSelect
                        value={draft.checkpoint?.domain ?? ""}
                        onChange={(next) => {
                          if (!next) return setCheckpoint(null);
                          const target = domains.find(
                            (entry) => entry.domain === next,
                          );
                          if (!target) return;
                          // Land on the first band the grid would offer, so
                          // switching domains never seeds one the grid refuses.
                          const band =
                            firstSelectableBand(target, draft.scope) ??
                            (target.grades[0]
                              ? { grade: target.grades[0] }
                              : null);
                          if (!band) return;
                          setCheckpoint({ domain: next, ...band });
                        }}
                        maxW="220px"
                        fieldProps={{ "aria-label": "Checkpoint domain" }}
                      >
                        <option value="">No checkpoint</option>
                        {checkpointDomainOptions
                          .filter((entry) => entry.value !== "")
                          .map((entry) => (
                            <option
                              key={entry.value}
                              value={entry.value}
                              disabled={entry.outOfScope}
                            >
                              {entry.label}
                            </option>
                          ))}
                      </FieldSelect>
                    </Flex>

                    {/* The band grid: one gesture states strand AND grade, in
                        the matrix's own vocabulary, with the scope boundary
                        drawn in place rather than explained in prose. */}
                    {draft.checkpoint && checkpointDomain && (
                      <Box mt={3}>
                        <CheckpointBandGrid
                          domain={checkpointDomain}
                          scope={draft.scope}
                          value={{
                            grade: draft.checkpoint.grade,
                            ...(draft.checkpoint.strand === undefined
                              ? {}
                              : { strand: draft.checkpoint.strand }),
                          }}
                          corner={
                            // Mode is DERIVED, so the chip may never predict
                            // one for a band the server has not resolved: only
                            // the stored target wears the plan's own reading,
                            // and any other draft band wears the default
                            // "working toward" the sentence below calls
                            // unresolved until saved.
                            sameTarget(draft.checkpoint, data.checkpoint)
                              ? plan?.conflict
                                ? "conflict"
                                : (plan?.mode ?? "toward")
                              : "toward"
                          }
                          onSelect={(band) =>
                            setCheckpoint({
                              domain: checkpointDomain.domain,
                              ...band,
                            })
                          }
                        />
                      </Box>
                    )}

                    <Stack gap={1} mt={2}>
                      {draft.checkpoint && plan && (
                        <Flex align="center" gap={2} flexWrap="wrap">
                          {sameTarget(draft.checkpoint, data.checkpoint) ? (
                            <>
                              <CheckpointModePill
                                mode={plan.mode}
                                suspended={plan.conflict}
                              />
                              <Text fontSize="2xs" color="charcoal.400">
                                Mode is derived from band fluency and cannot be
                                set here.
                              </Text>
                            </>
                          ) : (
                            <Text fontSize="2xs" color="charcoal.400">
                              Mode is derived from band fluency — it resolves
                              once this target is saved.
                            </Text>
                          )}
                        </Flex>
                      )}
                      {storedGroupCheckpoint && (
                        <Text fontSize="2xs" color="charcoal.400" lineHeight="1.5">
                          {draft.checkpoint === null
                            ? "The math group's checkpoint is cleared for this scholar only — the group keeps its own."
                            : inheritsGroupTarget
                              ? `Inherited from ${storedGroupCheckpoint.groupName ?? "the math group"}. Saving it unchanged keeps this scholar following the group.`
                              : "This is a scholar override; the math group's own checkpoint is unchanged."}
                        </Text>
                      )}
                      {!storedGroupCheckpoint && draft.checkpoint && (
                        <Text fontSize="2xs" color="charcoal.400">
                          Set for this scholar; the math group has none.
                        </Text>
                      )}
                    </Stack>
                  </Box>

                  {error && (
                    <Text fontSize="xs" color="red.600" data-testid="math-plan-error">
                      {error}
                    </Text>
                  )}
                </Stack>
              )}
            </Dialog.Body>

            <Flex px={6} py={4} gap={2} justify="flex-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={closeAndReset}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                colorPalette="violet"
                onClick={onSave}
                loading={saving}
                disabled={!draft || !!problem || saving}
                data-testid="math-plan-save"
              >
                Save math plan
              </Button>
            </Flex>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

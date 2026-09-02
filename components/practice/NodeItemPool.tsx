"use client";

/**
 * NodeItemPool — the staff view + edit surface over ONE knowledge node's
 * practice item pool (what the practice engine actually serves for that node).
 *
 * Three sources, one panel:
 *   - the deterministic TEMPLATE (code): shown as stable sample previews with
 *     answers, read-only — so a teacher sees exactly what scholars get;
 *   - stored word problems (verified-LLM + hand-authored): inline edit /
 *     delete / add, answers visible (staff-only surface);
 *   - manipulatives: prompt + spec JSON, gradability-checked server-side.
 *
 * Plus a "Generate items" action that runs the same Haiku → verification-gate
 * pipeline the seed-time pre-warm uses.
 *
 * Used from BOTH the Tree Map's NodeDrawer (teacher audience) and the
 * /teacher/math-skills studio page — one component, one behavior. Editing is
 * deliberately INLINE (no Dialog.Root): this panel mounts inside overlay
 * surfaces, and a dialog stacked over an open overlay scope is the known
 * Chakra/Ark body-lock leak (engineering-principles.md).
 *
 * Backend: convex/practiceItemPool.ts (curriculum-gated). The same core
 * helpers back the aide bot tools, so what a teacher does here the bot can do
 * in chat.
 */

import { useEffect, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Flex,
  IconButton,
  Input,
  Spinner,
  Text,
  Textarea,
} from "@chakra-ui/react";
import {
  Anchor,
  Check,
  PencilSimple,
  Play,
  Plus,
  Sparkle,
  Trash,
  X,
} from "@phosphor-icons/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Manipulative } from "@/components/manipulative/Manipulative";
import { StemText } from "@/components/practice/StemText";
import { stemPreviewText } from "@/shared/practiceStemBlocks";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { ManipulativeRehearseModal } from "@/components/practice/ManipulativeRehearseModal";
import {
  ManipulativesTabSkeleton,
  MixedTabSkeleton,
  QuestionsTabSkeleton,
} from "@/components/practice/MathSkillsContentSkeletons";
import {
  MANIPULATIVE_KIND_LABELS,
  MANIPULATIVE_KINDS,
  exampleSpecJson,
} from "@/components/manipulative/catalog";
import { isGradableManipulative, assertRenderableManipulative } from "@/lib/manipulative/authoring";
import { parseManipulativeSpec } from "@/lib/manipulative/grade";
import type { ManipulativeKind, ManipulativeSpec } from "@/lib/manipulative/types";
import { formatUnit, textNamesUnit, UNIT_KEYS, type UnitKey } from "@/convex/lib/practice/answers";

const ANSWER_TYPES = ["integer", "decimal", "fraction"] as const;

type PoolItem = {
  id: Id<"practiceItems">;
  stem: string;
  answerType: string;
  answer: string;
  /** Display-form unit the answer must carry ("cm³"), or null for the
   *  (default) value-only grading. */
  answerUnit: string | null;
  verifierKind: string;
  manipulativeSpec: string | null;
  source: string;
  model: string | null;
  verifiedAt: number;
  /** Null = core rotation / untagged; "stretch" gets the "Go deeper" tag —
   *  the SAME vocabulary + blue arrow the coverage-mark rail uses (T1: one
   *  rendering per signal), so a teacher who clicked the go-deeper mark can
   *  actually find the item(s) it counted. */
  tier?: string | null;
};

function sourceBadge(item: PoolItem) {
  // The row's ANSWER-FORMAT badge (the Questions thread's facet vocabulary):
  // a manipulative is Hands-on (teal), everything else is Written (violet) — the
  // SAME two tokens the facet + add buttons use, so a row's format reads at a
  // glance without minting a new colour.
  if (item.verifierKind === "manipulative")
    return { label: "Hands-on", palette: "teal" as const };
  return { label: "Written", palette: "violet" as const };
}

/** PROVENANCE — a separate variable from format, and the one a teacher acts on:
 *  did a MODEL write this item? Deliberately silent for hand-authored rows,
 *  which are the expected default in a curated pool and would badge most of the
 *  list for no decision (T2: name the new variable or delete the pixel). Kept
 *  when the format badge took over the primary slot, because "a model wrote
 *  this" is a trust signal no other cell on the row encodes. */
export function provenanceBadge(item: PoolItem) {
  // Silent for anything a human wrote or a human-curated source authored:
  // "authored" is the item editor's own save tag (practiceItemPool.ts), and
  // "registry" is the story-registry seeder's tag (convex/edgeStories.ts,
  // `seedRegistryQuestions`) — hand-written, human-reviewed application
  // questions, not model output. Everything else (e.g. "practice-gen",
  // "practice-gen-backfill") is genuinely LLM-authored and gets the trust
  // signal.
  if (item.source === "authored" || item.source === "registry") return null;
  return item.model ? "AI · verified" : "Generated";
}

/** Canonical uppercase section eyebrow (the house SectionEyebrow, shared by
 *  every Content thread pane so the four threads read as one hierarchy). */
function Eyebrow({ children }: { children: React.ReactNode }) {
  return <SectionEyebrow boxProps={{ mb: 2 }}>{children}</SectionEyebrow>;
}

// ── inline word-item editor (shared by edit + add) ─────────────────────────

/** The "no required unit" sentinel for the unit picker — a real UNIT_KEYS
 *  member is never the empty string, so this can't collide. Maps to "" on
 *  submit, which is the clear-the-unit value both createItem and updateItem
 *  already understand. */
const NO_UNIT = "";

function WordItemForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  initial: { stem: string; answerType: string; answer: string; answerUnit: string | null };
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (v: { stem: string; answerType: string; answer: string; answerUnit: string }) => void;
  onCancel: () => void;
}) {
  const [stem, setStem] = useState(initial.stem);
  const [answerType, setAnswerType] = useState(initial.answerType);
  const [answer, setAnswer] = useState(initial.answer);
  // The unit picker holds a UnitKey (registry-known only — never free text, so
  // a choice can always be canonicalized). initial.answerUnit is the already-
  // canonical DISPLAY form ("cm³"), so map it back to its key for the picker.
  const [answerUnit, setAnswerUnit] = useState<UnitKey | typeof NO_UNIT>(
    () => UNIT_KEYS.find((k) => formatUnit(k) === initial.answerUnit) ?? NO_UNIT,
  );

  // Inline warning for the stem-names-the-unit gate — computed client-side so
  // an author sees WHY before they even submit, not just after a rejection.
  const unitStemWarning =
    answerUnit !== NO_UNIT && !textNamesUnit(stem, answerUnit)
      ? `The stem doesn't mention ${formatUnit(answerUnit)} — saving will be refused unless the stem asks for it (e.g. "…in cubic centimeters").`
      : null;

  return (
    <Box borderWidth="1px" borderColor="violet.200" borderRadius="10px" p={3} bg="violet.50">
      <Textarea
        value={stem}
        onChange={(e) => setStem(e.target.value)}
        placeholder="The word problem the scholar reads — one unambiguous numeric answer."
        fontSize="sm"
        rows={3}
        bg="white"
        mb={2}
        data-testid="item-pool-stem"
      />
      <Flex gap={2} align="center" wrap="wrap">
        <Flex gap={1}>
          {ANSWER_TYPES.map((t) => (
            <Button
              key={t}
              size="xs"
              variant={answerType === t ? "solid" : "outline"}
              colorPalette="violet"
              onClick={() => setAnswerType(t)}
            >
              {t}
            </Button>
          ))}
        </Flex>
        <Input
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder={answerType === "fraction" ? "e.g. 3/4" : answerType === "decimal" ? "e.g. 6.5" : "e.g. 42"}
          size="sm"
          bg="white"
          maxW="140px"
          data-testid="item-pool-answer"
        />
        <FieldSelect
          value={answerUnit}
          onChange={(v) => setAnswerUnit(v as UnitKey | typeof NO_UNIT)}
          size="xs"
          maxW="130px"
          bg="white"
          data-testid="item-pool-unit"
          fieldProps={{ "aria-label": "Required answer unit" }}
        >
          <option value={NO_UNIT}>No unit</option>
          {UNIT_KEYS.map((k) => (
            <option key={k} value={k}>
              {formatUnit(k)}
            </option>
          ))}
        </FieldSelect>
        <Flex gap={1} ml="auto">
          <Button
            size="xs"
            colorPalette="violet"
            disabled={busy || !stem.trim() || !answer.trim()}
            onClick={() =>
              onSubmit({
                stem,
                answerType,
                answer,
                answerUnit: answerUnit === NO_UNIT ? "" : formatUnit(answerUnit),
              })
            }
            data-testid="item-pool-save"
          >
            <Check weight="bold" /> {submitLabel}
          </Button>
          <Button size="xs" variant="ghost" onClick={onCancel} disabled={busy}>
            <X weight="bold" /> Cancel
          </Button>
        </Flex>
      </Flex>
      {unitStemWarning && (
        <Text fontSize="xs" color="#8a6d1f" mt={2} data-testid="item-pool-unit-warning">
          {unitStemWarning}
        </Text>
      )}
      {error && (
        <Text fontSize="xs" color="red.600" mt={2}>
          {error}
        </Text>
      )}
    </Box>
  );
}

// ── inline manipulative-item authoring (add only — existing rows still edit
//    via the raw spec-JSON path on ItemRow) ─────────────────────────────────

/**
 * Authors a NEW manipulative item: pick a kind, get a prefilled gradable
 * example spec (from the same library the scholar gallery uses), tweak the
 * JSON, and see it rendered live before saving. Client-side validation here
 * is a UX convenience only — `createItemCore` re-runs the same
 * `isGradableManipulative` + `assertRenderableManipulative` guards
 * server-side, which stays the authority.
 */
function ManipulativeItemForm({
  submitLabel,
  busy,
  error,
  onSubmit,
  onCancel,
  initialKind = "partition",
}: {
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (specJson: string) => void;
  onCancel: () => void;
  /** Preselect a kind (and its known-good example) when the form opens — the
   *  Library's "Use on a skill…" handoff lands here with a kind already chosen,
   *  so the teacher never re-picks it. Defaults to the first kind. */
  initialKind?: ManipulativeKind;
}) {
  const [kind, setKind] = useState<ManipulativeKind>(initialKind);
  const [specDraft, setSpecDraft] = useState(() => exampleSpecJson(initialKind));

  const selectKind = (k: ManipulativeKind) => {
    setKind(k);
    setSpecDraft(exampleSpecJson(k));
  };

  // Re-derived on every keystroke — cheap, and gives inline feedback as the
  // teacher edits, not just on submit.
  let parsedSpec: ManipulativeSpec | null = null;
  let validationError: string | null = null;
  try {
    const parsed = JSON.parse(specDraft) as ManipulativeSpec;
    if (!isGradableManipulative(parsed)) {
      validationError =
        `This spec has no usable goal — a scholar could never be marked correct. ` +
        `Add a "goal" shaped for kind "${parsed.kind}" (see lib/manipulative/types.ts).`;
    } else {
      assertRenderableManipulative(parsed);
      parsedSpec = parsed;
    }
  } catch (e) {
    validationError = e instanceof Error ? e.message : String(e);
  }

  return (
    <Box borderWidth="1px" borderColor="teal.200" borderRadius="10px" p={3} bg="teal.50">
      <Text fontSize="xs" fontWeight="700" color="charcoal.500" textTransform="uppercase" letterSpacing="0.04em" mb={1.5}>
        Kind
      </Text>
      <Flex gap={1} wrap="wrap" mb={2}>
        {MANIPULATIVE_KINDS.map((k) => (
          <Button
            key={k}
            size="xs"
            variant={kind === k ? "solid" : "outline"}
            colorPalette="teal"
            onClick={() => selectKind(k)}
            data-testid={`manip-kind-${k}`}
          >
            {MANIPULATIVE_KIND_LABELS[k]}
          </Button>
        ))}
      </Flex>

      <Text fontSize="xs" color="charcoal.500" mb={1.5}>
        Spec JSON — prefilled with a working example; edit the numbers/prompt to fit this skill.
      </Text>
      <Textarea
        value={specDraft}
        onChange={(e) => setSpecDraft(e.target.value)}
        fontFamily="mono"
        fontSize="xs"
        rows={12}
        bg="white"
        mb={2}
        data-testid="manip-item-spec"
      />

      {validationError && (
        <Text fontSize="xs" color="red.600" mb={2} data-testid="manip-item-validation-error">
          {validationError}
        </Text>
      )}

      {parsedSpec && (
        <Box mb={2}>
          <Text fontSize="xs" fontWeight="700" color="charcoal.500" textTransform="uppercase" letterSpacing="0.04em" mb={1.5}>
            Preview
          </Text>
          <Box data-testid="manip-item-preview">
            <Manipulative spec={parsedSpec} />
          </Box>
        </Box>
      )}

      <Flex gap={1} justify="flex-end">
        <Button
          size="xs"
          colorPalette="teal"
          disabled={busy || !parsedSpec}
          onClick={() => parsedSpec && onSubmit(JSON.stringify(parsedSpec))}
          data-testid="manip-item-save"
        >
          <Check weight="bold" /> {submitLabel}
        </Button>
        <Button size="xs" variant="ghost" onClick={onCancel} disabled={busy}>
          <X weight="bold" /> Cancel
        </Button>
      </Flex>
      {error && (
        <Text fontSize="xs" color="red.600" mt={2}>
          {error}
        </Text>
      )}
    </Box>
  );
}

// ── one stored-item row ────────────────────────────────────────────────────

function ItemRow({ item }: { item: PoolItem }) {
  const updateItem = useMutation(api.practiceItemPool.updateItem);
  const deleteItem = useMutation(api.practiceItemPool.deleteItem);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [specDraft, setSpecDraft] = useState<string | null>(null);
  const [rehearsing, setRehearsing] = useState(false);

  const isManip = item.verifierKind === "manipulative";
  const badge = sourceBadge(item);
  const provenance = provenanceBadge(item);
  // The parsed spec for the Rehearse preview (manipulative rows only). Tolerant:
  // an unparseable spec simply hides the Rehearse button rather than throwing.
  const rehearseSpec = isManip ? parseManipulativeSpec(item.manipulativeSpec) : null;

  const saveWord = async (v: { stem: string; answerType: string; answer: string; answerUnit: string }) => {
    setBusy(true);
    setError(null);
    try {
      await updateItem({ id: item.id, ...v });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveSpec = async () => {
    if (specDraft === null) return;
    setBusy(true);
    setError(null);
    try {
      await updateItem({ id: item.id, manipulativeSpec: specDraft });
      setEditing(false);
      setSpecDraft(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      await deleteItem({ id: item.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (editing && !isManip) {
    return (
      <WordItemForm
        initial={{ stem: item.stem, answerType: item.answerType, answer: item.answer, answerUnit: item.answerUnit }}
        submitLabel="Save"
        busy={busy}
        error={error}
        onSubmit={saveWord}
        onCancel={() => {
          setEditing(false);
          setError(null);
        }}
      />
    );
  }

  if (editing && isManip) {
    return (
      <Box borderWidth="1px" borderColor="teal.200" borderRadius="10px" p={3} bg="teal.50">
        <Text fontSize="xs" color="charcoal.500" mb={2}>
          Manipulative spec (JSON). The prompt comes from <code>prompt</code>; an
          unsolvable goal is rejected on save.
        </Text>
        <Textarea
          value={specDraft ?? JSON.stringify(JSON.parse(item.manipulativeSpec ?? "{}"), null, 2)}
          onChange={(e) => setSpecDraft(e.target.value)}
          fontFamily="mono"
          fontSize="xs"
          rows={10}
          bg="white"
          mb={2}
        />
        <Flex gap={1} justify="flex-end">
          <Button size="xs" colorPalette="teal" onClick={saveSpec} disabled={busy || specDraft === null}>
            <Check weight="bold" /> Save
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setEditing(false);
              setSpecDraft(null);
              setError(null);
            }}
          >
            <X weight="bold" /> Cancel
          </Button>
        </Flex>
        {error && (
          <Text fontSize="xs" color="red.600" mt={2}>
            {error}
          </Text>
        )}
      </Box>
    );
  }

  return (
    <Flex
      gap={2}
      align="flex-start"
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="12px"
      p={2.5}
      data-testid="item-pool-row"
    >
      <Box flex={1} minW={0}>
        {/* Bucket A: one bordered card per item, so an embedded pipe table has
            room to render as a real table (via StemText) rather than raw pipes. */}
        <StemText value={item.stem} fontSize={14} align="left" color="charcoal.700" weight={400} lineHeight={1.55} />
        <Flex gap={2} mt={1.5} align="center" wrap="wrap">
          <Badge colorPalette={badge.palette} variant="subtle" size="sm">
            {badge.label}
          </Badge>
          {provenance && (
            <Badge
              colorPalette="gray"
              variant="subtle"
              size="sm"
              data-testid="item-pool-provenance"
            >
              {provenance}
            </Badge>
          )}
          {item.tier === "stretch" && (
            <Badge
              colorPalette="blue"
              variant="subtle"
              size="sm"
              display="inline-flex"
              alignItems="center"
              gap={1}
              data-testid="item-pool-go-deeper-tag"
            >
              <Anchor size={11} weight="fill" /> Go deeper
            </Badge>
          )}
          {item.answerUnit && (
            <Badge
              colorPalette="orange"
              variant="subtle"
              size="sm"
              data-testid="item-pool-unit-badge"
            >
              Requires {item.answerUnit}
            </Badge>
          )}
          {!isManip && (
            <Text fontSize="xs" color="charcoal.500">
              Answer:{" "}
              <Text as="span" fontWeight="700" color="charcoal.700">
                {item.answer}
                {item.answerUnit ? ` ${item.answerUnit}` : ""}
              </Text>
              {" · "}
              {item.answerType}
            </Text>
          )}
        </Flex>
        {error && !editing && (
          <Text fontSize="xs" color="red.600" mt={1}>
            {error}
          </Text>
        )}
      </Box>
      <Flex gap={1} flexShrink={0}>
        {/* Rehearse — the same "play it" a scholar gets: opens the REAL
            interactive manipulative (standalone, ungraded, zero writes). */}
        {rehearseSpec && (
          <Button
            size="xs"
            variant="ghost"
            color="violet.700"
            fontFamily="heading"
            fontWeight="600"
            _hover={{ bg: "violet.50" }}
            onClick={() => setRehearsing(true)}
            data-testid="item-pool-rehearse"
          >
            <Play weight="fill" />
            Rehearse
          </Button>
        )}
        <IconButton
          aria-label="Edit item"
          size="xs"
          variant="ghost"
          onClick={() => setEditing(true)}
          data-testid="item-pool-edit"
        >
          <PencilSimple weight="bold" />
        </IconButton>
        {confirmDelete ? (
          <Button size="xs" colorPalette="red" onClick={doDelete} disabled={busy}>
            Delete?
          </Button>
        ) : (
          <IconButton
            aria-label="Delete item"
            size="xs"
            variant="ghost"
            colorPalette="red"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash weight="bold" />
          </IconButton>
        )}
      </Flex>
      {rehearsing && rehearseSpec && (
        <ManipulativeRehearseModal
          spec={rehearseSpec}
          title={item.stem}
          onClose={() => setRehearsing(false)}
        />
      )}
    </Flex>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────

/** A dimmed one-line row standing in for content the active answer-format facet
 *  hides — the mechanism that keeps the fold a net gain over the old tabs: the
 *  whole pool stays visible in one view while the facet answers the narrow
 *  question. A "Show" link (when the caller wires one) reveals everything by
 *  jumping to the All facet. */
function HiddenByFacetRow({
  label,
  onShow,
}: {
  label: string;
  onShow?: () => void;
}) {
  return (
    <Flex
      align="center"
      gap={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="12px"
      px={2.5}
      py={1.5}
      opacity={0.55}
      data-testid="item-pool-hidden-row"
    >
      <Text fontSize="xs" color="charcoal.500" flex={1} minW={0} lineClamp={1}>
        {label}
      </Text>
      {onShow && (
        <Button
          size="xs"
          variant="ghost"
          colorPalette="violet"
          onClick={onShow}
          data-testid="item-pool-hidden-show"
        >
          Show
        </Button>
      )}
    </Flex>
  );
}

export function NodeItemPool({
  nodeKey,
  mode = "all",
  pool: poolProp,
  collapseAfter,
  onRevealAll,
  initialManipulativeKind,
}: {
  nodeKey: string;
  mode?: "all" | "questions" | "manipulatives";
  /** The node's pool, when a caller has already fetched it (the Math Skills
   *  studio holds the same `poolForNode` read for its header/Rehearse link).
   *  Provided ⇒ the internal query is skipped, so the page no longer fetches
   *  the same node twice. Omitted ⇒ this panel fetches its own, so the Tree
   *  Map's NodeDrawer and any other caller keep working untouched. */
  pool?: FunctionReturnType<typeof api.practiceItemPool.poolForNode>;
  /** Collapse the stored-item list past this many rows, with a "Show all"
   *  toggle (stage-2 unified pane, N≈8). Omitted ⇒ no collapse, so the Tree
   *  Map's NodeDrawer renders the full list exactly as before. */
  collapseAfter?: number;
  /** Reveal everything the active answer-format facet is hiding (switch to the
   *  All facet). The Math Skills studio passes it so the "hidden by the facet"
   *  one-liners get a working "Show" affordance; other callers (NodeDrawer,
   *  which is always mode="all" and hides nothing) omit it. */
  onRevealAll?: () => void;
  /** The Library's "Use on a skill…" handoff: when set, the add-manipulative
   *  form opens automatically with this kind preselected, so the teacher lands
   *  on the skill they clicked with the mechanic already chosen — reusing THIS
   *  editor, never a second one. Omitted for every other caller. */
  initialManipulativeKind?: ManipulativeKind;
}) {
  // Only fetch when the caller hasn't handed us a resolved pool (null included —
  // that's the "unknown node" answer, still a resolved value). During the
  // caller's own load window `poolProp` is undefined and this re-runs the SAME
  // query+args, which the Convex client dedupes to one subscription.
  const fetchedPool = useQuery(
    api.practiceItemPool.poolForNode,
    poolProp === undefined ? { nodeKey } : "skip",
  );
  const pool = poolProp === undefined ? fetchedPool : poolProp;
  const createItem = useMutation(api.practiceItemPool.createItem);
  const generateForNode = useAction(api.practiceItemPool.generateForNode);

  const [adding, setAdding] = useState(false);
  const [itemType, setItemType] = useState<"word" | "manipulative">("word");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genResult, setGenResult] = useState<string | null>(null);
  const [showAllItems, setShowAllItems] = useState(false);

  // The Library's "Use on a skill…" handoff: land with the add-manipulative
  // form already open on the chosen kind. Keyed on `initialManipulativeKind`,
  // so re-firing the handoff for a different kind re-opens; the component is
  // itself keyed by node+facet upstream, so switching skills re-runs this for
  // the new skill (the intended "place THIS mechanic, pick the skill" flow).
  useEffect(() => {
    if (initialManipulativeKind) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consumes the library handoff by staging its requested manipulative form.
      setItemType("manipulative");
      setAdding(true);
    }
  }, [initialManipulativeKind]);

  if (pool === undefined) {
    return mode === "manipulatives" ? (
      <ManipulativesTabSkeleton />
    ) : mode === "all" ? (
      <MixedTabSkeleton />
    ) : (
      <QuestionsTabSkeleton />
    );
  }
  if (pool === null) {
    return (
      <Text fontSize="sm" color="charcoal.400" py={2}>
        Unknown node.
      </Text>
    );
  }

  const wordItems = pool.items.filter((it) => it.verifierKind !== "manipulative");
  const manipItems = pool.items.filter((it) => it.verifierKind === "manipulative");
  const showQuestions = mode !== "manipulatives";
  const showManipulatives = mode !== "questions";
  const visibleItems = [
    ...(showQuestions ? wordItems : []),
    ...(showManipulatives ? manipItems : []),
  ];
  // What the active facet is HIDING, surfaced as a dimmed one-liner (never
  // vanished): a facet that silently drops content makes a teacher wonder what
  // they're not seeing — the exact anxiety the old tabs created. The Written
  // facet hides hands-on; the Hands-on facet hides written items AND the code
  // template (its preview block is written-only). The All facet hides nothing.
  const hiddenHandsOn = showManipulatives ? 0 : manipItems.length;
  const hiddenWritten = showQuestions ? 0 : wordItems.length;
  const hiddenTemplate = !showQuestions && pool.hasTemplate;
  const effectiveItemType =
    mode === "questions"
      ? "word"
      : mode === "manipulatives"
        ? "manipulative"
        : itemType;

  const addWord = async (v: { stem: string; answerType: string; answer: string; answerUnit: string }) => {
    setAddBusy(true);
    setAddError(null);
    try {
      await createItem({ nodeKey, ...v });
      setAdding(false);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const addManipulative = async (specJson: string) => {
    setAddBusy(true);
    setAddError(null);
    try {
      await createItem({ nodeKey, manipulativeSpec: specJson });
      setAdding(false);
    } catch (e) {
      setAddError(e instanceof Error ? e.message : String(e));
    } finally {
      setAddBusy(false);
    }
  };

  const closeAdd = () => {
    setAdding(false);
    setAddError(null);
  };

  const generate = async () => {
    setGenerating(true);
    setGenResult(null);
    try {
      const res = await generateForNode({ nodeKey, count: 8 });
      setGenResult(
        `${res.stored} item${res.stored === 1 ? "" : "s"} stored — ${res.verified} passed the verifier, ${res.rejected} rejected.`,
      );
    } catch (e) {
      setGenResult(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Box data-testid="node-item-pool">
      {/* ── Template source ── */}
      {showQuestions && (
        <Box mb={4}>
          <Eyebrow>Template drill{pool.hasTemplate ? "" : " — none"}</Eyebrow>
          {pool.hasTemplate ? (
            <>
              <Text fontSize="xs" color="charcoal.500" mb={2} lineHeight="1.5">
                This skill has a code-defined template: endless variants, answers
                correct by construction. Samples of what a scholar is served (not
                editable here — templates live in code):
              </Text>
              <Flex direction="column" gap={1}>
                {pool.templatePreviews.map((p, i) => (
                  <Flex key={i} gap={2} align="baseline" px={2.5} py={1.5} bg="gray.50" borderRadius="8px">
                    <Text fontSize="sm" color="charcoal.700" flex={1} minW={0}>
                      {/* Bucket B: a dense one-per-line preview list, so a table
                          run is flattened to one scannable line, never a nested
                          block table that would wreck the row rhythm. */}
                      {stemPreviewText(p.stem)}
                      {p.choices ? `  (${p.choices.join(" / ")})` : ""}
                    </Text>
                    <Text fontSize="xs" fontWeight="700" color="green.700" flexShrink={0}>
                      {p.answer}
                    </Text>
                  </Flex>
                ))}
              </Flex>
            </>
          ) : (
            <Text fontSize="xs" color="charcoal.500" lineHeight="1.5">
              No deterministic template — this skill&rsquo;s questions come from
              the stored pool below{pool.prewarmConceptual ? " (it's on the pre-warmed conceptual list, so the pool is expected to be stocked)" : ""}.
            </Text>
          )}
        </Box>
      )}

      {/* ── Stored items ── */}
      <Box mb={4}>
        <Flex align="center" justify="space-between" mb={2}>
          <Eyebrow>
            {mode === "questions"
              ? `Stored questions (${wordItems.length})`
              : mode === "manipulatives"
                ? `Manipulatives (${manipItems.length})`
                : `Stored items (${wordItems.length}${manipItems.length > 0 ? ` + ${manipItems.length} manipulative${manipItems.length === 1 ? "" : "s"}` : ""})`}
          </Eyebrow>
          <Flex gap={1}>
            <Button
              size="xs"
              variant="outline"
              colorPalette={mode === "manipulatives" ? "teal" : "violet"}
              onClick={() => {
                setItemType(mode === "manipulatives" ? "manipulative" : "word");
                setAdding(true);
              }}
              disabled={adding}
              data-testid="item-pool-add"
            >
              <Plus weight="bold" />{" "}
              {mode === "questions"
                ? "Add question"
                : mode === "manipulatives"
                  ? "Add manipulative"
                  : "Add item"}
            </Button>
            {showQuestions && (
              <Button
                size="xs"
                variant="outline"
                colorPalette="violet"
                onClick={generate}
                disabled={generating}
                data-testid="item-pool-generate"
                title="Draft word problems with AI; only verifier-passed items are stored"
              >
                {generating ? <Spinner size="xs" /> : <Sparkle weight="fill" />}
                {generating ? "Generating…" : "Generate questions"}
              </Button>
            )}
          </Flex>
        </Flex>

        {genResult && (
          <Text fontSize="xs" color="charcoal.500" mb={2}>
            {genResult}
          </Text>
        )}

        {showQuestions && !pool.hasTemplate && wordItems.length === 0 && (
          <Box borderWidth="1px" borderColor="#e3c766" bg="#fbf1de" borderRadius="12px" p={3} mb={2}>
            <Text fontSize="sm" fontWeight="600" color="#5a3e0f">
              No questions to serve yet. Add one or generate a verified set.
            </Text>
          </Box>
        )}
        {showManipulatives && !showQuestions && manipItems.length === 0 && (
          <Text fontSize="sm" color="charcoal.500" mb={2}>
            No manipulative for this skill yet.
          </Text>
        )}

        {adding && (
          <Box mb={2}>
            {mode === "all" && (
              <Flex gap={1} mb={2}>
                <Button
                  size="xs"
                  variant={itemType === "word" ? "solid" : "outline"}
                  colorPalette="violet"
                  onClick={() => setItemType("word")}
                  data-testid="item-pool-type-word"
                >
                  Word problem
                </Button>
                <Button
                  size="xs"
                  variant={itemType === "manipulative" ? "solid" : "outline"}
                  colorPalette="teal"
                  onClick={() => setItemType("manipulative")}
                  data-testid="item-pool-type-manipulative"
                >
                  Manipulative
                </Button>
              </Flex>
            )}
            {effectiveItemType === "word" ? (
              <WordItemForm
                initial={{ stem: "", answerType: "integer", answer: "", answerUnit: null }}
                submitLabel="Add"
                busy={addBusy}
                error={addError}
                onSubmit={addWord}
                onCancel={closeAdd}
              />
            ) : (
              <ManipulativeItemForm
                submitLabel="Add"
                busy={addBusy}
                error={addError}
                onSubmit={addManipulative}
                onCancel={closeAdd}
                initialKind={initialManipulativeKind}
              />
            )}
          </Box>
        )}

        <Flex direction="column" gap={2}>
          {(collapseAfter !== undefined && !showAllItems
            ? visibleItems.slice(0, collapseAfter)
            : visibleItems
          ).map((it) => (
            <ItemRow key={it.id} item={it} />
          ))}
        </Flex>
        {/* What the facet hides, kept honest as dimmed one-liners (never gone).
            One row per hidden format, plus the template when the Hands-on facet
            suppresses its written-only preview block. A "Show" affordance jumps
            to the All facet (only when the caller wired the reveal). */}
        {(hiddenHandsOn > 0 || hiddenWritten > 0 || hiddenTemplate) && (
          <Flex direction="column" gap={2} mt={2}>
            {hiddenHandsOn > 0 && (
              <HiddenByFacetRow
                label={`${hiddenHandsOn} hands-on item${hiddenHandsOn === 1 ? "" : "s"} hidden by the facet`}
                onShow={onRevealAll}
              />
            )}
            {hiddenWritten > 0 && (
              <HiddenByFacetRow
                label={`${hiddenWritten} written item${hiddenWritten === 1 ? "" : "s"} hidden by the facet`}
                onShow={onRevealAll}
              />
            )}
            {hiddenTemplate && (
              <HiddenByFacetRow
                label="Template · endless variants — hidden by the facet"
                onShow={onRevealAll}
              />
            )}
          </Flex>
        )}
        {collapseAfter !== undefined &&
          !showAllItems &&
          visibleItems.length > collapseAfter && (
            <Button
              size="xs"
              variant="ghost"
              colorPalette="violet"
              mt={2}
              onClick={() => setShowAllItems(true)}
              data-testid="item-pool-show-all"
            >
              Show all {visibleItems.length}
            </Button>
          )}
        {showQuestions && wordItems.length === 0 && pool.hasTemplate && !adding && (
          <Text fontSize="xs" color="charcoal.400">
            No stored questions — the template covers this skill; add word problems
            only if you want contextual variety on top.
          </Text>
        )}
      </Box>
    </Box>
  );
}

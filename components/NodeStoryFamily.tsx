"use client";

/**
 * NodeStoryFamily — the "Opens into the world" section of the NodeDrawer.
 *
 * Renders a focal node's durable *story* edges (bridges carrying a verified
 * world-material payload) as cards. Replaces PR #588's NodeHooksPanel: a hook
 * is now a bridge with a story, co-fetched by nodeNeighbourhood as the
 * `stories` array and never double-rendered as a generic violet bridge.
 *
 * Curriculum-role users get selection-driven inline editing (no modal, no
 * separate collapsed panel): edit/delete per card + an "Add story" affordance,
 * wired to api.edgeStories.upsertStory / removeStory. The reactive
 * neighbourhood query refreshes the cards after every write.
 */

import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Badge,
  Box,
  Button,
  Flex,
  Input,
  Text,
  Textarea,
} from "@chakra-ui/react";
import { Plus, PencilSimple, Play, Trash, X } from "@phosphor-icons/react";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { EmojiPickerButton } from "@/components/ui/EmojiPickerButton";
import { SectionEyebrow } from "@/components/ui/SectionEyebrow";
import { StoryRehearseModal } from "@/components/practice/StoryRehearseModal";
import type { StoryRehearseStory } from "@/components/practice/storyRehearse";

export type StoryKind = "instantiates" | "applies" | "history" | "etymology";

export type EdgeStory = {
  kind: StoryKind;
  hook: string;
  narrative: string;
  teaser?: string;
  visualEmoji?: string;
  probe?: string;
  source?: string;
  provenance: "registry" | "authored" | "generated";
  updatedAt?: number;
};

export type StoryItem = {
  edgeId: string;
  direction: "outgoing" | "incoming";
  fromKey: string;
  fromLabel: string;
  fromDomain: string;
  toKey: string;
  toLabel: string;
  toDomain: string;
  artUrl?: string;
  story: EdgeStory;
};

const STORY_KINDS: StoryKind[] = [
  "instantiates",
  "applies",
  "history",
  "etymology",
];

export const KIND_LABEL: Record<StoryKind, string> = {
  instantiates: "instantiates",
  applies: "applies to",
  history: "history",
  etymology: "etymology",
};

function prettyDomain(domain: string): string {
  return domain.replace(/[-_]/g, " ");
}

// ── Inline editor (shared by edit + add) ─────────────────────────────────────

type FormValues = {
  toLabel: string;
  toDomain: string;
  kind: StoryKind;
  hook: string;
  narrative: string;
  visualEmoji: string;
  probe: string;
  source: string;
};

function emptyForm(): FormValues {
  return {
    toLabel: "",
    toDomain: "",
    kind: "instantiates",
    hook: "",
    narrative: "",
    visualEmoji: "",
    probe: "",
    source: "",
  };
}

function fromStory(item: StoryItem): FormValues {
  return {
    toLabel: item.toLabel,
    toDomain: item.toDomain,
    kind: item.story.kind,
    hook: item.story.hook,
    narrative: item.story.narrative,
    visualEmoji: item.story.visualEmoji ?? "",
    probe: item.story.probe ?? "",
    source: item.story.source ?? "",
  };
}

const labelStyles = {
  fontFamily: "heading",
  fontSize: "sm" as const,
  fontWeight: "600" as const,
  color: "charcoal.500",
  mb: 1,
};

function StoryForm({
  mode,
  initial,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  mode: "add" | "edit";
  initial: FormValues;
  busy: boolean;
  error: string | null;
  onSubmit: (v: FormValues) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<FormValues>(initial);
  const set = <K extends keyof FormValues>(k: K, val: FormValues[K]) =>
    setV((prev) => ({ ...prev, [k]: val }));

  const canSubmit =
    v.hook.trim().length > 0 &&
    v.narrative.trim().length > 0 &&
    (mode === "edit" ||
      (v.toLabel.trim().length > 0 && v.toDomain.trim().length > 0));

  return (
    <Box>
      {mode === "add" && (
        <Flex gap={3} wrap="wrap" mb={3}>
          <Box flex="1 1 180px" minW="160px">
            <Text {...labelStyles}>Far-end concept</Text>
            <Input
              size="sm"
              value={v.toLabel}
              onChange={(e) => set("toLabel", e.currentTarget.value)}
              placeholder="e.g. Cicada life cycles"
              fontFamily="heading"
            />
          </Box>
          <Box flex="1 1 140px" minW="120px">
            <Text {...labelStyles}>Domain</Text>
            <Input
              size="sm"
              value={v.toDomain}
              onChange={(e) => set("toDomain", e.currentTarget.value)}
              placeholder="e.g. biology"
              fontFamily="heading"
            />
          </Box>
        </Flex>
      )}

      <Box mb={3} maxW="220px">
        <Text {...labelStyles}>Kind</Text>
        <FieldSelect
          value={v.kind}
          onChange={(val) => set("kind", val as StoryKind)}
          fieldProps={{ "aria-label": "Story kind" }}
        >
          {STORY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </FieldSelect>
      </Box>

      <Box mb={3}>
        <Text {...labelStyles}>Hook</Text>
        <Input
          size="sm"
          value={v.hook}
          onChange={(e) => set("hook", e.currentTarget.value)}
          placeholder="A one-line invitation into the world"
          fontFamily="heading"
        />
      </Box>

      <Box mb={3}>
        <Text {...labelStyles}>Narrative</Text>
        <Textarea
          size="sm"
          value={v.narrative}
          onChange={(e) => set("narrative", e.currentTarget.value)}
          placeholder="The story itself"
          rows={3}
          fontFamily="heading"
        />
      </Box>

      <Box mb={3} maxW="220px">
        <Text {...labelStyles}>Visual emoji (optional)</Text>
        <EmojiPickerButton
          value={v.visualEmoji}
          onChange={(emoji) => set("visualEmoji", emoji)}
          height="36px"
          minW="48px"
          fontSize="lg"
        />
      </Box>

      <Box mb={3}>
        <Text {...labelStyles}>Probe (optional)</Text>
        <Input
          size="sm"
          value={v.probe}
          onChange={(e) => set("probe", e.currentTarget.value)}
          placeholder="A Socratic question into it"
          fontFamily="heading"
        />
      </Box>

      <Box mb={3}>
        <Text {...labelStyles}>Source (optional)</Text>
        <Input
          size="sm"
          value={v.source}
          onChange={(e) => set("source", e.currentTarget.value)}
          placeholder="Citation / verification trail"
          fontFamily="heading"
        />
      </Box>

      {error && (
        <Text fontFamily="heading" fontSize="sm" color="red.600" mb={2}>
          {error}
        </Text>
      )}

      <Flex gap={2} align="center">
        <Button
          size="sm"
          colorPalette="green"
          variant="solid"
          disabled={!canSubmit || busy}
          onClick={() => onSubmit(v)}
          fontFamily="heading"
        >
          {mode === "add" ? "Add story" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
          fontFamily="heading"
        >
          Cancel
        </Button>
      </Flex>
    </Box>
  );
}

// ── Story card (display) ─────────────────────────────────────────────────────

function StoryCard({
  item,
  canEdit,
  onEdit,
  onDelete,
  onNavigate,
  onRehearse,
  deleting,
}: {
  item: StoryItem;
  canEdit: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onNavigate?: (nodeKey: string, label: string) => void;
  onRehearse?: () => void;
  deleting: boolean;
}) {
  const { story } = item;
  const related =
    item.direction === "outgoing"
      ? {
          key: item.toKey,
          label: item.toLabel,
          domain: item.toDomain,
        }
      : {
          key: item.fromKey,
          label: item.fromLabel,
          domain: item.fromDomain,
        };
  return (
    <Box borderRadius="12px" bg="gray.50" p={4}>
      <Flex justify="space-between" align="flex-start" gap={2} mb={2}>
        <Flex gap={1.5} wrap="wrap" align="center">
          {onNavigate ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              borderColor="gray.200"
              bg="white"
              color="charcoal.600"
              borderRadius="full"
              minH="auto"
              h="auto"
              px={2}
              py={0.5}
              fontFamily="heading"
              fontSize="xs"
              fontWeight="600"
              onClick={() => onNavigate(related.key, related.label)}
              aria-label={`Open ${related.label} neighbourhood`}
              _hover={{ borderColor: "violet.300", bg: "violet.50" }}
            >
              {related.label}
            </Button>
          ) : (
            <Badge
              variant="outline"
              borderColor="gray.200"
              bg="white"
              color="charcoal.600"
              borderRadius="full"
              px={2}
              fontFamily="heading"
              fontSize="xs"
              fontWeight="600"
            >
              {related.label}
            </Badge>
          )}
          {/* Suppress the domain pill when it collides with the kind label
              (e.g. domain "history" + kind "history") — one HISTORY pill, not two. */}
          {prettyDomain(related.domain).toLowerCase() !==
            KIND_LABEL[story.kind].toLowerCase() && (
            <Badge
              colorPalette="gray"
              variant="subtle"
              borderRadius="full"
              px={2}
              fontFamily="heading"
              fontSize="xs"
              fontWeight="600"
              color="charcoal.500"
              textTransform="uppercase"
              letterSpacing="0.03em"
            >
              {prettyDomain(related.domain)}
            </Badge>
          )}
          <Badge
            colorPalette="gray"
            variant="subtle"
            borderRadius="full"
            px={2}
            fontFamily="heading"
            fontSize="xs"
            fontWeight="600"
            color="charcoal.500"
            textTransform="uppercase"
            letterSpacing="0.03em"
          >
            {KIND_LABEL[story.kind]}
          </Badge>
        </Flex>
        {canEdit && (
          <Flex gap={1} flexShrink={0}>
            <Button
              size="xs"
              variant="ghost"
              colorPalette="gray"
              onClick={onEdit}
              aria-label="Edit story"
              title="Edit story"
              fontFamily="heading"
            >
              <PencilSimple weight="bold" />
            </Button>
            <Button
              size="xs"
              variant="ghost"
              colorPalette="red"
              disabled={deleting}
              onClick={onDelete}
              aria-label="Delete story"
              title="Delete story"
              fontFamily="heading"
            >
              <Trash weight="bold" />
            </Button>
          </Flex>
        )}
      </Flex>

      <Text
        fontFamily="heading"
        fontSize="md"
        fontWeight="700"
        color="charcoal.700"
        lineHeight="1.35"
        mb={1.5}
      >
        {story.hook}
      </Text>
      {story.visualEmoji && (
        <Text aria-hidden="true" fontSize="2xl" lineHeight="1" mb={1.5}>
          {story.visualEmoji}
        </Text>
      )}

      <Text fontSize="sm" color="charcoal.700" lineHeight="1.55">
        {story.narrative}
      </Text>

      {story.probe && (
        <Flex
          mt={3}
          gap={2}
          align="flex-start"
          bg="#f6f8fb"
          borderRadius="8px"
          p={2.5}
        >
          <Text
            fontFamily="heading"
            fontSize="md"
            fontWeight="700"
            color="#5663c6"
            lineHeight="1.2"
            flexShrink={0}
          >
            ?
          </Text>
          <Text
            fontSize="sm"
            color="charcoal.700"
            fontStyle="italic"
            lineHeight="1.55"
          >
            {story.probe}
          </Text>
        </Flex>
      )}

      {canEdit && onRehearse && (
        <Button
          size="xs"
          variant="ghost"
          color="violet.700"
          fontFamily="heading"
          fontWeight="600"
          mt={3}
          onClick={onRehearse}
          data-testid={`story-rehearse-${item.edgeId}`}
        >
          <Play weight="fill" />
          Rehearse
        </Button>
      )}

      {(story.source || story.provenance) && (
        <Text fontSize="xs" color="charcoal.400" mt={2.5} lineHeight="1.4">
          {story.source ? `${story.source} · ` : ""}
          {story.provenance}
        </Text>
      )}
    </Box>
  );
}

// ── Section ──────────────────────────────────────────────────────────────────

export function NodeStoryFamily({
  focalKey,
  stories,
  canEdit,
  onNavigate,
}: {
  focalKey: string;
  stories: StoryItem[];
  canEdit: boolean;
  onNavigate?: (nodeKey: string, label: string) => void;
}) {
  const upsert = useMutation(api.edgeStories.upsertStory);
  const remove = useMutation(api.edgeStories.removeStory);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [rehearsing, setRehearsing] = useState<StoryItem | null>(null);

  if (stories.length === 0 && !canEdit) return null;
  const outgoing = stories.filter((story) => story.direction === "outgoing");
  const incoming = stories.filter((story) => story.direction === "incoming");

  const storyPayload = (v: FormValues) => ({
    kind: v.kind,
    hook: v.hook.trim(),
    narrative: v.narrative.trim(),
    ...(v.visualEmoji.trim() ? { visualEmoji: v.visualEmoji.trim() } : {}),
    ...(v.probe.trim() ? { probe: v.probe.trim() } : {}),
    ...(v.source.trim() ? { source: v.source.trim() } : {}),
  });

  const handleEditSubmit = async (item: StoryItem, v: FormValues) => {
    setBusy(true);
    setError(null);
    try {
      await upsert({
        edgeId: item.edgeId as Id<"knowledgeNodeEdges">,
        fromKey: item.fromKey,
        // The edit form has no teaser field yet, but upsertStory replaces the
        // whole story object. Carry the existing teaser through so editing a
        // story that already has one (e.g. registry-seeded) doesn't drop it.
        story: {
          ...storyPayload(v),
          ...(item.story.teaser !== undefined
            ? { teaser: item.story.teaser }
            : {}),
        },
      });
      setEditingId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save story.");
    } finally {
      setBusy(false);
    }
  };

  const handleAddSubmit = async (v: FormValues) => {
    setBusy(true);
    setError(null);
    try {
      await upsert({
        fromKey: focalKey,
        toLabel: v.toLabel.trim(),
        toDomain: v.toDomain.trim(),
        story: storyPayload(v),
      });
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not add story.");
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (edgeId: string) => {
    setDeletingId(edgeId);
    try {
      await remove({ edgeId: edgeId as Id<"knowledgeNodeEdges"> });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Box mt={5}>
      {(canEdit || outgoing.length > 0 || adding) && (
        <>
          <Flex align="center" justify="space-between" gap={2} mb={3}>
          <SectionEyebrow>
            Stories — where this skill shows up in the world
          </SectionEyebrow>
          {canEdit && !adding && (
            <Button
              size="sm"
              variant="ghost"
              colorPalette="gray"
              onClick={() => {
                setAdding(true);
                setEditingId(null);
                setError(null);
              }}
              fontFamily="heading"
              data-testid="node-drawer-add-story"
            >
              <Plus weight="bold" />
              Add story
            </Button>
          )}
          </Flex>

          {outgoing.length === 0 && !adding && canEdit && (
          <Text fontSize="sm" color="charcoal.400" lineHeight="1.5" mb={2}>
            No world-stories yet. Add one to give the tutor something to open into.
          </Text>
          )}

          <Flex direction="column" gap={3}>
          {adding && (
            <Box
              borderWidth="1px"
              borderColor="violet.200"
              borderRadius="12px"
              bg="white"
              p={4}
            >
              <Flex align="center" justify="space-between" mb={3}>
                <Text
                  fontFamily="heading"
                  fontSize="sm"
                  fontWeight="700"
                  color="charcoal.600"
                >
                  New story
                </Text>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                  aria-label="Cancel"
                  fontFamily="heading"
                >
                  <X weight="bold" />
                </Button>
              </Flex>
              <StoryForm
                mode="add"
                initial={emptyForm()}
                busy={busy}
                error={error}
                onSubmit={handleAddSubmit}
                onCancel={() => setAdding(false)}
              />
            </Box>
          )}

          {outgoing.map((item) =>
            editingId === item.edgeId ? (
              <Box
                key={item.edgeId}
                borderWidth="1px"
                borderColor="violet.200"
                borderRadius="12px"
                bg="white"
                p={4}
              >
                <StoryForm
                  mode="edit"
                  initial={fromStory(item)}
                  busy={busy}
                  error={error}
                  onSubmit={(v) => handleEditSubmit(item, v)}
                  onCancel={() => setEditingId(null)}
                />
              </Box>
            ) : (
              <StoryCard
                key={item.edgeId}
                item={item}
                canEdit={canEdit}
                deleting={deletingId === item.edgeId}
                onNavigate={onNavigate}
                onEdit={() => {
                  setEditingId(item.edgeId);
                  setAdding(false);
                  setError(null);
                }}
                onDelete={() => handleDelete(item.edgeId)}
                onRehearse={() => setRehearsing(item)}
              />
            ),
          )}
          </Flex>
        </>
      )}

      {incoming.length > 0 && (
        <Box mt={outgoing.length > 0 || adding || canEdit ? 5 : 0}>
          <SectionEyebrow boxProps={{ mb: 3 }}>
            Stories that reach this skill
          </SectionEyebrow>
          <Flex direction="column" gap={3}>
            {incoming.map((item) =>
              editingId === item.edgeId ? (
                <Box
                  key={item.edgeId}
                  borderWidth="1px"
                  borderColor="violet.200"
                  borderRadius="12px"
                  bg="white"
                  p={4}
                >
                  <StoryForm
                    mode="edit"
                    initial={fromStory(item)}
                    busy={busy}
                    error={error}
                    onSubmit={(v) => handleEditSubmit(item, v)}
                    onCancel={() => setEditingId(null)}
                  />
                </Box>
              ) : (
                <StoryCard
                  key={item.edgeId}
                  item={item}
                  canEdit={canEdit}
                  deleting={deletingId === item.edgeId}
                  onNavigate={onNavigate}
                  onEdit={() => {
                    setEditingId(item.edgeId);
                    setAdding(false);
                    setError(null);
                  }}
                  onDelete={() => handleDelete(item.edgeId)}
                  onRehearse={() => setRehearsing(item)}
                />
              ),
            )}
          </Flex>
        </Box>
      )}
      {rehearsing && (
        <StoryRehearseModal
          story={{
            fromKey: rehearsing.fromKey,
            toKey: rehearsing.toKey,
            fromLabel: rehearsing.fromLabel,
            hook: rehearsing.story.hook,
            narrative: rehearsing.story.narrative,
            teaser: rehearsing.story.teaser,
            visualEmoji: rehearsing.story.visualEmoji,
            artUrl: rehearsing.artUrl,
            probe: rehearsing.story.probe,
          } satisfies StoryRehearseStory}
          onClose={() => setRehearsing(null)}
        />
      )}
    </Box>
  );
}

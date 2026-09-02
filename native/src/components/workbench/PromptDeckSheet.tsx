/**
 * The prompt deck the scholar authors — one SpeciesCard per world Species slot:
 * a shared prompt (all automata of that Species read it), a count within the
 * slot's range, the world-GIVEN Senses (read-only badges — the kid cannot grant
 * new senses), and charm art. The deck is the ONLY writer of automaton behavior;
 * the tutor has no path here (plan §7.1). Presented as a bottom sheet on native
 * (vs. the left column on web — plan §12).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useMutation } from "convex/react";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import type { DeckCard, SimulatorSpec } from "../../../vendor/simulator/contract";
import { MAX_PROMPT_CHARS } from "../../../vendor/simulator/contract";
import { colorForSlotIndex, deckDisplayPrompt, sensesLine } from "./helpers";
import { Sheet } from "./Sheet";
import { SpeciesIconImage } from "./SpeciesIcon";
import type { WorkbenchRunId } from "./useWorkbenchData";
import { TournamentCard } from "./TournamentCard";
import { AppTextInput } from "@/components/AppTextInput";
import { isRoundBasedWorkbench, workbenchDeckNoun } from "./workbenchTerminology";

export type CompilationStatus = {
  slotId: string;
  status: "compiling" | "ready" | "failed";
  errorMessage: string | null;
};

function SpeciesCard({
  slotIndex,
  slot,
  card,
  icon,
  compilation,
  focused,
  sessionId,
  canRemove,
  hasUnsavedDeckChanges,
  onChange,
  onLayoutY,
  roundBased,
}: {
  slotIndex: number;
  slot: SimulatorSpec["speciesSlots"][number];
  card: DeckCard;
  icon: string | undefined;
  compilation?: CompilationStatus;
  focused?: boolean;
  sessionId: Id<"sessions">;
  canRemove: boolean;
  hasUnsavedDeckChanges: boolean;
  onChange: (next: DeckCard) => void;
  onLayoutY?: (slotId: string, y: number) => void;
  roundBased: boolean;
}) {
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removeSpecies = useMutation(api.simulatorBenches.removeSpeciesFromBench);
  const color = colorForSlotIndex(slotIndex);

  // Tapping a species chip in the subheader opens the deck FOCUSED on that
  // species — its card auto-expands into the editor so the scholar lands
  // directly on the prompt they meant to write.
  useEffect(() => {
    if (focused) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Consuming focus must expand the deck before the focused prompt is displayed.
      setExpanded(true);
    }
  }, [focused]);

  // Card LIFT on edit, SETTLE on commit (§7.5 microinteraction): the card rises a
  // touch while being edited and settles quietly when the scholar is done — the
  // tactile "this is the thing I'm changing / it's committed" cue.
  const lift = useSharedValue(0);
  useEffect(() => {
    lift.set(reduceMotion
      ? expanded
        ? 1
        : 0
      : withTiming(expanded ? 1 : 0, { duration: 220, easing: Easing.out(Easing.cubic) }));
  }, [expanded, reduceMotion, lift]);

  const onRemove = async () => {
    if (hasUnsavedDeckChanges) {
      Alert.alert("Save your deck first", "Save the deck before removing a species.");
      return;
    }
    setRemoving(true);
    try {
      await removeSpecies({ sessionId, slotId: slot.slotId, acceptPromptLoss: true });
    } catch (error) {
      Alert.alert(
        "Couldn't remove this species",
        error instanceof Error ? error.message : "Please try again.",
      );
    }
    setRemoving(false);
  };
  const onRequestRemoval = () => {
    if (hasUnsavedDeckChanges) return;
    Alert.alert(
      "Remove species?",
      `Remove ${slot.label} and discard its prompt?`,
      [
        { text: "Keep species", style: "cancel" },
        { text: "Remove", style: "destructive", onPress: () => void onRemove() },
      ],
    );
  };
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -3 * lift.get() }, { scale: 1 + 0.012 * lift.get() }],
    shadowOpacity: 0.12 * lift.get(),
    shadowRadius: 8 * lift.get(),
  }));

  return (
    <Animated.View
      onLayout={(event) => onLayoutY?.(slot.slotId, event.nativeEvent.layout.y)}
      style={[styles.card, { borderColor: colors.border, backgroundColor: colors.bg }, liftStyle]}
    >
      <View style={styles.cardHead}>
        <SpeciesIconImage icon={icon} color={color} size={30} />
        <View style={styles.cardTitleWrap}>
          <View style={styles.cardTitleRow}>
            <Text style={[styles.cardTitle, { color: colors.fg }]} numberOfLines={1}>
              {slot.label}
            </Text>
            {slot.locked ? (
              <Text
                style={styles.lockGlyph}
                accessibilityLabel="Locked"
                accessibilityRole="text"
              >
                🔒
              </Text>
            ) : null}
          </View>
          <Text style={[styles.senses, { color: colors.fgMuted }]} numberOfLines={1}>
            {sensesLine(slot.senses)}
          </Text>
        </View>
        <View style={styles.counter}>
          <Pressable
            onPress={() => onChange({ ...card, count: Math.max(slot.countMin, card.count - 1) })}
            disabled={card.count <= slot.countMin}
            hitSlop={6}
            style={styles.counterBtn}
            accessibilityRole="button"
            accessibilityLabel={`Fewer ${slot.label}`}
            accessibilityValue={{ text: `${card.count}` }}
          >
            <Text style={[styles.counterSign, { color: card.count <= slot.countMin ? colors.gray300 : colors.fg }]}>
              −
            </Text>
          </Pressable>
          <Text style={[styles.count, { color: colors.fg }]}>{card.count}</Text>
          <Pressable
            onPress={() => onChange({ ...card, count: Math.min(slot.countMax, card.count + 1) })}
            disabled={card.count >= slot.countMax}
            hitSlop={6}
            style={styles.counterBtn}
            accessibilityRole="button"
            accessibilityLabel={`More ${slot.label}`}
            accessibilityValue={{ text: `${card.count}` }}
          >
            <Text style={[styles.counterSign, { color: card.count >= slot.countMax ? colors.gray300 : colors.fg }]}>
              +
            </Text>
          </Pressable>
        </View>
      </View>

      {slot.locked ? (
        <View style={styles.lockedNotice} accessibilityLabel={`${slot.label} prompt (locked)`}>
          <Text style={[styles.lockedExplainer, { color: colors.fgMuted }]}>
            This deck is locked — read it, then plan yours.
          </Text>
          <Text style={[styles.previewText, { color: colors.fg }]} numberOfLines={3}>
            {deckDisplayPrompt(slot, card) || "No prompt was authored for this deck."}
          </Text>
        </View>
      ) : expanded ? (
        <View style={styles.editor}>
          {slot.starterHint ? (
            <View
              style={[
                styles.guidance,
                { backgroundColor: colors.violetSubtle, borderColor: colors.violetMuted },
              ]}
            >
              <Text style={[styles.guidanceLabel, { color: colors.violet }]}>While you write</Text>
              <Text style={[styles.guidanceText, { color: colors.fg }]}>{slot.starterHint}</Text>
            </View>
          ) : null}
          <AppTextInput
            value={card.prompt}
            onChangeText={(text) => onChange({ ...card, prompt: text.slice(0, MAX_PROMPT_CHARS) })}
            placeholder={roundBased ? "What rule should guide this player?" : "How should this species behave?"}
            placeholderTextColor={colors.fgMuted}
            style={[styles.promptInput, { color: colors.fg, borderColor: colors.border }]}
            accessibilityLabel={`${slot.label} prompt`}
            accessibilityHint={slot.starterHint}
            multiline
            autoFocus={false}
          />
          <View style={styles.editorFoot}>
            <Text style={[styles.chars, { color: colors.fgMuted }]}>
              {card.prompt.length}/{MAX_PROMPT_CHARS}
            </Text>
            <Pressable onPress={() => setExpanded(false)} hitSlop={6} accessibilityRole="button">
              <Text style={[styles.done, { color: colors.violet }]}>done</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setExpanded(true)}
          style={styles.preview}
          accessibilityRole="button"
          accessibilityLabel={`Edit ${slot.label} prompt`}
        >
          <Text
            style={[styles.previewText, { color: card.prompt ? colors.fg : colors.fgMuted }]}
            numberOfLines={3}
          >
            {card.prompt ||
              (roundBased
                ? "Tap to write this strategy's rule →"
                : "Tap to write this species' prompt →")}
          </Text>
        </Pressable>
      )}

      {compilation ? (
        <Text
          style={[
            styles.compileStatus,
            {
              color:
                compilation.status === "failed"
                  ? colors.orange
                  : compilation.status === "ready"
                    ? colors.green
                    : colors.fgMuted,
            },
          ]}
        >
          {compilation.status === "ready"
            ? roundBased ? "Compiled rule ready" : "Compiled rules ready"
            : compilation.status === "failed"
              ? compilation.errorMessage ?? (roundBased ? "Couldn't compile this rule." : "Couldn't compile your prompt.")
              : roundBased ? "This strategy rule is being prepared…" : "This prompt is being prepared…"}
        </Text>
      ) : null}

      {canRemove ? (
        <View style={styles.removeArea}>
          <Pressable
            onPress={onRequestRemoval}
            disabled={hasUnsavedDeckChanges || removing}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${slot.label}`}
            accessibilityHint={
              hasUnsavedDeckChanges
                ? "Save the deck before removing a species."
                : "Opens a confirmation before the species is removed."
            }
          >
            <Text
              style={[
                styles.removeSpecies,
                { color: hasUnsavedDeckChanges ? colors.fgMuted : colors.danger },
              ]}
            >
              {removing ? "Removing…" : "Remove species"}
            </Text>
          </Pressable>
          {hasUnsavedDeckChanges ? (
            <Text style={[styles.removeHint, { color: colors.fgMuted }]}>
              Save the deck before removing a species.
            </Text>
          ) : null}
        </View>
      ) : null}

      {slot.senses.length > 0 ? (
        <View style={styles.badges}>
          {slot.senses.map((sense) => (
            <View key={sense.senseId} style={[styles.badge, { backgroundColor: colors.cyanSubtle }]}>
              <Text style={[styles.badgeText, { color: colors.cyan }]}>
                {sense.senseId}
                {sense.range && sense.range > 0 ? ` ${sense.range}` : ""}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </Animated.View>
  );
}

export function PromptDeckSheet({
  open,
  onClose,
  sessionId,
  spec,
  deck,
  deckVersion,
  focusedSlotId,
  speciesIcons,
  compiledPolicies,
  onDirtyChange,
  onSelectRun,
  docked,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: Id<"sessions">;
  spec: SimulatorSpec;
  deck: readonly DeckCard[];
  deckVersion: number;
  /** The species chip the scholar tapped to open the deck — scroll+expand it. */
  focusedSlotId: string | null;
  speciesIcons: Record<string, string | undefined>;
  compiledPolicies: readonly CompilationStatus[];
  onDirtyChange?: (dirty: boolean) => void;
  /** Tournament replays load into the one canonical world viewport. */
  onSelectRun: (runId: WorkbenchRunId) => void;
  /** Render inline in the right panel (landscape two-column) instead of a sheet. */
  docked?: boolean;
}) {
  const colors = useColors();
  const roundBased = isRoundBasedWorkbench(spec);
  const saveDeck = useMutation(api.simulatorBenches.saveDeck);
  const [draft, setDraft] = useState<DeckCard[]>(() => [...deck]);
  const [seenVersion, setSeenVersion] = useState(deckVersion);
  const [saving, setSaving] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const cardYRef = useRef<Record<string, number>>({});

  // Reset the local draft when the persisted deck version advances (a save
  // landed, or another surface edited it). Adjusting state during render — the
  // React-recommended alternative to a setState-in-effect — so in-progress edits
  // survive reactive re-renders that don't change the version.
  if (seenVersion !== deckVersion) {
    setSeenVersion(deckVersion);
    setDraft([...deck]);
  }

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify([...deck]), [draft, deck]);

  // The bottom-dock RunTray is a sibling of this sheet, so it needs the dirty
  // flag lifted (report it from an effect, never during render).
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Scroll to the focused species once the sheet is open and its card has laid
  // out (a short settle lets the auto-expand grow the card first).
  useEffect(() => {
    if (!open || !focusedSlotId) return;
    const timer = setTimeout(() => {
      const y = cardYRef.current[focusedSlotId];
      if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - 8), animated: true });
    }, 120);
    return () => clearTimeout(timer);
  }, [open, focusedSlotId]);

  const updateCard = (slotId: string, next: DeckCard) => {
    setDraft((current) => current.map((card) => (card.slotId === slotId ? next : card)));
  };

  const onSave = async () => {
    setSaving(true);
    try {
      await saveDeck({ sessionId, expectedDeckVersion: deckVersion, deck: draft });
    } catch (error) {
      Alert.alert("Couldn't save", error instanceof Error ? error.message : "Could not save the deck");
    }
    setSaving(false);
  };

  const cardBySlot = new Map(draft.map((card) => [card.slotId, card]));
  const compilationBySlot = new Map(
    compiledPolicies.map((compilation) => [compilation.slotId, compilation]),
  );
  const deckNoun = workbenchDeckNoun(spec);
  const versionLabel = dirty
    ? `${deckNoun === "prompt deck" ? "Prompt deck" : "Strategy rules"} · saved v${deckVersion} · draft v${deckVersion + 1}`
    : `${deckNoun === "prompt deck" ? "Prompt deck" : "Strategy rules"} · saved v${deckVersion}`;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      eyebrow={versionLabel}
      title={roundBased ? "Strategy rules" : "Your species"}
      heightFraction={0.82}
      docked={docked}
    >
      <ScrollView
        ref={scrollRef}
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {dirty ? (
          <Pressable onPress={onSave} style={[styles.saveBtn, { backgroundColor: colors.green }]}>
            <Text style={[styles.saveText, { color: colors.white }]}>{saving ? "Saving…" : "Save deck"}</Text>
          </Pressable>
        ) : null}

        {spec.speciesSlots.map((slot, index) => {
          const card =
            cardBySlot.get(slot.slotId) ?? { slotId: slot.slotId, count: slot.defaultCount, prompt: "" };
          return (
            <SpeciesCard
              key={slot.slotId}
              slotIndex={index}
              slot={slot}
              card={card}
              icon={speciesIcons[slot.label]}
              focused={slot.slotId === focusedSlotId}
              sessionId={sessionId}
              canRemove={
                spec.templateId === "ecosystemGrid" &&
                spec.speciesSlots.length > 1 &&
                !slot.locked &&
                slot.countMin === 0
              }
              hasUnsavedDeckChanges={dirty}
              onLayoutY={(slotId, y) => {
                cardYRef.current[slotId] = y;
              }}
              compilation={
                !dirty && spec.interpreter.kind === "scripted"
                  ? compilationBySlot.get(slot.slotId)
                  : undefined
              }
              onChange={(next) => updateCard(slot.slotId, next)}
              roundBased={roundBased}
            />
          );
        })}
        <TournamentCard sessionId={sessionId} onSelectRun={onSelectRun} />
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // The ScrollView needs a bounded height (flex:1 within the sheet body) or it
  // sizes to its content, overflows, and can't scroll — which buried the RunTray
  // launch control as an unreachable sliver at the drawer's edge.
  scrollView: { flex: 1 },
  scroll: { gap: 10, paddingBottom: 24 },
  saveBtn: { alignItems: "center", paddingVertical: 10, borderRadius: 10 },
  saveText: { fontFamily: fonts.semibold, fontSize: 14 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 12,
    gap: 10,
    shadowColor: "#0b1030",
    shadowOffset: { width: 0, height: 3 },
  },
  cardHead: { flexDirection: "row", alignItems: "center", gap: 10 },
  cardTitleWrap: { flex: 1, minWidth: 0 },
  cardTitleRow: { flexDirection: "row", alignItems: "center", gap: 4 },
  cardTitle: { fontFamily: fonts.bold, fontSize: 15 },
  lockGlyph: { fontSize: 11 },
  senses: { fontFamily: fonts.regular, fontSize: 11, marginTop: 1 },
  counter: { flexDirection: "row", alignItems: "center", gap: 6 },
  counterBtn: { width: 30, height: 30, alignItems: "center", justifyContent: "center" },
  counterSign: { fontFamily: fonts.bold, fontSize: 20 },
  count: { fontFamily: fonts.bold, fontSize: 15, minWidth: 20, textAlign: "center" },
  editor: { gap: 6 },
  guidance: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 3,
  },
  guidanceLabel: { fontFamily: fonts.bold, fontSize: 11 },
  guidanceText: { fontFamily: fonts.regular, fontSize: 12.5, lineHeight: 17 },
  promptInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: fonts.regular,
    fontSize: 14,
    minHeight: 96,
    textAlignVertical: "top",
  },
  editorFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  chars: { fontFamily: fonts.regular, fontSize: 10 },
  done: { fontFamily: fonts.semibold, fontSize: 12 },
  preview: { paddingVertical: 2 },
  previewText: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 18 },
  lockedNotice: { gap: 4 },
  lockedExplainer: { fontFamily: fonts.medium, fontSize: 11 },
  compileStatus: { fontFamily: fonts.medium, fontSize: 11 },
  removeArea: { gap: 6 },
  removeSpecies: { fontFamily: fonts.semibold, fontSize: 12 },
  removeHint: { fontFamily: fonts.regular, fontSize: 10.5 },
  badges: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  badgeText: { fontFamily: fonts.medium, fontSize: 11 },
});

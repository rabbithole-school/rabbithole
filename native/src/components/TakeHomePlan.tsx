/**
 * Scholar Prep's take-home lane. This is deliberately a thin native rendering
 * of api.takeHomePlans.forSelf: the backend owns ordering, assignment status,
 * and the suggestion decisions.
 */
import { useEffect, useMemo, useState } from "react";
import { useConvex, useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { useRouter } from "expo-router";
import { Alert, ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";

import { api, type Id } from "@/lib/convex";
import { openWebActivity } from "@/lib/externalAppHost";
import { openGameActivity } from "@/lib/gameHost";
import { webEmbedUrlError } from "@/lib/webEmbedConfig";
import { fonts, useColors } from "@/theme";
import { BookmarkSimpleIcon } from "@/components/BookmarkSimpleIcon";
import { TakeHomePinButton } from "@/components/TakeHomePinButton";
import { DueChip } from "./ui/DueChip";

type Plan = FunctionReturnType<typeof api.takeHomePlans.forSelf>;
type SelectedItem = Plan["selected"][number];
type Suggestion = Plan["suggestions"][number];
export type TakeHomePinning = FunctionReturnType<
  typeof api.takeHomePlans.pinningForSelf
>;
export type TakeHomePin = TakeHomePinning["pins"][number];

export function TakeHomePlan({
  mode = "prep",
  onOpenQuests,
  onTogglePin,
}: {
  mode?: "prep" | "home";
  onOpenQuests?: () => void;
  onTogglePin?: (target: { itemId?: Id<"takeHomePlanItems">; unitId: Id<"units"> | null; sessionId: Id<"sessions"> | null }) => void | Promise<unknown>;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const convex = useConvex();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 60_000) * 60_000);
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 60_000) * 60_000), 60_000);
    return () => clearInterval(timer);
  }, []);
  const raw = useQuery(api.takeHomePlans.forSelf, { now });
  const addSuggestion = useMutation(api.takeHomePlans.addSuggestion);
  const removeItem = useMutation(api.takeHomePlans.removeItem);
  const addNote = useMutation(api.takeHomePlans.addNote);
  const editNote = useMutation(api.takeHomePlans.editNote);
  const setNoteChecked = useMutation(api.takeHomePlans.setNoteChecked);
  const markActivityDone = useMutation(api.takeHomePlans.markActivityDone);
  const undoMarkActivityDone = useMutation(api.takeHomePlans.undoMarkActivityDone);
  const closeQuest = useMutation(api.takeHomePlans.closeQuest);
  const undoCloseQuest = useMutation(api.takeHomePlans.undoCloseQuest);
  const resolveSuggestion = useMutation(api.takeHomePlans.resolveSuggestion);
  const undoResolveSuggestion = useMutation(api.takeHomePlans.undoResolveSuggestion);
  const createSession = useMutation(api.sessions.create);
  const openOfflineHomework = useMutation(api.sessions.openOfflineHomework);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const [editingId, setEditingId] = useState<SelectedItem["id"] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const mutate = async (key: string, action: () => Promise<unknown>) => {
    if (pending) return;
    setPending(key);
    try { await action(); Haptics.selectionAsync().catch(() => {}); }
    catch (error) { console.warn("[take-home-plan]", error); Alert.alert("Couldn't update your list", "Please try again."); }
    finally { setPending(null); }
  };
  const cancelNote = () => {
    setNoteOpen(false);
    setNote("");
    setEditingId(null);
  };
  const saveNote = () => {
    const value = note.trim();
    if (!value) {
      cancelNote();
      return;
    }
    void mutate("note", async () => {
      if (editingId) await editNote({ itemId: editingId, text: value });
      else await addNote({ text: value });
      cancelNote();
    });
  };
  const openAssigned = (item: Plan["assigned"][number]) => {
    void mutate(`assigned:${item.id}`, async () => {
      if (item.activityKind === "offline") {
        const result = await openOfflineHomework({
          activityId: item.activityId,
          assignmentId: item.assignmentId,
        });
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: item.label },
        });
        return;
      }
      if (item.activityKind === "web") {
        let webUrl = item.webUrl;
        let webAllowedHosts = item.webAllowedHosts;
        let externalAppId: Id<"externalApps"> | null = null;
        if (!webUrl) {
          const activity = await convex.query(api.activities.getPublic, {
            id: item.activityId,
          });
          webUrl = activity?.webUrl ?? null;
          webAllowedHosts = activity?.webAllowedHosts ?? null;
          externalAppId = activity?.externalAppId ?? null;
        }
        if (!webUrl) {
          Alert.alert(
            "No website yet",
            "Ask your teacher to add the website URL for this activity.",
          );
          return;
        }
        const urlError = webEmbedUrlError(webUrl);
        if (urlError) {
          Alert.alert("Couldn’t open this activity", urlError);
          return;
        }
        openWebActivity({
          activityId: item.activityId,
          assignmentId: item.assignmentId,
          title: item.label,
          url: webUrl,
          allowedHosts: webAllowedHosts,
          externalAppId,
          gestureMode: "page",
        });
        return;
      }
      if (item.activityKind === "game") {
        openGameActivity({
          activityId: item.activityId,
          assignmentId: item.assignmentId,
          activityTitle: item.label,
        });
        return;
      }
      if (item.activityKind === "problem_set" && item.practiceSkillKey) {
        router.push({
          pathname: "/practice",
          params: { skill: item.practiceSkillKey },
        });
        return;
      }
      const result = await createSession({
        activityId: item.activityId,
        assignmentId: item.assignmentId,
      });
      if (result?.id) {
        router.push({
          pathname: "/session/[id]",
          params: { id: result.id, title: item.label },
        });
      }
    });
  };
  const openSelected = (item: SelectedItem) => {
    if (item.kind === "note" || !item.sessionId) return;
    router.push({
      pathname: "/session/[id]",
      params: { id: item.sessionId, title: item.label },
    });
  };

  if (raw === undefined) {
    return mode === "home"
      ? null
      : <View style={styles.card}><ActivityIndicator color={colors.violet} accessibilityLabel="Loading take-home plan" /></View>;
  }
  const isWeekendPlan = raw.takeHomePeriod === "weekend";
  const planHeading = isWeekendPlan ? "To do this weekend" : "To do tonight";
  const total = raw.assigned.length + raw.selected.length;
  if (mode === "home" && total === 0) {
    return <View style={styles.card}><Text style={styles.homeEmpty}>Nothing due tonight</Text></View>;
  }
  const remaining =
    raw.assigned.length +
    raw.selected.filter((item) => !item.checked).length;
  const remainingLabel =
    total === 0 ? null : remaining === 0 ? "All done" : `${remaining} left`;

  // A checkbox is a 44px control; rows without one only reserve its column
  // when a sibling row actually has one. Reserving it unconditionally punches
  // a visible hole in the card's left edge.
  const anyCheckable = raw.selected.some((item: SelectedItem) =>
    item.actions.some((action: string) =>
      ["setChecked", "markDone", "undoMarkDone", "closeQuest", "undoCloseQuest"].includes(action)));

  return (
    <View style={styles.stack}>
      <View style={styles.card}>
        <View style={styles.headingRow}>
          <View style={styles.headingTitle}><BookmarkSimpleIcon size={20} color={colors.violet} filled /><Text style={styles.heading}>{planHeading}</Text></View>
          {remainingLabel ? <Text style={styles.headingMeta}>{remainingLabel}</Text> : null}
        </View>
        {raw.assigned.length + raw.selected.length === 0 ? <Text style={styles.empty}>Nothing on your list yet. Add a note, or check the ideas below.</Text> : null}
        {raw.assigned.map((item) => {
          // Attribution: what this is and whose it is. Assigned rows are not
          // grouped under a unit band, so they carry their own identity. The
          // deadline is NOT here — it has its own status chip, so an overdue
          // row keeps its unit and teacher instead of losing them.
          const meta = ["Assigned", item.meta, item.teacherName ? `with ${item.teacherName}` : null]
            .filter(Boolean)
            .join(" \u00b7 ");
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`Open ${item.label}`}
              disabled={pending !== null}
              onPress={() => openAssigned(item)}
              style={({ pressed }) => [
                styles.row,
                pressed && styles.rowPressed,
              ]}
            >
              {anyCheckable ? <View style={styles.checkPlaceholder} /> : null}
              {item.unitEmoji ? <Text style={styles.rowGlyph}>{item.unitEmoji}</Text> : null}
              <View style={styles.rowBody}>
                <Text style={styles.title}>{item.label}</Text>
                <Text style={styles.detail}>{meta}</Text>
              </View>
              <DueChip dueAt={item.dueAt} nowMs={now} timeZone={raw.timeZone} />
              <View style={styles.cta}>
                <Text style={styles.ctaText}>Open</Text>
                <Text style={styles.ctaCaret} accessibilityElementsHidden>›</Text>
              </View>
            </Pressable>
          );
        })}
        {raw.selected.map((item: SelectedItem) => (
          <View key={item.id} style={styles.row}>
            {item.actions.some((action: string) => ["setChecked", "markDone", "undoMarkDone", "closeQuest", "undoCloseQuest"].includes(action)) ? <Pressable
              disabled={pending !== null}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: item.checked, disabled: pending !== null }}
              accessibilityLabel={`${item.checked ? "Uncheck" : "Check"} ${item.kind === "note" ? item.text : item.label}`}
              onPress={() => mutate(String(item.id), () => item.kind === "note"
                ? setNoteChecked({ itemId: item.id, checked: !item.checked })
                : item.kind === "activity"
                  ? item.actions.some((action: string) => action === "undoMarkDone") ? undoMarkActivityDone({ itemId: item.id }) : markActivityDone({ itemId: item.id })
                  : item.actions.some((action: string) => action === "undoCloseQuest") ? undoCloseQuest({ itemId: item.id }) : closeQuest({ itemId: item.id }))}
              style={styles.check}
            ><SymbolView name={item.checked ? "checkmark" : "circle"} size={20} tintColor={item.checked ? colors.green : colors.violet} /></Pressable> : anyCheckable ? <View style={styles.checkPlaceholder} /> : null}
            <View style={styles.rowBody}>
              {item.kind !== "note" && item.sessionId ? (
                <Pressable disabled={pending !== null} accessibilityRole="button" accessibilityLabel={`Open ${item.label}`} onPress={() => openSelected(item)} style={styles.titleButton}>
                  <Text style={[styles.title, item.checked && styles.titleDone]}>{item.label}</Text>
                </Pressable>
              ) : (
                <View style={styles.titleButton}>
                  <Text style={[styles.title, item.checked && styles.titleDone]}>{item.kind === "note" ? item.text : item.label}</Text>
                </View>
              )}
              {item.kind !== "note" && item.meta ? <Text style={styles.detail}>{item.meta}</Text> : null}
            </View>
            {item.kind === "note" ? <Text style={styles.origin}>Note</Text> : null}
            {(item.kind !== "note" || item.actions.includes("edit") || item.actions.includes("remove")) ? <View style={styles.iconActions}>
              {item.kind === "note" && item.actions.includes("edit") ? <Pressable disabled={pending !== null} accessibilityRole="button" accessibilityLabel={`Edit ${item.text}`} onPress={() => { setEditingId(item.id); setNote(item.text); setNoteOpen(true); }} style={styles.iconButton}><SymbolView name="pencil" size={17} tintColor={colors.charcoalSubtle} /></Pressable> : null}
              {item.kind === "note" && item.actions.includes("remove") ? <Pressable disabled={pending !== null} accessibilityRole="button" accessibilityLabel={`Remove ${item.text}`} onPress={() => mutate(`remove:${item.id}`, () => removeItem({ itemId: item.id }))} style={styles.iconButton}><SymbolView name="xmark" size={18} tintColor={colors.charcoalMuted} /></Pressable> : null}
              {item.kind !== "note" && onTogglePin ? <TakeHomePinButton selected subject={item.label} busy={pending !== null} onToggle={() => mutate(`remove:${item.id}`, async () => {
                await onTogglePin({ itemId: item.id, unitId: "unitId" in item ? item.unitId ?? null : null, sessionId: "sessionId" in item ? item.sessionId ?? null : null });
              })} /> : null}
            </View> : null}
          </View>
        ))}
        <Pressable disabled={pending !== null} accessibilityRole="button" accessibilityLabel="Add a note" onPress={() => setNoteOpen(true)} style={styles.addRow}>
          <SymbolView name="plus" size={20} tintColor={colors.violet} /><Text style={styles.addText}>Add a note</Text>
        </Pressable>
        {mode === "prep" && onOpenQuests ? <Pressable disabled={pending !== null} accessibilityRole="button" accessibilityLabel="Add a Quest" onPress={onOpenQuests} style={styles.addRow}>
          <SymbolView name="plus" size={20} tintColor={colors.violet} /><Text style={styles.addText}>Add a Quest</Text>
        </Pressable> : null}
      </View>

      {mode === "prep" && raw.suggestions.length > 0 ? <View style={styles.card}>
        <Text style={styles.heading}>Still open from today</Text>
        <Text style={styles.intro}>Rabbithole saw these open. Only you know if they’re finished. You can leave anything you’re not sure about.</Text>
        {raw.suggestions.map((item: Suggestion) => (
          <View key={item.id} style={styles.suggestion}>
            <Text style={styles.source}>{item.kind === "quest" ? "Quest" : "From today's class"}</Text>
            <View style={styles.suggestionTitleRow}>
              {item.kind === "quest" && item.meta ? <Text style={styles.questEmoji} accessibilityElementsHidden>{item.meta}</Text> : null}
              <Text style={[styles.title, styles.suggestionTitle]}>{item.label}</Text>
            </View>
            {item.kind === "activity" && item.meta ? <Text style={styles.detail}>{item.meta}</Text> : null}
            <View style={styles.actions}>
              {item.actions.includes("addToPlan") ? <TakeHomePinButton selected={false} subject={item.label} busy={pending !== null} onToggle={() => mutate(`add:${item.id}`, () => addSuggestion({ suggestion: item.kind === "activity" ? { kind: "activity", sessionId: item.sessionId } : { kind: "quest", unitId: item.unitId } }))} /> : null}
              {item.actions.includes("markDone") ? <Pressable accessibilityRole="button" accessibilityLabel={`I’m finished with ${item.label}`} disabled={pending !== null} onPress={() => mutate(`done:${item.id}`, () => resolveSuggestion({ suggestion: item.kind === "activity" ? { kind: "activity", sessionId: item.sessionId } : { kind: "quest", unitId: item.unitId } }))} style={[styles.action, styles.suggestionAction]}><SymbolView name="checkmark" size={16} tintColor={colors.charcoal} /><Text style={styles.actionText}>Done</Text></Pressable> : null}
            </View>
          </View>
        ))}
      </View> : null}
      {mode === "prep" && raw.resolvedToday.length > 0 ? <View style={styles.card}>
        <Text style={styles.heading}>Marked done</Text>
        {raw.resolvedToday.map((item) => <View key={item.itemId} style={styles.resolvedRow}><Text style={styles.title}>{item.label}</Text>{item.actions.includes("undo") ? <Pressable accessibilityRole="button" accessibilityLabel={`Undo ${item.label}`} onPress={() => mutate(`undo:${item.itemId}`, () => undoResolveSuggestion({ itemId: item.itemId }))} style={styles.action}><Text style={styles.actionText}>Undo</Text></Pressable> : null}</View>)}
      </View> : null}

      <Modal visible={noteOpen} transparent animationType="fade" onRequestClose={cancelNote}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.modalBackdrop}>
        <View style={styles.modal}>
          <Text style={styles.heading}>{editingId ? "Edit note" : "Add a note"}</Text>
          <TextInput autoFocus multiline value={note} onChangeText={setNote} placeholder="What do you want to remember?" placeholderTextColor={colors.charcoalSubtle} style={styles.input} accessibilityLabel="Note" />
          <View style={styles.actions}><Pressable onPress={cancelNote} accessibilityRole="button" accessibilityLabel="Cancel" style={styles.action}><Text style={styles.actionText}>Cancel</Text></Pressable><Pressable onPress={saveNote} accessibilityRole="button" accessibilityLabel="Save" style={[styles.action, styles.actionPrimary]}><Text style={styles.actionPrimaryText}>Save</Text></Pressable></View>
        </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    stack: { width: "100%", gap: 16 },
    card: { width: "100%", backgroundColor: c.bg, borderWidth: 1, borderColor: c.border, borderRadius: 16, padding: 16, gap: 10 },
    headingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 },
    headingTitle: { flexDirection: "row", alignItems: "center", gap: 8 },
    heading: { fontFamily: fonts.bold, fontSize: 18, lineHeight: 25, color: c.charcoal },
    headingMeta: { fontFamily: fonts.semibold, fontSize: 14, color: c.charcoalMuted },
    intro: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: c.charcoalMuted },
    homeEmpty: { fontFamily: fonts.semibold, fontSize: 14, lineHeight: 20, color: c.charcoalMuted, textAlign: "center", paddingVertical: 12 },
    empty: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: c.charcoalMuted, paddingVertical: 8 },
    row: { flexDirection: "row", alignItems: "flex-start", gap: 10, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.gray100, minHeight: 56 },
    rowPressed: { backgroundColor: c.gray100 },
    checkPlaceholder: { width: 44, height: 44 },
    check: { width: 44, height: 44, borderWidth: 2, borderColor: c.violet, borderRadius: 10, alignItems: "center", justifyContent: "center" },
    checkmark: { fontSize: 22, color: c.violet, fontFamily: fonts.bold },
    checkmarkOn: { color: c.green },
    rowBody: { flex: 1, minWidth: 0, gap: 2 },
    titleButton: { minHeight: 44, justifyContent: "center" },
    title: { fontFamily: fonts.semibold, fontSize: 16, lineHeight: 22, color: c.charcoal, flexShrink: 1 },
    titleDone: { textDecorationLine: "line-through", color: c.charcoalMuted },
    detail: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 20, color: c.charcoalMuted },
    rowGlyph: { fontSize: 18, lineHeight: 24, flexShrink: 0 },
    origin: { fontFamily: fonts.semibold, fontSize: 12, color: c.charcoalMuted, paddingTop: 4 },
    cta: { flexDirection: "row", alignItems: "center", gap: 2, flexShrink: 0 },
    ctaText: { fontFamily: fonts.semibold, fontSize: 13, color: c.violet },
    ctaCaret: { fontFamily: fonts.bold, fontSize: 16, lineHeight: 18, color: c.violet },
    iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
    iconActions: { flexDirection: "row", alignItems: "center" },
    remove: { fontSize: 24, color: c.charcoalMuted },
    addRow: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingTop: 8 },
    plus: { fontSize: 24, color: c.violet },
    addText: { fontFamily: fonts.semibold, fontSize: 16, color: c.violet },
    suggestion: { borderTopWidth: 1, borderTopColor: c.gray100, paddingTop: 12, gap: 5 },
    suggestionTitleRow: { flexDirection: "row", alignItems: "baseline", gap: 8 },
    questEmoji: { fontSize: 18, lineHeight: 22 },
    suggestionTitle: { flex: 1 },
    source: { fontFamily: fonts.bold, fontSize: 12, color: c.violet, textTransform: "uppercase", letterSpacing: 0.5 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingTop: 6 },
    action: { minHeight: 44, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: c.border, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
    suggestionAction: { width: 88 },
    actionPrimary: { backgroundColor: c.violetSubtle, borderColor: c.violetMuted },
    actionText: { fontFamily: fonts.semibold, fontSize: 14, color: c.charcoal },
    actionPrimaryText: { fontFamily: fonts.semibold, fontSize: 14, color: c.violet },
    resolvedRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 52 },
    modalBackdrop: { flex: 1, justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.35)" },
    modal: { backgroundColor: c.bg, borderRadius: 18, padding: 20, gap: 14 },
    input: { minHeight: 110, borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, color: c.charcoal, fontFamily: fonts.regular, fontSize: 16, textAlignVertical: "top" },
  });
}

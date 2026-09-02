import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { api } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import { AppTextInput } from "@/components/AppTextInput";

/**
 * WeeklyGoalsCard (native) — the scholar's own weekly-goal surface on the
 * iPad "My Learning" screen. Mirrors the web MyWeeklyGoalsCard: a small,
 * PRIVATE weekly commitment the kid sets — it's ACTIVE the moment they set it
 * (no teacher approval gate; they own the loop end-to-end) — that they track and
 * close out with "Did it" / "Not yet" + an optional one-line reflection. (A
 * teacher can also SUGGEST a goal, which the scholar chooses whether to take on.)
 *
 * Quiet + plain: no streaks, no scores, no peer comparison. "Not yet" is fine.
 * The mark-done moment and the practice-movement "look at this" nudge are both
 * portrait-voiced, never a trophy.
 */

// Enriched by the query with a per-goal `movement` field (null unless an active
// goal's subject shows demonstrated practice movement).
type WeeklyGoal = NonNullable<
  ReturnType<typeof useQuery<typeof api.weeklyGoals.myGoals>>
>["current"][number];

/**
 * Pull the human sentence out of a Convex mutation error (cap / auth /
 * validation) so a failed write shows a real reason, not a dead tap — parity
 * with the web card's toaster. Convex wraps a thrown `Error` as
 * "…Uncaught Error: <message>…"; surface just that clause when present.
 */
function errorMessage(e: unknown): string {
  if (e instanceof Error && e.message) {
    const m = e.message.match(/Uncaught Error:\s*(.+?)(?:\n|$)/);
    return (m?.[1] ?? e.message).trim();
  }
  return "Please try again.";
}

const STATUS_LABEL: Record<WeeklyGoal["status"], string> = {
  proposed: "Waiting to start",
  active: "This week",
  met: "Did it",
  not_yet: "Not yet — that's okay",
  archived: "Archived",
};

export default function WeeklyGoalsCard() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const data = useQuery(api.weeklyGoals.myGoals, {});
  const create = useMutation(api.weeklyGoals.create);

  const [text, setText] = useState("");
  const [strategy, setStrategy] = useState("");
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);

  const current = data?.current ?? [];
  const atCap = current.length >= 3;

  const handleCreate = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSaving(true);
    try {
      await create({ text: trimmed, strategy: strategy.trim() || undefined });
      setText("");
      setStrategy("");
      setAdding(false);
    } catch (e) {
      // Keep the typed text so the scholar can fix + retry.
      Alert.alert("Couldn't save that", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <View>
      <View style={styles.headerRow}>
        <Text style={styles.sectionLabel}>MY GOALS THIS WEEK</Text>
        {!adding && !atCap && (
          <Pressable onPress={() => setAdding(true)} hitSlop={8}>
            <Text style={styles.addLink}>+ set a goal</Text>
          </Pressable>
        )}
      </View>

      {data === undefined ? (
        <ActivityIndicator color={colors.violet} style={{ marginVertical: 16 }} />
      ) : (
        <View style={{ gap: 10 }}>
          {adding && (
            <View style={styles.formCard}>
              <AppTextInput
                style={styles.input}
                value={text}
                onChangeText={setText}
                placeholder="What do you want to get better at this week?"
                placeholderTextColor={colors.charcoalSubtle}
                multiline
              />
              <AppTextInput
                style={styles.input}
                value={strategy}
                onChangeText={setStrategy}
                placeholder="How will you try? (optional)"
                placeholderTextColor={colors.charcoalSubtle}
              />
              <View style={styles.btnRow}>
                <Pressable
                  onPress={handleCreate}
                  disabled={saving || !text.trim()}
                  style={[styles.primaryBtn, (saving || !text.trim()) && { opacity: 0.5 }]}
                >
                  {saving ? (
                    <ActivityIndicator color={colors.white} size="small" />
                  ) : (
                    <Text style={styles.primaryBtnText}>Set this goal</Text>
                  )}
                </Pressable>
                <Pressable
                  onPress={() => {
                    setAdding(false);
                    setText("");
                    setStrategy("");
                  }}
                  style={styles.ghostBtn}
                >
                  <Text style={styles.ghostBtnText}>Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}

          {current.length === 0 && !adding && (
            <Text style={styles.empty}>
              Nothing set yet. What&apos;s one thing you want to get better at this week?
            </Text>
          )}

          {current.map((goal) => (
            <WeeklyGoalItem key={goal._id} goal={goal} colors={colors} styles={styles} />
          ))}
        </View>
      )}
    </View>
  );
}

function WeeklyGoalItem({
  goal,
  colors,
  styles,
}: {
  goal: WeeklyGoal;
  colors: ReturnType<typeof useColors>;
  styles: ReturnType<typeof makeStyles>;
}) {
  const accept = useMutation(api.weeklyGoals.accept);
  const setOutcome = useMutation(api.weeklyGoals.setOutcome);
  const [reflection, setReflection] = useState("");
  const [busy, setBusy] = useState(false);

  const pillColor =
    goal.status === "met"
      ? colors.green
      : goal.status === "active"
        ? colors.violet
        : goal.status === "not_yet"
          ? colors.cyan
          : colors.orange;

  const run = async (fn: () => Promise<unknown>, failTitle: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      Alert.alert(failTitle, errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.goalCard}>
      <View style={styles.goalTop}>
        <Text style={styles.goalText}>{goal.text}</Text>
        <View style={[styles.pill, { backgroundColor: pillColor }]}>
          <Text style={styles.pillText}>{STATUS_LABEL[goal.status]}</Text>
        </View>
      </View>
      {goal.strategy ? <Text style={styles.plan}>My plan: {goal.strategy}</Text> : null}

      {goal.status === "proposed" && goal.source === "teacher" && (
        <View>
          {goal.teacherNote ? (
            <Text style={styles.teacherNote}>&quot;{goal.teacherNote}&quot; — your teacher</Text>
          ) : null}
          <Pressable
            onPress={() => run(() => accept({ goalId: goal._id }), "Couldn't accept that")}
            disabled={busy}
            style={[styles.primaryBtn, styles.selfStart, busy && { opacity: 0.5 }]}
          >
            <Text style={styles.primaryBtnText}>I&apos;ll take it on</Text>
          </Pressable>
        </View>
      )}

      {goal.status === "active" && (
        <View style={{ gap: 8 }}>
          {goal.movement && goal.movement.skills.length > 0 ? (
            <View style={styles.movementCard}>
              <Text style={styles.movementText}>
                Something to notice: your practice shows real movement in{" "}
                {formatSkillList(goal.movement.skills)}. If that feels like this
                goal, you can mark it done.
              </Text>
            </View>
          ) : null}
          <AppTextInput
            style={styles.input}
            value={reflection}
            onChangeText={setReflection}
            placeholder="How did it go? (optional)"
            placeholderTextColor={colors.charcoalSubtle}
          />
          <View style={styles.btnRow}>
            <Pressable
              onPress={() =>
                run(
                  () =>
                    setOutcome({
                      goalId: goal._id,
                      outcome: "met",
                      reflection: reflection.trim() || undefined,
                    }),
                  "Couldn't save that",
                )
              }
              disabled={busy}
              style={[styles.primaryBtn, { backgroundColor: colors.green }, busy && { opacity: 0.5 }]}
            >
              <Text style={styles.primaryBtnText}>Did it</Text>
            </Pressable>
            <Pressable
              onPress={() =>
                run(
                  () =>
                    setOutcome({
                      goalId: goal._id,
                      outcome: "not_yet",
                      reflection: reflection.trim() || undefined,
                    }),
                  "Couldn't save that",
                )
              }
              disabled={busy}
              style={styles.ghostBtn}
            >
              <Text style={styles.ghostBtnText}>Not yet</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/* A goal the scholar marked done gets a quiet, portrait-voiced moment —
          no confetti, no streak, no score. Just: you set this and you did it. */}
      {goal.status === "met" ? (
        <View style={styles.metCard}>
          <Text style={styles.metText}>
            You set this goal yourself and saw it through. That&apos;s yours to keep.
          </Text>
        </View>
      ) : null}

      {(goal.status === "met" || goal.status === "not_yet") && goal.reflection ? (
        <Text style={styles.reflection}>{goal.reflection}</Text>
      ) : null}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      marginTop: 18,
      marginBottom: 2,
    },
    sectionLabel: {
      color: c.charcoalSubtle,
      fontSize: 12.5,
      letterSpacing: 1.2,
      fontFamily: fonts.bold,
      marginLeft: 4,
    },
    addLink: { color: c.violet, fontSize: 14, fontFamily: fonts.semibold },
    empty: {
      color: c.fgMuted,
      fontSize: 16,
      fontFamily: fonts.regular,
      paddingVertical: 8,
      marginLeft: 4,
    },
    formCard: {
      backgroundColor: c.violetSubtle,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 14,
      gap: 8,
    },
    goalCard: {
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 16,
      gap: 8,
    },
    goalTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
    goalText: { flex: 1, fontSize: 16, fontFamily: fonts.semibold, color: c.navy },
    plan: { fontSize: 13, fontFamily: fonts.regular, color: c.charcoalMuted },
    teacherNote: {
      fontSize: 13,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      fontStyle: "italic",
      marginBottom: 6,
    },
    reflection: {
      fontSize: 14,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
      fontStyle: "italic",
    },
    metCard: {
      backgroundColor: c.violetSubtle,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.green,
      padding: 12,
    },
    metText: {
      fontSize: 14.5,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
    },
    movementCard: {
      backgroundColor: c.violetSubtle,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.violet,
      padding: 12,
    },
    movementText: {
      fontSize: 14.5,
      lineHeight: 20,
      fontFamily: fonts.regular,
      color: c.charcoalMuted,
    },
    pill: { borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
    pillText: { color: c.white, fontSize: 11, fontFamily: fonts.bold },
    input: {
      backgroundColor: c.bg,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: c.border,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      fontFamily: fonts.regular,
      color: c.fg,
    },
    btnRow: { flexDirection: "row", alignItems: "center", gap: 10 },
    selfStart: { alignSelf: "flex-start" },
    primaryBtn: {
      backgroundColor: c.violet,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    primaryBtnText: { color: c.white, fontSize: 14, fontFamily: fonts.semibold },
    ghostBtn: {
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
    },
    ghostBtnText: { color: c.charcoalMuted, fontSize: 14, fontFamily: fonts.semibold },
  });
}

/** Join skill labels into a gentle phrase: "A", "A and B", "A, B, and C". */
function formatSkillList(skills: string[]): string {
  if (skills.length === 1) return skills[0];
  if (skills.length === 2) return `${skills[0]} and ${skills[1]}`;
  return `${skills.slice(0, -1).join(", ")}, and ${skills[skills.length - 1]}`;
}

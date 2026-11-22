import { Pressable, StyleSheet, Text, View } from "react-native";

import { fonts, useColors } from "@/theme";

/**
 * The world's rules, shown INLINE in the builder chat whenever a thing's rules
 * are created or changed. The app publishes its rules in APP STATE as `rules`
 * (prompts.ts SCHOLAR_RULES_STEERING): one entry per rule with the thing it
 * belongs to, its name, its value, and who set it ("guess" = the builder
 * picked it, "scholar" = theirs). A chip only points at the rules: tapping it
 * opens the thing's own card in the app, the one place they are changed.
 */
export type WorldRule = {
  thing: string;
  name: string;
  value: string;
  by: "guess" | "scholar";
};

export type RuleChange = "new" | "changed" | null;

/** One chip: a thing's rules at the moment they were created/changed. */
export type RuleCardEvent = {
  key: string;
  /** The chat message this chip follows; null = after the whole thread. */
  afterMessageId: string | null;
  thing: string;
  kind: "new" | "updated" | "current";
  rules: Array<WorldRule & { change: RuleChange }>;
};

const OTHER_THING = "Your world";

function valueText(value: unknown): string | null {
  if (typeof value === "string") {
    const text = value.trim();
    if (/^infinity$/i.test(text) || text === "∞") return "∞";
    if (/^-infinity$/i.test(text) || text === "-∞") return "−∞";
    return text || null;
  }
  // A huge number is how an app says "never" / "forever": show it as ∞.
  if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) >= 1e9)) {
    return Number.isNaN(value) ? null : value < 0 ? "−∞" : "∞";
  }
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "on" : "off";
  return null;
}

/** The `rules` array in a saved app-state doc, cleaned. Never throws. */
export function parseWorldRules(doc: unknown): WorldRule[] {
  if (!doc || typeof doc !== "object") return [];
  const raw = (doc as { rules?: unknown }).rules;
  if (!Array.isArray(raw)) return [];
  const out: WorldRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = valueText(e.name);
    const value = valueText(e.value);
    if (!name || value == null) continue;
    const thing =
      valueText(e.thing) ?? valueText(e.group) ?? valueText(e.owner) ?? OTHER_THING;
    out.push({ thing, name, value, by: e.by === "scholar" ? "scholar" : "guess" });
  }
  return out;
}

function ruleKey(rule: Pick<WorldRule, "thing" | "name">): string {
  return `${rule.thing}\u0000${rule.name}`;
}

/** Group rules by thing, keeping the order things first appear. */
export function byThing(rules: WorldRule[]): Map<string, WorldRule[]> {
  const groups = new Map<string, WorldRule[]>();
  for (const rule of rules) {
    const list = groups.get(rule.thing) ?? [];
    list.push(rule);
    groups.set(rule.thing, list);
  }
  return groups;
}

/**
 * The chips a change from `prev` to `next` earns: one per thing with a new or
 * changed rule (value or owner). `prev === null` is the first look at this
 * app: every thing gets a "current" chip so the thread starts with the world's
 * laws on record.
 */
export function ruleCardEvents(
  prev: WorldRule[] | null,
  next: WorldRule[],
  afterMessageId: string | null,
  stamp: string,
): RuleCardEvent[] {
  const before = new Map((prev ?? []).map((r) => [ruleKey(r), r]));
  const events: RuleCardEvent[] = [];
  for (const [thing, rules] of byThing(next)) {
    const marked = rules.map((rule) => {
      const old = before.get(ruleKey(rule));
      const change: RuleChange = !prev
        ? null
        : !old
          ? "new"
          : old.value !== rule.value || old.by !== rule.by
            ? "changed"
            : null;
      return { ...rule, change };
    });
    const touched = marked.some((r) => r.change);
    if (prev && !touched) continue;
    const allNew = !!prev && marked.every((r) => r.change === "new");
    events.push({
      key: `${stamp}:${thing}`,
      afterMessageId,
      thing,
      kind: !prev ? "current" : allNew ? "new" : "updated",
      rules: marked,
    });
  }
  return events;
}

const KIND_TAG: Record<RuleCardEvent["kind"], string | null> = {
  new: "new",
  updated: "changed",
  current: null,
};

/** "Green light 6" for one changed rule, else "3 rules". */
function chipSummary(event: RuleCardEvent): string {
  const changed = event.rules.filter((r) => r.change);
  if (changed.length === 1) return `${changed[0].name} ${changed[0].value}`;
  const n = changed.length || event.rules.length;
  return n === 1 ? `${event.rules[0].name} ${event.rules[0].value}` : `${n} rules`;
}

/**
 * The chips after one chat message: small, wrapping onto more lines when
 * several things changed at once. A tap opens that thing's own rule card in
 * the app (CodeArtifactWebView.openRuleCard), so the rules keep one editable
 * home.
 */
export function RuleChips({
  events,
  onOpen,
}: {
  events: RuleCardEvent[];
  onOpen: (thing: string) => void;
}) {
  const colors = useColors();
  if (!events.length) return null;
  return (
    <View style={styles.row}>
      {events.map((event) => {
        const tag = KIND_TAG[event.kind];
        const summary = chipSummary(event);
        return (
          <Pressable
            key={event.key}
            onPress={() => onOpen(event.thing)}
            accessibilityRole="button"
            accessibilityLabel={`${event.thing} rules${tag ? `, ${tag}` : ""}: ${summary}. Opens its card.`}
            hitSlop={4}
            style={({ pressed }) => [
              styles.chip,
              {
                borderColor: colors.violetMuted,
                backgroundColor: colors.violetSubtle,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Text style={[styles.thing, { color: colors.violetSolid }]} numberOfLines={1}>
              {event.thing}
            </Text>
            <Text style={[styles.summary, { color: colors.fg }]} numberOfLines={1}>
              {summary}
            </Text>
            {tag ? (
              <Text style={[styles.tag, { color: colors.fgMuted }]}>{tag}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginHorizontal: 4 },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    maxWidth: 320,
  },
  thing: { fontFamily: fonts.semibold, fontSize: 13 },
  summary: { fontFamily: fonts.regular, fontSize: 13, flexShrink: 1 },
  tag: { fontFamily: fonts.medium, fontSize: 11 },
});

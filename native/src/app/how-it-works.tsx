import { useMemo } from "react";
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SymbolView, type SymbolViewProps } from "expo-symbols";

import { fonts, useColors } from "@/theme";
import { KID_SAFE_PRINCIPLES } from "@/lib/kidSafePrinciples";

let promptSourceBase = "https://github.com/rabbithole-school/rabbithole/blob/main";

const PROMPT_SOURCES = [
  {
    label: "Tutor rules",
    url: `${promptSourceBase}/convex/prompts.ts`,
  },
  {
    label: "Reflection + Ask rules",
    url: `${promptSourceBase}/convex/metaPrompts.ts`,
  },
] as const;

// How it works — the scholar-facing transparency page. Parity with the web
// /how-it-works: explain, in plain language, what the tutor is and how it's
// built to make you think MORE, not less. (The web page also links the
// published system prompts on GitHub — kept here as a closing note.)

const POINTS: {
  icon: SymbolViewProps["name"];
  title: string;
  body: string;
}[] = [
  {
    icon: "brain.head.profile",
    title: "It's an AI, and it tells you so",
    body: "Your tutor is a computer program (a large language model), not a person. It will never pretend to be your friend or have feelings — it's a thinking tool, on your side.",
  },
  {
    icon: "questionmark.bubble",
    title: "It asks more than it answers",
    body: "Instead of handing you the answer, it asks better questions and gives you time to think. That's on purpose — the struggle is where the learning happens.",
  },
  {
    icon: "sparkles",
    title: "It follows your curiosity",
    body: "When you get curious about something, it helps you chase that thread — even across subjects. Your map fills with the ideas you've explored.",
  },
  {
    icon: "person.2.fill",
    title: "Your teacher is in the loop",
    body: "Your teacher sets up your activities and can see your work. A clear learning insight you share in Today's reflection can become part of your portrait too. Ask Rabbithole is different: that conversation never becomes portrait evidence.",
  },
  {
    icon: "lock.open",
    title: "Nothing is hidden",
    body: "The exact instructions your tutor follows are published openly. Rabbithole is open-source — anyone can read how it works, including you and your family.",
  },
];

export default function HowItWorksScreen() {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  return (
    <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
      <Text style={styles.lede}>
        Rabbithole&apos;s tutor is built to make you think{" "}
        <Text style={styles.ledeEm}>more</Text>, not less. Here&apos;s how.
      </Text>

      {POINTS.map((p) => (
        <View
          key={p.title}
          style={styles.card}
          accessible
          accessibilityLabel={`${p.title}. ${p.body}`}
        >
          <View style={styles.iconWrap} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <SymbolView name={p.icon} size={24} tintColor={colors.violet} />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.title}>{p.title}</Text>
            <Text style={styles.body}>{p.body}</Text>
          </View>
        </View>
      ))}

      {/* ── A peek behind the curtain ───────────────────────────────────────
          Kid-safe, static gloss on the rules the tutor follows. Parity with
          the web BehindTheCurtain component (components/BehindTheCurtain.tsx)
          + lib/kidSafePrinciples.ts. Never render assembled prompts or anything
          from the governed learning record here. */}
      <View style={styles.curtainSection}>
        <View style={styles.curtainHeader}>
          <SymbolView
            name="checklist"
            size={20}
            tintColor={colors.navy}
          />
          <Text style={styles.curtainHeading}>The kinds of rules Rabbithole follows</Text>
        </View>
        <Text style={styles.curtainLede}>
          Here&apos;s the short version: the AI is supposed to help you do the thinking, not do it for you.
        </Text>

        <View accessibilityRole="list">
          {KID_SAFE_PRINCIPLES.map((p) => (
            <View
              key={p.title}
              style={styles.principleRow}
              accessible
              accessibilityLabel={`${p.title}: ${p.blurb}`}
            >
              <View
                style={styles.principleDot}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
              />
              <Text style={styles.principleText}>
                <Text style={styles.principleTitle}>{p.title}: </Text>
                {p.blurb}
              </Text>
            </View>
          ))}
        </View>
      </View>

      <Text style={styles.footer}>
        None of this is a secret. The exact instructions Rabbithole gives the AI
        are posted publicly on GitHub — anyone can read them, including you and
        your family.
      </Text>
      <View style={styles.sourceLinks}>
        {PROMPT_SOURCES.map((source) => (
          <Pressable
            key={source.url}
            accessibilityRole="link"
            onPress={() => void Linking.openURL(source.url)}
            style={({ pressed }) => [
              styles.sourceLink,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Text style={styles.sourceLinkText}>{source.label} ↗</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
  flex: { flex: 1, backgroundColor: c.bgSubtle },
  content: { width: "100%", maxWidth: 640, alignSelf: "center", padding: 24 },
  lede: {
    fontSize: 21,
    lineHeight: 30,
    fontFamily: fonts.semibold,
    color: c.navy,
    marginBottom: 22,
  },
  ledeEm: { fontFamily: fonts.bold, color: c.violet },
  card: {
    flexDirection: "row",
    gap: 15,
    backgroundColor: c.bg,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    padding: 18,
    marginBottom: 14,
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    backgroundColor: c.violetSubtle,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 17, fontFamily: fonts.bold, color: c.navy, marginBottom: 5 },
  body: { fontSize: 15, lineHeight: 22, fontFamily: fonts.regular, color: c.charcoalMuted },
  footer: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.regular,
    color: c.charcoalSubtle,
    textAlign: "center",
    marginTop: 12,
    paddingHorizontal: 10,
  },
  sourceLinks: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 10,
    marginTop: 14,
  },
  sourceLink: {
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: 12,
    backgroundColor: c.bg,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  sourceLinkText: {
    color: c.navy,
    fontFamily: fonts.semibold,
    fontSize: 14,
  },
  curtainSection: {
    backgroundColor: c.bg,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: c.border,
    padding: 18,
    marginBottom: 14,
  },
  curtainHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  curtainHeading: {
    fontSize: 15,
    fontFamily: fonts.bold,
    color: c.navy,
    flex: 1,
    flexShrink: 1,
  },
  curtainLede: {
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
    marginBottom: 14,
  },
  principleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 10,
  },
  principleDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: c.violet,
    marginTop: 7,
    flexShrink: 0,
  },
  principleText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 21,
    fontFamily: fonts.regular,
    color: c.charcoalMuted,
  },
  principleTitle: {
    fontFamily: fonts.bold,
    color: c.navy,
  },
});}

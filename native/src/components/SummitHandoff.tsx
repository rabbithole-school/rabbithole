/**
 * Native SummitHandoff — the RN analogue of web
 * `components/practice/SummitHandoff.tsx` (Stage 2 / roadmap D5). Rendered when
 * the practice queue is empty, it reads the scholar's per-domain progress and
 * picks one of three honest states:
 *   • domain EXHAUSTED (every skill demonstrated) → a summit celebration, optional
 *     Go Deeper work in-domain when available, and a switcher for already-started domains.
 *   • access-complete but not exhausted → a quiet "placed through" handoff.
 *   • merely caught up (locked skills remain) → the gentle "check back later"
 *     copy, still with a switcher to any other started domain.
 *
 * Backed by the SAME read as web — `api.practiceSkills.domainsForScholar`.
 * Switching routes HOME with `?highlightDomain=` (router.replace) — the
 * scholar-home CHOOSER with that domain's tile preselected, never straight
 * into practice (raise-the-ceiling consolidation, f7: the summit hand-off is
 * a REDIRECT into the existing "You Pick" chooser, not its own destination).
 *
 * ⚠️ KID-FACING COPY (Andy/Opus review-gated) — kept verbatim in sync with the
 * web component's first-pass wording; pride + curiosity pull, never deficit.
 *
 * NOTE: native runtime is NOT verified in this environment (no simulator) —
 * flagged as human follow-up.
 */

import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";

import { api, type Id } from "@/lib/convex";
import { fonts, useColors, type Colors } from "@/theme";
import { selectSummitHandoff, selectMixedSummitHandoff } from "../../vendor/shared/practiceSummit";

export function SummitHandoff({
  scholarId,
  domain,
  domains: domainSet,
}: {
  scholarId: Id<"users">;
  /** The session's effective domain (undefined ⇒ the default, first-listed). */
  domain: string | undefined;
  /** A MIXED playlist's blended domain set (≥2). When present the empty queue
   *  means EVERY blended domain is caught-up/summited → playlist-level handoff. */
  domains?: string[];
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const domains = useQuery(api.practiceSkills.domainsForScholar, { scholarId });

  const switchTo = (d: string) =>
    router.replace({ pathname: "/", params: { highlightDomain: d } });

  // Until the read resolves, keep the original gentle empty-state copy so there
  // is no celebratory flash before we know whether this is a real summit.
  if (domains === undefined) {
    return (
      <View style={styles.card}>
        <CaughtUpText styles={styles} />
      </View>
    );
  }

  // ── MIXED playlist: the queue emptied across a blend of domains. ──
  if (domainSet && domainSet.length > 1) {
    const { domainsInSet, allExhausted, allPlacedThrough, switchable } = selectMixedSummitHandoff(
      domains,
      domainSet,
    );
    return (
      <View style={styles.card}>
        {allExhausted ? (
          <>
            <Text style={styles.title}>
              🏔️ You&apos;ve topped out every subject in this playlist!
            </Text>
            <Text style={styles.body}>
              {domainsInSet.map((d) => d.label).join(" · ")} — all fluent.
              {" "}If more Go Deeper problems are available, you can keep
              exploring here. Your teacher will choose when it&apos;s time for a
              new primary domain.
            </Text>
          </>
        ) : allPlacedThrough ? (
          <>
            <Text style={styles.title}>
              Placed through every subject in this playlist 🗺️
            </Text>
            <Text style={styles.body}>
              Every subject now grants access, through practice or placement.
              Nothing&apos;s due right now. Reviews will bring placed skills back a
              few at a time.
            </Text>
          </>
        ) : (
          <CaughtUpText styles={styles} />
        )}

        {switchable.length > 0 && (
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>Switch focus</Text>
            <View style={styles.pillWrap}>
              {switchable.map((d) => (
                <Pressable
                  key={d.domain}
                  onPress={() => switchTo(d.domain)}
                  style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
                >
                  <Text style={styles.pillText}>
                    {d.label}
                    {d.exhausted ? "  ✓" : ""}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}

        <Pressable onPress={() => router.back()} style={styles.linkBtn}>
          <Text style={styles.linkBtnText}>Back home</Text>
        </Pressable>
      </View>
    );
  }

  const { current, switchable, isSummit, placedThrough } = selectSummitHandoff(
    domains,
    domain,
  );

  return (
    <View style={styles.card}>
      {isSummit ? (
        <>
          <Text style={styles.title}>
            🏔️ You&apos;ve reached the summit of {current!.label}!
          </Text>
          <Text style={styles.body}>
            Every skill here is fluent — you&apos;ve climbed the whole mountain.
            {" "}If more Go Deeper problems are available, you can keep
            exploring here. Your teacher will choose when it&apos;s time for a
            new primary domain.
          </Text>
        </>
      ) : placedThrough ? (
        <>
          <Text style={styles.title}>
            Placed through all of {current!.label} 🗺️
          </Text>
          <Text style={styles.body}>
            Nothing&apos;s due right now. Skills marked as placed become fluent
            as you demonstrate them in practice. Reviews will bring them back a
            few at a time.
          </Text>
        </>
      ) : (
        <CaughtUpText styles={styles} />
      )}

      {switchable.length > 0 && (
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Switch focus</Text>
          <View style={styles.pillWrap}>
            {switchable.map((d) => (
              <Pressable
                key={d.domain}
                onPress={() => switchTo(d.domain)}
                style={({ pressed }) => [styles.pill, pressed && { opacity: 0.7 }]}
              >
                <Text style={styles.pillText}>
                  {d.label}
                  {d.exhausted ? "  ✓" : ""}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      <Pressable onPress={() => router.back()} style={styles.linkBtn}>
        <Text style={styles.linkBtnText}>Back home</Text>
      </Pressable>
    </View>
  );
}

function CaughtUpText({ styles }: { styles: ReturnType<typeof makeStyles> }) {
  return (
    <>
      <Text style={styles.title}>Nothing to practice right now 🎉</Text>
      <Text style={styles.body}>
        You&apos;re caught up on everything that&apos;s unlocked. Check back later
        as new skills open up.
      </Text>
    </>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    card: {
      width: "100%",
      maxWidth: 420,
      backgroundColor: c.bg,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: c.border,
      padding: 22,
      gap: 12,
      alignItems: "center",
    },
    title: { fontFamily: fonts.bold, fontSize: 19, color: c.fg, textAlign: "center" },
    body: {
      fontFamily: fonts.regular,
      fontSize: 14.5,
      lineHeight: 21,
      color: c.fgMuted,
      textAlign: "center",
    },
    primaryBtn: {
      minHeight: 52,
      borderRadius: 12,
      backgroundColor: c.navy,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 22,
      alignSelf: "stretch",
    },
    primaryBtnText: { fontFamily: fonts.bold, fontSize: 16, color: c.white },
    switchRow: {
      alignSelf: "stretch",
      borderTopWidth: 1,
      borderTopColor: c.border,
      paddingTop: 14,
      marginTop: 2,
      gap: 8,
      alignItems: "center",
    },
    switchLabel: {
      fontFamily: fonts.semibold,
      fontSize: 12,
      letterSpacing: 0.6,
      textTransform: "uppercase",
      color: c.fgMuted,
    },
    pillWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
    pill: {
      minHeight: 40,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.gray50,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 14,
    },
    pillText: { fontFamily: fonts.semibold, fontSize: 14, color: c.navy },
    linkBtn: { alignItems: "center", justifyContent: "center", paddingVertical: 6 },
    linkBtnText: { fontFamily: fonts.semibold, fontSize: 14, color: c.fgMuted },
  });
}

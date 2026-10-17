/**
 * AppCard — a session's live app as ONE card in the chat-primary work panel
 * (TRA-519, "one app surface"). Title · "Version N" · Open, over the running
 * app. It replaces the Preview/Code toggle the panel used to carry for a code
 * artifact: the source, History and the rest of the builder live behind Open,
 * which shows the full-screen builder for THIS SAME session
 * (`/session/[id]?view=builder`).
 *
 * The preview stays the canonical native HTML host (CodeArtifactWebView), live
 * and interactive, so the app's state, askTutor, snapshot capture and
 * `run_app_action` keep working in the chat view exactly as before. The web
 * twin is components/AppCard.tsx.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { api, type Doc, type Id } from "@/lib/convex";
import { fonts, useColors } from "@/theme";
import {
  CodeArtifactWebView,
  type CodeArtifactWebViewHandle,
} from "@/components/CodeArtifactWebView";
import type { AppTutorRequest } from "../../vendor/shared/appTutorRequest";
import { APP_SURFACE_COPY } from "../../vendor/shared/appSurface";
import { revisionsForApp } from "../../vendor/vibecode/helpers";

/** The newest version number, or null when no version has been saved yet. */
export function latestVersion(
  revisions: readonly { version: number }[] | undefined,
): number | null {
  if (!revisions || revisions.length === 0) return null;
  return revisions.reduce((max, rev) => Math.max(max, rev.version), 0);
}

export function AppCard({
  sessionId,
  artifact,
  codeArtifactRef,
  onAskTutor,
  onAppAiTurn,
  appAiEnabled,
}: {
  sessionId: Id<"sessions">;
  artifact: Doc<"artifacts">;
  codeArtifactRef?: React.Ref<CodeArtifactWebViewHandle>;
  onAskTutor?: (request: AppTutorRequest) => void | Promise<void>;
  /** A character exchange or judgment finished in the app (→ tutor queue). */
  onAppAiTurn?: () => void;
  /** False for a non-owner viewer: the app's character/judges answer
   *  `unavailable` without a server call. */
  appAiEnabled?: boolean;
}) {
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);
  const router = useRouter();
  const revisions = useQuery(api.codeArtifactRevisions.listForSession, {
    sessionId,
  });
  // The newest of THIS app's versions (the builder's History lists the same).
  const version = latestVersion(revisionsForApp(revisions, artifact._id));
  const title = artifact.title || "Your app";
  const isEmpty = (artifact.content ?? "").trim() === "";

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {title}
          </Text>
          {version !== null ? (
            <Text style={styles.version}>
              {` · ${APP_SURFACE_COPY.version(version)}`}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            // Name this app, so an older app opens itself, not the newest.
            router.setParams({ view: "builder", app: artifact._id });
          }}
          style={({ pressed }) => [styles.openBtn, pressed && styles.openBtnPressed]}
          accessibilityRole="button"
          accessibilityLabel={`${APP_SURFACE_COPY.open} ${title}`}
        >
          <Text style={styles.openText}>{APP_SURFACE_COPY.open}</Text>
          <SymbolView
            name="arrow.up.left.and.arrow.down.right"
            size={13}
            tintColor={colors.white}
          />
        </Pressable>
      </View>

      {isEmpty ? (
        <View style={styles.empty}>
          <SymbolView
            name="chevron.left.forwardslash.chevron.right"
            size={28}
            tintColor={colors.violet}
          />
          <Text style={styles.emptyTitle}>Nothing here yet</Text>
          <Text style={styles.emptyHint}>
            Build your app with your tutor — it will show up here.
          </Text>
        </View>
      ) : (
        <View style={styles.previewFrame}>
          <CodeArtifactWebView
            ref={codeArtifactRef}
            key={artifact._id}
            scope={{ kind: "session", artifactId: artifact._id }}
            content={artifact.content ?? ""}
            onAskTutor={onAskTutor}
            onAppAiTurn={onAppAiTurn}
            appAiEnabled={appAiEnabled}
          />
        </View>
      )}
    </View>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    // One white surface with even borders (visual-design.md).
    card: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      backgroundColor: c.white,
      overflow: "hidden",
    },
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    headerText: {
      flex: 1,
      flexDirection: "row",
      alignItems: "baseline",
    },
    title: {
      flexShrink: 1,
      fontFamily: fonts.semibold,
      fontSize: 15,
      color: c.charcoal,
    },
    version: {
      fontFamily: fonts.medium,
      fontSize: 13,
      color: c.charcoalMuted,
    },
    openBtn: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      minHeight: 44,
      paddingHorizontal: 16,
      borderRadius: 999,
      backgroundColor: c.violetSolid,
    },
    openBtnPressed: {
      opacity: 0.82,
    },
    openText: {
      fontFamily: fonts.semibold,
      fontSize: 14,
      color: c.white,
    },
    previewFrame: {
      height: 460,
      backgroundColor: c.white,
    },
    empty: {
      alignItems: "center",
      paddingVertical: 40,
      paddingHorizontal: 16,
      gap: 8,
      backgroundColor: c.white,
    },
    emptyTitle: {
      fontFamily: fonts.semibold,
      fontSize: 16,
      color: c.charcoal,
    },
    emptyHint: {
      fontFamily: fonts.regular,
      fontSize: 14,
      lineHeight: 20,
      textAlign: "center",
      color: c.charcoalMuted,
    },
  });
}

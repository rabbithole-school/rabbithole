/**
 * The Studio screen — native chrome around one self-contained WebView
 * document (`shared/studioDocument.generated.ts`), which holds the entire
 * code editor, the canvas, and the JS runtime that drives the grid robot /
 * drawing pen.
 *
 * WHY ONE DOCUMENT, NOT SPLIT ACROSS THE BRIDGE: the fast loop here is
 * keystroke → Run → redraw, and Andy's standing requirement is "instant,
 * delightful, tactile response and quick iteration". An RPC in that loop —
 * even a fast one — adds a round trip (and a serialization boundary) between
 * every keystroke and what the scholar sees, which kills exactly the feel
 * this screen exists to deliver. Keeping editor+canvas+runtime together
 * means Run never leaves the WebView at all. Everything THIS file owns is
 * deliberately the slow path instead: level switches, saves, charm artwork,
 * and the model-assisted syntax fix — traffic that can tolerate a bridge hop
 * because a kid never times a keystroke against it.
 *
 * WHY THE WEBVIEW IS KEYED ON THE DOCUMENT HASH ALONE: keying on the level or
 * the source would force React to remount the WebView on every level switch
 * or save, which reloads the whole document and throws away the scholar's
 * live editor state (cursor position, undo stack, unsaved edits) along with
 * it. The document itself never changes at runtime — only its build hash
 * does, when a new build ships — so that's the only thing worth keying on.
 * Level changes instead travel over the bridge as a `setLevel` action, which
 * the sandbox applies in place.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { fonts, useColors } from "@/theme";

// NOTE: not yet vendored to native/vendor/shared/ at the time this screen was
// built — see the report for the exact vendor-manifest entry needed.
import { STUDIO_LEVELS } from "../../../vendor/shared/studioLevels";
import type {
  StudioLevel,
  StudioRunResult,
} from "../../../vendor/shared/studioContract";

import { StudioCanvas } from "./StudioCanvas";
import { StudioLevelRail } from "./StudioLevelRail";
import { useStudioBridge } from "./useStudioBridge";
import { useStudioCharms } from "./useStudioCharms";

const HEADER_H = 44;

export function StudioScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const [seedBase] = useState(() => `direct:${Date.now()}`);

  const handleDone = useCallback(() => {
    router.back();
  }, []);

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      <View style={[styles.topBar, { paddingTop: insets.top, height: insets.top + HEADER_H, borderBottomColor: colors.border }]}>
        <Pressable onPress={handleDone} hitSlop={12} style={styles.doneButton}>
          <Text style={[styles.doneText, { color: colors.violet }]}>Done</Text>
        </Pressable>
        <Text style={[styles.title, { color: colors.fg }]} pointerEvents="none">
          Studio
        </Text>
        {/* Balances the Done button so the title stays centered. The sandbox
            already shows its own "thinking" state while a fix request is in
            flight, so there is no native affordance to render here. */}
        <View style={styles.doneButton} />
      </View>

      <StudioWorkspace
        levels={STUDIO_LEVELS}
        seedBase={seedBase}
        preferMostRecent
        bottomInset={insets.bottom}
        leftInset={insets.left}
        rightInset={insets.right}
      />
    </View>
  );
}

export function StudioWorkspace({
  levels,
  seedBase,
  nextWorldSeed,
  onRun,
  initialLevelId,
  preferMostRecent = false,
  bottomInset = 0,
  leftInset = 0,
  rightInset = 0,
}: {
  levels: readonly StudioLevel[];
  seedBase: string;
  nextWorldSeed?: (levelId: string) => string;
  onRun?: (run: StudioRunResult) => void;
  initialLevelId?: string;
  preferMostRecent?: boolean;
  bottomInset?: number;
  leftInset?: number;
  rightInset?: number;
}) {
  const { width, height } = useWindowDimensions();
  const isLandscape = width >= height;
  const allowedLevelIds = useMemo(() => levels.map((level) => level.id), [levels]);
  const {
    webViewRef,
    onLoadStart,
    onMessage,
    actionsReady,
    activeLevelId,
    programs,
    openLevel,
    sendCharms,
  } = useStudioBridge({
    allowedLevelIds,
    seedBase,
    nextWorldSeed,
    onRun,
  });
  useStudioCharms(sendCharms, actionsReady);

  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    if (!actionsReady || programs === undefined) return;
    restoredRef.current = true;
    const rows = Object.entries(programs).filter(([levelId]) =>
      allowedLevelIds.includes(levelId),
    );
    const mostRecent =
      preferMostRecent && rows.length
        ? rows.reduce((a, b) => (b[1].updatedAt > a[1].updatedAt ? b : a))
        : undefined;
    const levelId = mostRecent?.[0] ?? initialLevelId ?? levels[0]?.id;
    if (levelId) openLevel(levelId);
  }, [
    actionsReady,
    allowedLevelIds,
    initialLevelId,
    levels,
    openLevel,
    preferMostRecent,
    programs,
  ]);

  const solvedLevelIds = useMemo(() => {
    const ids = new Set<string>();
    if (programs) {
      for (const [levelId, row] of Object.entries(programs)) {
        if (row.solved) ids.add(levelId);
      }
    }
    return ids;
  }, [programs]);

  return (
    <View
      style={[
        styles.body,
        isLandscape ? styles.bodyRow : styles.bodyColumn,
        { paddingBottom: isLandscape ? bottomInset : 0 },
      ]}
    >
      <StudioLevelRail
        levels={levels}
        activeLevelId={activeLevelId}
        solvedLevelIds={solvedLevelIds}
        orientation={isLandscape ? "vertical" : "horizontal"}
        onSelectLevel={openLevel}
      />
      <View
        style={[
          styles.canvasWrap,
          isLandscape
            ? { paddingLeft: leftInset, paddingRight: rightInset }
            : { paddingBottom: bottomInset },
        ]}
      >
        <StudioCanvas
          ref={webViewRef}
          onLoadStart={onLoadStart}
          onMessage={onMessage}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  doneButton: {
    minWidth: 56,
    minHeight: 44,
    justifyContent: "center",
  },
  doneText: {
    fontFamily: fonts.semibold,
    fontSize: 17,
  },
  title: {
    fontFamily: fonts.semibold,
    fontSize: 17,
  },
  body: { flex: 1 },
  bodyRow: { flexDirection: "row" },
  bodyColumn: { flexDirection: "column" }, // rail as a strip above the canvas in narrow/portrait windows
  canvasWrap: { flex: 1 },
});

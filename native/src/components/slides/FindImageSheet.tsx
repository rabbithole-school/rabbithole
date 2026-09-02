/**
 * FindImageSheet — the scholar types a few words and Rabbithole searches the web
 * for an image to drop on the current slide. Modelled on `MakePictureDialog` so
 * the two image sources (Make an image / Find an image) feel identical: the same
 * centred card, `AppTextInput`, and house sheet chrome — the difference is a
 * result grid instead of a single primary button.
 *
 * This sheet owns ONLY the search half of the flow: query → busy → one of the
 * folded states (results grid · empty · capped · unavailable · error), copy
 * verbatim from the shared `FIND_IMAGE_COPY`. Tapping a thumbnail hands the
 * chosen result back to the host, which closes the sheet and runs the (slow)
 * server-side re-host on the SAME optimistic placeholder cascade "Make an image"
 * uses. So this file never inserts anything and never blocks on the pick.
 *
 * Three deliberate UX properties:
 *  - FIXED HEIGHT with an idle empty state, so the panel never resizes when the
 *    grid arrives after the first search.
 *  - PERSISTENCE across open/close: the host holds the last {query, results,
 *    shape} snapshot and passes it back as `initial`, because a scholar commonly
 *    reopens to change their mind about which picture to use.
 *  - CONTAIN, not cover: thumbnails fit inside their cell so the scholar can
 *    judge the real aspect ratio, and a client-side Shape filter (any/square/
 *    wide/tall) narrows by aspect (Brave has no server-side shape param).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Image } from "expo-image";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppTextInput } from "@/components/AppTextInput";
import { fonts, palette, useColors } from "@/theme";
import {
  FIND_IMAGE_COPY,
  FIND_IMAGE_MAX_QUERY,
  WEB_IMAGE_SHAPES,
  canSubmitImageSearch,
  filterImagesByShape,
  webImageShapeLabel,
  type WebImageSearchResponse,
  type WebImageSearchResult,
  type WebImageShape,
} from "./findImage";

const GRID_COLUMNS = 3;

/**
 * What persists across open/close. The host stores it and hands it back as
 * `initial`; transient states (busy/error/capped) deliberately do NOT persist.
 */
export type ImageSearchSnapshot = {
  query: string;
  activeQuery: string;
  results: WebImageSearchResult[];
  shape: WebImageShape;
};

export const EMPTY_IMAGE_SEARCH_SNAPSHOT: ImageSearchSnapshot = {
  query: "",
  activeQuery: "",
  results: [],
  shape: "any",
};

type Phase =
  | "idle"
  | "busy"
  | "results"
  | "empty"
  | "capped"
  | "unavailable"
  | "error";

export function FindImageSheet({
  initial,
  onSnapshot,
  onSearch,
  onPick,
  onCancel,
}: {
  /** The last snapshot, restored so a reopen shows the previous query + grid. */
  initial: ImageSearchSnapshot;
  /** Persist the current snapshot up to the host (called as it changes). */
  onSnapshot: (snapshot: ImageSearchSnapshot) => void;
  /**
   * Run the search. The host wraps the Convex action with the deck's
   * `artifactId`; this sheet stays free of any backend so it can be mounted in a
   * test with a stub. Returns the folded contract both surfaces render.
   */
  onSearch: (query: string) => Promise<WebImageSearchResponse>;
  /**
   * The scholar tapped a result. The host closes the sheet, drops a canvas
   * placeholder, and re-hosts the image in the background — this never awaits it.
   * `query` is the search that produced the grid, so the host derives honest alt
   * from it (never a stranger's page title).
   */
  onPick: (image: WebImageSearchResult, query: string) => void;
  /** Backed out without picking. */
  onCancel: () => void;
}) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => makeStyles(colors), [colors]);

  const [query, setQuery] = useState(initial.query);
  const [results, setResults] = useState<WebImageSearchResult[]>(
    initial.results,
  );
  const [shape, setShape] = useState<WebImageShape>(initial.shape);
  const [phase, setPhase] = useState<Phase>(
    initial.results.length > 0 ? "results" : "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string>(
    FIND_IMAGE_COPY.errorFallback,
  );
  // The query that produced the current grid — the pick and its alt derive from
  // THIS, not the live input the kid may already be retyping.
  const [activeQuery, setActiveQuery] = useState(initial.activeQuery);
  // A stale search must not overwrite a newer one: a slow first request landing
  // after a fast second would show the wrong grid for the wrong words.
  const searchToken = useRef(0);

  // Persist the durable slice up to the host whenever it settles, so reopening
  // restores the last query + grid + shape.
  useEffect(() => {
    onSnapshot({ query, activeQuery, results, shape });
  }, [query, activeQuery, results, shape, onSnapshot]);

  const busy = phase === "busy";
  const canSubmit = canSubmitImageSearch(query, busy);

  const submit = useCallback(async () => {
    if (!canSubmitImageSearch(query, busy)) return;
    const trimmed = query.trim().slice(0, FIND_IMAGE_MAX_QUERY);
    const token = ++searchToken.current;
    setActiveQuery(trimmed);
    setPhase("busy");
    let response: WebImageSearchResponse;
    try {
      response = await onSearch(trimmed);
    } catch {
      response = { status: "error", error: FIND_IMAGE_COPY.errorFallback };
    }
    if (token !== searchToken.current) return;
    if (response.status === "results") {
      setResults(response.results);
      setPhase(response.results.length > 0 ? "results" : "empty");
    } else if (response.status === "capped") {
      setPhase("capped");
    } else if (response.status === "unavailable") {
      setPhase("unavailable");
    } else {
      setErrorMessage(response.error.trim() || FIND_IMAGE_COPY.errorFallback);
      setPhase("error");
    }
  }, [busy, onSearch, query]);

  // The grid renders results narrowed to the chosen shape (client-side —
  // Brave has no shape param), padded so the last row keeps equal columns.
  const shaped = useMemo(
    () => filterImagesByShape(results, shape),
    [results, shape],
  );
  const gridData = useMemo(() => {
    if (phase !== "results") return [] as (WebImageSearchResult | null)[];
    const padded: (WebImageSearchResult | null)[] = [...shaped];
    while (padded.length % GRID_COLUMNS !== 0) padded.push(null);
    return padded;
  }, [phase, shaped]);

  const renderItem = useCallback(
    ({ item }: { item: WebImageSearchResult | null }) => {
      if (!item) return <View style={styles.gridCellSpacer} />;
      const host = item.sourceHost?.trim();
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={item.title?.trim() || FIND_IMAGE_COPY.altFallback}
          onPress={() => onPick(item, activeQuery)}
          style={({ pressed }) => [
            styles.gridCell,
            pressed && styles.gridCellPressed,
          ]}
        >
          <Image
            source={{ uri: item.thumbnailUrl }}
            style={styles.thumb}
            // Contain, not cover: the scholar can judge the true aspect ratio.
            contentFit="contain"
            transition={120}
            alt={item.title?.trim() || FIND_IMAGE_COPY.altFallback}
            accessibilityLabel={item.title?.trim() || FIND_IMAGE_COPY.altFallback}
          />
          {host ? (
            <Text style={styles.caption} numberOfLines={1}>
              {host}
            </Text>
          ) : null}
        </Pressable>
      );
    },
    [activeQuery, onPick, styles],
  );

  // The message shown in the fixed body for every non-grid state.
  const bodyMessage = (): string | null => {
    switch (phase) {
      case "idle":
        return FIND_IMAGE_COPY.idleHint;
      case "busy":
        return FIND_IMAGE_COPY.busy;
      case "empty":
        return FIND_IMAGE_COPY.empty;
      case "capped":
        return FIND_IMAGE_COPY.capped;
      case "unavailable":
        return FIND_IMAGE_COPY.unavailable;
      case "error":
        return errorMessage;
      default:
        return null;
    }
  };
  // A shape filter can hide every result of an otherwise-successful search.
  const shapeHidEverything =
    phase === "results" && results.length > 0 && shaped.length === 0;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={[
        StyleSheet.absoluteFill,
        styles.overlay,
        { paddingBottom: Math.max(insets.bottom, 16) },
      ]}
    >
      <Pressable style={styles.backdrop} onPress={onCancel} />
      <View style={styles.sheet}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.eyebrow}>{FIND_IMAGE_COPY.label}</Text>
            <Text style={styles.title} numberOfLines={2}>
              {FIND_IMAGE_COPY.action}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={FIND_IMAGE_COPY.cancel}
            hitSlop={10}
            onPress={onCancel}
            style={({ pressed }) => [
              styles.closeButton,
              pressed && styles.closePressed,
            ]}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
        </View>

        <View style={styles.searchRow}>
          <AppTextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            maxLength={FIND_IMAGE_MAX_QUERY}
            onSubmitEditing={() => void submit()}
            returnKeyType="search"
            placeholder={FIND_IMAGE_COPY.placeholder}
            accessibilityLabel={FIND_IMAGE_COPY.label}
            placeholderTextColor={colors.charcoalSubtle}
            style={[styles.input, styles.searchInput]}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={FIND_IMAGE_COPY.submit}
            accessibilityState={{ disabled: !canSubmit }}
            disabled={!canSubmit}
            onPress={() => void submit()}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && canSubmit && styles.primaryPressed,
              !canSubmit && styles.primaryDisabled,
            ]}
          >
            <Text style={styles.primaryText}>{FIND_IMAGE_COPY.submit}</Text>
          </Pressable>
        </View>

        {/* Shape filter — always present so the body never shifts. */}
        <View style={styles.shapeRow}>
          <Text style={styles.shapeLabel}>{FIND_IMAGE_COPY.shapeLabel}</Text>
          {WEB_IMAGE_SHAPES.map((s) => {
            const active = s === shape;
            return (
              <Pressable
                key={s}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={webImageShapeLabel(s)}
                onPress={() => setShape(s)}
                style={({ pressed }) => [
                  styles.shapePill,
                  active && styles.shapePillActive,
                  pressed && !active && styles.shapePillPressed,
                ]}
              >
                <Text
                  style={[
                    styles.shapePillText,
                    active && styles.shapePillTextActive,
                  ]}
                >
                  {webImageShapeLabel(s)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={styles.body}>
          {phase === "results" && !shapeHidEverything ? (
            <FlatList
              data={gridData}
              keyExtractor={(item, index) => item?.resultId ?? `spacer-${index}`}
              numColumns={GRID_COLUMNS}
              renderItem={renderItem}
              columnWrapperStyle={styles.gridRow}
              contentContainerStyle={styles.gridContent}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            />
          ) : phase === "busy" ? (
            <View style={styles.stateWrap}>
              <ActivityIndicator color={colors.violet} />
              <Text style={styles.stateText}>{FIND_IMAGE_COPY.busy}</Text>
            </View>
          ) : (
            <View style={styles.stateWrap}>
              <Text style={styles.stateText}>
                {shapeHidEverything
                  ? FIND_IMAGE_COPY.emptyForShape
                  : bodyMessage()}
              </Text>
            </View>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

function makeStyles(c: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    overlay: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 24,
      paddingTop: 24,
      zIndex: 20,
    },
    backdrop: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: "rgba(8, 13, 30, 0.42)",
    },
    sheet: {
      width: "100%",
      maxWidth: 720,
      // Fixed height (not max): the panel is the same size idle or full of
      // results, so the grid arriving never shifts the layout.
      height: "86%",
      borderRadius: 26,
      overflow: "hidden",
      backgroundColor: c.bg,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: palette.navy[900],
      shadowOpacity: 0.22,
      shadowRadius: 30,
      shadowOffset: { width: 0, height: 14 },
    },
    header: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 16,
      paddingHorizontal: 24,
      paddingTop: 22,
      paddingBottom: 12,
    },
    headerText: { flex: 1, minWidth: 0 },
    eyebrow: {
      color: c.charcoalSubtle,
      fontSize: 12,
      letterSpacing: 1.1,
      textTransform: "uppercase",
      fontFamily: fonts.bold,
      marginBottom: 3,
    },
    title: {
      color: c.navy,
      fontSize: 22,
      lineHeight: 27,
      fontFamily: fonts.bold,
    },
    closeButton: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.gray50,
    },
    closePressed: { backgroundColor: c.gray100 },
    closeText: {
      color: c.charcoalMuted,
      fontSize: 28,
      lineHeight: 30,
      fontFamily: fonts.regular,
      marginTop: -2,
    },
    searchRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingHorizontal: 24,
      paddingBottom: 12,
    },
    input: {
      minHeight: 48,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: 14,
      backgroundColor: c.bgSubtle,
      color: c.fg,
      paddingHorizontal: 14,
      paddingVertical: 11,
      fontSize: 16,
      fontFamily: fonts.regular,
    },
    searchInput: { flex: 1 },
    shapeRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 24,
      paddingBottom: 14,
    },
    shapeLabel: {
      color: c.charcoalSubtle,
      fontSize: 13,
      fontFamily: fonts.medium,
      marginRight: 2,
    },
    shapePill: {
      paddingHorizontal: 14,
      paddingVertical: 7,
      borderRadius: 999,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.bgSubtle,
    },
    shapePillActive: {
      backgroundColor: c.violet,
      borderColor: c.violet,
    },
    shapePillPressed: { backgroundColor: c.gray100 },
    shapePillText: {
      color: c.charcoalMuted,
      fontSize: 13,
      fontFamily: fonts.medium,
    },
    shapePillTextActive: { color: c.white },
    body: {
      flex: 1,
      minHeight: 0,
      paddingHorizontal: 24,
      paddingBottom: 20,
    },
    gridContent: { paddingBottom: 4, gap: 10 },
    gridRow: { gap: 10 },
    gridCell: {
      flex: 1,
      borderRadius: 12,
      overflow: "hidden",
      backgroundColor: c.bgSubtle,
      borderWidth: 1,
      borderColor: c.border,
    },
    gridCellSpacer: { flex: 1 },
    gridCellPressed: { opacity: 0.7 },
    thumb: { width: "100%", aspectRatio: 1, backgroundColor: c.gray50 },
    caption: {
      color: c.charcoalMuted,
      fontSize: 11,
      lineHeight: 15,
      fontFamily: fonts.regular,
      paddingHorizontal: 6,
      paddingVertical: 4,
    },
    stateWrap: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      gap: 12,
      paddingHorizontal: 24,
    },
    stateText: {
      color: c.charcoalMuted,
      fontSize: 15,
      lineHeight: 21,
      textAlign: "center",
      fontFamily: fonts.regular,
    },
    primaryButton: {
      minHeight: 48,
      borderRadius: 14,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: c.violet,
      paddingHorizontal: 22,
    },
    primaryPressed: { backgroundColor: c.violetSolid },
    primaryDisabled: { opacity: 0.48 },
    primaryText: {
      color: c.white,
      fontSize: 16,
      fontFamily: fonts.bold,
    },
  });
}

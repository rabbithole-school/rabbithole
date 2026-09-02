import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  AppState,
  LayoutChangeEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import ExternalDisplay, { useExternalDisplay } from "react-native-external-display";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useKeepAwake } from "expo-keep-awake";
import * as Print from "expo-print";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  CANVAS_H,
  CANVAS_W,
  type Deck,
  type Slide,
} from "../../../vendor/shared/slidesScene";
import {
  clipsOverflow,
  verticalAlignToJustify,
} from "../../../vendor/shared/slidesRenderContract";
import { usePresentationAsam } from "@/contexts/AsamControllerContext";
import {
  getPresentationDisplayState,
  type ExternalScreen,
} from "@/lib/presentationExternalDisplay";
import { fonts, useColors } from "@/theme";
import { SlideElementContentNative } from "./SlideElementContentNative";

const SYSTEM_UI_RELEASE_TIMEOUT_MS = 30_000;
const NO_PLAYING_VIDEOS: ReadonlySet<string> = new Set();

export type SlidesPresentationNativeProps = {
  deck: Deck;
  /** Controlled current slide, zero-indexed. */
  slideIndex?: number;
  /** Used when `slideIndex` is omitted. */
  initialSlideIndex?: number;
  onSlideIndexChange?: (slideIndex: number) => void;
  onExit: () => void;
  /** Resolves a scene image asset id to a URL suitable for Expo Image. */
  resolveAsset?: (assetId: string) => string | null;
};

export function SlidesPresentationNative({
  deck,
  slideIndex,
  initialSlideIndex = 0,
  onSlideIndexChange,
  onExit,
  resolveAsset,
}: SlidesPresentationNativeProps) {
  useKeepAwake();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { releaseForSystemUI, restoreAfterSystemUI } = usePresentationAsam();
  const [uncontrolledIndex, setUncontrolledIndex] = useState(initialSlideIndex);
  const [printing, setPrinting] = useState(false);
  const [videoPlayback, setVideoPlayback] = useState<{
    slideId: string | null;
    ids: ReadonlySet<string>;
  }>(() => ({ slideId: null, ids: NO_PLAYING_VIDEOS }));
  const [showConnectionGuidance, setShowConnectionGuidance] = useState(false);
  const previousConnected = useRef<boolean | null>(null);
  const awaitingSystemUIReturn = useRef(false);
  const systemUIBecameInactive = useRef(false);
  const systemUIReleaseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screens: Readonly<Record<string, ExternalScreen>> = useExternalDisplay();
  const index = clampIndex(slideIndex ?? uncontrolledIndex, deck.slides.length);
  const currentSlide = deck.slides[index];
  const nextSlide = deck.slides[index + 1] ?? null;
  const playingVideoIds =
    videoPlayback.slideId === currentSlide?.id
      ? videoPlayback.ids
      : NO_PLAYING_VIDEOS;
  const {
    externalScreenId,
    hasExternalScreen,
    connected,
    canPrintNotes,
    mainScreenMode,
  } = getPresentationDisplayState(screens);

  const restoreSystemUI = useCallback(() => {
    awaitingSystemUIReturn.current = false;
    systemUIBecameInactive.current = false;
    if (systemUIReleaseTimer.current) {
      clearTimeout(systemUIReleaseTimer.current);
      systemUIReleaseTimer.current = null;
    }
    restoreAfterSystemUI();
  }, [restoreAfterSystemUI]);

  const setIndex = useCallback(
    (nextIndex: number) => {
      const clamped = clampIndex(nextIndex, deck.slides.length);
      if (clamped === index) return;
      if (onSlideIndexChange) onSlideIndexChange(clamped);
      else setUncontrolledIndex(clamped);
    },
    [deck.slides.length, index, onSlideIndexChange],
  );

  const goPrevious = useCallback(() => setIndex(index - 1), [index, setIndex]);
  const goNext = useCallback(() => setIndex(index + 1), [index, setIndex]);

  const toggleVideo = useCallback((elementId: string) => {
    if (!currentSlide) return;
    setVideoPlayback((current) => {
      const next = new Set(
        current.slideId === currentSlide.id ? current.ids : NO_PLAYING_VIDEOS,
      );
      if (next.has(elementId)) next.delete(elementId);
      else next.add(elementId);
      return { slideId: currentSlide.id, ids: next };
    });
  }, [currentSlide]);

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(
      `Slide ${index + 1} of ${deck.slides.length}`,
    );
  }, [deck.slides.length, index]);

  useEffect(() => {
    if (previousConnected.current !== null && previousConnected.current !== connected) {
      AccessibilityInfo.announceForAccessibility(
        connected ? "Slides are showing on the TV" : "The TV disconnected",
      );
    }
    previousConnected.current = connected;
    if (connected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- an external display connection must immediately close this transient hint.
      setShowConnectionGuidance(false);
      restoreSystemUI();
    }
  }, [connected, restoreSystemUI]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (!awaitingSystemUIReturn.current) return;
      if (state === "inactive" || state === "background") {
        systemUIBecameInactive.current = true;
      } else if (state === "active" && systemUIBecameInactive.current) {
        restoreSystemUI();
      }
    });
    return () => {
      subscription.remove();
      restoreSystemUI();
    };
  }, [restoreSystemUI]);

  const swipe = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-24, 24])
        .failOffsetY([-32, 32])
        .onEnd((event) => {
          if (event.translationX <= -56) goNext();
          if (event.translationX >= 56) goPrevious();
        })
        .runOnJS(true),
    [goNext, goPrevious],
  );

  const printNotes = useCallback(async () => {
    if (printing) return;
    if (!canPrintNotes) {
      Alert.alert(
        "Print notes unavailable",
        "Disconnect screen mirroring before opening speaker notes.",
      );
      return;
    }
    setPrinting(true);
    try {
      await Print.printAsync({ html: notesHtml(deck) });
    } catch {
      Alert.alert("Print notes", "The notes could not be printed. Please try again.");
    } finally {
      setPrinting(false);
    }
  }, [canPrintNotes, deck, printing]);

  const connectTV = useCallback(() => {
    awaitingSystemUIReturn.current = true;
    systemUIBecameInactive.current = false;
    releaseForSystemUI();
    if (systemUIReleaseTimer.current) clearTimeout(systemUIReleaseTimer.current);
    systemUIReleaseTimer.current = setTimeout(
      restoreSystemUI,
      SYSTEM_UI_RELEASE_TIMEOUT_MS,
    );
    setShowConnectionGuidance(true);
  }, [releaseForSystemUI, restoreSystemUI]);

  const finish = useCallback(() => {
    Alert.alert(
      "End presentation?",
      connected
        ? "This will stop showing your slides on the TV."
        : "This will close presentation mode.",
      [
        { text: "Keep presenting", style: "cancel" },
        {
          text: "Done",
          onPress: () => {
            restoreSystemUI();
            onExit();
          },
        },
      ],
    );
  }, [connected, onExit, restoreSystemUI]);

  if (!currentSlide) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyText, { color: colors.fgMuted, fontFamily: fonts.regular }]}>
          This deck has no slides to present.
        </Text>
        <PresentationButton label="Done" onPress={finish} colors={colors} />
      </View>
    );
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.bg }]}>
      {externalScreenId && (
        <ExternalDisplay fallbackInMainScreen={false} screen={externalScreenId}>
          <ExternalSlideStage
            slide={currentSlide}
            resolveAsset={resolveAsset}
            playingVideoIds={playingVideoIds}
          />
        </ExternalDisplay>
      )}

      <GestureDetector gesture={swipe}>
        <View
          style={[
            styles.speaker,
            {
              paddingTop: Math.max(insets.top, 20),
              paddingRight: Math.max(insets.right, 20),
              paddingBottom: Math.max(insets.bottom, 20),
              paddingLeft: Math.max(insets.left, 20),
            },
          ]}
        >
          <View style={styles.header}>
            <Text
              style={[
                styles.count,
                { color: colors.fg, fontFamily: fonts.medium },
              ]}
            >
              Slide {index + 1} of {deck.slides.length}
            </Text>
            <Text
              style={[
                styles.connection,
                { color: colors.fgMuted, fontFamily: fonts.medium },
              ]}
            >
              {mainScreenMode === "speaker"
                ? "Showing on the TV"
                : mainScreenMode === "connecting"
                  ? "Connecting to the TV"
                  : "On this iPad only"}
            </Text>
            {!hasExternalScreen && (
              <PresentationButton label="Connect TV" onPress={connectTV} colors={colors} />
            )}
            <PresentationButton
              disabled={printing}
              label={printing ? "Preparing notes…" : "Print notes"}
              onPress={printNotes}
              colors={colors}
            />
            <PresentationButton label="Done" onPress={finish} colors={colors} />
          </View>

          {mainScreenMode === "speaker" ? (
            <View style={styles.presentationBody}>
              <View style={styles.previewColumn}>
                <View style={styles.currentArea}>
                  <Text
                    style={[
                      styles.sectionLabel,
                      { color: colors.fgMuted, fontFamily: fonts.medium },
                    ]}
                  >
                    Current slide
                  </Text>
                  <SlidePreview
                    slide={currentSlide}
                    resolveAsset={resolveAsset}
                    playingVideoIds={playingVideoIds}
                    onVideoPress={toggleVideo}
                    videoMuted
                  />
                </View>
                <View style={styles.nextArea}>
                  <Text
                    style={[
                      styles.sectionLabel,
                      { color: colors.fgMuted, fontFamily: fonts.medium },
                    ]}
                  >
                    Next slide
                  </Text>
                  {nextSlide ? (
                    <SlidePreview
                      slide={nextSlide}
                      resolveAsset={resolveAsset}
                    />
                  ) : (
                    <View
                      style={[styles.noNext, { borderColor: colors.border }]}
                    >
                      <Text
                        style={[
                          styles.noNextText,
                          {
                            color: colors.fgMuted,
                            fontFamily: fonts.regular,
                          },
                        ]}
                      >
                        Last slide
                      </Text>
                    </View>
                  )}
                </View>
              </View>
              <View style={styles.notesArea}>
                <Text
                  accessibilityRole="header"
                  style={[
                    styles.sectionLabel,
                    { color: colors.fgMuted, fontFamily: fonts.medium },
                  ]}
                >
                  Speaker notes
                </Text>
                <ScrollView
                  contentContainerStyle={styles.notesContent}
                  showsVerticalScrollIndicator
                >
                  <Text
                    style={[
                      styles.notes,
                      { color: colors.fg, fontFamily: fonts.regular },
                    ]}
                  >
                    {currentSlide.speakerNotes?.trim() ||
                      "No notes for this slide."}
                  </Text>
                </ScrollView>
              </View>
            </View>
          ) : mainScreenMode === "slide" ? (
            <View style={styles.onDevicePresentation}>
              {showConnectionGuidance && (
                <Text
                  style={[
                    styles.onDeviceGuidance,
                    { color: colors.fgMuted, fontFamily: fonts.regular },
                  ]}
                >
                  Open Control Center from the top-right of this iPad, choose
                  Screen Mirroring, then select the classroom TV.
                </Text>
              )}
              <View testID="slides-ipad-presentation" style={styles.onDeviceStage}>
                <SlideCanvas
                  slide={currentSlide}
                  resolveAsset={resolveAsset}
                  playingVideoIds={playingVideoIds}
                  onVideoPress={toggleVideo}
                  videoMuted={false}
                />
              </View>
            </View>
          ) : (
            <View style={styles.connectState}>
              <Text
                accessibilityRole="header"
                style={[
                  styles.connectTitle,
                  { color: colors.fg, fontFamily: fonts.medium },
                ]}
              >
                Securing the TV output
              </Text>
              <Text
                style={[
                  styles.connectBody,
                  { color: colors.fgMuted, fontFamily: fonts.regular },
                ]}
              >
                Speaker notes will appear here once the TV is no longer
                mirroring this iPad.
              </Text>
            </View>
          )}

          <View style={styles.controls}>
            <PresentationButton
              disabled={index === 0}
              label="Previous"
              onPress={goPrevious}
              colors={colors}
            />
            <PresentationButton
              disabled={index === deck.slides.length - 1}
              label="Next"
              onPress={goNext}
              colors={colors}
            />
          </View>
        </View>
      </GestureDetector>
    </View>
  );
}

function PresentationButton({
  label,
  onPress,
  disabled = false,
  colors,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.button,
        { borderColor: colors.border, backgroundColor: colors.bg },
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, { color: colors.fg, fontFamily: fonts.medium }]}>{label}</Text>
    </Pressable>
  );
}

function SlidePreview({
  slide,
  resolveAsset,
  playingVideoIds,
  onVideoPress,
  videoMuted = true,
}: {
  slide: Slide;
  resolveAsset?: (assetId: string) => string | null;
  playingVideoIds?: ReadonlySet<string>;
  onVideoPress?: (elementId: string) => void;
  videoMuted?: boolean;
}) {
  return (
    <View accessible={false} style={styles.preview}>
      <SlideCanvas
        slide={slide}
        resolveAsset={resolveAsset}
        playingVideoIds={playingVideoIds}
        onVideoPress={onVideoPress}
        videoMuted={videoMuted}
      />
    </View>
  );
}

function ExternalSlideStage({
  slide,
  resolveAsset,
  playingVideoIds,
}: {
  slide: Slide;
  resolveAsset?: (assetId: string) => string | null;
  playingVideoIds: ReadonlySet<string>;
}) {
  return (
    <View accessible={false} style={styles.externalStage}>
      <SlideCanvas
        slide={slide}
        resolveAsset={resolveAsset}
        playingVideoIds={playingVideoIds}
        videoMuted={false}
      />
    </View>
  );
}

function SlideCanvas({
  slide,
  resolveAsset,
  playingVideoIds,
  onVideoPress,
  videoMuted = true,
}: {
  slide: Slide;
  resolveAsset?: (assetId: string) => string | null;
  playingVideoIds?: ReadonlySet<string>;
  onVideoPress?: (elementId: string) => void;
  videoMuted?: boolean;
}) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);
  const scale = Math.min(size.width / CANVAS_W, size.height / CANVAS_H);
  const width = CANVAS_W * scale;
  const height = CANVAS_H * scale;

  return (
    <View style={styles.canvasHost} onLayout={onLayout}>
      {scale > 0 && (
        <View style={[styles.canvas, { width, height, backgroundColor: slide.background }]}>
          {slide.elementIds.map((id) => {
            const element = slide.elements[id];
            return element ? (
              <SlideElementView
                element={element}
                key={id}
                scale={scale}
                resolveAsset={resolveAsset}
                videoPlaying={playingVideoIds?.has(id) ?? false}
                onVideoPress={
                  element.type === "video" && onVideoPress
                    ? () => onVideoPress(id)
                    : undefined
                }
                videoMuted={videoMuted}
              />
            ) : null;
          })}
        </View>
      )}
    </View>
  );
}

export function SlideElementView({
  element,
  scale,
  resolveAsset,
  videoPlaying,
  onVideoPress,
  videoMuted,
}: {
  element: Slide["elements"][string];
  scale: number;
  resolveAsset?: (assetId: string) => string | null;
  videoPlaying: boolean;
  onVideoPress?: () => void;
  videoMuted: boolean;
}) {
  const { frame } = element;
  const frameStyle = {
    left: frame.x * scale,
    top: frame.y * scale,
    width: frame.w * scale,
    height: frame.h * scale,
    transform: [{ rotate: `${frame.rotation}deg` }],
  };

  return (
    <View
      style={[
        styles.element,
        frameStyle,
        clipsOverflow(element.type) && { overflow: "hidden" },
        element.type === "text" && {
          justifyContent: verticalAlignToJustify(element.style.verticalAlign),
        },
      ]}
    >
      <SlideElementContentNative
        accessible={false}
        element={element}
        onVideoPress={onVideoPress}
        resolveAsset={resolveAsset}
        scale={scale}
        videoPlaying={videoPlaying}
        videoMuted={videoMuted}
      />
    </View>
  );
}

function clampIndex(index: number, count: number) {
  return Math.max(0, Math.min(Math.max(0, count - 1), index));
}

function notesHtml(deck: Deck) {
  const sections = deck.slides
    .map((slide, index) => {
      const heading = slideHeading(slide) || `Slide ${index + 1}`;
      const notes = slide.speakerNotes?.trim();
      return `<section><h2>Slide ${index + 1}: ${escapeHtml(heading)}</h2>${
        notes
          ? `<div class="notes">${escapeHtml(notes)}</div>`
          : '<p class="empty">No speaker notes.</p>'
      }</section>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 0.7in; } body { color: #111; font: 14pt -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; line-height: 1.45; }
    h1 { font-size: 22pt; margin: 0 0 0.4in; } h2 { font-size: 16pt; margin: 0 0 0.12in; } section { break-inside: avoid; margin: 0 0 0.35in; }
    .notes { white-space: pre-wrap; } .empty { color: #666; font-style: italic; }
  </style></head><body><h1>${escapeHtml(deck.title)} — speaker notes</h1>${sections}</body></html>`;
}

function slideHeading(slide: Slide) {
  for (const id of slide.elementIds) {
    const element = slide.elements[id];
    if (element?.type === "text" && element.text.trim()) {
      return element.text.trim().split(/\r?\n/, 1)[0].slice(0, 160);
    }
  }
  return "";
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return escaped[character];
  });
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
  emptyText: { fontSize: 18, textAlign: "center" },
  speaker: { flex: 1, padding: 20, gap: 14 },
  header: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 16 },
  count: { flex: 1, fontSize: 18 },
  connection: { fontSize: 16 },
  presentationBody: { flex: 1, minHeight: 0, flexDirection: "row", gap: 20 },
  onDevicePresentation: { flex: 1, minHeight: 0, gap: 10 },
  onDeviceGuidance: { fontSize: 17, lineHeight: 23, textAlign: "center" },
  onDeviceStage: { flex: 1, minHeight: 0, backgroundColor: "#000" },
  connectState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
    paddingHorizontal: 48,
  },
  connectTitle: { fontSize: 30, textAlign: "center" },
  connectBody: { maxWidth: 680, fontSize: 20, lineHeight: 28, textAlign: "center" },
  previewColumn: { width: "34%", minWidth: 260, gap: 14 },
  currentArea: { flex: 2, minHeight: 0, gap: 6 },
  notesArea: { flex: 1, gap: 6 },
  nextArea: { flex: 1, minHeight: 110, gap: 6 },
  sectionLabel: { fontSize: 15 },
  notesContent: { paddingBottom: 12 },
  notes: { fontSize: 26, lineHeight: 34 },
  preview: { flex: 1, minHeight: 0, backgroundColor: "#000" },
  noNext: { flex: 1, alignItems: "center", justifyContent: "center", borderWidth: 1 },
  noNextText: { fontSize: 16 },
  controls: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  button: {
    minWidth: 96,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: 17 },
  disabled: { opacity: 0.4 },
  externalStage: { flex: 1, backgroundColor: "#000" },
  canvasHost: { flex: 1, alignItems: "center", justifyContent: "center" },
  canvas: { overflow: "hidden" },
  element: { position: "absolute" },
});

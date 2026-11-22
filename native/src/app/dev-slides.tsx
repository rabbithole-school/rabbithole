/**
 * `/dev-slides` — an isolated harness for the native slide editor.
 *
 * It renders the REAL `SlidesEditorNative` against a local fixture deck, with
 * no Convex and no auth-bound deliverable, so the editor's feel can be checked
 * on a device in isolation (and re-checked after a change) without setting up a
 * session, an activity, and a deliverable first.
 *
 * This started life as a standalone spike carrying its own copy of the
 * transform loop. That copy is gone deliberately: two slide implementations
 * would be two things to keep at parity, and the point of the shared scene is
 * that there is ONE editor per surface. The harness holds a deck in local state
 * and applies ops with `applySlideOps` — which is exactly what the Convex
 * mutation does server-side — so what you feel here is what a scholar feels.
 */

import { useCallback, useRef, useState } from "react";
import { Stack } from "expo-router";
import { Modal, StyleSheet, View } from "react-native";

import {
  applySlideOps,
  SLIDES_COPY,
  type Deck,
  type SlideOp,
} from "../../vendor/shared/slidesScene";
import {
  SlidesEditorNative,
  type SlidesEditorNativeHandle,
} from "@/components/slides/SlidesEditorNative";
import { HeaderPillButton } from "@/components/HeaderPillButton";
import { SlidesTalkNative } from "@/components/slides/SlidesTalkNative";
import { TakeReviewNative } from "@/components/talk/TakeReviewNative";
import {
  chooseHowToPresent,
  type PresentChoice,
} from "@/components/talk/presentChoice";
import { METER_FRAME_MS } from "@/lib/micLevel";
import type { RehearsalTake, SlideShowing } from "@/lib/rehearsalTake";
import type { StoredTake } from "@/lib/rehearsalStore";
import {
  SlidesViewToggleNative,
  type SlidesViewMode,
} from "@/components/slides/SlidesViewToggleNative";
import { useColors } from "@/theme";

const FIXTURE: Deck = {
  schemaVersion: 1,
  title: "Volcanoes of Hawaii",
  width: 1280,
  height: 720,
  revision: 0,
  slides: [
    {
      id: "sl1",
      background: "#ffffff",
      elementIds: ["el1", "el2", "el3", "el4"],
      elements: {
        el1: {
          id: "el1",
          type: "text",
          frame: { x: 90, y: 70, w: 700, h: 120, rotation: 0 },
          text: "Volcanoes of Hawaii",
          style: {
            fontSize: 56, bold: true, italic: false,
            color: "#222656", align: "left", verticalAlign: "top",
          },
        },
        el2: {
          id: "el2",
          type: "text",
          frame: { x: 90, y: 220, w: 620, h: 200, rotation: 0 },
          text: "Double-tap to edit. Drag to move. Corner to resize.",
          style: {
            fontSize: 28, bold: false, italic: false,
            color: "#364153", align: "left", verticalAlign: "top",
          },
        },
        // Deliberately rotated, so resize-in-local-space is exercised for real.
        el3: {
          id: "el3",
          type: "rect",
          frame: { x: 830, y: 180, w: 340, h: 260, rotation: 348 },
          style: { fill: "#AD60BF", stroke: null, strokeWidth: 0 },
        },
        el4: {
          id: "el4",
          type: "ellipse",
          frame: { x: 250, y: 470, w: 180, h: 180, rotation: 0 },
          style: { fill: "#1f9d6b", stroke: null, strokeWidth: 0 },
        },
      },
    },
    {
      id: "sl2",
      background: "#fff8ec",
      elementIds: ["el5"],
      elements: {
        el5: {
          id: "el5",
          type: "text",
          frame: { x: 170, y: 260, w: 940, h: 150, rotation: 0 },
          text: "Delete this fixture element",
          style: {
            fontSize: 56, bold: true, italic: false,
            color: "#222656", align: "center", verticalAlign: "middle",
          },
        },
      },
    },
    {
      id: "sl3",
      background: "#edf8ff",
      elementIds: ["el6"],
      elements: {
        el6: {
          id: "el6",
          type: "image",
          frame: { x: 290, y: 150, w: 700, h: 420, rotation: 0 },
          assetId: "broken-image",
          alt: "Broken image fixture",
        },
      },
    },
  ],
};

// Two made-up rehearsals of the fixture deck, for "Sample rehearsal": the
// review screen without recording anything (a simulator with no microphone
// can't), so it can be checked and screenshotted anywhere. No audio, so Play
// is off; the timeline and table still scrub.
function sampleTake(
  id: string,
  recordedAt: number,
  segments: { seconds: number; base: number; loudFrom?: number }[],
): StoredTake {
  const levels: number[] = [];
  const slides: SlideShowing[] = [];
  segments.forEach((segment, index) => {
    slides.push({ atMs: levels.length * METER_FRAME_MS, index, slideId: `sl${index + 1}` });
    const frames = Math.round((segment.seconds * 1000) / METER_FRAME_MS);
    for (let k = 0; k < frames; k++) {
      const pause = k % 38 >= 30; // ~2.4 s phrases, ~0.6 s breaths
      const loud = segment.loudFrom !== undefined && k >= segment.loudFrom && k < segment.loudFrom + 36;
      const base = loud ? 0.9 : segment.base;
      levels.push(pause ? 0.12 : Math.round((base + 0.05 * Math.sin(k * 1.1)) * 1000) / 1000);
    }
  });
  const take: RehearsalTake = {
    version: 1,
    id,
    recordedAt,
    durationMs: levels.length * METER_FRAME_MS,
    frameMs: METER_FRAME_MS,
    levels,
    slides,
    audioFile: "",
  };
  return { ...take, audioUri: null };
}

const SAMPLE_TAKES: StoredTake[] = [
  sampleTake("sample-1", Date.UTC(2026, 10, 16, 20, 12), [
    { seconds: 20, base: 0.64 },
    { seconds: 30, base: 0.5 },
    { seconds: 20, base: 0.62 },
  ]),
  sampleTake("sample-2", Date.UTC(2026, 10, 17, 18, 5), [
    { seconds: 15, base: 0.68 },
    { seconds: 25, base: 0.6, loudFrom: 150 },
    { seconds: 18, base: 0.68 },
  ]),
];

function resolveFixtureAsset(assetId: string) {
  // This closed localhost port deterministically reaches expo-image's native
  // error path without relying on network availability.
  return assetId === "broken-image" ? "http://127.0.0.1:1/broken-image.png" : null;
}

export default function DevSlidesHarness() {
  // Dev-only. It is registered in the router like any other route, so without
  // this a fleet build ships a fixture screen a scholar could deep-link into.
  // Before any hook, so the early return cannot break the hook order.
  if (!__DEV__) return null;
  return <DevSlidesHarnessInner />;
}

function DevSlidesHarnessInner() {
  const colors = useColors();
  const [deck, setDeck] = useState<Deck>(FIXTURE);
  const [presenting, setPresenting] = useState<PresentChoice | "sample" | null>(null);
  const [sampleSelected, setSampleSelected] = useState(SAMPLE_TAKES.length - 1);
  const [viewMode, setViewMode] = useState<SlidesViewMode>("slide");

  // Mirror the server's PER-KIND id minting so ids read the same here as in prod.
  // The counter has to persist ACROSS calls within the same deck generation —
  // a single onOps batch can mint several ids before `deck` itself updates —
  // but incrementing it inside a `useMemo` factory mutates a value after that
  // render's memo computation has already returned, which the compiler
  // disallows. Refs are the sanctioned place for that mutable counter, but
  // reading/writing `.current` has to stay inside the callback body (which
  // only runs when actually invoked, later) rather than directly in the
  // render body, which the compiler also disallows.
  const editorRef = useRef<SlidesEditorNativeHandle>(null);
  const seedDeckRef = useRef<Deck | null>(null);
  const seedRef = useRef({ slide: 0, element: 0 });
  const mintId = useCallback(
    (kind: "slide" | "element") => {
      if (seedDeckRef.current !== deck) {
        const seed = { slide: 0, element: 0 };
        for (const s of deck.slides) {
          const sn = Number(s.id.replace(/^sl/, ""));
          if (Number.isFinite(sn) && sn > seed.slide) seed.slide = sn;
          for (const e of s.elementIds) {
            const en = Number(e.replace(/^el/, ""));
            if (Number.isFinite(en) && en > seed.element) seed.element = en;
          }
        }
        seedRef.current = seed;
        seedDeckRef.current = deck;
      }
      return kind === "slide"
        ? `sl${++seedRef.current.slide}`
        : `el${++seedRef.current.element}`;
    },
    [deck],
  );

  const onOps = useCallback(
    (ops: SlideOp[]) => {
      setDeck((cur) => {
        const r = applySlideOps(cur, ops, mintId);
        return r.ok ? r.deck : cur;
      });
    },
    [mintId],
  );

  const addFixtureMedia = useCallback(async () => ({
    type: "image" as const,
    assetId: "broken-image",
    alt: "Media fixture",
  }), []);

  const addFixtureSketch = useCallback(async () => ({
    type: "image" as const,
    assetId: "broken-image",
    alt: "Sketch fixture",
  }), []);

  // Present belongs to the HOST's chrome, not the editor's toolbar — so the
  // harness carries its own, in its own header, and drives the editor through
  // the same ref the real surface uses. Committing the in-flight edit before
  // leaving editing chrome mirrors `SlidesDeliverable.presentDeck`, which is
  // what keeps this harness faithful to what a scholar actually gets.
  const openPresenter = useCallback(async (choice: PresentChoice) => {
    const saved = (await editorRef.current?.commitPendingEdit()) ?? true;
    if (!saved) return;
    setPresenting(choice);
  }, []);

  const presentDeck = useCallback(() => {
    void (async () => {
      const choice = await chooseHowToPresent("Present slides", SLIDES_COPY.present);
      if (choice) await openPresenter(choice);
    })();
  }, [openPresenter]);

  // Straight into a rehearsal, skipping the Present/Rehearse sheet. Mini's
  // iOS smoke runs Appium with autoAcceptAlerts, which taps an action sheet's
  // first button (Present) before a scenario can choose Rehearse, so the
  // rehearsal scenario comes in here. The sheet itself is checked by hand.
  const rehearseDeck = useCallback(() => {
    void openPresenter("rehearse");
  }, [openPresenter]);

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <SlidesViewToggleNative value={viewMode} onChange={setViewMode} />
          ),
          // The app's header pills, as one custom item with iOS 26's shared
          // glass capsule hidden (see HeaderPillButton): hand-rolled buttons
          // in headerRight sat inside that capsule and drew two outlines.
          unstable_headerRightItems: () => [
            {
              type: "custom" as const,
              hidesSharedBackground: true,
              element: (
                <View style={styles.headerButtons}>
                  <HeaderPillButton
                    icon="mic"
                    label="Rehearse"
                    onPress={rehearseDeck}
                    testID="dev-slides-rehearse"
                  />
                  <HeaderPillButton
                    icon="play.rectangle"
                    label="Sample rehearsal"
                    onPress={() => setPresenting("sample")}
                    testID="dev-slides-sample-rehearsal"
                  />
                  <HeaderPillButton
                    icon="rectangle.on.rectangle"
                    label={SLIDES_COPY.present}
                    onPress={presentDeck}
                    testID="dev-slides-present"
                  />
                </View>
              ),
            },
          ],
        }}
      />
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <SlidesEditorNative
          ref={editorRef}
          deck={deck}
          onOps={onOps}
          gridOpen={viewMode === "grid"}
          onGridOpenChange={(open) => setViewMode(open ? "grid" : "slide")}
          resolveAsset={resolveFixtureAsset}
          onAddMedia={addFixtureMedia}
          onAddSketch={addFixtureSketch}
        />
        <Modal
          animationType="fade"
          onRequestClose={() => setPresenting(null)}
          presentationStyle="fullScreen"
          supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
          visible={presenting !== null}
        >
          {presenting === "sample" ? (
            <TakeReviewNative
              title={deck.title || "Your slides"}
              deck={deck}
              takes={SAMPLE_TAKES}
              selected={sampleSelected}
              onSelect={setSampleSelected}
              againLabel="Rehearse again"
              onAgain={() => setPresenting("rehearse")}
              onDone={() => setPresenting(null)}
              resolveAsset={resolveFixtureAsset}
            />
          ) : presenting ? (
            <SlidesTalkNative
              deck={deck}
              deckKey="dev-slides-fixture"
              mode={presenting}
              onExit={() => setPresenting(null)}
              resolveAsset={resolveFixtureAsset}
            />
          ) : null}
        </Modal>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // The app builder's header spacing (VibecodeScreen styles.headerRight).
  headerButtons: { flexDirection: "row", alignItems: "center", gap: 10 },
});

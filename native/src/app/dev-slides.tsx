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
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

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
import { SlidesPresentationNative } from "@/components/slides/SlidesPresentationNative";
import {
  SlidesViewToggleNative,
  type SlidesViewMode,
} from "@/components/slides/SlidesViewToggleNative";
import { fonts, useColors } from "@/theme";

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
  const [presenting, setPresenting] = useState(false);
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
  const presentDeck = useCallback(() => {
    void (async () => {
      const saved = (await editorRef.current?.commitPendingEdit()) ?? true;
      if (!saved) return;
      setPresenting(true);
    })();
  }, []);

  return (
    <>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <SlidesViewToggleNative value={viewMode} onChange={setViewMode} />
          ),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={SLIDES_COPY.present}
              onPress={presentDeck}
              testID="dev-slides-present"
              style={({ pressed }) => [
                styles.presentButton,
                { borderColor: colors.border, opacity: pressed ? 0.65 : 1 },
              ]}
            >
              <Text style={{ fontFamily: fonts.medium, color: colors.fg }}>
                {SLIDES_COPY.present}
              </Text>
            </Pressable>
          ),
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
          onRequestClose={() => setPresenting(false)}
          presentationStyle="fullScreen"
          supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
          visible={presenting}
        >
          <SlidesPresentationNative deck={deck} onExit={() => setPresenting(false)} />
        </Modal>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  presentButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
});

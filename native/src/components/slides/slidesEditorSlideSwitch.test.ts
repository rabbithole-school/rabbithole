/**
 * Switching slides must not throw away what the scholar just typed.
 *
 * The text overlay is unmounted the instant the active slide changes, so the
 * in-flight draft cannot rely on the input's `onBlur` firing first — on device
 * the typed text simply vanished. The slide-change path therefore has to commit
 * the pending text edit itself, exactly as the Present/export path does.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Record<string, unknown> & { children?: ReactNode };

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props, children);
  return {
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    AppState: {
      currentState: "active",
      addEventListener: () => ({ remove: () => {} }),
    },
    Pressable: host("pressable"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    Text: host("text"),
    View: host("view"),
  };
});

vi.mock("react-native-gesture-handler", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const gesture = () => {
    const proxy: unknown = new Proxy(
      {},
      { get: () => (..._args: unknown[]) => proxy },
    );
    return proxy;
  };
  return {
    Gesture: {
      Tap: gesture,
      Pan: gesture,
      Rotation: gesture,
      Race: gesture,
      Simultaneous: gesture,
      Exclusive: gesture,
    },
    GestureDetector: ({ children }: Props) => children ?? null,
    ScrollView: ({ children, ...props }: Props) =>
      react.createElement("scroll-view", props, children),
  };
});

vi.mock("react-native-reanimated", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const view = ({ children, ...props }: Props) =>
    react.createElement("animated-view", props, children);
  return {
    default: { View: view },
    runOnJS: <T,>(fn: T) => fn,
    useAnimatedStyle: () => ({}),
    useSharedValue: <T,>(initial: T) => {
      let current = initial;
      return {
        get value() {
          return current;
        },
        set value(next: T) {
          current = next;
        },
        get: () => current,
        set: (next: T) => {
          current = next;
        },
      };
    },
  };
});

vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("phosphor-react-native", () => ({ ScribbleIcon: () => null }));
vi.mock("@/theme", () => ({
  fonts: new Proxy<Record<string, string>>({}, { get: () => "font" }),
  useColors: () => new Proxy<Record<string, string>>({}, { get: () => "#000" }),
}));
vi.mock("@/lib/commandTextInput", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    CommandTextInput: (props: Props) => react.createElement("command-text-input", props),
    isCommandTextInputAvailable: true,
  };
});
vi.mock("@/lib/hardwareKeyboard", () => ({ useHardwareKeyboard: () => false }));
vi.mock("@/lib/keyCapture", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    KeyCaptureView: (props: Props) => react.createElement("key-capture", props),
    isKeyCaptureAvailable: true,
    isKeyCaptureChordAvailable: false,
  };
});
vi.mock("./SlideElementContentNative", () => ({
  SlideElementContentNative: () => null,
}));

import { SlidesEditorNative } from "./SlidesEditorNative";
import {
  CANVAS_H,
  CANVAS_W,
  emptySlide,
  emptyDeck,
  type Deck,
  type SlideOp,
} from "../../../vendor/shared/slidesScene";

function twoSlideDeck(): Deck {
  const deck = emptyDeck("Test deck", "slide-1");
  return { ...deck, slides: [...deck.slides, emptySlide("slide-2")] };
}

function findByTestID(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.find((node) => node.props?.testID === testID);
}

async function mountEditorMidTextEdit(text: string) {
  const ops: SlideOp[][] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = create(
      createElement(SlidesEditorNative, {
        deck: twoSlideDeck(),
        onOps: (batch: SlideOp[]) => {
          ops.push(batch);
          return true;
        },
      }),
    );
  });

  // Give the canvas a size — the text overlay only renders once it has scale.
  const layoutEvent = {
    nativeEvent: { layout: { width: CANVAS_W, height: CANVAS_H } },
  };
  await act(async () => {
    for (const node of renderer.root.findAll(
      (candidate) => typeof candidate.props?.onLayout === "function",
    )) {
      node.props.onLayout(layoutEvent);
    }
  });

  // Insert a text box; the editor selects the element the op created.
  await act(async () => {
    findByTestID(renderer, "slides-toolbar-insert-text").props.onPress();
  });

  // Enter it (hardware-keyboard Return on the selected text element).
  await act(async () => {
    renderer.root.find(
      (node) => node.props.active === true && typeof node.props.onSubmit === "function",
    ).props.onSubmit();
  });

  // Type, without ever blurring the input.
  const input = renderer.root.find(
    (node) => node.props.accessibilityLabel === "Slide text",
  );
  await act(async () => {
    input.props.onChangeText(text);
  });

  return { renderer, ops, opsBefore: () => ops.length };
}

function textCommits(ops: SlideOp[][], from: number) {
  return ops
    .slice(from)
    .flat()
    .filter((op) => op.op === "patchElement" && op.text !== undefined);
}

describe("SlidesEditorNative — editing text across a slide change", () => {
  it("commits the in-flight text edit when the active slide changes", async () => {
    const { renderer, ops } = await mountEditorMidTextEdit("Photosynthesis notes");
    const before = ops.length;

    // Tap slide 2's thumbnail. The overlay unmounts with the slide change, so
    // the draft has to be committed by this path rather than by its onBlur.
    await act(async () => {
      findByTestID(renderer, "slides-thumbnail-slide-2").props.onPress();
    });

    const committed = textCommits(ops, before);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({
      slideId: "slide-1",
      text: "Photosynthesis notes",
    });

    await act(async () => renderer.unmount());
  });

  it("keeps both the typed text and the new slide when adding a slide mid-edit", async () => {
    const { renderer, ops } = await mountEditorMidTextEdit("Chloroplasts");
    const before = ops.length;

    await act(async () => {
      findByTestID(renderer, "slides-add-slide").props.onPress();
    });

    expect(textCommits(ops, before)).toHaveLength(1);
    // The added slide must survive the second mutation of the same tick.
    const thumbnails = new Set(
      renderer.root
        .findAll((node) =>
          String(node.props?.testID ?? "").startsWith("slides-thumbnail-"),
        )
        .map((node) => node.props.testID as string),
    );
    expect(thumbnails.size).toBe(3);

    await act(async () => renderer.unmount());
  });
});

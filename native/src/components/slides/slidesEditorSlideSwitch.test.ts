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

const { showActionSheet, dismissActionSheet } = vi.hoisted(() => ({
  showActionSheet: vi.fn(),
  dismissActionSheet: vi.fn(),
}));

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props, children);
  return {
    ActionSheetIOS: { showActionSheetWithOptions: showActionSheet, dismissActionSheet },
    ActivityIndicator: () => null,
    Alert: { alert: vi.fn() },
    findNodeHandle: () => 1,
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
    default: {
      View: view,
      ScrollView: ({ children, ...props }: Props) =>
        react.createElement("scroll-view", props, children),
    },
    useAnimatedRef: () => ({ current: null }),
    runOnJS: <T,>(fn: T) => fn,
    useAnimatedReaction: () => undefined,
    withTiming: <T,>(value: T) => value,
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

vi.mock("react-native-sortables", () => import("./sortablesTestMock"));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("phosphor-react-native", () => ({ ScribbleIcon: () => null }));
vi.mock("@/theme", () => ({
  fonts: new Proxy<Record<string, string>>({}, { get: () => "font" }),
  // Each colour is its own name, so a test can tell the highlight from a border.
  useColors: () => new Proxy<Record<string, string>>({}, { get: (_, key) => String(key) }),
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
  applySlideOps,
  emptySlide,
  emptyDeck,
  makeDeckIdFactory,
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
  const onOps = (batch: SlideOp[]) => {
    ops.push(batch);
    return true;
  };

  await act(async () => {
    renderer = create(createElement(SlidesEditorNative, { deck: twoSlideDeck(), onOps }));
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

  return { renderer, ops, onOps, opsBefore: () => ops.length };
}

/** The deck the server holds after the editor's own batches, as a later revision. */
function serverDeckAfter(ops: SlideOp[][], extra: SlideOp[]): Deck {
  let deck = twoSlideDeck();
  for (const batch of [...ops, extra]) {
    const result = applySlideOps(deck, batch, makeDeckIdFactory(deck));
    if (!result.ok) throw new Error(result.error);
    deck = result.deck;
  }
  return { ...deck, revision: deck.revision + 100 };
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

  it("stays on the scholar's slide and saves the draft there when the tutor reorders slides (TRA-704)", async () => {
    const { renderer, ops, onOps } = await mountEditorMidTextEdit("Light reactions");
    const before = ops.length;

    // The tutor moves the slide being edited to the end. The scholar's slide
    // was at index 0; slide-2 now sits there.
    const reordered = serverDeckAfter(ops, [
      { op: "moveSlide", slideId: "slide-1" },
    ]);
    expect(reordered.slides.map((s) => s.id)).toEqual(["slide-2", "slide-1"]);
    await act(async () => {
      renderer.update(createElement(SlidesEditorNative, { deck: reordered, onOps }));
    });

    // The text box is still open under the scholar's fingers.
    const input = renderer.root.find(
      (node) => node.props.accessibilityLabel === "Slide text",
    );
    expect(input.props.value ?? input.props.defaultValue).toBe("Light reactions");

    // The unmount backstop persists the draft; it must land on slide-1.
    await act(async () => renderer.unmount());
    const committed = textCommits(ops, before);
    expect(committed).toHaveLength(1);
    expect(committed[0]).toMatchObject({ slideId: "slide-1", text: "Light reactions" });
  });
});

describe("SlidesEditorNative — dragging a thumbnail", () => {
  async function mount() {
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
    const railOrder = () =>
      renderer.root
        .findAll((node) => String(node.props?.testID ?? "").startsWith("slides-thumbnail-"))
        .map((node) => (node.props.testID as string).replace("slides-thumbnail-", ""));
    return { renderer, ops, railOrder };
  }

  it("moves the slide with one moveSlide op and redraws the rail in the new order", async () => {
    const { renderer, ops, railOrder } = await mount();

    await act(async () => {
      findByTestID(renderer, "slides-thumbnail-slide-2").props.onDropAt(0);
    });

    expect(ops).toEqual([[{ op: "moveSlide", slideId: "slide-2", afterSlideId: null }]]);
    expect(railOrder()).toEqual(["slide-2", "slide-1"]);

    // One undo puts it back.
    await act(async () => {
      findByTestID(renderer, "slides-toolbar-undo").props.onPress();
    });
    expect(railOrder()).toEqual(["slide-1", "slide-2"]);

    await act(async () => renderer.unmount());
  });

  it("opens the slide menu only after a still hold, and a drag after it closes it", async () => {
    const { renderer, ops } = await mount();
    showActionSheet.mockClear();
    const hold = (slideId: string, gesture: string, ...args: number[]) =>
      act(async () => {
        findByTestID(renderer, `slides-thumbnail-${slideId}`).props[gesture](...args);
      });

    // Lifted and let go before the hold became a long press: no menu.
    await hold("slide-1", "onShortHold");
    expect(showActionSheet).not.toHaveBeenCalled();

    // Lifted and dragged straight away: a drag, so no menu, and nothing moved.
    await hold("slide-1", "onDragAway");
    expect(showActionSheet).not.toHaveBeenCalled();
    expect(ops).toEqual([]);

    // A real reorder opens no menu either.
    await hold("slide-2", "onDropAt", 0);
    expect(showActionSheet).not.toHaveBeenCalled();
    ops.length = 0;

    // Held still past the long-press time and let go: the menu opens.
    await hold("slide-1", "onLongPress");
    expect(showActionSheet).toHaveBeenCalledTimes(1);
    expect(dismissActionSheet).not.toHaveBeenCalled();
    expect(ops).toEqual([]);

    // Held until the menu opens, then dragged to another slot after all: the
    // menu goes and the slide moves. (The reorder above put slide-1 second.)
    showActionSheet.mockClear();
    await hold("slide-1", "onHoldThenDropAt", 0);
    expect(showActionSheet).toHaveBeenCalledTimes(1);
    expect(dismissActionSheet).toHaveBeenCalledTimes(1);
    expect(ops.flat()).toEqual([expect.objectContaining({ op: "moveSlide", slideId: "slide-1" })]);

    await act(async () => renderer.unmount());
  });

  it("runs the chosen menu action", async () => {
    const { renderer, ops } = await mount();
    showActionSheet.mockClear();
    await act(async () => {
      findByTestID(renderer, "slides-thumbnail-slide-2").props.onLongPress();
    });
    const [{ options, destructiveButtonIndex }, choose] = showActionSheet.mock.calls[0] as [
      { options: string[]; destructiveButtonIndex: number },
      (index: number) => void,
    ];
    expect(options[destructiveButtonIndex]).toBe("Delete slide");
    await act(async () => choose(destructiveButtonIndex));
    expect(ops.flat()).toEqual([
      expect.objectContaining({ op: "removeSlide", slideId: "slide-2" }),
    ]);
    await act(async () => renderer.unmount());
  });

  it("keeps the slide on screen when another slide is dragged past it", async () => {
    const { renderer, railOrder } = await mount();
    // slide-1 is on screen; drag slide-2 in front of it.
    await act(async () => {
      findByTestID(renderer, "slides-thumbnail-slide-2").props.onDropAt(0);
    });
    expect(railOrder()).toEqual(["slide-2", "slide-1"]);
    expect(
      findByTestID(renderer, "slides-thumbnail-slide-1").props.accessibilityLabel,
    ).toBe("Open slide 2");
    const current = renderer.root.findAll(
      (node) =>
        String(node.props?.testID ?? "").startsWith("slides-thumbnail-") &&
        [node.props.style].flat(Infinity).some((s) => s?.borderColor === "cyan"),
    );
    expect(current.map((node) => node.props.testID)).toEqual(["slides-thumbnail-slide-1"]);
    await act(async () => renderer.unmount());
  });
});

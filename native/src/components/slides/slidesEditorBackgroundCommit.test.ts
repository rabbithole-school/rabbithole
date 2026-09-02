/**
 * An in-flight text draft lives ONLY in this component, so anything that can
 * interrupt a scholar mid-sentence has to write it through.
 *
 * The editor used to commit on exactly three paths — blur, slide switch, and
 * the host's close/present/export — none of which fire when iPadOS backgrounds
 * the app or a kid force-quits it from the app switcher. Typed text was then
 * lost permanently. These tests pin the three new triggers (idle auto-save,
 * backgrounding, unmount) AND the property that makes them safe: they PERSIST
 * without ending the edit session, so they never close the overlay under a
 * scholar who is still typing and never delete a box they are about to fill.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Record<string, unknown> & { children?: ReactNode };

const { appStateListeners } = vi.hoisted(() => ({
  appStateListeners: new Set<(state: string) => void>(),
}));

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
      addEventListener: (_event: string, listener: (state: string) => void) => {
        appStateListeners.add(listener);
        return { remove: () => appStateListeners.delete(listener) };
      },
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
  PLACEHOLDER_CASCADE_STEP,
  emptyDeck,
  type SlideOp,
} from "../../../vendor/shared/slidesScene";

/** The 2s idle window in SlidesEditorNative, plus a tick. */
const PAST_AUTOSAVE_MS = 2100;

function findByTestID(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.find((node) => node.props?.testID === testID);
}

/** The text overlay, or nothing when the edit session has closed. `deep: false`
 *  keeps the mock's host child from double-counting the one input. */
function textInput(renderer: ReactTestRenderer) {
  return renderer.root.findAll(
    (node) => node.props?.accessibilityLabel === "Slide text",
    { deep: false },
  );
}

function textOps(ops: SlideOp[][], from: number) {
  return ops
    .slice(from)
    .flat()
    .filter(
      (op) =>
        (op.op === "patchElement" && op.text !== undefined) ||
        op.op === "removeElement",
    );
}

async function mountEditor() {
  const ops: SlideOp[][] = [];
  let renderer!: ReactTestRenderer;

  await act(async () => {
    renderer = create(
      createElement(SlidesEditorNative, {
        deck: emptyDeck("Test deck", "slide-1"),
        onOps: (batch: SlideOp[]) => {
          ops.push(batch);
          return true;
        },
      }),
    );
  });

  // The canvas only renders its overlays once it has a measured size.
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

  return { renderer, ops };
}

/** Insert a text box, open it for editing, and (optionally) type into it. */
async function mountMidTextEdit(text?: string) {
  const { renderer, ops } = await mountEditor();

  await act(async () => {
    findByTestID(renderer, "slides-toolbar-insert-text").props.onPress();
  });
  await act(async () => {
    renderer.root.find(
      (node) => node.props.active === true && typeof node.props.onSubmit === "function",
    ).props.onSubmit();
  });

  if (text !== undefined) {
    await act(async () => {
      textInput(renderer)[0].props.onChangeText(text);
    });
  }

  return { renderer, ops, before: ops.length };
}

afterEach(() => {
  appStateListeners.clear();
  vi.useRealTimers();
});

describe("SlidesEditorNative — flushing an in-flight draft", () => {
  it("writes the draft through when the app is backgrounded, without closing the overlay", async () => {
    const { renderer, ops, before } = await mountMidTextEdit("Photosynthesis notes");

    await act(async () => {
      for (const listener of appStateListeners) listener("background");
    });

    expect(textOps(ops, before)).toEqual([
      {
        op: "patchElement",
        slideId: "slide-1",
        id: "el1",
        text: "Photosynthesis notes",
      },
    ]);
    // The scholar is still in the box — a flush must not steal the caret.
    expect(textInput(renderer)).toHaveLength(1);

    await act(async () => renderer.unmount());
  });

  it("auto-saves an idle draft and leaves the edit session open", async () => {
    vi.useFakeTimers();
    const { renderer, ops, before } = await mountMidTextEdit("Chloroplasts");

    await act(async () => {
      vi.advanceTimersByTime(PAST_AUTOSAVE_MS);
    });

    expect(textOps(ops, before)).toHaveLength(1);
    expect(textInput(renderer)).toHaveLength(1);

    // The eventual blur has nothing left to write: the auto-save already
    // landed this exact text in the local deck.
    const afterAutosave = ops.length;
    await act(async () => {
      textInput(renderer)[0].props.onBlur();
    });
    expect(textOps(ops, afterAutosave)).toHaveLength(0);
    expect(textInput(renderer)).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("does not re-run the idle auto-save while the draft is unchanged", async () => {
    vi.useFakeTimers();
    const { renderer, ops, before } = await mountMidTextEdit("Stomata");

    await act(async () => {
      vi.advanceTimersByTime(PAST_AUTOSAVE_MS);
    });
    await act(async () => {
      vi.advanceTimersByTime(PAST_AUTOSAVE_MS * 3);
    });

    expect(textOps(ops, before)).toHaveLength(1);

    await act(async () => renderer.unmount());
  });

  it("flushes the draft on unmount", async () => {
    const { renderer, ops, before } = await mountMidTextEdit("Xylem");

    await act(async () => renderer.unmount());

    expect(textOps(ops, before)).toEqual([
      { op: "patchElement", slideId: "slide-1", id: "el1", text: "Xylem" },
    ]);
  });

  it("never writes a blank draft through a flush — the box is removed on defocus instead", async () => {
    vi.useFakeTimers();
    const { renderer, ops, before } = await mountMidTextEdit("   ");

    // Persisting whitespace would make the blur below look like an unchanged
    // commit, leaving the invisible box behind.
    await act(async () => {
      vi.advanceTimersByTime(PAST_AUTOSAVE_MS);
    });
    for (const listener of appStateListeners) {
      await act(async () => listener("background"));
    }
    expect(textOps(ops, before)).toHaveLength(0);

    await act(async () => {
      textInput(renderer)[0].props.onBlur();
    });
    expect(textOps(ops, before)).toEqual([
      { op: "removeElement", slideId: "slide-1", id: "el1" },
    ]);

    await act(async () => renderer.unmount());
  });
});

describe("SlidesEditorNative — committing a text edit", () => {
  it("removes a box the scholar emptied rather than leaving an invisible one", async () => {
    const { renderer, ops, before } = await mountMidTextEdit("");

    await act(async () => {
      textInput(renderer)[0].props.onBlur();
    });

    expect(textOps(ops, before)).toEqual([
      { op: "removeElement", slideId: "slide-1", id: "el1" },
    ]);

    await act(async () => renderer.unmount());
  });

  it("leaves a box that was opened and closed untouched exactly as it was", async () => {
    const { renderer, ops, before } = await mountMidTextEdit();

    await act(async () => {
      textInput(renderer)[0].props.onBlur();
    });

    expect(textOps(ops, before)).toHaveLength(0);

    await act(async () => renderer.unmount());
  });
});

describe("SlidesEditorNative — inserting elements", () => {
  /** The frames of every addElement op emitted so far, in order. */
  function insertedFrames(ops: SlideOp[][]) {
    return ops
      .flat()
      .filter((op): op is Extract<SlideOp, { op: "addElement" }> => op.op === "addElement")
      .map((op) => (op.element as { frame: { x: number; y: number } }).frame);
  }

  it("cascades a repeated insert instead of stacking it on the first", async () => {
    const { renderer, ops } = await mountEditor();

    for (const _ of [0, 1]) {
      await act(async () => {
        findByTestID(renderer, "slides-toolbar-insert-rect").props.onPress();
      });
    }

    const inserts = insertedFrames(ops);
    expect(inserts).toHaveLength(2);
    expect(inserts[1].x - inserts[0].x).toBe(PLACEHOLDER_CASCADE_STEP);
    expect(inserts[1].y - inserts[0].y).toBe(PLACEHOLDER_CASCADE_STEP);

    await act(async () => renderer.unmount());
  });

  it("cascades two taps that land before any re-render", async () => {
    const { renderer, ops } = await mountEditor();

    // BOTH taps inside ONE act, so React never re-renders between them and the
    // rendered `slide` still describes the empty canvas for the second one.
    // Measuring occupancy from that stale closure put both rectangles on the
    // identical frame; only visibleDeckRef knows about the first insert.
    await act(async () => {
      const insert = findByTestID(renderer, "slides-toolbar-insert-rect");
      insert.props.onPress();
      insert.props.onPress();
    });

    const inserts = insertedFrames(ops);
    expect(inserts).toHaveLength(2);
    expect(inserts[1].x - inserts[0].x).toBe(PLACEHOLDER_CASCADE_STEP);
    expect(inserts[1].y - inserts[0].y).toBe(PLACEHOLDER_CASCADE_STEP);

    await act(async () => renderer.unmount());
  });
});

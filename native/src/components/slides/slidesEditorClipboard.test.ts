/**
 * Copy and paste of slides from the native editor's slide menu.
 *
 * Each night of a multi-night unit is its own deck, so a scholar assembling the
 * final deck copies slides out of one editor and pastes them into another. The
 * menu opens beside a thumbnail when it is held; these tests read its rows and
 * press them the way iOS would.
 */
import { createElement, type ReactNode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = Record<string, unknown> & { children?: ReactNode };
type MenuButton = { text: string; onPress?: () => void };

const { alert, announce, showActionSheet, dismissActionSheet } = vi.hoisted(() => ({
  alert: vi.fn(),
  announce: vi.fn(),
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
    AccessibilityInfo: { announceForAccessibility: announce },
    ActionSheetIOS: { showActionSheetWithOptions: showActionSheet, dismissActionSheet },
    ActivityIndicator: () => null,
    Alert: { alert },
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
  clearSlideClipboard,
  copySlidesToClipboard,
  getSlideClipboardSnapshot,
} from "../../../vendor/shared/slideClipboard";
import {
  CANVAS_H,
  CANVAS_W,
  MAX_SLIDES_PER_DECK,
  SLIDES_COPY,
  emptySlide,
  emptyDeck,
  type Deck,
  type SlideOp,
} from "../../../vendor/shared/slidesScene";

const OWNER = "user-a";

function deckWithSlides(...ids: string[]): Deck {
  const [first, ...rest] = ids;
  const deck = emptyDeck("Test deck", first);
  return { ...deck, slides: [...deck.slides, ...rest.map((id) => emptySlide(id))] };
}

function findByTestID(renderer: ReactTestRenderer, testID: string) {
  return renderer.root.find((node) => node.props?.testID === testID);
}

function thumbnailIds(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      (node) =>
        // Host nodes only: the composite Pressable carries the same props.
        typeof node.type === "string" &&
        typeof node.props?.testID === "string" &&
        node.props.testID.startsWith("slides-thumbnail-") &&
        typeof node.props.onLongPress === "function",
    )
    .map((node) => (node.props.testID as string).replace("slides-thumbnail-", ""));
}

async function mount(
  deck: Deck,
  clipboardOwnerId?: string | null,
  saveResult: (batch: SlideOp[]) => boolean | Promise<boolean> = () => true,
) {
  const ops: SlideOp[][] = [];
  const indexChanges: number[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      createElement(SlidesEditorNative, {
        deck,
        clipboardOwnerId,
        onOps: (batch: SlideOp[]) => {
          ops.push(batch);
          return saveResult(batch);
        },
        onSlideIndexChange: (i: number) => indexChanges.push(i),
      }),
    );
  });
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
  return { renderer, ops, indexChanges };
}

/** Hold a rail thumbnail and return the action sheet's choices, Cancel left out. */
async function openMenu(renderer: ReactTestRenderer, slideId: string) {
  showActionSheet.mockClear();
  await act(async () => {
    findByTestID(renderer, `slides-thumbnail-${slideId}`).props.onLongPress();
  });
  expect(showActionSheet).toHaveBeenCalledTimes(1);
  const [{ options, cancelButtonIndex }, choose] = showActionSheet.mock.calls[0] as [
    { options: string[]; cancelButtonIndex: number },
    (index: number) => void,
  ];
  expect(options[cancelButtonIndex]).toBe(SLIDES_COPY.cancel);
  return options
    .map((text, index): MenuButton => ({ text, onPress: () => choose(index) }))
    .filter((_, index) => index !== cancelButtonIndex);
}

async function press(buttons: MenuButton[], text: string) {
  const button = buttons.find((b) => b.text === text);
  expect(button, `menu button "${text}"`).toBeDefined();
  await act(async () => {
    button!.onPress?.();
  });
}

afterEach(() => {
  clearSlideClipboard();
  alert.mockReset();
  announce.mockReset();
  vi.useRealTimers();
});

describe("SlidesEditorNative — slide menu copy and paste", () => {
  it("keeps today's menu when no clipboard owner is given", async () => {
    copySlidesToClipboard(OWNER, deckWithSlides("other-1").slides);
    const { renderer } = await mount(deckWithSlides("slide-1", "slide-2"));

    const buttons = await openMenu(renderer, "slide-1");
    expect(buttons.map((b) => b.text)).toEqual([
      SLIDES_COPY.addSlideBefore,
      SLIDES_COPY.addSlideAfter,
      SLIDES_COPY.duplicateSlide,
      SLIDES_COPY.deleteSlide,
    ]);

    await act(async () => renderer.unmount());
  });

  it("offers Copy slide and Copy all slides, and no Paste while nothing is copied", async () => {
    const { renderer } = await mount(deckWithSlides("slide-1", "slide-2"), OWNER);

    const buttons = await openMenu(renderer, "slide-2");
    expect(buttons.map((b) => b.text)).toEqual([
      SLIDES_COPY.addSlideBefore,
      SLIDES_COPY.addSlideAfter,
      SLIDES_COPY.duplicateSlide,
      SLIDES_COPY.copySlide,
      SLIDES_COPY.copyAllSlides,
      SLIDES_COPY.deleteSlide,
    ]);

    await act(async () => renderer.unmount());
  });

  it("copies one slide, confirms it, then offers Paste in the right place", async () => {
    vi.useFakeTimers();
    const { renderer } = await mount(deckWithSlides("slide-1", "slide-2"), OWNER);

    await press(await openMenu(renderer, "slide-2"), SLIDES_COPY.copySlide);

    const copied = getSlideClipboardSnapshot();
    expect(copied?.ownerId).toBe(OWNER);
    expect(copied?.slides.map((s) => s.id)).toEqual(["slide-2"]);
    const message = SLIDES_COPY.copiedSlides(1);
    expect(findByTestID(renderer, "slides-copy-notice").props.accessibilityLiveRegion).toBe(
      "polite",
    );
    expect(announce).toHaveBeenCalledWith(message);

    const buttons = await openMenu(renderer, "slide-1");
    expect(buttons.map((b) => b.text)).toEqual([
      SLIDES_COPY.addSlideBefore,
      SLIDES_COPY.addSlideAfter,
      SLIDES_COPY.duplicateSlide,
      SLIDES_COPY.copySlide,
      SLIDES_COPY.copyAllSlides,
      SLIDES_COPY.pasteSlidesAfter(1),
      SLIDES_COPY.deleteSlide,
    ]);

    // The notice goes away on its own.
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(
      renderer.root.findAll((node) => node.props?.testID === "slides-copy-notice"),
    ).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("never offers another user's copied slides", async () => {
    copySlidesToClipboard("user-b", deckWithSlides("other-1").slides);
    const { renderer } = await mount(deckWithSlides("slide-1"), OWNER);

    const texts = (await openMenu(renderer, "slide-1")).map((b) => b.text);
    expect(texts.some((t) => t.startsWith("Paste"))).toBe(false);

    await act(async () => renderer.unmount());
  });

  it("pastes every copied slide after the chosen one in ONE batch, opens the first, and undoes in one step", async () => {
    copySlidesToClipboard(OWNER, deckWithSlides("night1-a", "night1-b").slides);
    const { renderer, ops, indexChanges } = await mount(
      deckWithSlides("slide-1", "slide-2"),
      OWNER,
    );

    await press(await openMenu(renderer, "slide-1"), SLIDES_COPY.pasteSlidesAfter(2));

    expect(ops).toHaveLength(1);
    expect(ops[0].map((op) => op.op)).toEqual(["addSlide", "addSlide"]);
    const after = thumbnailIds(renderer);
    expect(after).toHaveLength(4);
    expect(after[0]).toBe("slide-1");
    expect(after[3]).toBe("slide-2");
    expect(indexChanges.at(-1)).toBe(1);

    await act(async () => {
      findByTestID(renderer, "slides-toolbar-undo").props.onPress();
    });
    expect(ops).toHaveLength(2);
    expect(thumbnailIds(renderer)).toEqual(["slide-1", "slide-2"]);

    await act(async () => renderer.unmount());
  });

  it("saves a speaker note still being typed BEFORE the paste, so one Undo removes the paste", async () => {
    copySlidesToClipboard(OWNER, deckWithSlides("night1-a").slides);
    const { renderer, ops } = await mount(deckWithSlides("slide-1", "slide-2"), OWNER);

    const notes = () =>
      renderer.root.find(
        (node) =>
          node.props.accessibilityLabel === SLIDES_COPY.speakerNotes &&
          typeof node.props.onChangeText === "function",
      );
    await act(async () => notes().props.onFocus());
    await act(async () => notes().props.onChangeText("Say the hypothesis first"));

    await press(await openMenu(renderer, "slide-1"), SLIDES_COPY.pasteSlidesAfter(1));

    // The note lands first, then the paste, so the paste is the newest step.
    expect(ops.map((batch) => batch.map((op) => op.op))).toEqual([
      ["setSpeakerNotes"],
      ["addSlide"],
    ]);
    expect(thumbnailIds(renderer)).toHaveLength(3);

    await act(async () => {
      findByTestID(renderer, "slides-toolbar-undo").props.onPress();
    });
    expect(ops.at(-1)?.map((op) => op.op)).toEqual(["removeSlide"]);
    expect(thumbnailIds(renderer)).toEqual(["slide-1", "slide-2"]);

    await act(async () => renderer.unmount());
  });

  it("keeps text typed while a paste waits for the notes to save", async () => {
    copySlidesToClipboard(OWNER, deckWithSlides("night1-a").slides);
    let finishNotesSave!: () => void;
    const notesSave = new Promise<boolean>((resolve) => {
      finishNotesSave = () => resolve(true);
    });
    const { renderer, ops } = await mount(
      deckWithSlides("slide-1", "slide-2"),
      OWNER,
      (batch) => (batch[0]?.op === "setSpeakerNotes" ? notesSave : true),
    );

    const notes = () =>
      renderer.root.find(
        (node) =>
          node.props.accessibilityLabel === SLIDES_COPY.speakerNotes &&
          typeof node.props.onChangeText === "function",
      );
    await act(async () => notes().props.onFocus());
    await act(async () => notes().props.onChangeText("Say the hypothesis first"));
    await press(await openMenu(renderer, "slide-1"), SLIDES_COPY.pasteSlidesAfter(1));

    // The notes save is still in flight: start a text box and type into it.
    await act(async () => {
      findByTestID(renderer, "slides-toolbar-insert-text").props.onPress();
    });
    await act(async () => {
      renderer.root
        .find(
          (node) => node.props.active === true && typeof node.props.onSubmit === "function",
        )
        .props.onSubmit();
    });
    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === "Slide text")
        .props.onChangeText("Data table");
    });

    await act(async () => {
      finishNotesSave();
      await notesSave;
    });

    expect(JSON.stringify(ops)).toContain("Data table");
    // The text is saved before the paste, so the paste is the newest batch
    // and one Undo removes it.
    expect(ops.at(-1)?.map((op) => op.op)).toEqual(["addSlide"]);
    expect(thumbnailIds(renderer)).toHaveLength(3);
    await act(async () => {
      findByTestID(renderer, "slides-toolbar-undo").props.onPress();
    });
    expect(ops.at(-1)?.map((op) => op.op)).toEqual(["removeSlide"]);
    expect(thumbnailIds(renderer)).toEqual(["slide-1", "slide-2"]);

    await act(async () => renderer.unmount());
  });

  it("copies the text a scholar is still typing", async () => {
    const { renderer } = await mount(deckWithSlides("slide-1", "slide-2"), OWNER);

    await act(async () => {
      findByTestID(renderer, "slides-toolbar-insert-text").props.onPress();
    });
    await act(async () => {
      renderer.root
        .find(
          (node) => node.props.active === true && typeof node.props.onSubmit === "function",
        )
        .props.onSubmit();
    });
    await act(async () => {
      renderer.root
        .find((node) => node.props.accessibilityLabel === "Slide text")
        .props.onChangeText("Water cycle");
    });

    await press(await openMenu(renderer, "slide-1"), SLIDES_COPY.copyAllSlides);

    const copied = getSlideClipboardSnapshot()?.slides ?? [];
    expect(copied.map((s) => s.id)).toEqual(["slide-1", "slide-2"]);
    const texts = copied[0].elementIds.map((id) => {
      const el = copied[0].elements[id];
      return el.type === "text" ? el.text : null;
    });
    expect(texts).toContain("Water cycle");

    await act(async () => renderer.unmount());
  });

  it("says so, and writes nothing, when the deck has no room", async () => {
    const full = deckWithSlides(
      ...Array.from({ length: MAX_SLIDES_PER_DECK }, (_, i) => `slide-${i + 1}`),
    );
    copySlidesToClipboard(OWNER, deckWithSlides("extra").slides);
    const { renderer, ops } = await mount(full, OWNER);

    await press(await openMenu(renderer, "slide-1"), SLIDES_COPY.pasteSlidesAfter(1));

    expect(alert).toHaveBeenLastCalledWith(SLIDES_COPY.pasteNoRoom);
    expect(ops).toHaveLength(0);

    await act(async () => renderer.unmount());
  });

  it("duplicates a slide right after itself, in one batch, without the clipboard", async () => {
    const { renderer, ops } = await mount(deckWithSlides("slide-1", "slide-2"));

    await press(await openMenu(renderer, "slide-1"), SLIDES_COPY.duplicateSlide);

    expect(ops).toEqual([
      [
        expect.objectContaining({
          op: "addSlide",
          afterSlideId: "slide-1",
          uniqueElementIds: true,
          slide: expect.objectContaining({ id: "slide-1" }),
        }),
      ],
    ]);

    await act(async () => renderer.unmount());
  });
});

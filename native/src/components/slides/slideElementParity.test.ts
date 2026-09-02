import { createElement, type ReactNode } from "react";
import { act, create } from "react-test-renderer";
import { Ellipse } from "react-native-svg";
import { describe, expect, it, vi } from "vitest";

const { Text, View, passthrough } = vi.hoisted(() => {
  const text = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("text", props, children);
  const view = ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("view", props, children);
  return {
    Text: text,
    View: view,
    passthrough: ({ children }: { children?: ReactNode }) => children ?? null,
  };
});

vi.mock("react-native", () => ({
  Pressable: passthrough,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text,
  View,
}));
vi.mock("expo-image", () => ({ Image: passthrough }));
vi.mock("expo-video", () => ({
  useVideoPlayer: () => ({ pause: vi.fn(), play: vi.fn() }),
  VideoView: passthrough,
}));
vi.mock("react-native-svg", () => ({
  default: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("svg", props, children),
  Ellipse: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("ellipse", props, children),
}));
vi.mock("react-native-external-display", () => ({
  default: passthrough,
  useExternalDisplay: () => ({}),
}));
vi.mock("react-native-gesture-handler", () => ({
  Gesture: { Pan: () => ({ activeOffsetX: () => ({ failOffsetY: () => ({ onEnd: () => ({ runOnJS: () => ({}) }) }) }) }) },
  GestureDetector: passthrough,
}));
vi.mock("expo-keep-awake", () => ({ useKeepAwake: vi.fn() }));
vi.mock("expo-print", () => ({ printAsync: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({}) }));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", medium: "medium", regular: "regular" },
  useColors: () => ({ border: "#ddd", fgMuted: "#666" }),
}));
vi.mock("@/contexts/AsamControllerContext", () => ({
  usePresentationAsam: () => ({
    releaseForSystemUI: vi.fn(),
    restoreAfterSystemUI: vi.fn(),
  }),
}));
vi.mock("@/lib/presentationExternalDisplay", () => ({
  getPresentationDisplayState: () => ({
    externalScreenId: null,
    hasExternalScreen: false,
    connected: false,
    canPrintNotes: false,
    mainScreenMode: "slide",
  }),
}));

import { SlideElementContentNative } from "./SlideElementContentNative";
import type { SlideElement } from "../../../vendor/shared/slidesScene";
import {
  clipsOverflow,
  lineStrokeLogical,
  TEXT_LINE_HEIGHT_RATIO,
  TEXT_PADDING,
  verticalAlignToJustify,
} from "../../../vendor/shared/slidesRenderContract";
import { SlideElementView } from "./SlidesPresentationNative";

const frame = { x: 0, y: 0, w: 100, h: 100, rotation: 0 };

function textElement(fontSize: number): SlideElement {
  return {
    id: "text",
    type: "text",
    frame,
    text: "A text element",
    style: {
      align: "left",
      bold: false,
      color: "#222656",
      fontSize,
      italic: false,
      verticalAlign: "top",
    },
  };
}

function lineElement(strokeWidth: number): Extract<SlideElement, { type: "line" }> {
  return {
    id: "line",
    type: "line",
    frame,
    style: { fill: null, stroke: "#222656", strokeWidth },
  };
}

function ellipseElement(): SlideElement {
  return {
    id: "ellipse",
    type: "ellipse",
    frame: { x: 0, y: 0, w: 200, h: 100, rotation: 0 },
    style: { fill: "#abcdef", stroke: "#123456", strokeWidth: 8 },
  };
}

function hasOverflowHidden(style: unknown): boolean {
  return Array.isArray(style)
    ? style.some((part) => hasOverflowHidden(part))
    : typeof style === "object" &&
        style !== null &&
        "overflow" in style &&
        style.overflow === "hidden";
}

function hasBackgroundColor(style: unknown, expected: unknown): boolean {
  return Array.isArray(style)
    ? style.some((part) => hasBackgroundColor(part, expected))
    : typeof style === "object" &&
        style !== null &&
        "backgroundColor" in style &&
        style.backgroundColor === expected;
}

describe("SlideElementContentNative render parity", () => {
  it.each([0.25, 2])(
    "scales text padding and line height at scale %s",
    (scale) => {
      const fontSize = 24;
      let renderer!: ReturnType<typeof create>;
      act(() => {
        renderer = create(
          createElement(SlideElementContentNative, { element: textElement(fontSize), scale }),
        );
      });

      const style = renderer.root.findByType(Text).props.style;
      expect(style.padding).toBe(TEXT_PADDING * scale);
      expect(style.lineHeight).toBe(fontSize * scale * TEXT_LINE_HEIGHT_RATIO);
      act(() => renderer.unmount());
    },
  );

  it("clamps line thickness before applying scale", () => {
    const scale = 0.25;
    const strokeWidth = 2;
    const element = lineElement(strokeWidth);
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(SlideElementContentNative, { element, scale }),
      );
    });

    // A post-scale clamp would incorrectly make this 1 instead of 0.5.
    // Locate the rule view by its stroke colour rather than tree position so a
    // harmless refactor of the surrounding views doesn't break this test.
    const line = renderer.root.find(
      (node) => node.type === View && hasBackgroundColor(node.props.style, element.style.stroke),
    );
    expect(line.props.style.height).toBe(lineStrokeLogical(strokeWidth) * scale);
    expect(line.props.style.height).toBe(0.5);
    act(() => renderer.unmount());
  });

  it("renders non-square ellipses with per-axis SVG radii inset for the stroke", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(SlideElementContentNative, { element: ellipseElement(), scale: 0.5 }),
      );
    });

    const ellipse = renderer.root.findByType(Ellipse);
    expect(ellipse.props).toMatchObject({
      cx: 50,
      cy: 25,
      rx: 48,
      ry: 23,
      fill: "#abcdef",
      stroke: "#123456",
      strokeWidth: 4,
    });
    expect(ellipse.props.rx).not.toBe(ellipse.props.ry);
    act(() => renderer.unmount());
  });

  it("maps vertical alignment to flexbox justification", () => {
    expect(verticalAlignToJustify("top")).toBe("flex-start");
    expect(verticalAlignToJustify("middle")).toBe("center");
    expect(verticalAlignToJustify("bottom")).toBe("flex-end");
  });

  it.each([
    ["text", true],
    ["line", false],
    ["rect", false],
    ["ellipse", false],
    ["image", false],
    ["video", false],
  ] as const)("clips %s element frames: %s", (elementType, expected) => {
    expect(clipsOverflow(elementType)).toBe(expected);
  });

  it("clips text frames but allows line strokes to overflow their frames", () => {
    let renderer!: ReturnType<typeof create>;
    act(() => {
      renderer = create(
        createElement(SlideElementView, {
          element: lineElement(12),
          scale: 1,
          videoPlaying: false,
          videoMuted: true,
        }),
      );
    });
    expect(hasOverflowHidden(renderer.root.findByType(View).props.style)).toBe(false);
    act(() => renderer.unmount());

    act(() => {
      renderer = create(
        createElement(SlideElementView, {
          element: textElement(24),
          scale: 1,
          videoPlaying: false,
          videoMuted: true,
        }),
      );
    });
    expect(hasOverflowHidden(renderer.root.findByType(View).props.style)).toBe(true);
    act(() => renderer.unmount());
  });
});

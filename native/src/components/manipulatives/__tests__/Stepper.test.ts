import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: unknown }) => children ?? null,
}));

vi.mock("react-native", () => ({
  Pressable: passthrough,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: passthrough,
  View: passthrough,
}));

vi.mock("../kit", () => ({ selectionTick: vi.fn() }));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", semibold: "semibold" },
  useColors: () => ({
    bg: "#fff",
    border: "#ddd",
    charcoalSubtle: "#666",
    fgMuted: "#555",
    gray50: "#eee",
    violet: "#7048e8",
  }),
}));

import { Stepper } from "../Stepper";

type ElementWithProps = ReactElement<Record<string, any>>;

function compactButtons() {
  return stepButtons(Stepper({
    value: 3,
    min: 0,
    max: 9,
    label: "ones",
    compact: true,
    onChange: vi.fn(),
  }));
}

function stepButtons(stepper: ElementWithProps) {
  return (Array.isArray(stepper.props.children) ? stepper.props.children : [stepper.props.children])
    .filter(
      (child): child is ElementWithProps =>
        isValidElement(child) && typeof (child as ElementWithProps).props.symbol === "string",
    )
    .map((button) => {
      if (typeof button.type !== "function") throw new Error("Expected a StepButton.");
      return (button.type as (props: Record<string, any>) => ElementWithProps)(button.props);
    });
}

function buttonStyle(button: ElementWithProps) {
  return button.props.style({ pressed: false }).filter(Boolean);
}

describe("compact native Stepper", () => {
  it("keeps both compact controls at an effective 44pt minimum target", () => {
    const buttons = compactButtons();
    expect(buttons).toHaveLength(2);
    for (const button of buttons) {
      const styles = buttonStyle(button);
      const compactStyle = styles.find((style: Record<string, unknown>) => style.minWidth === 32);

      expect(button.props.hitSlop).toBe(6);
      expect(compactStyle).toMatchObject({
        minWidth: 32,
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        maxWidth: 44,
      });
      expect((compactStyle!.minWidth as number) + 2 * (button.props.hitSlop as number)).toBe(44);
    }
  });
  it("keeps compact buttons visually aligned while non-compact buttons stay fixed at 44pt", () => {
    const compactStyles = compactButtons().map(buttonStyle);
    const standard = Stepper({
      value: 3, min: 0, max: 9, label: "ones", onChange: vi.fn(),
    });
    const standardStyles = stepButtons(standard).map(buttonStyle);
    expect(compactStyles).toHaveLength(2);
    expect(compactStyles[0]).toEqual(compactStyles[1]);
    expect(compactStyles[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ height: 44, alignItems: "center", justifyContent: "center" }),
      expect.objectContaining({ minWidth: 32 }),
    ]));
    expect(standardStyles[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({ width: 44, height: 44 }),
    ]));
  });
});

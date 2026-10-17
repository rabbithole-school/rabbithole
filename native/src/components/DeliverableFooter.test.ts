import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

/**
 * DeliverableFooter is the one "Check my work" footer shared by the chat-primary
 * DeliverablePanel and the app builder (TRA-519). These pin the states the panel
 * rendered before the extraction: the label and accessibility name per state,
 * and which presses are live.
 */

vi.mock("convex/react", () => ({ useMutation: () => vi.fn() }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("@/lib/convex", () => ({
  api: { sessions: { ensureActivitySetup: "ensureActivitySetup" } },
}));
vi.mock("./FlairChips", () => ({ FlairChips: () => null }));
vi.mock("@/theme", () => ({
  fonts: { semibold: "s" },
  useColors: () => new Proxy({}, { get: () => "#000" }),
}));
vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props as never, children as never);
  return {
    ActivityIndicator: host("spinner"),
    Pressable: host("pressable"),
    Text: host("text"),
    View: host("view"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});

import { DeliverableFooter, criteriaFor } from "./DeliverableFooter";

const base = {
  kind: "text" as const,
  mode: "manual" as const,
  flairKey: "doc",
  criteria: [],
  resolved: true,
  criteriaPending: false,
  criteriaFailed: false,
  disabled: false,
  busy: false,
  onCheck: vi.fn(),
  onRetry: vi.fn(),
};

function button(over: Partial<typeof base>) {
  let tree!: ReturnType<typeof create>;
  act(() => {
    tree = create(createElement(DeliverableFooter, { ...base, ...over }));
  });
  return tree.root.findByProps({ accessibilityRole: "button" });
}

describe("DeliverableFooter", () => {
  it("checks the work when available", () => {
    const onCheck = vi.fn();
    const b = button({ onCheck });
    expect(b.props.accessibilityLabel).toBe("Check my work");
    b.props.onPress();
    expect(onCheck).toHaveBeenCalledOnce();
  });

  it("hands work in without a rubric as 'Send this work'", () => {
    expect(button({ mode: "none" }).props.accessibilityLabel).toBe(
      "Send this work",
    );
  });

  it("is inert while busy, preparing, or disabled", () => {
    for (const over of [{ busy: true }, { criteriaPending: true }, { disabled: true }]) {
      const b = button(over);
      expect(b.props.onPress).toBeUndefined();
      expect(b.props.accessibilityState).toEqual({ disabled: true });
    }
  });

  it("turns into a retry when the rubric failed to prepare", () => {
    const onRetry = vi.fn();
    const photo = button({ criteriaFailed: true, kind: "photo", onRetry });
    expect(photo.props.accessibilityLabel).toBe(
      "Try preparing the photo check again",
    );
    photo.props.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(button({ criteriaFailed: true }).props.accessibilityLabel).toBe(
      "Try preparing the rubric check again",
    );
  });
});

describe("criteriaFor", () => {
  const criteria = [{ id: "a", label: "A" }];
  it("uses the authored rubric, the prepared one, or none", () => {
    expect(criteriaFor({ mode: "manual", criteria }, null)).toBe(criteria);
    expect(criteriaFor({ mode: "none", criteria }, null)).toEqual([]);
    expect(criteriaFor({ mode: "auto", criteria: [] }, null)).toEqual([]);
    expect(
      criteriaFor({ mode: "auto", criteria: [] }, { status: "ready", criteria }),
    ).toBe(criteria);
  });
});

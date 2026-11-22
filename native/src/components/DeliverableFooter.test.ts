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
let confirmAnswer = true;
let confirmCalls = 0;
vi.mock("@/lib/confirmFinishAndSend", () => ({
  confirmFinishAndSend: () => {
    confirmCalls += 1;
    return Promise.resolve(confirmAnswer);
  },
}));
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
    ScrollView: host("scrollview"),
    Text: host("text"),
    View: host("view"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  };
});

import {
  DeliverableFooter,
  criteriaFor,
  type DeliverableFooterProps,
} from "./DeliverableFooter";
import { QuestSessionContext, type QuestSession } from "@/lib/questSession";

const base = {
  kind: "text" as const,
  mode: "manual" as const,
  flairKey: "doc",
  sessionId: null,
  criteria: [],
  resolved: true,
  criteriaPending: false,
  criteriaFailed: false,
  disabled: false,
  busy: false,
  onCheck: vi.fn(),
  onRetry: vi.fn(),
};

function button(over: Partial<DeliverableFooterProps>) {
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

  it("hands work in without a rubric as 'Finish and send this work', asking first", async () => {
    const onCheck = vi.fn();
    const b = button({ mode: "none", onCheck });
    expect(b.props.accessibilityLabel).toBe("Finish and send this work");

    // Declined: nothing is sent and the activity stays open.
    confirmAnswer = false;
    b.props.onPress();
    await Promise.resolve();
    expect(onCheck).not.toHaveBeenCalled();

    // Confirmed: the work goes in.
    confirmAnswer = true;
    b.props.onPress();
    await Promise.resolve();
    await Promise.resolve();
    expect(onCheck).toHaveBeenCalledOnce();
  });

  it("checks rubric work without asking", () => {
    confirmCalls = 0;
    const onCheck = vi.fn();
    button({ onCheck }).props.onPress();
    expect(onCheck).toHaveBeenCalledOnce();
    expect(confirmCalls).toBe(0);
  });

  it.each([
    { criteriaPending: false, criteriaFailed: false },
    { criteriaPending: true, criteriaFailed: false },
    { criteriaPending: false, criteriaFailed: true },
  ])("finish-only asks and sends without waiting for criteria: %o", async (state) => {
    const onCheck = vi.fn();
    const onRetry = vi.fn();
    const b = button({
      ...state,
      mode: "auto",
      finishOnly: true,
      onCheck,
      onRetry,
    });
    expect(b.props.accessibilityLabel).toBe("Finish and send this work");
    expect(b.props.accessibilityState).toEqual({ disabled: false });
    expect(b.findByType("text" as never).children).toEqual(["Finish and send"]);
    expect(b.findAllByType("spinner" as never)).toHaveLength(0);

    confirmAnswer = false;
    b.props.onPress();
    await Promise.resolve();
    expect(onCheck).not.toHaveBeenCalled();

    confirmAnswer = true;
    b.props.onPress();
    await Promise.resolve();
    expect(onCheck).toHaveBeenCalledOnce();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("finish-only still respects busy or unavailable work", () => {
    for (const over of [{ busy: true }, { disabled: true }]) {
      const b = button({ ...over, finishOnly: true, criteriaFailed: true });
      expect(b.props.onPress).toBeUndefined();
      expect(b.props.accessibilityState).toEqual({ disabled: true });
      expect(b.props.accessibilityLabel).toBe("Finish and send this work");
    }
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

  describe("on a Quest's session (TRA-720)", () => {
    // The header's "I'm ready to show" is a Quest's one hand-in.
    function footerIn(
      quest: QuestSession["quest"],
      over: Partial<DeliverableFooterProps>,
    ) {
      let tree!: ReturnType<typeof create>;
      act(() => {
        tree = create(
          createElement(
            QuestSessionContext.Provider,
            { value: { quest, openReadyToShow: () => {} } },
            createElement(DeliverableFooter, { ...base, ...over }),
          ),
        );
      });
      return tree.root.findAllByProps({ accessibilityRole: "button" });
    }
    const quest = { unitId: "unit-1" } as unknown as NonNullable<QuestSession["quest"]>;

    it("offers no Finish and send, nor while the Quest is still being looked up", () => {
      expect(footerIn(quest, { mode: "none" })).toHaveLength(0);
      expect(footerIn(quest, { mode: "auto", finishOnly: true })).toHaveLength(0);
      expect(footerIn(undefined, { mode: "none" })).toHaveLength(0);
    });

    it("keeps Check my work, which hands nothing in", () => {
      const [check] = footerIn(quest, { mode: "manual" });
      expect(check.props.accessibilityLabel).toBe("Check my work");
    });

    it("leaves every other session its Finish and send", () => {
      const [send] = footerIn(null, { mode: "none" });
      expect(send.props.accessibilityLabel).toBe("Finish and send this work");
    });
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

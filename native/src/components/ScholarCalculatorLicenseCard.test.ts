import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The native Fast math + Calculator license card, tested for the properties the
 * unified design is FOR: one fixed slot order in every state, the scholar's own
 * self-relative reading (an em dash while uncalibrated, never a 0%), no score /
 * threshold / ranking / streak vocabulary, no second credential shell, a
 * button-local busy state, and a CTA that actually requests the Quick-facts run.
 */

const { routerPush, selectionAsync, licenseStatus, focusEffects } = vi.hoisted(
  () => ({
    routerPush: vi.fn(),
    selectionAsync: vi.fn(() => Promise.resolve()),
    licenseStatus: { value: undefined as unknown },
    // Every registered focus callback, so a test can replay "the scholar came
    // back to Home" without a navigator.
    focusEffects: [] as (() => void)[],
  }),
);

vi.mock("react-native", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const host =
    (name: string) =>
    ({ children, ...props }: Props) =>
      react.createElement(name, props as never, children as never);
  return {
    ActivityIndicator: (props: Props) =>
      react.createElement("activity-indicator", props as never),
    Pressable: ({ children, style, ...props }: Props) =>
      react.createElement(
        "pressable",
        {
          ...props,
          // Resolve the ({ pressed }) => style form so tests can assert the
          // wrapper's own layout (e.g. a full-width CTA).
          style: typeof style === "function" ? style({ pressed: false }) : style,
        } as never,
        children as never,
      ),
    ScrollView: host("scroll-view"),
    StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
    Text: host("text"),
    View: host("view"),
  };
});
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-router", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return {
    router: { push: routerPush },
    useFocusEffect: (effect: () => void) => {
      focusEffects.push(effect);
      react.useEffect(effect, [effect]);
    },
  };
});
vi.mock("expo-haptics", () => ({ selectionAsync }));
vi.mock("convex/react", () => ({ useQuery: () => licenseStatus.value }));
vi.mock("@/lib/convex", () => ({
  api: {
    calculatorLicenses: { myLicenseStatus: "calculatorLicenses.myLicenseStatus" },
  },
}));
vi.mock("@/theme", () => ({
  fonts: { bold: "bold", regular: "regular" },
  useColors: () => ({
    bg: "#fff",
    border: "#ddd",
    charcoal: "#222",
    charcoalMuted: "#666",
    cyanSubtle: "#eefafa",
    gray50: "#f7f7f7",
    navy: "#123",
    teal: "#16707e",
    white: "#fff",
  }),
}));

import { ScholarCalculatorLicenseCard } from "./ScholarCalculatorLicenseCard";

type JsonNode = ReturnType<ReturnType<typeof create>["toJSON"]>;

const known = {
  calibration: "known" as const,
  baselineKnown: true,
  automaticCount: 263,
  denominator: 418,
  percent: 63,
  ready: false,
};

const UNCALIBRATED = {
  state: "building" as const,
  license: null,
  fastMath: {
    calibration: "uncalibrated" as const,
    baselineKnown: false,
    automaticCount: 0,
    denominator: 418,
    percent: 0,
    ready: false,
  },
};
const PROGRESS = { state: "building" as const, license: null, fastMath: known };
const READY = {
  state: "ready" as const,
  license: null,
  fastMath: { ...known, automaticCount: 418, percent: 100, ready: true },
};
const LICENSED = {
  state: "licensed" as const,
  license: {
    issuedAt: Date.UTC(2026, 4, 12, 18, 0, 0),
    issuedByName: "Teacher Lee",
    badge: { imageUrl: null, artStatus: "ready", icon: "🧮" },
  },
  fastMath: known,
};

function render(status: unknown) {
  licenseStatus.value = status;
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(createElement(ScholarCalculatorLicenseCard));
  });
  return renderer;
}

/** Every rendered string, in visual order. */
function texts(node: JsonNode): string[] {
  if (node === null || node === undefined) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  return (node.children ?? []).flatMap((child) => texts(child as JsonNode));
}

function flatStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatStyle));
  return (style ?? {}) as Record<string, unknown>;
}

function ctaButton(renderer: ReturnType<typeof create>) {
  return renderer.root.find(
    (n) => n.type === "pressable" && n.props.accessibilityRole === "button",
  );
}

describe("ScholarCalculatorLicenseCard (native)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing while the read is in flight or the viewer is not a scholar", () => {
    expect(render(undefined).toJSON()).toBeNull();
    expect(render(null).toJSON()).toBeNull();
  });

  it("keeps ONE fixed slot order in every state", () => {
    const cases: { status: unknown; slots: string[] }[] = [
      {
        status: UNCALIBRATED,
        slots: [
          "Fast math",
          "Not licensed",
          "Calculator license",
          "—",
          "Fast math is still getting a baseline",
          "Keep practicing fast math",
          "Your own practice progress",
          "Practice fast math",
        ],
      },
      {
        status: PROGRESS,
        slots: [
          "Fast math",
          "Not licensed",
          "Calculator license",
          "63%",
          "263 of 418 facts automatic",
          "Keep practicing fast math",
          "Your own practice progress",
          "Practice fast math",
        ],
      },
      {
        status: READY,
        slots: [
          "Fast math",
          "Ready for the test",
          "Calculator license",
          "100%",
          "418 of 418 facts automatic",
          "Ask a teacher to proctor",
          "Your own practice progress",
          "Practice fast math",
        ],
      },
      {
        status: LICENSED,
        slots: [
          "Fast math",
          "Licensed",
          "Calculator license",
          "63%",
          "263 of 418 facts automatic",
          "Your Calculator License is active",
          "Your own practice progress",
          "ISSUED",
          "PROCTOR",
          "Practice fast math",
        ],
      },
    ];

    for (const { status, slots } of cases) {
      const lines = texts(render(status).toJSON());
      const positions = slots.map((slot) =>
        lines.findIndex((line) => line.includes(slot)),
      );
      expect(positions.some((index) => index < 0)).toBe(false);
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      // The eyebrow opens the card and the action always closes it.
      expect(positions[0]).toBe(0);
      expect(positions[positions.length - 1]).toBe(lines.length - 1);
    }
  });

  it("shows the scholar's own reading as an em dash until a baseline exists", () => {
    const lines = texts(render(UNCALIBRATED).toJSON());
    expect(lines).toContain("—");
    expect(lines.join(" ")).toContain("Fast math is still getting a baseline");
    expect(lines.join(" ")).not.toContain("0%");
  });

  it("shows the self-relative percent and fraction once calibrated", () => {
    const lines = texts(render(PROGRESS).toJSON());
    expect(lines).toContain("63%");
    expect(lines).toContain("263 of 418 facts automatic");
  });

  it("renders the compact fact map and exposes each square's fact and state", () => {
    const renderer = render({
      ...PROGRESS,
      fastMath: {
        ...known,
        facts: [
          {
            factKey: "mul:7x8",
            op: "mul",
            a: 7,
            b: 8,
            label: "7 × 8",
            state: "automatic",
            seenCount: 12,
            correctCount: 12,
          },
        ],
      },
    });

    const factCell = renderer.root.find(
      (node) =>
        node.type === "pressable" &&
        node.props.accessibilityLabel ===
          "7 × 8 — automatic, 12 of 12 correct",
    );
    act(() => factCell.props.onPress());
    expect(texts(renderer.toJSON())).toContain("7 × 8 — automatic");
  });

  it("never speaks in scores, thresholds, rankings, streaks, or in-app tests", () => {
    for (const status of [UNCALIBRATED, PROGRESS, READY, LICENSED]) {
      const copy = texts(render(status).toJSON()).join(" ").toLowerCase();
      for (const banned of [
        "score",
        "threshold",
        "rank",
        "streak",
        "out of 100",
        "take the test",
        "start the test",
        "passing",
      ]) {
        expect(copy).not.toContain(banned);
      }
    }
  });

  it("drops the old dark credential shell in the licensed state", () => {
    const renderer = render(LICENSED);
    const lines = texts(renderer.toJSON());
    const copy = lines.join(" ");
    expect(copy).not.toContain("RABBITHOLE");
    expect(copy).not.toContain("LICENSED TO");
    expect(copy).not.toContain("Permission to use a calculator in class");
    // Same fixed grammar as every other state, plus the credential fields.
    expect(lines).toContain("Calculator license");
    expect(lines).toContain("ISSUED");
    expect(lines).toContain("PROCTOR");
    expect(lines).toContain("Teacher Lee");
    expect(lines).toContain("Licensed");
  });

  it("keeps Issued / Proctor fields out of every unlicensed state", () => {
    for (const status of [UNCALIBRATED, PROGRESS, READY]) {
      const lines = texts(render(status).toJSON());
      expect(lines).not.toContain("ISSUED");
      expect(lines).not.toContain("PROCTOR");
      expect(lines).not.toContain("Licensed");
    }
  });

  it("uses the same card frame and alignment in every state", () => {
    const frames = [UNCALIBRATED, PROGRESS, READY, LICENSED].map((status) => {
      const root = render(status).root.findAll((n) => n.type === "view")[0];
      return flatStyle(root.props.style);
    });
    for (const frame of frames) {
      expect(frame).toEqual(frames[0]);
      expect(frame.alignItems).toBe("stretch");
    }
  });

  it("renders the action as the same full-width secondary button in every state", () => {
    const weightOf = (status: unknown) => {
      const button = ctaButton(render(status));
      const inner = button.findAll((n) => n.type === "view")[0];
      return {
        wrap: flatStyle(button.props.style),
        inner: flatStyle(inner.props.style),
      };
    };
    const weights = [UNCALIBRATED, PROGRESS, READY, LICENSED].map(weightOf);
    for (const { wrap, inner } of weights) {
      // Secondary in every state: the Math tab's primary CTA belongs to the
      // check-in / playlist card above, so this one must not compete with it.
      expect(inner.backgroundColor).toBe("transparent");
      expect(inner.borderColor).toBe("#16707e");
      // Full width, matching the sibling cards' bottom-slot buttons.
      expect(wrap.alignSelf).toBe("stretch");
      expect(inner).toEqual(weights[0].inner);
    }
    // Same label, same slot, same weight.
    for (const status of [UNCALIBRATED, PROGRESS, READY, LICENSED]) {
      expect(ctaButton(render(status)).props.accessibilityLabel).toBe(
        "Practice fast math",
      );
    }
  });

  it("routes the action to the real Quick-facts practice run", () => {
    const renderer = render(PROGRESS);
    act(() => {
      ctaButton(renderer).props.onPress();
    });
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(routerPush).toHaveBeenCalledWith({
      pathname: "/practice",
      params: { quickFacts: "1" },
    });
    expect(selectionAsync).toHaveBeenCalledTimes(1);
  });

  it("keeps busy button-local: the card state never changes and a second tap is a no-op", () => {
    const renderer = render(READY);
    const before = texts(renderer.toJSON());
    act(() => {
      ctaButton(renderer).props.onPress();
    });
    const after = texts(renderer.toJSON());

    expect(after).toContain("Starting fast math…");
    // Only the button's own words changed — every other slot is untouched.
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(ctaButton(renderer).props.accessibilityState).toEqual({
      disabled: true,
      busy: true,
    });

    act(() => {
      ctaButton(renderer).props.onPress();
    });
    expect(routerPush).toHaveBeenCalledTimes(1);

    // Home stays mounted under /practice, so coming back has to end the busy
    // text rather than leaving the card "starting" forever.
    act(() => {
      focusEffects[focusEffects.length - 1]?.();
    });
    expect(texts(renderer.toJSON())).not.toContain("Starting fast math…");
    expect(ctaButton(renderer).props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
    });
  });

  it("does not let the card root swallow the action from assistive tech", () => {
    const renderer = render(PROGRESS);
    const root = renderer.root.findAll((n) => n.type === "view")[0];
    expect(root.props.accessible).toBeUndefined();
    expect(root.props.accessibilityLabel).toBeUndefined();
    expect(ctaButton(renderer)).toBeTruthy();
  });
});

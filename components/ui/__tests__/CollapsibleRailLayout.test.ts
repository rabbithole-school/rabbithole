// @vitest-environment jsdom
// The overlay form of CollapsibleRailLayout (the School rail below lg): a
// collapsed strip whose toggle opens the rail as a modal drawer, closed by
// Escape, the rail's own collapse control, or following a link. The splitter
// form must not pick any of that up.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { system } from "@/lib/theme";
import { CollapsibleRailLayout } from "../CollapsibleRailLayout";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // jsdom has no ResizeObserver or matchMedia; the splitter form and Chakra
  // both reach for them.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

async function render(overlay: boolean) {
  await act(async () => {
    // eslint-disable-next-line react/no-children-prop -- the props type requires children in the props object
    const layout = createElement(CollapsibleRailLayout, {
      overlay,
      railId: "test-rail",
      expandAriaLabel: "Show sections",
      overlayAriaLabel: "Sections",
      rail: ({ collapse }) =>
        createElement(
          "div",
          null,
          createElement("button", { type: "button", onClick: collapse }, "Collapse"),
          createElement("a", { href: "#guardians" }, "Guardians"),
        ),
      children: createElement("main", null, "Page content"),
    });
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, { value: system, children: layout }),
    );
  });
  await settle();
}

const toggle = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Show sections"]')!;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

async function openDrawer() {
  await act(async () => toggle().click());
  await settle();
}

describe("CollapsibleRailLayout overlay form", () => {
  it("starts closed, with the expand control reporting aria-expanded=false", async () => {
    await render(true);
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain("Page content");
  });

  it("opens the rail as a labelled dialog with aria-expanded=true", async () => {
    await render(true);
    await openDrawer();
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.getAttribute("aria-label")).toBe("Sections");
    expect(d!.textContent).toContain("Guardians");
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
  });

  it("moves focus into the drawer, closes on Escape, and returns focus to the toggle", async () => {
    await render(true);
    await openDrawer();
    expect(dialog()!.contains(document.activeElement)).toBe(true);
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(dialog()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(toggle());
  });

  it("closes when a nav link is chosen", async () => {
    await render(true);
    await openDrawer();
    const link = dialog()!.querySelector("a")!;
    await act(async () => link.click());
    await settle();
    expect(dialog()).toBeNull();
  });

  it("closes from the rail's own collapse control", async () => {
    await render(true);
    await openDrawer();
    const collapse = [...dialog()!.querySelectorAll("button")].find(
      (b) => b.textContent === "Collapse",
    )!;
    await act(async () => collapse.click());
    await settle();
    expect(dialog()).toBeNull();
  });
});

describe("CollapsibleRailLayout splitter form", () => {
  it("renders the rail inline with no dialog or drawer toggle state", async () => {
    await render(false);
    expect(dialog()).toBeNull();
    expect(document.body.textContent).toContain("Guardians");
    expect(toggle().hasAttribute("aria-expanded")).toBe(false);
  });
});

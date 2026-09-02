/**
 * The web tile mark's ANNOUNCEMENT, which is the half a shared-resolver test
 * can't see. Whichever rung the chain lands on — a logo, the emoji, the
 * initial — the squircle is one image element, and every current call site
 * already names the app around it, so the mark goes quiet rather than saying
 * it a second time. Same contract as `native/src/components/AppTileMark.test.ts`.
 */
// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChakraProvider } from "@chakra-ui/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { system } from "@/lib/theme";
import { AppTileIcon, type AppTileIconProps } from "@/components/ui/AppTileIcon";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function render(props: AppTileIconProps) {
  act(() => {
    root!.render(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(AppTileIcon, props),
      }),
    );
  });
}

/** The squircle itself — the one element assistive tech is meant to see. */
function tile(): HTMLElement {
  const el = container!.firstElementChild as HTMLElement | null;
  expect(el).toBeTruthy();
  return el!;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

describe("AppTileIcon — standing on its own", () => {
  it("announces the app once on every rung", () => {
    for (const props of [
      { name: "Catalog app", iconUrl: "https://cdn.example.com/logo.png" },
      { name: "Catalog app", iconEmoji: "🧮" },
      { name: "Catalog app" },
    ] satisfies AppTileIconProps[]) {
      render(props);
      expect(tile().getAttribute("role")).toBe("img");
      expect(tile().getAttribute("aria-label")).toBe("Catalog app icon");
      // The mark inside is part of that one image, never a second one: a logo
      // with its own alt, or an emoji claiming its own image role, would be
      // announced twice.
      expect(container!.querySelectorAll('[role="img"]')).toHaveLength(1);
      expect(
        container!.querySelector("img")?.getAttribute("alt") ?? "",
      ).toBe("");
    }
  });
});

describe("AppTileIcon — decorative", () => {
  it("says nothing when the surrounding element already names the app", () => {
    for (const props of [
      {
        name: "Catalog app",
        iconUrl: "https://cdn.example.com/logo.png",
        decorative: true,
      },
      { name: "Catalog app", iconEmoji: "🧮", decorative: true },
      { name: "Catalog app", decorative: true },
    ] satisfies AppTileIconProps[]) {
      render(props);
      expect(tile().getAttribute("aria-hidden")).toBe("true");
      expect(tile().getAttribute("role")).toBeNull();
      expect(tile().getAttribute("aria-label")).toBeNull();
      // Nothing inside re-exposes the identity either.
      expect(container!.querySelectorAll('[role="img"]')).toHaveLength(0);
      expect(container!.textContent).not.toContain("Catalog app");
    }
  });
});

describe("AppTileIcon — the runtime rung", () => {
  it("falls to the emoji when the logo fails to load, staying one element", () => {
    render({
      name: "Catalog app",
      iconUrl: "https://cdn.example.com/logo.png",
      iconEmoji: "🧮",
    });
    const img = container!.querySelector("img");
    expect(img).toBeTruthy();

    act(() => {
      img!.dispatchEvent(new Event("error", { bubbles: false }));
    });

    expect(container!.querySelector("img")).toBeNull();
    expect(container!.textContent).toContain("🧮");
    expect(tile().getAttribute("aria-label")).toBe("Catalog app icon");
  });
});

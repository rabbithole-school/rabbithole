import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, test } from "vitest";

import { BuildProgress, BuildStopped } from "@/components/vibecode/BuildProgress";
import { system } from "@/lib/theme";

function render<P extends object>(node: ComponentType<P>, props: P) {
  return renderToStaticMarkup(
    // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
    createElement(ChakraProvider, {
      value: system,
      children: createElement(node, props),
    }),
  );
}

describe("BuildProgress card", () => {
  test("lists every stage and highlights the planning subtitle first", () => {
    const html = render(BuildProgress, {
      variant: "card",
      stage: "planning",
      startedAt: Date.now(),
    });
    expect(html).toContain("Planning the app");
    expect(html).toContain("Writing the app");
    expect(html).toContain("Looking at what it built");
    expect(html).toContain("Fixing what it saw");
    expect(html).toContain("usually a minute or two");
  });

  test("does not show the planning subtitle once past planning", () => {
    const html = render(BuildProgress, {
      variant: "card",
      stage: "writing",
      startedAt: Date.now(),
    });
    expect(html).not.toContain("usually a minute or two");
  });

  test("renders the Stop button when a stop handler is provided", () => {
    const html = render(BuildProgress, {
      variant: "card",
      stage: "writing",
      startedAt: Date.now(),
      onStop: () => {},
    });
    expect(html).toContain("Stop");
  });
});

describe("BuildProgress chat line", () => {
  test("shows the active stage label as a compact line", () => {
    const html = render(BuildProgress, {
      variant: "line",
      stage: "looking",
      startedAt: Date.now(),
    });
    expect(html).toContain("Looking at what it built");
  });

  test("shows m:ss elapsed", () => {
    const html = render(BuildProgress, {
      variant: "line",
      stage: "planning",
      startedAt: Date.now() - 75_000,
    });
    expect(html).toContain("1:15");
  });
});

describe("BuildStopped settled card", () => {
  test("renders the settled title and recovery line, with no ticking clock", () => {
    const html = render(BuildStopped, { onRetry: () => {} });
    expect(html).toContain("The build stopped before an app appeared");
    expect(html).toContain("Try again, or describe what to build.");
    // A retry handler renders the Try again button.
    expect(html).toMatch(/<button/);
    // No progress stages — this is the settled card, not the ticking one.
    expect(html).not.toContain("Planning the app");
    expect(html).not.toContain("Writing the app");
  });

  test("omits the Try again button when no retry handler is given", () => {
    const html = render(BuildStopped, {});
    expect(html).toContain("The build stopped before an app appeared");
    expect(html).not.toMatch(/<button/);
  });
});

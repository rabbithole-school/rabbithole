import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { describe, expect, test, vi } from "vitest";

import { ManipulativeLibrary } from "@/components/manipulative/ManipulativeLibrary";
import {
  MANIPULATIVE_KIND_LABELS,
  MANIPULATIVE_KINDS,
} from "@/components/manipulative/catalog";
import { system } from "@/lib/theme";

vi.mock("convex/react", () => ({
  useQuery: () => undefined,
}));

vi.mock("@/components/manipulative/Manipulative", () => ({
  Manipulative: () => null,
}));

vi.mock("@/components/manipulative/ThemeIconAdmin", () => ({
  ThemeIconAdmin: () => null,
}));

describe("ManipulativeLibrary accessibility", () => {
  test("names every kind-card Rehearse control with its mechanic label", () => {
    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(ManipulativeLibrary, {
          onUseKind: () => undefined,
        }),
      }),
    );
    const buttons = html.match(/<button\b[^>]*>/g) ?? [];
    const kindButtons = buttons.filter((button) =>
      button.includes('data-testid="manip-card-open-'),
    );

    expect(kindButtons).toHaveLength(MANIPULATIVE_KINDS.length);
    for (const kind of MANIPULATIVE_KINDS) {
      const button = kindButtons.find((candidate) =>
        candidate.includes(`data-testid="manip-card-open-${kind}"`),
      );
      const label = MANIPULATIVE_KIND_LABELS[kind].replaceAll("&", "&amp;");

      expect(button).toContain(`aria-label="Rehearse ${label}"`);
    }
  });
});

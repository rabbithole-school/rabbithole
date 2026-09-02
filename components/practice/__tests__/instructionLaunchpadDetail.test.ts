import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChakraProvider } from "@chakra-ui/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { system } from "@/lib/theme";

const mocks = vi.hoisted(() => ({
  parseInstructionManipulative: vi.fn(),
}));

vi.mock("@/lib/manipulative/types", () => ({
  isChallenge: vi.fn(() => false),
  parseInstructionManipulative: mocks.parseInstructionManipulative,
}));

import { InstructionLaunchpadDetailPane } from "../InstructionLaunchpadDetail";

describe("InstructionAtomCard manipulative summary", () => {
  beforeEach(() => {
    mocks.parseInstructionManipulative.mockReset();
  });

  it("computes the summary once and reuses its unchanged output fields", () => {
    mocks.parseInstructionManipulative.mockReturnValue({
      mode: "single",
      spec: {
        concept: "Number sense",
        prompt: "Put the point on 5.",
      },
    });

    const html = renderToStaticMarkup(
      // eslint-disable-next-line react/no-children-prop -- Chakra's createElement type requires children in the props object
      createElement(ChakraProvider, {
        value: system,
        children: createElement(InstructionLaunchpadDetailPane, {
          headingLabel: "Whole numbers",
          launchpad: {
            key: "whole-numbers",
            domain: "arithmetic",
            strand: "whole-numbers",
            status: "passed",
            provenance: "authored",
            title: "Build number sense",
            subtitle: null,
            atoms: [{ kind: "manipulative", spec: "serialized manipulative" }],
            atomKinds: ["manipulative"],
            medium: "manipulative",
            hasWorkedExample: false,
            version: 1,
            updatedAt: 1,
            verifyReport: null,
          },
        }),
      }),
    );

    expect(mocks.parseInstructionManipulative).toHaveBeenCalledOnce();
    expect(mocks.parseInstructionManipulative).toHaveBeenCalledWith(
      "serialized manipulative",
    );
    expect(html).toContain("Number sense");
    expect(html).toContain("Put the point on 5.");
  });
});

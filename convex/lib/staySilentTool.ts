// The `stay_silent` tool, kept apart from appUpdateTools.ts on purpose: that
// module is reachable from convex/schema.ts (through sessionHelpers), and the
// schema bundle cannot contain a dynamic import.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool.js";
import { STAY_SILENT_TOOL_NAME } from "./appUpdateTools";

/**
 * `stay_silent`: offered only on an appUpdate turn with no asks. The stream
 * holds back the turn's text until the model's first tool decision, so text
 * written before this call never reaches the scholar; `onSilence` makes the
 * stream drop any text after it and end the turn.
 */
export async function makeStaySilentTool(
  onSilence: () => void,
): Promise<BetaRunnableTool> {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  return betaTool({
    name: STAY_SILENT_TOOL_NAME,
    description:
      "End this turn without saying anything to the scholar. This is the default while they are still working in the app: let them keep going. Call it before writing any text; nothing you write in this turn is shown.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      additionalProperties: false,
    },
    run: async () => {
      onSilence();
      return "Silent. The scholar sees nothing from this turn. Do not write anything.";
    },
  }) as BetaRunnableTool;
}

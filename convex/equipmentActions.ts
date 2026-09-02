"use node";

/**
 * Equipment — model-calling actions (Node runtime).
 *
 * identifyPhoto: the AI half of the mobile add-by-photo flow. A staffer snaps
 * a photo of a piece of gear; this action looks at the uploaded image and
 * suggests name / category / quantity / description (+ a safety note when the
 * item is genuinely hazardous). Suggestions only — the staffer confirms or
 * edits everything before the item is created, and the tutor-suggestable gate
 * stays default-OFF regardless. Pure prompt/parser logic lives in
 * lib/equipmentIdentify.ts.
 */

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAuthUserId } from "@convex-dev/auth/server";
import { MODELS } from "./lib/models";
import { recordAnthropicUsage } from "./usage";
import { isStaffRole } from "./lib/roles";
import { sniffImageMime, bytesToBase64 } from "./lib/imageBytes";
import { withBoundedEquipmentPhoto } from "./lib/equipmentPhotoBlob";
import {
  IDENTIFY_PROMPT,
  parseIdentification,
  type EquipmentIdentification,
} from "./lib/equipmentIdentify";

export const identifyPhoto = action({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args): Promise<EquipmentIdentification | null> => {
    const userId = await getAuthUserId(ctx);
    if (!userId) throw new Error("Not signed in");
    const caller = await ctx.runQuery(internal.users.getByIdInternal, {
      id: userId,
    });
    if (!caller || !isStaffRole(caller.role)) throw new Error("Forbidden");

    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("Photo not found");
    return await withBoundedEquipmentPhoto(blob, async (bytes) => {
      // Anthropic image blocks accept only jpeg/png/gif/webp and 400 on a
      // mismatch — sniff, don't guess (per lib/imageBytes doctrine).
      const mime = sniffImageMime(bytes);
      if (!mime) throw new Error("Unsupported image format");

      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic();
      // Sonnet, not Haiku: identification quality is the whole value of the
      // flow, volume is tiny (one call per new inventory item).
      const resp = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: mime,
                  data: bytesToBase64(bytes),
                },
              },
              { type: "text", text: IDENTIFY_PROMPT },
            ],
          },
        ],
      });
      await recordAnthropicUsage(ctx, {
        source: "equipment-identify",
        role: caller.role,
        model: MODELS.SONNET,
        usage: resp.usage,
      });
      const text = resp.content
        .map((b) => (b.type === "text" ? b.text : ""))
        .join("");
      return parseIdentification(text);
    });
  },
});

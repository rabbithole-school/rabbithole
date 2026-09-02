// Physical-environment bot tools — the read + write toolset the staff aide
// (in-app Curriculum Assistant · Slack · MCP) and the unit-designer Curriculum
// Bot use to inspect and edit the school's rooms/equipment. Thin wrappers over
// convex/physicalEnvAide.ts (name-based, institution-resolved). Staff-only: the
// bot surfaces are already staff-gated, and every internal fn re-checks.
//
// The tutor's own suggest_physical_task (convex/http.ts) is a DIFFERENT surface
// (scholar-facing, read-only-to-the-inventory); this is the STAFF management +
// reference surface.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AideEmit } from "./aideStream";

const supervisionSchema = {
  type: "string" as const,
  enum: ["none", "adult_present", "teacher_only"] as const,
  description:
    "How the tutor may suggest it: none = freely; adult_present = 'ask your teacher to help'; teacher_only = never tutor-suggested.",
};

/**
 * Build the school-inventory tools. Returns the read tool separately from the
 * write tools so callers can hand out only what fits: the staff aide/Slack/MCP
 * get read + write; the unit-designer Curriculum Bot gets read only (reference
 * while designing, not edit).
 */
export async function makePhysicalEnvTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: { callerUserId: Id<"users"> },
) {
  const { callerUserId } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const listSchoolEquipmentTool = betaTool({
    name: "list_school_equipment",
    description:
      "List the school's physical rooms and equipment (the shared inventory the AI tutor can invite scholars to explore hands-on). Use it to see what's available before referencing gear in a lesson/unit, or before adding/removing items. Each item shows its room, quantity, safety notes, and whether the tutor may currently suggest it (tutorSuggestable).",
    inputSchema: { type: "object" as const, properties: {} },
    run: async () => {
      const inv = await ctx.runQuery(
        internal.physicalEnvAide.inventoryForActor,
        { callerUserId },
      );
      emit({
        toolComplete: {
          name: "list_school_equipment",
          result: `${inv.equipment.length} items across ${inv.spaces.length} rooms`,
        },
      });
      return JSON.stringify(inv);
    },
  });

  const addSchoolEquipmentTool = betaTool({
    name: "add_school_equipment",
    description:
      "Add a piece of equipment to the school inventory. Reference gear by the exact name teachers use. It's OFF for the tutor by default (a human opts it in) unless you set tutorSuggestable. If roomName names a room that doesn't exist yet, it's created.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: 'e.g. "Set of hand bells"' },
        roomName: { type: "string" as const, description: 'Room it lives in, e.g. "Music Room"' },
        category: { type: "string" as const, description: "musical | scientific | measurement | art | tools | manipulatives" },
        quantity: { type: "string" as const, description: 'Free text, e.g. "8 bells (C-C)", "class set"' },
        description: { type: "string" as const },
        tutorSuggestable: { type: "boolean" as const, description: "Whether the tutor may suggest it right away (default false)." },
        supervision: supervisionSchema,
        safetyNotes: { type: "string" as const, description: "Surfaced verbatim to the tutor when it suggests this." },
        usageIdeas: { type: "array" as const, items: { type: "string" as const }, description: "Open task ideas (starting points, not scripts)." },
      },
      required: ["name"] as const,
    },
    run: async (input) => {
      const res = await ctx.runMutation(
        internal.physicalEnvAide.addEquipmentForActor,
        { callerUserId, ...input },
      );
      emit({ toolComplete: { name: "add_school_equipment", result: res.message } });
      return res.message;
    },
  });

  const updateSchoolEquipmentTool = betaTool({
    name: "update_school_equipment",
    description:
      "Update an existing piece of equipment (found by name). Use it to fix details, move it to another room, or flip whether the tutor may suggest it (tutorSuggestable). Only pass the fields you're changing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Current name of the item to update." },
        newName: { type: "string" as const, description: "Rename it (optional)." },
        roomName: { type: "string" as const, description: "Move it to this room (created if new)." },
        category: { type: "string" as const },
        quantity: { type: "string" as const },
        description: { type: "string" as const },
        tutorSuggestable: { type: "boolean" as const, description: "Turn the tutor's ability to suggest this on/off." },
        supervision: supervisionSchema,
        safetyNotes: { type: "string" as const },
      },
      required: ["name"] as const,
    },
    run: async (input) => {
      const res = await ctx.runMutation(
        internal.physicalEnvAide.updateEquipmentForActor,
        { callerUserId, ...input },
      );
      emit({ toolComplete: { name: "update_school_equipment", result: res.message } });
      return res.message;
    },
  });

  const removeSchoolEquipmentTool = betaTool({
    name: "remove_school_equipment",
    description:
      "Remove a piece of equipment from the inventory (found by name) — e.g. it broke or the school no longer has it. This archives it (reversible) and immediately stops the tutor from suggesting it. If the name matches several items, you'll be asked which one.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: 'Name of the item to remove, e.g. "Metronome".' },
      },
      required: ["name"] as const,
    },
    run: async (input) => {
      const res = await ctx.runMutation(
        internal.physicalEnvAide.archiveEquipmentForActor,
        { callerUserId, name: input.name },
      );
      emit({ toolComplete: { name: "remove_school_equipment", result: res.message } });
      return res.message;
    },
  });

  const addSchoolRoomTool = betaTool({
    name: "add_school_room",
    description:
      "Add a room/space to the school (e.g. 'Maker Lab'). Idempotent by name. Equipment can then be placed in it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: 'e.g. "Maker Lab"' },
        kind: {
          type: "string" as const,
          enum: ["classroom", "lab", "music", "art", "library", "makerspace", "outdoor", "gym", "other"] as const,
        },
        description: { type: "string" as const },
      },
      required: ["name"] as const,
    },
    run: async (input) => {
      const res = await ctx.runMutation(
        internal.physicalEnvAide.addRoomForActor,
        { callerUserId, ...input },
      );
      emit({ toolComplete: { name: "add_school_room", result: res.message } });
      return res.message;
    },
  });

  return {
    read: listSchoolEquipmentTool,
    write: [
      addSchoolEquipmentTool,
      updateSchoolEquipmentTool,
      removeSchoolEquipmentTool,
      addSchoolRoomTool,
    ],
  };
}

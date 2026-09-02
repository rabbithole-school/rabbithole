// Practice ITEM-POOL aide tools — the chat transport over the same core
// helpers that back the teacher item-pool UI (convex/practiceItemPool.ts).
// Lets staff ask "which fraction nodes have no items?", read a node's pool
// (template previews + stored items, answers included — staff surface), edit
// or delete a stored item, hand-author a new one, and run the verified-LLM
// generation pipeline for a node.
//
// Composed into assembleCurriculumTools (lib/aideTools.ts), so the in-app
// aide, the Slack bot, and the MCP connector all get them from one gating
// point. Gating: canDesignCurriculum (teacher / admin / curriculum_designer)
// — this is design-side catalog content, no scholar data, the same audience
// as create_problem_set. Checked inline here (returns [] otherwise) so
// callers can spread the result unconditionally.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, ROLES, type Role } from "./roles";
import { PRACTICE_DOMAINS } from "./practice/domains";
import { MANIPULATIVE_VERIFIER_KIND } from "../../lib/manipulative/practiceContract";
import type { AideEmit } from "./aideStream";

const DOMAIN_SLUGS = PRACTICE_DOMAINS.map((d) => d.domain);

export async function makePracticePoolTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: { role: Role | null | undefined },
) {
  const canDesignCurriculum =
    isTeacherRole(opts.role) || opts.role === ROLES.CURRICULUM_DESIGNER;
  if (!canDesignCurriculum) return [];

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const domainEnumDesc = `One of: ${DOMAIN_SLUGS.join(", ")}`;

  const listNodesTool = betaTool({
    name: "list_practice_nodes",
    description:
      "Survey the practice ITEM POOL for a whole domain of the skills tree: every knowledge node with its item sources — deterministic template yes/no, stored word-problem count, manipulative count — and whether it's serveable at all. Use this to answer coverage questions ('which fraction nodes have no practice items?', 'what does Kai's frontier node actually serve?') and to find pool holes before assigning practice. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        domain: { type: "string" as const, enum: DOMAIN_SLUGS, description: domainEnumDesc },
      },
      required: ["domain"] as const,
    },
    run: async (input: { domain: string }) => {
      const res = await ctx.runQuery(internal.practiceItemPool.poolSummaryInternal, {
        domain: input.domain,
      });
      emit({
        toolComplete: {
          name: "list_practice_nodes",
          result: `${res.nodes.length} nodes in ${res.domainLabel}`,
        },
      });
      const holes = res.nodes.filter((n) => !n.serveable).map((n) => n.nodeKey);
      return JSON.stringify({
        domain: res.domain,
        domainLabel: res.domainLabel,
        unserveableNodes: holes,
        nodes: res.nodes,
      });
    },
  });

  const getPoolTool = betaTool({
    name: "get_practice_item_pool",
    description:
      "Read ONE knowledge node's practice item pool: sample items from its deterministic template (what a scholar actually gets served, with answers), every stored item (verified-LLM word problems, hand-authored items, manipulatives) with its id + canonical answer, and whether the node is on the pre-warmed conceptual list. Answers are staff-facing — never paste them into anything a scholar will see. Read-only; use the item ids with update/delete_practice_item.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodeKey: {
          type: "string" as const,
          description: "The knowledge node's key (snake_case, e.g. 'fraction_as_division'). Find keys via list_practice_nodes.",
        },
      },
      required: ["nodeKey"] as const,
    },
    run: async (input: { nodeKey: string }) => {
      const pool = await ctx.runQuery(internal.practiceItemPool.poolForNodeInternal, {
        nodeKey: input.nodeKey,
      });
      if (!pool) return `No knowledge node with key "${input.nodeKey}". Use list_practice_nodes to find the right key.`;
      emit({
        toolComplete: {
          name: "get_practice_item_pool",
          result: `${pool.node.label}: ${pool.items.length} stored item(s)${pool.hasTemplate ? " + template" : ""}`,
        },
      });
      return JSON.stringify(pool);
    },
  });

  const createItemTool = betaTool({
    name: "create_practice_item",
    description:
      "Hand-author a NEW practice word problem on a knowledge node. The item enters the same serving pool as verified-LLM items (scholars can be served it immediately), so confirm the stem + answer with the teacher before writing. The answer is validated against the answerType and stored canonically; stems should have ONE unambiguous numeric answer.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodeKey: { type: "string" as const, description: "The knowledge node's key." },
        stem: { type: "string" as const, description: "The word problem the scholar reads." },
        answerType: { type: "string" as const, enum: ["integer", "decimal", "fraction"] as const },
        answer: { type: "string" as const, description: "Canonical answer, e.g. '42', '6.50', '3/4'." },
        answerUnit: {
          type: "string" as const,
          description:
            "For a MEASUREMENT problem only: the unit the answer must be written in, e.g. 'cm³', 'm²', '°'. The scholar then has to type the unit as part of the answer, so the stem must ask for it ('…in cubic centimeters') — it is refused otherwise. Omit for every non-measurement problem.",
        },
      },
      required: ["nodeKey", "stem", "answerType", "answer"] as const,
    },
    run: async (input: {
      nodeKey: string;
      stem: string;
      answerType: string;
      answer: string;
      answerUnit?: string;
    }) => {
      try {
        await ctx.runMutation(internal.practiceItemPool.createItemInternal, input);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ toolComplete: { name: "create_practice_item", result: `Refused: ${msg.slice(0, 200)}` } });
        return `Refused: ${msg}`;
      }
      emit({ toolComplete: { name: "create_practice_item", result: `Added item on ${input.nodeKey}` } });
      return `Item added to "${input.nodeKey}" (answer ${input.answer}).`;
    },
  });

  const updateItemTool = betaTool({
    name: "update_practice_item",
    description:
      "Edit a stored practice item (find its id via get_practice_item_pool). For a word item, pass any of stem / answerType / answer — the answer re-validates and re-normalizes. For a manipulative, pass manipulativeSpec (full JSON) and/or stem; the spec is gradability-checked so an unsolvable puzzle can't be saved. Edits are live for scholars immediately — confirm with the teacher first. The edited item is marked source 'authored' (a human is now the verifier of record).",
    inputSchema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" as const, description: "The item id from get_practice_item_pool." },
        stem: { type: "string" as const },
        answerType: { type: "string" as const, enum: ["integer", "decimal", "fraction"] as const },
        answer: { type: "string" as const },
        answerUnit: {
          type: "string" as const,
          description:
            "The unit the answer must be written in ('cm³', 'm²', '°') for a measurement problem; pass \"\" to stop requiring a unit. The stem must ask for it or the edit is refused.",
        },
        manipulativeSpec: { type: "string" as const, description: "Full ManipulativeSpec JSON (manipulative items only)." },
      },
      required: ["itemId"] as const,
    },
    run: async (input: {
      itemId: string;
      stem?: string;
      answerType?: string;
      answer?: string;
      answerUnit?: string;
      manipulativeSpec?: string;
    }) => {
      try {
        await ctx.runMutation(internal.practiceItemPool.updateItemInternal, {
          id: input.itemId as Id<"practiceItems">,
          stem: input.stem,
          answerType: input.answerType,
          answer: input.answer,
          answerUnit: input.answerUnit,
          manipulativeSpec: input.manipulativeSpec,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ toolComplete: { name: "update_practice_item", result: `Refused: ${msg.slice(0, 200)}` } });
        return `Refused: ${msg}`;
      }
      emit({ toolComplete: { name: "update_practice_item", result: "Item updated" } });
      return "Item updated.";
    },
  });

  const deleteItemTool = betaTool({
    name: "delete_practice_item",
    description:
      "Delete a stored practice item (id via get_practice_item_pool). Destructive and immediate — confirm with the teacher first. Template items can't be deleted (they're code, not rows); this only removes stored word problems / authored items / manipulatives.",
    inputSchema: {
      type: "object" as const,
      properties: {
        itemId: { type: "string" as const, description: "The item id from get_practice_item_pool." },
      },
      required: ["itemId"] as const,
    },
    run: async (input: { itemId: string }) => {
      try {
        const res = await ctx.runMutation(internal.practiceItemPool.deleteItemInternal, {
          id: input.itemId as Id<"practiceItems">,
        });
        emit({ toolComplete: { name: "delete_practice_item", result: `Deleted item on ${res.skillKey}` } });
        return `Deleted "${res.stem.slice(0, 80)}" from ${res.skillKey}.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ toolComplete: { name: "delete_practice_item", result: `Refused: ${msg.slice(0, 200)}` } });
        return `Refused: ${msg}`;
      }
    },
  });

  const generateItemsTool = betaTool({
    name: "generate_practice_items",
    description:
      "Run the verified-LLM generation pipeline for one knowledge node: a fast model drafts word problems, EVERY candidate passes the arithmetic verification gate (its solution expression must evaluate to its stated answer), and only survivors are stored. Use to fill a pool hole ('this node has no items') or refresh a stale pool. `replace: true` clears the node's existing word items first (refused if the node has manipulatives, which replace would destroy). Report the generated/verified/rejected/stored counts back to the teacher.",
    inputSchema: {
      type: "object" as const,
      properties: {
        nodeKey: { type: "string" as const, description: "The knowledge node's key." },
        count: { type: "number" as const, description: "How many items to store (default 8, max 20)." },
        replace: { type: "boolean" as const, description: "Clear existing word items first (default false)." },
      },
      required: ["nodeKey"] as const,
    },
    run: async (input: { nodeKey: string; count?: number; replace?: boolean }) => {
      try {
        if (input.replace) {
          const pool = await ctx.runQuery(internal.practiceItemPool.poolForNodeInternal, {
            nodeKey: input.nodeKey,
          });
          if (pool?.items.some((it) => it.verifierKind === MANIPULATIVE_VERIFIER_KIND)) {
            return "Refused: this node has manipulative items; replace would delete them. Generate without replace, or delete items individually.";
          }
        }
        const count = Math.max(1, Math.min(20, Math.floor(input.count ?? 8)));
        const res = await ctx.runAction(internal.practiceGen.generateVerifiedItems, {
          skillKey: input.nodeKey,
          count,
          replace: input.replace ?? false,
        });
        emit({
          toolComplete: {
            name: "generate_practice_items",
            result: `${res.stored} stored (${res.rejected} rejected by the verifier)`,
          },
        });
        return JSON.stringify(res);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        emit({ toolComplete: { name: "generate_practice_items", result: `Failed: ${msg.slice(0, 200)}` } });
        return `Generation failed: ${msg}`;
      }
    },
  });

  return [
    listNodesTool,
    getPoolTool,
    createItemTool,
    updateItemTool,
    deleteItemTool,
    generateItemsTool,
  ];
}

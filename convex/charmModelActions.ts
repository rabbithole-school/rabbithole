"use node";

// charm_model's engine: resolve each requested subject from the shared cache
// (convex/charmModels.ts) or have GPT-6 Astra write it, sandbox-check every
// result (lib/charmModelSandbox.ts), and hand the session a script asset it
// owns. Node runtime for `vm`. The builder tool in lib/tutorSessionTools.ts
// owns the per-turn budget and passes what is left of it in.

import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CHARM_MODEL_CONTRACT,
  MAX_CHARM_MODEL_CHANGE_LEN,
  MAX_CHARM_MODEL_SUBJECT_LEN,
  charmModelInput,
  charmModelKey,
  charmModelRemixInput,
  charmModelRetryInput,
  charmModelScript,
  extractCharmModelCode,
  normalizeCharmModelSubject,
  tidyCharmModelChange,
} from "./lib/charmModelCode";
import { checkCharmModel } from "./lib/charmModelSandbox";
import { openaiRespond } from "./lib/openaiResponses";
import { normalizeOpenAIResponsesUsage } from "./lib/usage";
import { recordUsage } from "./usage";
import { appAssetRef } from "../shared/appAssets";

/** One fix-it retry after a failed check, then an honest failure. */
const GENERATION_ATTEMPTS = 2;

let threeSourcePromise: Promise<string> | null = null;

/** The exact three.js bytes apps run, loaded once per action instance. */
function threeSource(): Promise<string> {
  threeSourcePromise ??= import("./lib/threeIifeSource.generated").then(
    ({ THREE_IIFE_SOURCE }) => THREE_IIFE_SOURCE,
  );
  return threeSourcePromise;
}

type Attribution = {
  sessionId: Id<"sessions">;
  role: string;
  source: string;
};

/**
 * Ask Astra for a model, check it, and retry once with the check's complaint.
 * Every attempt's usage is recorded, including ones the check refuses.
 */
async function writeCheckedModel(
  ctx: ActionCtx,
  input: string,
  attribution: Attribution,
): Promise<
  { code: string; model: string; parts: string[] } | { problem: string }
> {
  const three = await threeSource();
  let prompt = input;
  let problem = "the model writer did not answer";
  for (let attempt = 1; attempt <= GENERATION_ATTEMPTS; attempt++) {
    const reply = await openaiRespond(CHARM_MODEL_CONTRACT, prompt);
    if (!reply) return { problem: "the model writer is unavailable right now" };
    // Awaited: a dangling write is not guaranteed to land once the action
    // returns, and every attempt here was paid for.
    await recordUsage(ctx, {
      source: attribution.source,
      role: attribution.role,
      model: reply.model,
      usage: normalizeOpenAIResponsesUsage(reply.usage),
      sessionId: attribution.sessionId,
    });
    const code = extractCharmModelCode(reply.text);
    const check = await checkCharmModel(code, three);
    if (check.ok) {
      return { code, model: reply.model, parts: check.parts };
    }
    problem = check.problem;
    console.warn(`[charmModel] check failed (attempt ${attempt}): ${problem}`);
    prompt = charmModelRetryInput(input, problem);
  }
  return { problem };
}

export type CharmModelOutcome =
  | {
      name: string;
      status: "ready";
      key: string;
      reference: string;
      cached: boolean;
      remixed: boolean;
      parts: string[];
      ms: number;
    }
  | { name: string; status: "refused"; message: string };

const refused = (name: string, message: string): CharmModelOutcome => ({
  name,
  status: "refused",
  message,
});

export const prepareForSession = internalAction({
  args: {
    sessionId: v.id("sessions"),
    requests: v.array(
      v.object({ name: v.string(), change: v.optional(v.string()) }),
    ),
    maxNewGenerations: v.number(),
    createdBy: v.optional(v.id("users")),
    role: v.string(),
    usageSource: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ outcomes: CharmModelOutcome[]; generationsUsed: number }> => {
    const attribution: Attribution = {
      sessionId: args.sessionId,
      role: args.role,
      source: args.usageSource,
    };

    // Pass 1: read the cache and spend the generation budget in request
    // order, before anything slow starts, so parallel work can't overspend.
    let budget = Math.max(0, Math.floor(args.maxNewGenerations));
    // Subjects to write fresh, each with the row its result is cached on.
    const toGenerate = new Map<string, Id<"charmModels">>();
    const plans: Array<
      | { kind: "refused"; outcome: CharmModelOutcome }
      | {
          kind: "go";
          name: string;
          subject: string;
          change?: string;
          row: Doc<"charmModels">;
          baseCached: boolean;
        }
    > = [];
    for (const request of args.requests) {
      const name = request.name.replace(/\s+/g, " ").trim();
      const subject = normalizeCharmModelSubject(name);
      const change = request.change ? tidyCharmModelChange(request.change) : "";
      if (!subject) {
        plans.push({ kind: "refused", outcome: refused(name, "Name the object to model.") });
        continue;
      }
      if (subject.length > MAX_CHARM_MODEL_SUBJECT_LEN) {
        plans.push({
          kind: "refused",
          outcome: refused(name, `That name is longer than ${MAX_CHARM_MODEL_SUBJECT_LEN} characters. Use a short noun, such as "chimpanzee".`),
        });
        continue;
      }
      if (change.length > MAX_CHARM_MODEL_CHANGE_LEN) {
        plans.push({
          kind: "refused",
          outcome: refused(name, `That change is longer than ${MAX_CHARM_MODEL_CHANGE_LEN} characters. Describe it in one sentence.`),
        });
        continue;
      }
      const row = await ctx.runMutation(internal.charmModels.ensureRow, {
        subject: name,
        ...(args.createdBy ? { createdBy: args.createdBy } : {}),
      });
      if (!row) {
        plans.push({ kind: "refused", outcome: refused(name, "Name the object to model.") });
        continue;
      }
      if (row.hidden) {
        plans.push({
          kind: "refused",
          outcome: refused(name, "That model is not available. Choose a different subject."),
        });
        continue;
      }
      const baseCached = row.status === "ready" && Boolean(row.code);
      const baseCost = baseCached || toGenerate.has(subject) ? 0 : 1;
      const cost = baseCost + (change ? 1 : 0);
      if (cost > budget) {
        plans.push({
          kind: "refused",
          outcome: refused(
            name,
            "This turn's budget for new 3D models is used up. Use the models already returned, and ask for this one in your next reply.",
          ),
        });
        continue;
      }
      budget -= cost;
      if (baseCost) toGenerate.set(subject, row._id);
      plans.push({ kind: "go", name, subject, change: change || undefined, row, baseCached });
    }
    const generationsUsed = Math.max(0, Math.floor(args.maxNewGenerations)) - budget;

    // Base generations run in parallel, one per subject, shared by every
    // request that names it (a model and its remix in the same call).
    type Base = { code: string; parts: string[] } | { problem: string };
    const basePromises = new Map<string, Promise<Base>>();
    for (const [subject, id] of toGenerate) {
      basePromises.set(
        subject,
        writeCheckedModel(ctx, charmModelInput(subject), attribution).then(
          async (result) => {
            if ("problem" in result) {
              await ctx.runMutation(internal.charmModels.setFailed, { id });
              return result;
            }
            await ctx.runMutation(internal.charmModels.setReady, {
              id,
              code: result.code,
              generationModel: result.model,
            });
            return result;
          },
        ),
      );
    }

    let storeQueue: Promise<unknown> = Promise.resolve();
    const outcomes = await Promise.all(
      plans.map(async (plan): Promise<CharmModelOutcome> => {
        if (plan.kind === "refused") return plan.outcome;
        const started = Date.now();
        const base: Base = plan.baseCached
          ? await recheckCached(plan.row.code as string)
          : await basePromises.get(plan.subject)!;
        if ("problem" in base) {
          return refused(
            plan.name,
            `The 3D model could not be made: ${base.problem}. Build without it, or try a simpler subject.`,
          );
        }
        let { code, parts } = base;
        if (plan.change) {
          const remix = await writeCheckedModel(
            ctx,
            charmModelRemixInput(plan.subject, plan.change, base.code),
            attribution,
          );
          if ("problem" in remix) {
            return refused(
              plan.name,
              `The remix could not be made: ${remix.problem}. The original ${plan.subject} is still available without a change.`,
            );
          }
          ({ code, parts } = remix);
        }
        const key = charmModelKey(plan.subject, plan.change);
        // Copies land one at a time. Production would tolerate overlap (each
        // registration is its own transaction), but convex-test cannot
        // overlap one action's writes, and a few ms beside a 30 s generation
        // is free.
        const store = storeQueue.then(() =>
          storeSessionScript(ctx, args.sessionId, charmModelScript(key, code)),
        );
        storeQueue = store.catch(() => null);
        const reference = await store;
        if (!reference) {
          return refused(
            plan.name,
            "This app already has 8 assets, the most it can hold. Reuse a model or picture already in the app, or remove one before adding another.",
          );
        }
        return {
          name: plan.name,
          status: "ready",
          key,
          reference,
          cached: plan.baseCached,
          remixed: Boolean(plan.change),
          parts,
          ms: Date.now() - started,
        };
      }),
    );
    return { outcomes, generationsUsed };
  },
});

/**
 * A cache hit is checked again before it is served: the check is ~15 ms, it
 * yields the part names the builder animates by, and it catches a cached model
 * that a later three.js upgrade broke.
 */
async function recheckCached(
  code: string,
): Promise<{ code: string; parts: string[] } | { problem: string }> {
  const check = await checkCharmModel(code, await threeSource());
  return check.ok ? { code, parts: check.parts } : { problem: check.problem };
}

/** Store a session-owned copy, as charm_icon does with its cached PNG. */
async function storeSessionScript(
  ctx: ActionCtx,
  sessionId: Id<"sessions">,
  script: string,
): Promise<string | null> {
  const storageId = await ctx.storage.store(
    new Blob([script], { type: "text/javascript" }),
  );
  const registered = await ctx.runMutation(
    internal.sessionHelpers.registerAppAsset,
    { sessionId, storageId },
  );
  if (!registered) {
    await ctx.storage.delete(storageId);
    return null;
  }
  return appAssetRef(String(storageId));
}

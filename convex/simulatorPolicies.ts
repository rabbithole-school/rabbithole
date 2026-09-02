import { v } from "convex/values";

import { internalMutation, internalQuery } from "./_generated/server";
import {
  POLICY_INTERPRETER_VERSION,
  policyIRValidator,
} from "../lib/simulator/policyIR";

export const getForCompile = internalQuery({
  args: { policyId: v.id("compiledPolicies") },
  handler: async (ctx, args) => {
    const policy = await ctx.db.get(args.policyId);
    return policy?.status === "compiling" ? policy : null;
  },
});

export const completeCompile = internalMutation({
  args: {
    policyId: v.id("compiledPolicies"),
    compileContextHash: v.string(),
    policy: policyIRValidator,
    policyHash: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.policyId);
    if (
      !existing ||
      existing.status !== "compiling" ||
      existing.compileContextHash !== args.compileContextHash ||
      // Defense-in-depth for the closed per-template vocabulary: the parser
      // already template-scopes every predicate, but the interpreter trusts
      // the stored record, so a template-mismatched policy must never stick.
      existing.templateId !== args.policy.templateId
    ) {
      return { kind: "stale" as const };
    }
    await ctx.db.patch(args.policyId, {
      status: "ready",
      policy: args.policy,
      policyHash: args.policyHash,
      errorCode: undefined,
      errorMessage: undefined,
      interpreterVersion: POLICY_INTERPRETER_VERSION,
      updatedAt: Date.now(),
    });
    return { kind: "ready" as const };
  },
});

export const failCompile = internalMutation({
  args: {
    policyId: v.id("compiledPolicies"),
    compileContextHash: v.string(),
    errorCode: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.policyId);
    if (
      !existing ||
      existing.status !== "compiling" ||
      existing.compileContextHash !== args.compileContextHash
    ) {
      return { kind: "stale" as const };
    }
    await ctx.db.patch(args.policyId, {
      status: "failed",
      policy: undefined,
      policyHash: undefined,
      errorCode: args.errorCode,
      errorMessage:
        "Couldn't compile your prompt. This species will use live Haiku instead.",
      compileAttempts: (existing.compileAttempts ?? 0) + 1,
      updatedAt: Date.now(),
    });
    return { kind: "failed" as const };
  },
});

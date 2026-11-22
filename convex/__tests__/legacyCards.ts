// Seed activity cards the way the grid placed them before TRA-582.
//
// The public placeClass / updatePlacement take no work (their validators refuse it) and
// the public placeHomework is gone: the teacher grid gives work to a class.
// Cards placed before that still live in prod, and reconcile, closures,
// flags and removal still act on them, so tests seed them through the same
// core writers the public mutations used, as the signed-in caller.

import type { TestConvex } from "convex-test";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type schema from "../schema";
import {
  corePlaceClass,
  corePlaceHomework,
  coreUpdatePlacement,
} from "../masterSchedule";

type Caller = Pick<TestConvex<typeof schema>, "run">;

async function callerId(ctx: MutationCtx): Promise<Id<"users"> | undefined> {
  const identity = await ctx.auth.getUserIdentity();
  return identity ? (identity.subject.split("|")[0] as Id<"users">) : undefined;
}

/** `masterSchedule.placeClass` as it was before TRA-582: work makes a card. */
export function placeCard(
  as: Caller,
  args: Omit<Parameters<typeof corePlaceClass>[1], "actorId">,
) {
  return as.run(async (ctx) =>
    corePlaceClass(ctx as unknown as MutationCtx, {
      ...args,
      actorId: await callerId(ctx as unknown as MutationCtx),
    }),
  );
}

/** The retired `masterSchedule.placeHomework`: a homework card on its due day. */
export function placeHomeworkCard(
  as: Caller,
  args: Parameters<typeof corePlaceHomework>[1],
) {
  return as.run((ctx) => corePlaceHomework(ctx as unknown as MutationCtx, args));
}

/** `masterSchedule.updatePlacement` as it was before TRA-582: work relinks a card. */
export function updateCard(
  as: Caller,
  args: Omit<Parameters<typeof coreUpdatePlacement>[1], "actorId">,
) {
  return as.run(async (ctx) =>
    coreUpdatePlacement(ctx as unknown as MutationCtx, {
      ...args,
      actorId: await callerId(ctx as unknown as MutationCtx),
    }),
  );
}

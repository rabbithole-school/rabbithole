/**
 * handleSeedSpawn — execute a fired seed's optional `spawn` (roadmap §7②).
 *
 * A gated cross-domain seed can, beyond the Sky star itself, spawn a follow-up:
 *  • teacherNotification — raise a teacher alert (implemented here via
 *    alerts.raiseAlert: records an `alerts` row + posts to the linked channel if
 *    one exists; fire-and-forget, never throws).
 *  • activity — a SUGGESTED problem_set (reusing the canonical ActivityKind)
 *    pending teacher confirm in Guidance. DEFERRED (roadmap §10): needs the
 *    suggested-activity model + the Guidance confirm/dismiss surface. A safe
 *    no-op for now — the Sky seed still fired — with a clear TODO, so a seed
 *    that sets `spawn.kind === "activity"` never errors.
 *
 * Kept OUT of gateEval.ts (which stays pure) because it needs a MutationCtx.
 */

import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import type { SeedSpawn } from "./crossDomainSeeds";
import { raiseAlert } from "../../alerts";

export async function handleSeedSpawn(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  topic: string,
  spawn: SeedSpawn,
): Promise<void> {
  if (spawn.kind === "teacherNotification") {
    await raiseAlert(ctx, {
      kind: "seed_spawn",
      severity: "info",
      title: "A cross-domain connection opened up",
      body: spawn.note,
      source: "practice:seed-spawn",
      audience: "institution",
      scholarId,
      // One ping per (scholar, seed topic). Seed firing is already idempotent
      // (deduped on topic), but this is belt-and-braces so a re-fire never
      // re-notifies.
      dedupKey: `seed-spawn:${scholarId}:${topic}`,
    });
    return;
  }

  // spawn.kind === "activity": TODO(§7②) — create a SUGGESTED problem_set
  // (ActivityKind) pending teacher confirm in Guidance. Deferred: needs the
  // suggested-activity model + Guidance confirm/dismiss surface. No-op for now.
}

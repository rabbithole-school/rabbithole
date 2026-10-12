/**
 * Install a finished, self-contained HTML app as a Rabbithole activity — no
 * rehearsal session as a vessel (TRA-493). An app vibecoded anywhere (Claude
 * Code, Claude in Slack, any agent) becomes a real activity as long as it
 * speaks the `window.rabbithole` SDK. Procedure + SDK reference:
 * `.agents/skills/app-to-activity/`. CLI wrapper: `scripts/app-to-activity.mjs`.
 *
 * Composition only — every write goes through the existing primitive:
 * `createCurriculumUnitCore` / `createScholarLessonCore` (teacherAide.ts),
 * `createActivityCore` + `writeVibecodeStarterApp` (activities.ts), with the
 * character checked by `validateCharacterSpec` and each judge by
 * `validateJudgeSpec` (appAiDirector.ts), and the contract by `buildContractPatch` (lib/buildContract.ts). No new table.
 *
 * Internal: reachable only with deploy credentials (`npx convex run`), never
 * from a browser. Prod use still needs Andy's per-turn approval
 * (.claude/rules/rabbithole-convex-deploys.md).
 */
import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { createActivityCore, writeVibecodeStarterApp } from "./activities";
import {
  createCurriculumUnitCore,
  createScholarLessonCore,
} from "./teacherAide";
import { validateCharacterSpec, validateJudgeSpec } from "./appAiDirector";
import { MAX_JUDGES } from "../shared/appAiPolicy";
import { MAX_STATIC_HTML_BYTES } from "./customApps";
import { buildContractPatch, buildContractValidator } from "./lib/buildContract";
import { requireUnitEditAccessForUser } from "./lib/auth";
import { assertInstitutionActive } from "./lib/access";
import { isTeacherRole } from "./lib/roles";
import { looksLikeHtml } from "../lib/vibecode/helpers";
import { requestedAppAssetIds } from "../shared/appAssets";

const characterInput = v.object({
  name: v.string(),
  persona: v.string(),
  moods: v.array(v.string()),
  verdicts: v.optional(v.array(v.string())),
  greeting: v.optional(v.string()),
  directorNotes: v.optional(v.string()),
});

const judgeInput = v.object({
  id: v.string(),
  rubric: v.string(),
  verdicts: v.array(v.string()),
});

type AppAi = NonNullable<Doc<"customApps">["appAi"]>;

/** Key-order-independent JSON (stored documents do not keep key order). */
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/** Same character and judges, ignoring the spec's own timestamp. */
function sameCharacter(a: AppAi | undefined, b: AppAi | undefined): boolean {
  return (
    canonical(a?.character) === canonical(b?.character) &&
    canonical(a?.judges) === canonical(b?.judges)
  );
}

export const installAppAsActivity = internalMutation({
  args: {
    authorUserId: v.id("users"),
    // Defaults to the activity title; reused by (author, title).
    unitTitle: v.optional(v.string()),
    // Defaults to the activity title; reused by (unit, title).
    lessonTitle: v.optional(v.string()),
    // Reused by (lesson, title); the reused activity must be vibecode.
    activityTitle: v.string(),
    html: v.string(),
    character: v.optional(characterInput),
    // `rabbithole.judge` rubrics, the same spec as the App designer's
    // define_judge. The starter's judges become exactly these.
    judges: v.optional(v.array(judgeInput)),
    // The activity's systemPrompt: the brief the tutor (and, under Edit, the
    // App designer) works from.
    brief: v.string(),
    buildContract: v.optional(buildContractValidator),
    allowSilence: v.optional(v.boolean()),
    // A finished app is Play-only by default.
    editAccess: v.optional(
      v.union(
        v.literal("always"),
        v.literal("never"),
        v.literal("afterCompletion"),
      ),
    ),
    scholarDescription: v.optional(v.string()),
    // Teacher-facing description of what the activity is for.
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const author = await ctx.db.get(args.authorUserId);
    if (!author) throw new Error("Author not found");
    if (!isTeacherRole(author.role)) {
      throw new Error("The author must be a teacher or admin");
    }
    await assertInstitutionActive(ctx, author);

    // ── Validate everything before the first write ──────────────────────
    const activityTitle = args.activityTitle.trim();
    if (!activityTitle) throw new Error("activityTitle must be non-empty");
    const brief = args.brief.trim();
    if (!brief) throw new Error("brief must be non-empty");
    const html = args.html;
    const htmlBytes = new TextEncoder().encode(html).length;
    if (htmlBytes > MAX_STATIC_HTML_BYTES) {
      throw new Error(
        `HTML is too large (${htmlBytes} bytes; max ${MAX_STATIC_HTML_BYTES}).`,
      );
    }
    if (!html.trim() || !looksLikeHtml(html)) {
      throw new Error("html must be a non-empty HTML app");
    }
    if (requestedAppAssetIds(html).length > 0) {
      throw new Error(
        "An installed app must be self-contained: inline images as data: URLs instead of /app-assets/ references.",
      );
    }
    let character: AppAi["character"];
    if (args.character) {
      const validated = validateCharacterSpec(args.character);
      if (!validated.ok) throw new Error(`Character: ${validated.error}`);
      character = validated.value;
    }
    let judges: AppAi["judges"];
    if (args.judges && args.judges.length > 0) {
      if (args.judges.length > MAX_JUDGES) {
        throw new Error(`An app may have at most ${MAX_JUDGES} judges.`);
      }
      judges = args.judges.map((judge) => {
        const validated = validateJudgeSpec(judge);
        if (!validated.ok) throw new Error(`Judge ${judge.id}: ${validated.error}`);
        return validated.value;
      });
      if (new Set(judges.map((j) => j.id)).size !== judges.length) {
        throw new Error("Judge ids must be unique.");
      }
    }
    const appAi: AppAi | undefined =
      character || judges
        ? {
            ...(character ? { character } : {}),
            ...(judges ? { judges } : {}),
            updatedAt: Date.now(),
          }
        : undefined;
    if (args.allowSilence && !args.buildContract) {
      throw new Error("allowSilence needs a buildContract (it only means something under one).");
    }
    // Validates + normalizes the contract (throws on bad shape). The kind is
    // always vibecode here, so a contract is always allowed.
    const contract = buildContractPatch("vibecode", {
      buildContract: args.buildContract ?? null,
      allowSilence: args.allowSilence ?? false,
    });

    // ── Unit → lesson → activity (find-or-create) ───────────────────────
    const unit = await createCurriculumUnitCore(ctx, {
      authorId: author._id,
      title: args.unitTitle?.trim() || activityTitle,
    });
    await requireUnitEditAccessForUser(ctx, author, { unitId: unit.unitId });
    const lesson = await createScholarLessonCore(ctx, {
      unitId: unit.unitId,
      title: args.lessonTitle?.trim() || activityTitle,
    });
    const peers = await ctx.db
      .query("activities")
      .withIndex("by_lesson", (q) => q.eq("lessonId", lesson.lessonId))
      .collect();
    const match = peers.find(
      (a) => a.title.trim().toLowerCase() === activityTitle.toLowerCase(),
    );
    if (match && match.kind !== "vibecode") {
      throw new Error(
        `"${match.title}" in this lesson is a ${match.kind} activity, not an app; pick another activityTitle.`,
      );
    }
    const activityId =
      match?._id ??
      (await createActivityCore(ctx, {
        lessonId: lesson.lessonId,
        title: activityTitle,
        kind: "vibecode",
        systemPrompt: brief,
      }));
    // A re-run makes the activity match the files exactly: no contract clears one.
    await ctx.db.patch(activityId, {
      systemPrompt: brief,
      buildContract: contract.buildContract,
      allowSilence: contract.allowSilence,
      editAccess: args.editAccess ?? "never",
      ...(args.scholarDescription !== undefined
        ? { scholarDescription: args.scholarDescription.trim() || undefined }
        : {}),
      ...(args.description !== undefined
        ? { description: args.description.trim() || undefined }
        : {}),
    });

    // ── The starter app ─────────────────────────────────────────────────
    const activity = await ctx.db.get(activityId);
    if (!activity) throw new Error("Activity not found");
    const existing = activity.starterAppId
      ? await ctx.db.get(activity.starterAppId)
      : null;
    const unchanged =
      existing?.kind === "static" &&
      existing.html === html &&
      existing.name === activityTitle &&
      sameCharacter(existing.appAi, appAi);
    let starterAppId = activity.starterAppId;
    if (!unchanged || !starterAppId) {
      starterAppId = await writeVibecodeStarterApp(ctx, {
        activity,
        createdBy: author._id,
        name: activityTitle,
        html,
        appAssetIds: [],
        appAi,
        updatedAt: Date.now(),
      });
    }
    // An installed app IS what scholars open; never a blank slate.
    await ctx.db.patch(activityId, {
      starterAppId,
      scholarsStartFrom: "starter",
    });
    const starter = await ctx.db.get(starterAppId);
    return {
      unitId: unit.unitId,
      lessonId: lesson.lessonId,
      activityId,
      starterAppId,
      created: {
        unit: !unit.existed,
        lesson: !lesson.existed,
        activity: !match,
      },
      starterChanged: !unchanged,
      starterUpdatedAt: starter?.updatedAt ?? null,
      unitUnpublished: (await ctx.db.get(unit.unitId))?.unpublished === true,
      htmlBytes,
      characterName: appAi?.character?.name ?? null,
      judgeIds: appAi?.judges?.map((judge) => judge.id) ?? [],
    };
  },
});

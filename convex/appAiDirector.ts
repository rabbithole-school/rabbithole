/**
 * The tutor's side of server-backed app AI (shared/appAiPolicy.ts).
 *
 * Build time: `define_character` / `define_judge` write the server-only spec
 * (`artifacts.appAi`) onto the session's code app. The spec is a snapshot that
 * travels with the app's HTML (starter promotion, scholar clone, duplication),
 * so it is never resolved through the activity at run time.
 *
 * Play time: the scholar's tutor directs the character — a standing direction
 * (`direct_character`) or one line spoken through it (`speak_as_character`).
 * Both are recorded in `appAiTurns` for teachers and never surface in the
 * scholar's chat.
 */
import { v, type Infer } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { pickFocusApp } from "./lib/focusApp";
import {
  APP_JUDGE_ID_PATTERN,
  MAX_CHARACTER_REPLY_CHARS,
  MAX_DIRECTION_CHARS,
  MAX_DIRECTOR_NOTES_CHARS,
  MAX_JUDGES,
  MAX_MOODS,
  MAX_PERSONA_CHARS,
  MAX_RUBRIC_CHARS,
  MAX_VERDICTS,
} from "../shared/appAiPolicy";
import { upsertCharacterLine } from "./appStates";
import {
  characterSpecValidator,
  judgeSpecValidator,
} from "./lib/appAiValidators";

export const MAX_CHARACTER_NAME_CHARS = 40;
const MIN_MOODS = 2;
/** Moods and verdicts are machine-readable tokens the app switches on. */
const APP_AI_TOKEN_PATTERN = /^[a-z][a-z0-9_-]{0,23}$/;

type CharacterSpec = Infer<typeof characterSpecValidator>;
type JudgeSpec = Infer<typeof judgeSpecValidator>;

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

function validateTokens(
  label: string,
  raw: readonly string[],
  min: number,
  max: number,
): Validated<string[]> {
  const tokens = raw.map((token) => token.trim().toLowerCase());
  if (tokens.length < min || tokens.length > max) {
    return {
      ok: false,
      error: `Give ${min === max ? min : `${min}–${max}`} ${label}.`,
    };
  }
  const bad = tokens.find((token) => !APP_AI_TOKEN_PATTERN.test(token));
  if (bad !== undefined) {
    return {
      ok: false,
      error: `Each of the ${label} must be one short lowercase word (letters, digits, - or _), not "${bad}".`,
    };
  }
  if (new Set(tokens).size !== tokens.length) {
    return { ok: false, error: `The ${label} must not repeat.` };
  }
  return { ok: true, value: tokens };
}

/** Normalize and bound a character spec; the error is written for the model. */
export function validateCharacterSpec(input: {
  name: string;
  persona: string;
  moods: readonly string[];
  verdicts?: readonly string[];
  greeting?: string;
  directorNotes?: string;
}): Validated<CharacterSpec> {
  const name = input.name.replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_CHARACTER_NAME_CHARS) {
    return {
      ok: false,
      error: `The character needs a name of at most ${MAX_CHARACTER_NAME_CHARS} characters.`,
    };
  }
  const persona = input.persona.trim();
  if (!persona || persona.length > MAX_PERSONA_CHARS) {
    return {
      ok: false,
      error: `The persona must be non-empty and at most ${MAX_PERSONA_CHARS} characters.`,
    };
  }
  const moods = validateTokens("moods", input.moods, MIN_MOODS, MAX_MOODS);
  if (!moods.ok) return moods;
  let verdicts: string[] | undefined;
  if (input.verdicts && input.verdicts.length > 0) {
    const checked = validateTokens("verdicts", input.verdicts, 1, MAX_VERDICTS);
    if (!checked.ok) return checked;
    verdicts = checked.value;
  }
  const greeting = input.greeting?.trim() || undefined;
  if (greeting && greeting.length > MAX_CHARACTER_REPLY_CHARS) {
    return {
      ok: false,
      error: `The greeting must be at most ${MAX_CHARACTER_REPLY_CHARS} characters.`,
    };
  }
  const directorNotes = input.directorNotes?.trim() || undefined;
  if (directorNotes && directorNotes.length > MAX_DIRECTOR_NOTES_CHARS) {
    return {
      ok: false,
      error: `The director notes must be at most ${MAX_DIRECTOR_NOTES_CHARS} characters.`,
    };
  }
  return {
    ok: true,
    value: {
      name,
      persona,
      moods: moods.value,
      ...(verdicts ? { verdicts } : {}),
      ...(greeting ? { greeting } : {}),
      ...(directorNotes ? { directorNotes } : {}),
    },
  };
}

export function validateJudgeSpec(input: {
  id: string;
  rubric: string;
  verdicts: readonly string[];
}): Validated<JudgeSpec> {
  const id = input.id.trim();
  if (!APP_JUDGE_ID_PATTERN.test(id)) {
    return {
      ok: false,
      error:
        "The judge id must start with a letter and use only letters, digits, - or _ (at most 40).",
    };
  }
  const rubric = input.rubric.trim();
  if (!rubric || rubric.length > MAX_RUBRIC_CHARS) {
    return {
      ok: false,
      error: `The rubric must be non-empty and at most ${MAX_RUBRIC_CHARS} characters.`,
    };
  }
  const verdicts = validateTokens("verdicts", input.verdicts, 1, MAX_VERDICTS);
  if (!verdicts.ok) return verdicts;
  return { ok: true, value: { id, rubric, verdicts: verdicts.value } };
}

/** The app the tutor is building: the app open in the builder this turn
 * (`focusArtifactId`, TRA-519) when it is one of this session's apps, else
 * the session's newest code artifact (lib/focusApp.ts). */
async function newestCodeArtifact(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  focusArtifactId?: Id<"artifacts">,
): Promise<Doc<"artifacts"> | null> {
  const artifacts = await ctx.db
    .query("artifacts")
    .withIndex("by_session", (q) => q.eq("sessionId", sessionId))
    .collect();
  return pickFocusApp(artifacts, sessionId, focusArtifactId);
}

async function ownedSession(
  ctx: QueryCtx,
  sessionId: Id<"sessions">,
  callerUserId: Id<"users">,
): Promise<Doc<"sessions">> {
  const session = await ctx.db.get(sessionId);
  if (!session || session.userId !== callerUserId) {
    throw new Error("App AI is available only in the owner's session");
  }
  return session;
}

/**
 * A persona-only edit changes no code revision, so the per-turn starter
 * autosave short-circuits and never re-promotes. When this rehearsal artifact
 * is the one the activity's starter was promoted from, carry the spec onto the
 * starter directly so new scholar sessions clone it.
 */
async function syncPromotedStarter(
  ctx: MutationCtx,
  session: Doc<"sessions">,
  artifact: Doc<"artifacts">,
  appAi: NonNullable<Doc<"artifacts">["appAi"]>,
): Promise<boolean> {
  if (!session.isTestDrive || !session.activityId) return false;
  const activity = await ctx.db.get(session.activityId);
  const starterAppId = activity?.starterAppId;
  if (!starterAppId) return false;
  const starter = await ctx.db.get(starterAppId);
  if (
    starter?.kind !== "static" ||
    starter.origin !== "starter" ||
    starter.sourceArtifactId !== artifact._id
  ) {
    return false;
  }
  // Promotion forks a shared starter rather than editing it in place; never
  // rewrite a row another activity still points at.
  const references = await ctx.db
    .query("activities")
    .withIndex("by_starterAppId", (q) => q.eq("starterAppId", starterAppId))
    .take(2);
  if (references.length > 1) return false;
  await ctx.db.patch(starterAppId, { appAi, updatedAt: appAi.updatedAt });
  return true;
}

const characterInput = v.object({
  name: v.string(),
  persona: v.string(),
  moods: v.array(v.string()),
  verdicts: v.optional(v.array(v.string())),
  greeting: v.optional(v.string()),
  directorNotes: v.optional(v.string()),
});

const defineResult = v.union(
  v.object({
    ok: v.literal(true),
    artifactId: v.id("artifacts"),
    starterSynced: v.boolean(),
  }),
  v.object({ ok: v.literal(false), error: v.string() }),
);

export const defineCharacter = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    callerUserId: v.id("users"),
    character: characterInput,
    /** The app open in the builder this turn (TRA-519). */
    focusArtifactId: v.optional(v.id("artifacts")),
  },
  returns: defineResult,
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId, args.callerUserId);
    const validated = validateCharacterSpec(args.character);
    if (!validated.ok) return validated;
    const artifact = await newestCodeArtifact(
      ctx,
      session._id,
      args.focusArtifactId,
    );
    if (!artifact) {
      return {
        ok: false as const,
        error: "There is no app yet. Build it with create_code first, then define the character.",
      };
    }
    const appAi = {
      ...artifact.appAi,
      character: validated.value,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(artifact._id, { appAi });
    const starterSynced = await syncPromotedStarter(
      ctx,
      session,
      artifact,
      appAi,
    );
    return { ok: true as const, artifactId: artifact._id, starterSynced };
  },
});

export const defineJudge = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    callerUserId: v.id("users"),
    judge: v.object({
      id: v.string(),
      rubric: v.string(),
      verdicts: v.array(v.string()),
    }),
    /** The app open in the builder this turn (TRA-519). */
    focusArtifactId: v.optional(v.id("artifacts")),
  },
  returns: defineResult,
  handler: async (ctx, args) => {
    const session = await ownedSession(ctx, args.sessionId, args.callerUserId);
    const validated = validateJudgeSpec(args.judge);
    if (!validated.ok) return validated;
    const artifact = await newestCodeArtifact(
      ctx,
      session._id,
      args.focusArtifactId,
    );
    if (!artifact) {
      return {
        ok: false as const,
        error: "There is no app yet. Build it with create_code first, then define the judge.",
      };
    }
    const existing = artifact.appAi?.judges ?? [];
    const judges = [
      ...existing.filter((judge) => judge.id !== validated.value.id),
      validated.value,
    ];
    if (judges.length > MAX_JUDGES) {
      return {
        ok: false as const,
        error: `An app may have at most ${MAX_JUDGES} judges; reuse or replace one by its id.`,
      };
    }
    const appAi = { ...artifact.appAi, judges, updatedAt: Date.now() };
    await ctx.db.patch(artifact._id, { appAi });
    const starterSynced = await syncPromotedStarter(
      ctx,
      session,
      artifact,
      appAi,
    );
    return { ok: true as const, artifactId: artifact._id, starterSynced };
  },
});

/**
 * The character the scholar's tutor may direct this turn: the newest code app
 * in the owner's session that carries one. Only names, moods, and verdicts —
 * the persona stays out of the tool schema.
 */
export const directableCharacterForSession = internalQuery({
  args: {
    sessionId: v.id("sessions"),
    callerUserId: v.id("users"),
    /** The app open in the builder this turn (TRA-519). */
    focusArtifactId: v.optional(v.id("artifacts")),
  },
  returns: v.union(
    v.null(),
    v.object({
      artifactId: v.id("artifacts"),
      name: v.string(),
      moods: v.array(v.string()),
      verdicts: v.array(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    const session = await ctx.db.get(args.sessionId);
    if (!session || session.userId !== args.callerUserId) return null;
    const artifact = await newestCodeArtifact(
      ctx,
      session._id,
      args.focusArtifactId,
    );
    const character = artifact?.appAi?.character;
    if (!artifact || !character) return null;
    return {
      artifactId: artifact._id,
      name: character.name,
      moods: character.moods,
      verdicts: character.verdicts ?? [],
    };
  },
});

async function directableArtifact(
  ctx: QueryCtx,
  args: {
    sessionId: Id<"sessions">;
    artifactId: Id<"artifacts">;
    callerUserId: Id<"users">;
  },
): Promise<{ session: Doc<"sessions">; character: CharacterSpec }> {
  const session = await ownedSession(ctx, args.sessionId, args.callerUserId);
  const artifact = await ctx.db.get(args.artifactId);
  const character = artifact?.appAi?.character;
  if (
    !artifact ||
    artifact.sessionId !== session._id ||
    artifact.type !== "code" ||
    !character
  ) {
    throw new Error("This app has no character to direct");
  }
  return { session, character };
}

export const recordDirection = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    direction: v.string(),
  },
  returns: v.id("appAiTurns"),
  handler: async (ctx, args) => {
    const { session } = await directableArtifact(ctx, args);
    const direction = args.direction.trim();
    if (direction.length > MAX_DIRECTION_CHARS) {
      throw new Error(
        `A direction must be at most ${MAX_DIRECTION_CHARS} characters`,
      );
    }
    return await ctx.db.insert("appAiTurns", {
      sessionId: session._id,
      artifactId: args.artifactId,
      kind: "direction",
      status: "done",
      direction,
      createdAt: Date.now(),
    });
  },
});

export const speakAsCharacter = internalMutation({
  args: {
    sessionId: v.id("sessions"),
    artifactId: v.id("artifacts"),
    callerUserId: v.id("users"),
    line: v.string(),
    mood: v.optional(v.string()),
    verdict: v.optional(v.string()),
  },
  returns: v.object({
    turnId: v.id("appAiTurns"),
    overrodeVerdict: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const { session, character } = await directableArtifact(ctx, args);
    const line = args.line.replace(/\s+/g, " ").trim();
    if (!line || line.length > MAX_CHARACTER_REPLY_CHARS) {
      throw new Error(
        `A character line must be non-empty and at most ${MAX_CHARACTER_REPLY_CHARS} characters`,
      );
    }
    if (args.mood !== undefined && !character.moods.includes(args.mood)) {
      throw new Error(`"${args.mood}" is not one of this character's moods`);
    }
    if (
      args.verdict !== undefined &&
      !(character.verdicts ?? []).includes(args.verdict)
    ) {
      throw new Error(
        `"${args.verdict}" is not one of this character's verdicts`,
      );
    }
    const now = Date.now();
    const turnId = await ctx.db.insert("appAiTurns", {
      sessionId: session._id,
      artifactId: args.artifactId,
      kind: "aside",
      status: "done",
      line,
      ...(args.mood !== undefined ? { mood: args.mood } : {}),
      ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
      createdAt: now,
    });
    await upsertCharacterLine(ctx, {
      sessionId: session._id,
      artifactId: args.artifactId,
      line: {
        id: String(turnId),
        line,
        ...(args.mood !== undefined ? { mood: args.mood } : {}),
        ...(args.verdict !== undefined ? { verdict: args.verdict } : {}),
        requestedAt: now,
      },
    });
    let overrodeVerdict = false;
    if (args.verdict !== undefined) {
      // Finished exchanges only, bounded: other apps' rows interleave.
      const latestExchange = (
        await ctx.db
          .query("appAiTurns")
          .withIndex("by_session_kind_status", (q) =>
            q
              .eq("sessionId", session._id)
              .eq("kind", "exchange")
              .eq("status", "done"),
          )
          .order("desc")
          .take(50)
      ).find((row) => row.artifactId === args.artifactId);
      if (latestExchange) {
        await ctx.db.patch(latestExchange._id, {
          verdictOverride: { verdict: args.verdict, at: now },
        });
        overrodeVerdict = true;
      }
    }
    return { turnId, overrodeVerdict };
  },
});

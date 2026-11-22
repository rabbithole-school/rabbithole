// One parent-aide turn, independent of how it arrived.
//
// The parent aide used to be assembled inline in http.ts `/parent-chat-stream`:
// load the parent's context, derive the guardianship scope, build the scoped
// tools, build the prompt. That tied the aide to a browser request and an SSE
// response. This module is the seam: every channel that reaches the aide calls
// `prepareParentAideTurn` with the parent's id and a REQUIRED channel, so the
// scoping and prompt can never fork between channels.
//
// Three callers today:
//   - `/parent-chat-stream` (channel "web") — authenticates the browser
//     session, checks ownership of the assistant row, then streams the
//     prepared turn over SSE with `runAideStream`.
//   - `runParentAideTurn` (channel "sms") — no request, no SSE, no
//     selected child. Persists the parent's message and the reply as
//     `parentChatMessages` rows, so the web panel shows the same thread.
//     The SMS webhook (convex/parentSms.ts) resolves the sender to a
//     consented guardian, queues the text, and calls this one turn at a
//     time per parent.
//   - `simulateParentSmsTurn` (channel "sms", simulated) — staff on
//     /family-chat texting as one of their school's parents
//     (convex/familyChat.ts). Same prompt, tools, and model as a real text;
//     the history is the staff member's own in-browser thread, nothing is
//     persisted to the parent's thread, and the BunnyPad freeze/find tools
//     say what they would do instead of doing it.
//
// Scoping is the whole point of the seam: `allowedScholarIds` comes ONLY from
// the parent's own `guardianships` rows (parentChat.getContext), and it is the
// set the scholar-read tools resolve names against. No channel supplies it.

import type { Anthropic } from "@anthropic-ai/sdk";
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ROLES } from "./roles";
import { matchByName } from "./nameMatch";
import { MODELS } from "./models";
import { makeScholarReadTools } from "./scholarReadTools";
import {
  guardCodeToolArguments,
  makeScholarCodeTools,
  protectedTermsFromNames,
} from "./scholarCodeTools";
import {
  buildParentAideSystemPrompt,
  resolveSelectedChildName,
} from "./parentAidePrompt";
import type { InstitutionPromptProfile } from "./institutionPromptProfile";
import { effectiveInstitutionTimeZone } from "./institutionTime";
import { formattingGuidance, linkBaseFor, schoolTimeLabel } from "./channels";
import { cachedSystem, runAideLoop, type AideEmit, type AideTools } from "./aideStream";
import { smsBodyFor } from "./parentMessageChannels";
import { recordUsage } from "../usage";
import { familyBedtimeRangeText } from "../../shared/bedtime";

export const PARENT_AIDE_MODEL = MODELS.SONNET;
export const PARENT_AIDE_MAX_TOKENS = 2048;
/**
 * Cost cap on the tool loop now that the code explorer is here. Looser than
 * the scholar Workshop's CODE_EXPLORER_MAX_ITERATIONS (5) because the
 * scholar-read tools ran uncapped before and a turn that reads two children's
 * practice + seeds and then opens a source file is already four rounds; the
 * SDK stops silently at the cap and the partial text is finalized as the
 * answer, so the cap must never bite a normal turn.
 */
export const PARENT_AIDE_MAX_ITERATIONS = 8;
/** The `usage.source` every parent-aide channel records under. */
export const PARENT_AIDE_USAGE_SOURCE = "parent-chat";
/** Staff simulations (/family-chat), kept apart from real parents' spend. */
export const PARENT_AIDE_SIMULATION_USAGE_SOURCE = "parent-chat-preview";

/** One message of a simulated thread, oldest first. */
export type SimulatedParentMessage = {
  role: "user" | "assistant";
  content: string;
};

/**
 * How the turn arrived. Required, so a new caller has to say which channel it
 * is rather than inheriting the web panel's assumptions.
 *
 * - `web`: the parent portal. `selectedChildId` is the portal header's
 *   current child, client-supplied, and only ever resolved against the
 *   parent's own children.
 * - `sms`: a text from the parent's consented phone. No selected child, no
 *   live stream; the reply goes out as plain text, so the prompt carries the
 *   SMS formatting rules and the tools stamp absolute links.
 */
export type ParentAideChannel =
  | { kind: "web"; selectedChildId?: string | null }
  | { kind: "sms" };

export interface PreparedParentAideTurn {
  parentName: string;
  children: Array<{ id: Id<"users">; name: string }>;
  /** The guardianship-derived scope the read tools resolve names against. */
  allowedScholarIds: Set<Id<"users">>;
  institutionId: Id<"institutions"> | null;
  profile: InstitutionPromptProfile;
  tools: AideTools;
  systemPrompt: string;
  /**
   * Built fresh each turn: "Right now it is …" in the children's school time
   * zone, then any texts we sent before the parent's first message in this
   * conversation (see `apiMessages`). Callers pass it as `cachedSystem`'s
   * dynamic text, after the cache breakpoint, so the cached prompt stays
   * byte-stable.
   */
  turnSystemText: string;
  /**
   * History in API shape, oldest first, empty placeholders dropped. It opens
   * with the parent; texts we sent before that are in `turnSystemText`.
   */
  apiMessages: Array<{ role: "user" | "assistant"; content: string }>;
}

/**
 * Load everything one parent-aide turn needs. Returns null when the user is
 * not a parent or guardian (the same answer `parentChat.getContext` gives).
 *
 * The caller authenticates; this function trusts `parentUserId` and derives
 * everything else from it. `emit` receives tool progress events — the web
 * route passes its late-bound SSE emit, a background caller a no-op.
 */
export async function prepareParentAideTurn(
  ctx: ActionCtx,
  args: {
    parentUserId: Id<"users">;
    channel: ParentAideChannel;
    emit: AideEmit;
    /** The history ends at this message (the turn's own); see getContext. */
    throughMessageId?: Id<"parentChatMessages">;
    /**
     * A staff simulation (/family-chat): `history` replaces the parent's
     * stored thread, and the BunnyPad freeze/find tools change nothing. The
     * scope, prompt, and every read tool are the real parent's.
     */
    simulation?: { history: SimulatedParentMessage[] };
  },
): Promise<PreparedParentAideTurn | null> {
  const { parentUserId, channel, emit, throughMessageId, simulation } = args;
  const context = await ctx.runQuery(internal.parentChat.getContext, {
    parentUserId,
    ...(throughMessageId ? { throughMessageId } : {}),
  });
  if (!context) return null;

  // SCOPE: the tool resolver may only see this parent's children.
  const allowedScholarIds = new Set(context.children.map((c) => c.id));
  const childNames = context.children.map((c) => c.name);
  const institutionId = await ctx.runQuery(
    internal.usage.resolveSharedScholarInstitution,
    { userIds: context.children.map((child) => child.id) },
  );
  // Identity resolves from the child's institution (byte-identical to the old
  // primary-school wording when that's the primary / children disagree).
  const profile = await ctx.runQuery(internal.institutions.promptProfile, {
    institutionId,
  });
  // The primary school's own facts (the BunnyPad's bedtime, the school day)
  // reach only its parents, as bedtime itself does (lib/bedtime.ts).
  const firstParty = await ctx.runQuery(
    internal.institutions.isPrimaryInstitution,
    { institutionId },
  );

  // A text can't follow a relative path; the web panel can. The SMS base is
  // the deployment's app origin, so it is the same on every turn and the
  // prompt that names it stays byte-stable.
  const linkBase = channel.kind === "sms" ? linkBaseFor("sms") : "";

  // Same shared tool set as the teacher aide, role-filtered to tier-1 and
  // id-scoped to this parent's children (lib/scholarReadTools) — plus the
  // scholar Code Explorer (lib/scholarCodeTools): read-only, public-mirror
  // reads so "how does Rabbithole decide what's on her frontier?" gets a
  // true answer from the real code instead of a "can't see that" deflection
  // (2026-09-16: three of the first nine free-typed parent questions on prod
  // were about how the engine works, and all three were refused). The
  // explorer carries no scholar data, so it needs no guardianship scoping.
  // `guardianScopedParentAide`: this is the one caller that may receive the
  // Math Skills tile's skill list (TRA-322), because the audience is forced to
  // parent and the scope is this parent's guardianships.
  const scholarReadTools = await makeScholarReadTools(
    ctx,
    emit,
    ROLES.PARENT,
    allowedScholarIds,
    linkBase,
    undefined,
    undefined,
    false,
    { guardianScopedParentAide: true },
  );
  // Guarded: the model picks the explorer's arguments AFTER seeing the
  // child's data, so a child's or parent's name in a path/query would reach
  // GitHub's request logs — refuse those at the boundary
  // (lib/scholarCodeTools.guardCodeToolArguments).
  const codeTools = guardCodeToolArguments(
    await makeScholarCodeTools(emit, ctx),
    protectedTermsFromNames([...childNames, context.parentName]),
  );
  // BunnyPad freeze: the guardian id is the authenticated parent this turn
  // was prepared for, closed over here — the model never supplies it.
  const freezeTools = await makeParentFreezeTools(ctx, emit, {
    guardianUserId: parentUserId,
    children: context.children,
    source: freezeSourceFor(channel),
    dryRun: simulation !== undefined,
  });
  // Bedtime: the same closed-over guardian and strict child match. Bedtime
  // is the primary school's (lib/bedtime.ts), so only its parents get the
  // tools, as only they hear about bedtime in the prompt.
  const bedtimeTools = firstParty
    ? await makeParentBedtimeTools(ctx, emit, {
        guardianUserId: parentUserId,
        children: context.children,
        source: freezeSourceFor(channel),
        dryRun: simulation !== undefined,
      })
    : [];
  const tools: AideTools = [
    ...scholarReadTools,
    ...codeTools,
    ...freezeTools,
    ...bedtimeTools,
  ];

  const childList =
    childNames.length > 0 ? childNames.join(", ") : "(no children linked yet)";
  // The portal header's current selection, resolved ONLY against this
  // parent's guardianship-derived children — an id for anyone else falls
  // back to no selection rather than naming a child they can't see. A
  // text has no header, so no selection.
  const selectedChildName =
    channel.kind === "web"
      ? resolveSelectedChildName(context.children, channel.selectedChildId)
      : undefined;
  const basePrompt = buildParentAideSystemPrompt({
    profile,
    parentName: context.parentName,
    childList,
    childCount: childNames.length,
    selectedChildName,
    channel: channel.kind === "sms" ? "sms" : "web",
    linkBase,
    firstParty,
  });
  // Static per channel, so the cached prefix stays byte-stable per channel.
  const systemPrompt =
    channel.kind === "sms"
      ? `${basePrompt}\n\n${formattingGuidance("sms")}`
      : basePrompt;

  // A parent says "for 2 hours" or "Saturday"; the model needs today. The zone is
  // the children's shared school (the same one the prompt names), else the
  // default — freezeFromGuardian's reply labels the end in each BunnyPad's
  // own school time, and the aide reads that back.
  const timeZone = effectiveInstitutionTimeZone(profile.timeZone ?? undefined);
  const clockLine = `Right now it is ${schoolTimeLabel(Date.now(), timeZone, { withYear: true })}. Use it for "for 2 hours"-style lengths and for which day "tonight" or "Saturday" is.`;

  // A simulation's thread lives in the staff member's browser; the real
  // parent's stored thread is never read into it.
  const history = simulation
    ? simulation.history.map((m) => ({ ...m, at: Date.now() }))
    : context.messages;
  const kept = history.filter((m) => m.content.trim() !== "");
  // The API rejects a history that opens with an assistant message, but the
  // conversation can open on texts we sent: the 8 pm charge reminder or the
  // SMS intro (parentSms.noteSmsSent), or a failed turn's failure text. A
  // reply like "it's charging" means nothing without the text it answers,
  // so those go in the turn's system text instead (TRA-624).
  const firstParentRow = kept.findIndex((m) => m.role === "user");
  const opensAt = firstParentRow === -1 ? kept.length : firstParentRow;
  const sentFirst = textsSentFirst(kept.slice(0, opensAt), timeZone);
  const apiMessages = kept
    .slice(opensAt)
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  return {
    parentName: context.parentName,
    children: context.children,
    allowedScholarIds,
    institutionId,
    profile,
    tools,
    systemPrompt,
    turnSystemText: sentFirst ? `${clockLine}\n\n${sentFirst}` : clockLine,
    apiMessages,
  };
}

/**
 * The texts we sent before the parent's first message in this conversation,
 * each with its school time, or null when the conversation opens with the
 * parent.
 */
function textsSentFirst(
  rows: Array<{ content: string; at: number }>,
  timeZone: string,
): string | null {
  if (rows.length === 0) return null;
  const texts = rows
    .map((row) => `Sent ${schoolTimeLabel(row.at, timeZone)}:\n${row.content}`)
    .join("\n\n");
  // "The school sent", not "you texted": the reminder and the intro come from
  // a cron, so the aide can't promise to stop or change them.
  const [these, them] =
    rows.length === 1
      ? ["this automatic text", "it"]
      : ["these automatic texts", "them"];
  return `Before the parent's first message below, the school sent them ${these}. Their message may be a reply to ${them}.\n\n${texts}`;
}

/**
 * Run one complete parent-aide turn with no HTTP request and no SSE: persist
 * the parent's message, run the shared tool loop to completion, persist the
 * reply, and return its text. The caller authenticates the parent (e.g. maps
 * a verified phone number to a user) and owns the Anthropic client.
 *
 * Both rows land in `parentChatMessages`, so the turn appears in the parent's
 * web panel thread. The reply row is written once, complete — there is no
 * placeholder for the panel to show as streaming, and no stop button to
 * honor. An empty reply writes no assistant row (as `finalizeStream` drops an
 * empty placeholder).
 */
export async function runParentAideTurn(
  ctx: ActionCtx,
  args: {
    anthropic: Anthropic;
    parentUserId: Id<"users">;
    content: string;
    channel: ParentAideChannel;
  },
): Promise<{
  content: string;
  userMessageId: Id<"parentChatMessages">;
  assistantMessageId: Id<"parentChatMessages"> | null;
}> {
  const { anthropic, parentUserId, content, channel } = args;
  // Refuses a non-guardian, a read-only account, and an empty message before
  // anything is written.
  const userMessageId = await ctx.runMutation(
    internal.parentChat.appendUserMessageInternal,
    { parentUserId, content },
  );

  // Bound to its own message: a later message can't become this turn's
  // question even if it lands before the history loads (TRA-558).
  const turn = await prepareParentAideTurn(ctx, {
    parentUserId,
    channel,
    emit: () => {},
    throughMessageId: userMessageId,
  });
  if (!turn) throw new Error("Forbidden: not a guardian");

  const reply = await answerPreparedTurn(ctx, anthropic, turn, channel, {
    source: PARENT_AIDE_USAGE_SOURCE,
    role: ROLES.PARENT,
  });

  const assistantMessageId = reply.trim()
    ? await ctx.runMutation(internal.parentChat.appendAssistantMessageInternal, {
        parentUserId,
        content: reply,
      })
    : null;
  return { content: reply, userMessageId, assistantMessageId };
}

/**
 * Run the shared tool loop over a prepared turn to completion and record its
 * spend. The one place a background parent-aide turn calls the model, so a
 * real text and a staff simulation get the same model, caps, and notices.
 */
async function answerPreparedTurn(
  ctx: ActionCtx,
  anthropic: Anthropic,
  turn: PreparedParentAideTurn,
  channel: ParentAideChannel,
  usage: { source: string; role: string },
): Promise<string> {
  const result = await runAideLoop({
    anthropic,
    model: PARENT_AIDE_MODEL,
    maxTokens: PARENT_AIDE_MAX_TOKENS,
    system: cachedSystem(turn.systemPrompt, turn.turnSystemText),
    messages: turn.apiMessages,
    tools: turn.tools,
    maxIterations: PARENT_AIDE_MAX_ITERATIONS,
    // A text renders nothing: no `_…_` around a refusal notice.
    noticeStyle: channel.kind === "sms" ? "plain" : "markdown",
    label: "parent aide",
  });
  await recordUsage(ctx, {
    source: usage.source,
    role: usage.role,
    institutionId: turn.institutionId,
    model: result.model || String(PARENT_AIDE_MODEL),
    usage: result.usage,
  });
  return result.content;
}

/**
 * One simulated SMS turn for staff (/family-chat): the reply this parent
 * would get if they texted the last message of `history`. Prepared exactly as
 * a real text is (channel "sms", the parent's own guardianship scope), but it
 * writes nothing the parent can see: no `parentChatMessages` rows, no text
 * sent, and the BunnyPad tools only describe what they would do. The caller
 * authorizes the staff member against this parent first.
 *
 * Returns the full reply (what the next turn's history carries) and `sms`,
 * the body a phone would actually receive (parentSms delivers the same
 * transform).
 */
export async function simulateParentSmsTurn(
  ctx: ActionCtx,
  args: {
    anthropic: Anthropic;
    parentUserId: Id<"users">;
    history: SimulatedParentMessage[];
    /** The staff member's role, for the usage row. */
    callerRole: string;
  },
): Promise<{ content: string; sms: string }> {
  const channel: ParentAideChannel = { kind: "sms" };
  const turn = await prepareParentAideTurn(ctx, {
    parentUserId: args.parentUserId,
    channel,
    emit: () => {},
    simulation: { history: args.history },
  });
  if (!turn) throw new Error("Forbidden: not a guardian");
  const content = await answerPreparedTurn(ctx, args.anthropic, turn, channel, {
    source: PARENT_AIDE_SIMULATION_USAGE_SOURCE,
    role: args.callerRole,
  });
  return { content, sms: content.trim() ? smsBodyFor(content) : "" };
}

// ─── BunnyPad freeze ────────────────────────────────────────────────────────

/** What a simulated freeze/find tells the model, which says it back. */
const SIMULATION_NOTICE = "Staff preview: nothing was changed.";

/** The audit-line source a freeze from this channel records. A new channel
 *  must name its own source here rather than borrow one. */
function freezeSourceFor(
  channel: ParentAideChannel,
): "parent_app" | "parent_sms" {
  switch (channel.kind) {
    case "web":
      return "parent_app";
    case "sms":
      return "parent_sms";
  }
}

/**
 * The guardian's BunnyPad freeze tools: read the status of every one of their
 * children's BunnyPads, and freeze or unfreeze one child's.
 *
 * Two boundaries, both fixed before the model sees anything:
 *   - `guardianUserId` is the parent the turn was prepared for, closed over
 *     here. Neither tool's input schema has a guardian field, and `run` reads
 *     only the named fields, so a model-supplied id goes nowhere.
 *   - The child is resolved by name ONLY against `children` (the
 *     guardianships-derived list), with the strict matcher, so an ambiguous
 *     name is refused rather than guessed. freezeFromGuardian re-checks the
 *     guardianship itself.
 */
export async function makeParentFreezeTools(
  ctx: ActionCtx,
  emit: AideEmit,
  args: {
    guardianUserId: Id<"users">;
    children: Array<{ id: Id<"users">; name: string }>;
    source: "parent_app" | "parent_sms";
    /** A staff simulation: set/find say what they would do, and do nothing. */
    dryRun?: boolean;
  },
): Promise<AideTools> {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  const { guardianUserId, children, source, dryRun = false } = args;

  const statusTool = betaTool({
    name: "get_bunnypad_freeze_status",
    description:
      "Whether a freeze is set on each of the parent's children's BunnyPads (their school iPad), until when (school time), and who set it: 'family' (a parent) or 'school' (a teacher); also each child's planned freezes (one-off or repeating), with the id cancel_planned_bunnypad_freeze needs. A freeze takes effect on the BunnyPad once it is connected, so this says what is set, not what the BunnyPad shows this second. Call this before answering any question about a freeze, before unfreezing, and before cancelling a planned freeze.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as const,
    },
    run: async () => {
      const [status, plans] = await Promise.all([
        ctx.runQuery(internal.deviceLock.freezeStatusForGuardian, {
          guardianUserId,
        }),
        ctx.runQuery(internal.scheduledFreezes.listForGuardian, {
          guardianUserId,
        }),
      ]);
      // The query returns the boundary; a freeze whose end has passed is
      // already over on the device even if the thaw job hasn't run yet.
      const now = Date.now();
      const result = status.children.map((child) => {
        const planned = (
          plans.find((p) => p.scholarId === child.scholarId)?.plans ?? []
        ).map((plan) => ({ id: plan.id, when: plan.text }));
        return {
          child: child.name,
          ...(planned.length > 0 ? { plannedFreezes: planned } : {}),
          bunnyPads: child.devices.map((device) => {
            const frozen = device.frozenUntil !== null && device.frozenUntil > now;
            return {
              device: device.device,
              frozen,
              ...(frozen
                ? {
                    frozenUntil: device.frozenUntilLabel,
                    frozenBy: device.frozenBy,
                    setByYou: device.setByYou,
                  }
                : {}),
            };
          }),
        };
      });
      emit({
        toolComplete: {
          name: "get_bunnypad_freeze_status",
          result: "Checked BunnyPad freeze",
        },
      });
      return JSON.stringify(result);
    },
  });

  const setTool = betaTool({
    name: "set_bunnypad_freeze",
    description:
      "Freeze or unfreeze one child's BunnyPad (every BunnyPad paired to that child). A frozen BunnyPad stays in Rabbithole behind a screen saying it is frozen until the stated time, then thaws on its own. A freeze or unfreeze takes effect once the BunnyPad is connected. Call it as soon as the parent asks; no confirmation is needed unless their intent is unclear. Give its length as minutes, or its end as untilTime (\"until 5:33pm\" is untilTime \"17:33\"), never both. A family freeze lasts at least 5 minutes and must end before the next school day starts (up to 8 hours is always allowed); a refusal names the latest end time. For a freeze that starts later or repeats, use schedule_bunnypad_freeze instead. You cannot change a freeze the school set; the result says so when that happens. Report the result's message to the parent as it is.",
    inputSchema: {
      type: "object" as const,
      properties: {
        childName: {
          type: "string" as const,
          description: "The child's name, as listed in your instructions.",
        },
        frozen: {
          type: "boolean" as const,
          description: "true to freeze, false to unfreeze.",
        },
        minutes: {
          type: "number" as const,
          description:
            "How many minutes from now the freeze lasts (whole number, at least 5; \"2 hours 3 minutes\" is 123). Use this or untilTime when freezing; ignored when unfreezing.",
        },
        untilTime: {
          type: "string" as const,
          description:
            "When the freeze ends, 24-hour school time, e.g. \"17:33\": the next time that clock time comes round. Use this or minutes when freezing.",
        },
      },
      required: ["childName", "frozen"] as const,
    },
    run: async (input) => {
      const match = matchByName(input.childName, children);
      if (match.kind === "none") {
        return `"${input.childName}" isn't one of your children, so I can't change their BunnyPad.`;
      }
      if (match.kind === "ambiguous") {
        return `"${input.childName}" could be ${match.candidates.map((c) => c.name).join(" or ")}. Ask the parent which child they mean.`;
      }
      let untilClockMinutes: number | undefined;
      if (input.frozen && input.untilTime !== undefined) {
        const clock = minutesFromClock(input.untilTime);
        if (clock === null) {
          return 'Give the end time as a 24-hour clock time, like "17:33".';
        }
        untilClockMinutes = clock;
      }
      const length = input.frozen
        ? untilClockMinutes !== undefined
          ? { untilClockMinutes }
          : { minutes: input.minutes }
        : {};
      if (dryRun) {
        // The same refusals a real request meets (minutes out of range,
        // nothing paired, a school freeze), read-only, so the preview
        // shows what the parent would actually be told.
        const check = await ctx.runQuery(
          internal.deviceLock.previewFreezeFromGuardian,
          {
            guardianUserId,
            scholarId: match.scholar.id,
            frozen: input.frozen,
            ...length,
          },
        );
        if (!check.ok) return check.message ?? "That freeze can't be set.";
        const would = input.frozen
          ? `freeze ${match.scholar.name}'s BunnyPad ${untilClockMinutes !== undefined ? `until ${input.untilTime}` : `for ${input.minutes} minutes`}`
          : `unfreeze ${match.scholar.name}'s BunnyPad`;
        return `${SIMULATION_NOTICE} For a real parent this would ${would}.`;
      }
      const result = await ctx.runMutation(
        internal.deviceLock.freezeFromGuardian,
        {
          guardianUserId,
          scholarId: match.scholar.id,
          source,
          frozen: input.frozen,
          ...length,
        },
      );
      emit({
        toolComplete: {
          name: "set_bunnypad_freeze",
          result: result.ok
            ? input.frozen
              ? "BunnyPad freeze set"
              : "BunnyPad unfreeze set"
            : `Failed: ${result.message}`,
        },
      });
      return result.message;
    },
  });

  const weekdayCodes = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const scheduleTool = betaTool({
    name: "schedule_bunnypad_freeze",
    description:
      "Plan a freeze of one child's BunnyPad that starts later: once (\"6 to 7pm tonight\", \"Saturday 3 to 5pm\") or repeating on days of the week (\"6 to 7pm every weeknight\"). At the start time the BunnyPad freezes until the end time, the same as a freeze set then. A window starts and ends on the same day, lasts 5 minutes to 8 hours, and never runs during the school day (an occurrence then is skipped, and one that runs into the first bell ends there); a school freeze in force wins. If the window has already begun today, the freeze starts now. Call it as soon as the parent asks; no confirmation is needed unless their intent is unclear. Report the result's message to the parent as it is.",
    inputSchema: {
      type: "object" as const,
      properties: {
        childName: {
          type: "string" as const,
          description: "The child's name, as listed in your instructions.",
        },
        startTime: {
          type: "string" as const,
          description: "When the freeze starts, 24-hour school time, e.g. \"18:00\".",
        },
        endTime: {
          type: "string" as const,
          description: "When it ends, 24-hour school time, later the same day, e.g. \"19:00\".",
        },
        repeatDays: {
          type: "array" as const,
          items: {
            type: "string" as const,
            enum: weekdayCodes,
          },
          description:
            "For a repeating freeze, the days it happens (\"every weeknight\" is mon to fri). Leave out for a one-off.",
        },
        date: {
          type: "string" as const,
          description:
            "For a one-off on a particular day, its date as YYYY-MM-DD in school time. Leave out for the next time the window comes round (today if it hasn't ended yet, else tomorrow).",
        },
      },
      required: ["childName", "startTime", "endTime"] as const,
    },
    run: async (input) => {
      const match = matchByName(input.childName, children);
      if (match.kind === "none") {
        return `"${input.childName}" isn't one of your children, so I can't change their BunnyPad.`;
      }
      if (match.kind === "ambiguous") {
        return `"${input.childName}" could be ${match.candidates.map((c) => c.name).join(" or ")}. Ask the parent which child they mean.`;
      }
      const startMinutes = minutesFromClock(input.startTime);
      const endMinutes = minutesFromClock(input.endTime);
      if (startMinutes === null || endMinutes === null) {
        return 'Give both times as 24-hour clock times, like "18:00" and "19:00".';
      }
      const weekdays = (input.repeatDays ?? []).map((d) =>
        weekdayCodes.indexOf(String(d).toLowerCase().slice(0, 3)),
      );
      if (weekdays.some((d) => d < 0)) {
        return 'Give the days as "mon" to "sun".';
      }
      const request = {
        guardianUserId,
        scholarId: match.scholar.id,
        startMinutes,
        endMinutes,
        ...(weekdays.length > 0 ? { weekdays } : {}),
        ...(input.date !== undefined ? { dayKey: input.date } : {}),
      };
      if (dryRun) {
        const check = await ctx.runQuery(
          internal.scheduledFreezes.previewScheduleFromGuardian,
          request,
        );
        if (!check.ok) return check.message ?? "That freeze can't be planned.";
        return `${SIMULATION_NOTICE} For a real parent this would plan a freeze of ${match.scholar.name}'s BunnyPad from ${input.startTime} to ${input.endTime}${weekdays.length > 0 ? ` on ${(input.repeatDays ?? []).join(", ")}` : ""}.`;
      }
      const result = await ctx.runMutation(
        internal.scheduledFreezes.scheduleFromGuardian,
        { ...request, source },
      );
      emit({
        toolComplete: {
          name: "schedule_bunnypad_freeze",
          result: result.ok
            ? "BunnyPad freeze planned"
            : `Failed: ${result.message}`,
        },
      });
      return result.message;
    },
  });

  const cancelPlanTool = betaTool({
    name: "cancel_planned_bunnypad_freeze",
    description:
      "Remove one planned freeze (one-off or repeating), by the id get_bunnypad_freeze_status lists. It doesn't lift a freeze that is already running; use set_bunnypad_freeze to unfreeze that. Report the result's message to the parent as it is.",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string" as const,
          description: "The planned freeze's id, from get_bunnypad_freeze_status.",
        },
      },
      required: ["id"] as const,
    },
    run: async (input) => {
      if (dryRun) {
        const plans = await ctx.runQuery(
          internal.scheduledFreezes.listForGuardian,
          { guardianUserId },
        );
        const found = plans.some((child) =>
          child.plans.some((plan) => plan.id === input.id),
        );
        if (!found) return "That planned freeze isn't there any more.";
        return `${SIMULATION_NOTICE} For a real parent this would remove that planned freeze.`;
      }
      const result = await ctx.runMutation(
        internal.scheduledFreezes.cancelFromGuardian,
        { guardianUserId, scheduledFreezeId: input.id, source },
      );
      emit({
        toolComplete: {
          name: "cancel_planned_bunnypad_freeze",
          result: result.ok
            ? "Planned freeze removed"
            : `Failed: ${result.message}`,
        },
      });
      return result.message;
    },
  });

  // Find my BunnyPad: same closed-over guardian and strict child match as the
  // freeze; prepareFindFromGuardian re-checks the guardianship itself.
  const findTool = betaTool({
    name: "find_bunnypad",
    description:
      "Make one child's BunnyPad play a loud find sound, for a BunnyPad the family can't locate. It plays a shrill tone for about 30 seconds; nothing else on the BunnyPad changes. It stays silent while Do Not Disturb is on, so silence does not mean the BunnyPad is somewhere else. It only reaches a BunnyPad that is on and online. Report the result's message to the parent as it is: 'sent' means it was sent, not that it is beeping.",
    inputSchema: {
      type: "object" as const,
      properties: {
        childName: {
          type: "string" as const,
          description: "The child's name, as listed in your instructions.",
        },
      },
      required: ["childName"] as const,
    },
    run: async (input) => {
      const match = matchByName(input.childName, children);
      if (match.kind === "none") {
        return `"${input.childName}" isn't one of your children, so I can't find their BunnyPad.`;
      }
      if (match.kind === "ambiguous") {
        return `"${input.childName}" could be ${match.candidates.map((c) => c.name).join(" or ")}. Ask the parent which child they mean.`;
      }
      if (dryRun) {
        const check = await ctx.runQuery(
          internal.bunnypadFind.previewFindFromGuardian,
          { guardianUserId, scholarId: match.scholar.id },
        );
        if (!check.ok) return check.message ?? "That BunnyPad can't be found.";
        return `${SIMULATION_NOTICE} For a real parent this would play the find sound on ${match.scholar.name}'s BunnyPad.`;
      }
      const result = await ctx.runAction(internal.bunnypadFindPush.findFromGuardian, {
        guardianUserId,
        scholarId: match.scholar.id,
        source,
      });
      emit({
        toolComplete: {
          name: "find_bunnypad",
          result: result.ok ? "Find sound sent" : `Failed: ${result.message}`,
        },
      });
      return result.message;
    },
  });

  return [statusTool, setTool, scheduleTool, cancelPlanTool, findTool];
}

// ─── BunnyPad bedtime ───────────────────────────────────────────────────────

/** "19:30" → 1170, or null for anything that isn't a 24-hour clock time. */
function minutesFromClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * The guardian's BunnyPad bedtime tools (TRA-625): read each child's nightly
 * window, and set one child's. The same two boundaries as the freeze tools:
 * the guardian is closed over, and the child is matched by name only against
 * this parent's guardianship-derived list. scholarBedtimes.setFromGuardian
 * re-checks the guardianship and the bounds itself.
 */
export async function makeParentBedtimeTools(
  ctx: ActionCtx,
  emit: AideEmit,
  args: {
    guardianUserId: Id<"users">;
    children: Array<{ id: Id<"users">; name: string }>;
    source: "parent_app" | "parent_sms";
    /** A staff simulation: set says what it would do, and does nothing. */
    dryRun?: boolean;
  },
): Promise<AideTools> {
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  const { guardianUserId, children, source, dryRun = false } = args;

  const statusTool = betaTool({
    name: "get_bunnypad_bedtime",
    description:
      "Each of the parent's children's BunnyPad bedtime: the nightly window when the BunnyPad sleeps, and whether the family set it or it is the school's 8pm to 6am. A child whose school doesn't put the BunnyPad to sleep shows no bedtime. Call this before answering a question about bedtime, and before changing one.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [] as const,
    },
    run: async () => {
      const status = await ctx.runQuery(
        internal.scholarBedtimes.statusForGuardian,
        { guardianUserId },
      );
      emit({
        toolComplete: {
          name: "get_bunnypad_bedtime",
          result: "Checked BunnyPad bedtime",
        },
      });
      return JSON.stringify(
        status.map((child) => ({
          child: child.name,
          bedtime: child.bedtime
            ? {
                window: child.bedtime.text,
                setBy: child.bedtime.setByFamily ? "family" : "school",
              }
            : null,
        })),
      );
    },
  });

  const setTool = betaTool({
    name: "set_bunnypad_bedtime",
    description:
      `Set one child's BunnyPad bedtime, every night: when the BunnyPad goes to sleep and when it wakes. It can only be stricter than the school's 8pm to 6am: ${familyBedtimeRangeText()}. Setting 20:00 and 06:00 puts the child back on the school's bedtime. Any of the child's parents can change it, and the latest change is the one that counts. Call it as soon as the parent asks; confirm first only when their intent is unclear. When the bedtime gets earlier, mention afterwards that it also ends evening homework time on the BunnyPad. For one evening only, a freeze is the tool, not this. Report the result's message to the parent as it is.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        childName: {
          type: "string" as const,
          description: "The child's name, as listed in your instructions.",
        },
        bedtime: {
          type: "string" as const,
          description:
            "When the BunnyPad goes to sleep, 24-hour school time, e.g. \"19:30\".",
        },
        wakeTime: {
          type: "string" as const,
          description:
            "When it wakes the next morning, 24-hour school time, e.g. \"06:00\". Use \"06:00\" unless the parent asked for a later wake-up.",
        },
      },
      required: ["childName", "bedtime", "wakeTime"] as const,
    },
    run: async (input) => {
      const match = matchByName(input.childName, children);
      if (match.kind === "none") {
        return `"${input.childName}" isn't one of your children, so I can't change their bedtime.`;
      }
      if (match.kind === "ambiguous") {
        return `"${input.childName}" could be ${match.candidates.map((c) => c.name).join(" or ")}. Ask the parent which child they mean.`;
      }
      const startMinutes = minutesFromClock(input.bedtime);
      const endMinutes = minutesFromClock(input.wakeTime);
      if (startMinutes === null || endMinutes === null) {
        return 'Give both times as 24-hour clock times, like "19:30" and "06:00".';
      }
      const request = {
        guardianUserId,
        scholarId: match.scholar.id,
        startMinutes,
        endMinutes,
      };
      if (dryRun) {
        const check = await ctx.runQuery(
          internal.scholarBedtimes.previewFromGuardian,
          request,
        );
        if (!check.ok) return check.message ?? "That bedtime can't be set.";
        return `${SIMULATION_NOTICE} For a real parent this would set ${match.scholar.name}'s BunnyPad bedtime to ${input.bedtime} to ${input.wakeTime}.`;
      }
      const result = await ctx.runMutation(
        internal.scholarBedtimes.setFromGuardian,
        { ...request, source },
      );
      emit({
        toolComplete: {
          name: "set_bunnypad_bedtime",
          result: result.ok
            ? "BunnyPad bedtime set"
            : `Failed: ${result.message}`,
        },
      });
      return result.message;
    },
  });

  return [statusTool, setTool];
}

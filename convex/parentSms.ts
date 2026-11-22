// Inbound SMS → the parent aide. A text from a guardian's consented phone is
// one more channel into the same aide the parent portal runs
// (lib/parentAideTurn), never a second chatbot.
//
// The path, in order:
//   1. http.ts `/twilio/sms` verifies X-Twilio-Signature (fail closed) and
//      calls `ingestInboundSms`, then answers Twilio at once with TwiML. The
//      model never runs inside the webhook, so a slow turn can't make Twilio
//      time out and retry.
//   2. `ingestInboundSms` dedupes on MessageSid BEFORE any write, refuses a
//      `From` that isn't one E.164 number, handles the keywords (STOP /
//      START / HELP) in code, resolves the sender to exactly one consented
//      guardian, applies the hourly cap and the exact-repeat guard, and
//      queues the text.
//   3. `processSmsTurns` runs that parent's queue one turn at a time, oldest
//      first, so an earlier text can never be answered after a later one and
//      two quick texts can't both answer the second (TRA-558). Each turn is
//      bound to its own message (runParentAideTurn → getContext
//      throughMessageId). A text that waited over five minutes is dropped,
//      not answered late. The reply goes out through deliverOffPortal as
//      plain text, after consent and guardianship are checked again. A
//      failed turn's failure text is also saved as the aide's reply.
//
// The pilot gate is the consent row: an `sms` row in parentChannelIdentities
// with `optInAt` and no `stopState`, written by staff with
// `recordSmsConsent` after verbal consent. No env flag, no START keyword.
// That consent is scoped to the aide (`scope: "aide"`): it does not turn on
// teacher messages by SMS (lib/parentMessageChannels rowCarriesTeacherMessages).
//
// The toll-free number is the primary school's (one verified sender, one
// business on its registration), so this is first-party-only: a guardian is
// eligible only when every child they're linked to is at the live primary
// institution. Build the per-institution version when a second school has a
// number of its own.
//
// Logs carry no phone numbers and no message bodies.

import { v, type Infer } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  canonicalPhoneIdentity,
  deliverOffPortal,
  isE164Sender,
  SMS_TURN_FAILED_TEXT,
  smsHelpText,
  smsIntroText,
  smsKeyword,
  smsBodyFor,
} from "./lib/parentMessageChannels";
import { livePrimaryInstitution } from "./lib/primaryInstitution";
import { appBaseUrlOrNull } from "./lib/deploymentConfig";
import { runParentAideTurn } from "./lib/parentAideTurn";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { anthropicErrorMessage } from "./lib/aideStream";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import { nextOpenSchoolDayKey, prevOpenSchoolDayKey } from "./lib/schoolDays";
import {
  listSimpleMdmDevices,
  normalizeSerial,
  simpleMdmErrorMessage,
} from "./lib/simpleMdmClient";
import {
  dayKeyForTimezone,
  dayStartForDayKey,
  shiftDayKey,
  weekdayForDayKey,
} from "../shared/institutionDay";
import {
  CHARGE_REMINDERS_OFF_REPLY,
  CHARGE_REMINDERS_ON_REPLY,
  chargeReminderKeyword,
  chargeReminderText,
  chargeReminderVerdict,
  type BatteryEvidence,
  type ChargeReminderKid,
  type ChargeVerdict,
} from "./lib/chargeReminder";

/**
 * A running turn older than this is dead: a Convex action can't outlive 10
 * minutes, so by now its action has been killed without reaching
 * `finishSmsTurn`. The watchdog scheduled at claim time fails it, texts the
 * parent, and moves the queue on.
 */
export const SMS_TURN_STALE_MS = 11 * 60_000;

/**
 * Inbound texts per parent per hour before the rest are ignored
 * (`rate-limited`). A pilot cost cap set well above any real family's use,
 * NOT a calibrated threshold: its job is to stop a loop (an auto-responder
 * answering each reply) from running the model all night.
 */
export const SMS_HOURLY_CAP = 20;
const HOUR_MS = 60 * 60_000;

/**
 * A queued text older than this when its turn comes up is dropped
 * (`stale`), not answered: a request ("freeze it now") must not run hours or
 * days later, when the parent next texts.
 */
export const SMS_QUEUE_STALE_MS = 5 * 60_000;

/** SHA-256 hex of a text, for the exact-repeat check (the text isn't kept). */
async function bodyHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The aide's reply row for a turn that failed, so the thread shows it and
 *  the next turn's history can't pick the failed request back up. */
async function noteFailedTurn(ctx: MutationCtx, parentUserId: Id<"users">) {
  await ctx.db.insert("parentChatMessages", {
    parentUserId,
    role: "assistant",
    content: SMS_TURN_FAILED_TEXT,
  });
}

type Ctx = QueryCtx | MutationCtx;

/**
 * Why this user can't text the aide, or null when they can. Authorized on
 * GUARDIANSHIP, not role: a teacher who is also a parent is eligible, the
 * same as the web aide (http.ts /parent-chat-stream). The WhatsApp opt-in's
 * `role !== PARENT` check is deliberately not reused.
 */
async function ineligibleReason(
  ctx: Ctx,
  userId: Id<"users">,
): Promise<string | null> {
  const user = await ctx.db.get(userId);
  if (!user) return "no-user";
  if (user.readOnly) return "read-only";
  const links = await ctx.db
    .query("guardianships")
    .withIndex("by_parent", (q) => q.eq("parentUserId", userId))
    .collect();
  if (links.length === 0) return "not-guardian";
  // First-party gate (see the header): every child at the live primary.
  const primary = await livePrimaryInstitution(ctx);
  if (!primary) return "not-first-party";
  for (const link of links) {
    const child = await ctx.db.get(link.scholarUserId);
    if (!child || child.institutionId !== primary._id) return "not-first-party";
  }
  return null;
}

/** The sms identity rows for one canonical number. */
function smsRowsFor(ctx: Ctx, identity: string) {
  return ctx.db
    .query("parentChannelIdentities")
    .withIndex("by_identity", (q) =>
      q.eq("channel", "sms").eq("identity", identity),
    )
    .collect();
}

/**
 * The number a queued/running turn may text back, or null. Re-checked at send
 * time, so a STOP, a staff edit, or a guardianship removed mid-turn stops the
 * reply (it can carry a child's data).
 */
async function replyTarget(
  ctx: Ctx,
  turn: Doc<"parentSmsInbound">,
): Promise<string | null> {
  if (!turn.identityId || !turn.parentUserId) return null;
  const row = await ctx.db.get(turn.identityId);
  if (
    !row ||
    row.channel !== "sms" ||
    row.parentUserId !== turn.parentUserId ||
    !row.optInAt ||
    row.stopState === true
  ) {
    return null;
  }
  if ((await smsRowsFor(ctx, row.identity)).length !== 1) return null;
  if (await ineligibleReason(ctx, turn.parentUserId)) return null;
  return row.identity;
}

// ── 1. Inbound ──────────────────────────────────────────────────────────

/**
 * One verified inbound text. Returns what happened, and `reply` when the
 * webhook should answer inline (only the HELP text, which carries no
 * scholar data). Nothing else is said to a sender that didn't resolve.
 */
export const ingestInboundSms = internalMutation({
  args: {
    messageSid: v.string(),
    from: v.string(),
    body: v.string(),
    // Twilio sets this (STOP / START / HELP) only when Advanced Opt-Out is
    // on, and then it has already sent its own keyword reply.
    optOutType: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Dedupe first: a retried delivery writes nothing at all.
    const seen = await ctx.db
      .query("parentSmsInbound")
      .withIndex("by_message_sid", (q) => q.eq("messageSid", args.messageSid))
      .first();
    if (seen) return { action: "duplicate" as const, reply: null };

    const record = (fields: Omit<Partial<Doc<"parentSmsInbound">>, "_id" | "_creationTime">) =>
      ctx.db.insert("parentSmsInbound", {
        messageSid: args.messageSid,
        status: "ignored",
        finishedAt: Date.now(),
        ...fields,
      });

    // One E.164 number or nothing: a `whatsapp:` id or a malformed sender
    // must not normalize its way onto a family's row.
    if (!isE164Sender(args.from)) {
      await record({ reason: "malformed-from" });
      return { action: "ignored" as const, reply: null };
    }
    const identity = canonicalPhoneIdentity(args.from);
    const rows = await smsRowsFor(ctx, identity);
    const optOut = args.optOutType?.trim().toUpperCase();
    const keyword =
      optOut === "STOP"
        ? "stop"
        : optOut === "START"
          ? "start"
          : optOut === "HELP"
            ? "help"
            : smsKeyword(args.body);

    if (keyword === "stop") {
      // Honored for every row on this number, ambiguous or not. No reply:
      // the toll-free network already sent its fixed confirmation, and
      // Twilio blocks further texts to the number (error 21610).
      for (const row of rows) await ctx.db.patch(row._id, { stopState: true });
      await record({
        status: "stopped",
        ...(rows.length === 1 ? { parentUserId: rows[0].parentUserId } : {}),
      });
      return { action: "stopped" as const, reply: null };
    }
    if (keyword === "start") {
      // Lifts the carrier block only. Consent is staff-recorded, so this
      // re-opts nothing and never reaches the aide.
      await record({ reason: "start-keyword" });
      return { action: "ignored" as const, reply: null };
    }
    if (keyword === "help") {
      // Only a number we know gets our reply. An unknown sender keeps
      // Twilio's own HELP / INFO reply, and anything else from it (SUPPORT)
      // is ignored: an open auto-reply is an SMS-pumping target.
      if (rows.length === 0) {
        await record({ reason: "unknown-number" });
        return { action: "ignored" as const, reply: null };
      }
      await record({ status: "help" });
      // Twilio answered a forwarded HELP itself (and, by default, answers
      // HELP / INFO without forwarding them at all); a second reply would
      // double up. Only the keywords it didn't answer get ours.
      if (optOut === "HELP") return { action: "help" as const, reply: null };
      const primary = await livePrimaryInstitution(ctx);
      const base = appBaseUrlOrNull();
      return {
        action: "help" as const,
        reply: smsHelpText(
          primary?.name ?? "Your school",
          base ? `${base.replace(/\/+$/, "")}/parent` : null,
        ),
      };
    }

    // Resolve the sender to exactly one consented, eligible guardian.
    if (rows.length === 0) {
      await record({ reason: "unknown-number" });
      return { action: "ignored" as const, reply: null };
    }
    if (rows.length > 1) {
      await record({ reason: "ambiguous-identity" });
      return { action: "ignored" as const, reply: null };
    }
    const row = rows[0];
    const parentUserId = row.parentUserId;
    if (row.stopState === true) {
      await record({ parentUserId, reason: "stopped-number" });
      return { action: "ignored" as const, reply: null };
    }
    if (!row.optInAt) {
      await record({ parentUserId, reason: "no-consent" });
      return { action: "ignored" as const, reply: null };
    }
    const ineligible = await ineligibleReason(ctx, parentUserId);
    if (ineligible) {
      await record({ parentUserId, reason: ineligible });
      return { action: "ignored" as const, reply: null };
    }
    // NO REMINDERS / REMINDERS ON: the school-night charge reminder's own
    // switch, decided in code like STOP, never by the aide. The reply is a
    // fixed sentence with no child data, so it goes back inline.
    const reminderSwitch = chargeReminderKeyword(args.body);
    if (reminderSwitch) {
      await ctx.db.patch(row._id, {
        chargeRemindersOffAt: reminderSwitch === "off" ? Date.now() : undefined,
      });
      await record({
        parentUserId,
        identityId: row._id,
        reason: reminderSwitch === "off" ? "reminders-off" : "reminders-on",
      });
      return {
        action: "reminders" as const,
        reply:
          reminderSwitch === "off"
            ? CHARGE_REMINDERS_OFF_REPLY
            : CHARGE_REMINDERS_ON_REPLY,
      };
    }

    const text = args.body.trim();
    if (!text) {
      // A picture with no words: nothing the aide can read.
      await record({ parentUserId, reason: "empty" });
      return { action: "ignored" as const, reply: null };
    }

    // Cost cap, then loop guard. Both count this parent's texts over the
    // last hour, whatever happened to them.
    const lastHour = await ctx.db
      .query("parentSmsInbound")
      .withIndex("by_parent", (q) =>
        q.eq("parentUserId", parentUserId).gt("_creationTime", Date.now() - HOUR_MS),
      )
      .collect();
    if (lastHour.length >= SMS_HOURLY_CAP) {
      await record({ parentUserId, reason: "rate-limited" });
      return { action: "ignored" as const, reply: null };
    }
    const hash = await bodyHash(text);
    const previous = lastHour.filter((r) => r.bodyHash !== undefined).at(-1);
    if (previous?.bodyHash === hash) {
      // The same words again within the hour: an auto-responder answering
      // our reply, or a double send. Answering it would feed a loop.
      await record({ parentUserId, reason: "repeat" });
      return { action: "ignored" as const, reply: null };
    }

    await ctx.db.insert("parentSmsInbound", {
      messageSid: args.messageSid,
      parentUserId,
      identityId: row._id,
      status: "queued",
      body: text,
      bodyHash: hash,
    });
    // Always kick the worker; it no-ops while another turn of this parent's
    // is running, and that turn picks this one up when it finishes.
    await ctx.scheduler.runAfter(0, internal.parentSms.processSmsTurns, {
      parentUserId,
    });
    return { action: "queued" as const, reply: null };
  },
});

// ── 2. The per-parent queue ─────────────────────────────────────────────

/**
 * Start this parent's oldest queued turn, or return null while one is
 * already running (or nothing is queued). A mutation, so two workers racing
 * for the same parent can't both claim: Convex serializes them.
 */
export const claimNextSmsTurn = internalMutation({
  args: { parentUserId: v.id("users") },
  handler: async (ctx, { parentUserId }) => {
    const running = await ctx.db
      .query("parentSmsInbound")
      .withIndex("by_parent_status", (q) =>
        q.eq("parentUserId", parentUserId).eq("status", "running"),
      )
      .first();
    if (running) return null;
    const queued = await ctx.db
      .query("parentSmsInbound")
      .withIndex("by_parent_status", (q) =>
        q.eq("parentUserId", parentUserId).eq("status", "queued"),
      )
      .collect(); // oldest first (index order, then _creationTime)
    for (const turn of queued) {
      // Consent or eligibility can change while a text waits (a STOP right
      // after a question), and a request that waited too long is no longer
      // what the parent wants now: such a turn never runs.
      const lost =
        Date.now() - turn._creationTime > SMS_QUEUE_STALE_MS
          ? "stale"
          : (await replyTarget(ctx, turn)) === null
            ? "consent-withdrawn"
            : null;
      if (lost) {
        await ctx.db.patch(turn._id, {
          status: "ignored",
          reason: lost,
          body: undefined,
          finishedAt: Date.now(),
        });
        continue;
      }
      const body = turn.body ?? "";
      await ctx.db.patch(turn._id, {
        status: "running",
        body: undefined, // from here it lives in parentChatMessages
        startedAt: Date.now(),
      });
      await ctx.scheduler.runAfter(
        SMS_TURN_STALE_MS,
        internal.parentSms.expireStuckSmsTurn,
        { turnId: turn._id },
      );
      return { turnId: turn._id, body };
    }
    return null;
  },
});

/**
 * The number a turn may text back right now (see `replyTarget`). An answer
 * needs the turn still running: once the watchdog has failed it, the parent
 * already has the failure text and must not get a late second reply.
 */
export const smsReplyTarget = internalQuery({
  args: { turnId: v.id("parentSmsInbound"), requireRunning: v.boolean() },
  handler: async (ctx, { turnId, requireRunning }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn || (requireRunning && turn.status !== "running")) return null;
    return await replyTarget(ctx, turn);
  },
});

/**
 * Close a running turn and start the next queued one. A turn the watchdog
 * already failed stays failed (its parent was already told).
 */
export const finishSmsTurn = internalMutation({
  args: {
    turnId: v.id("parentSmsInbound"),
    status: v.union(v.literal("answered"), v.literal("failed")),
    reason: v.optional(v.string()),
    // The turn produced no reply of its own: save the failure text as the
    // aide's reply.
    noteFailure: v.boolean(),
  },
  handler: async (ctx, { turnId, status, reason, noteFailure }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.status !== "running") return;
    await ctx.db.patch(turnId, {
      status,
      ...(reason ? { reason } : {}),
      finishedAt: Date.now(),
    });
    if (noteFailure && turn.parentUserId) {
      await noteFailedTurn(ctx, turn.parentUserId);
    }
    if (turn.parentUserId) {
      await ctx.scheduler.runAfter(0, internal.parentSms.processSmsTurns, {
        parentUserId: turn.parentUserId,
      });
    }
  },
});

/**
 * The watchdog: a turn still running after SMS_TURN_STALE_MS died with its
 * action. Fail it, tell the parent, and let the queue move, so a crashed turn
 * never blocks the next text.
 */
export const expireStuckSmsTurn = internalMutation({
  args: { turnId: v.id("parentSmsInbound") },
  handler: async (ctx, { turnId }) => {
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.status !== "running" || !turn.parentUserId) return;
    await ctx.db.patch(turnId, {
      status: "failed",
      reason: "timed-out",
      finishedAt: Date.now(),
    });
    await noteFailedTurn(ctx, turn.parentUserId);
    await ctx.scheduler.runAfter(0, internal.parentSms.sendSmsTurnFailure, {
      turnId,
    });
    await ctx.scheduler.runAfter(0, internal.parentSms.processSmsTurns, {
      parentUserId: turn.parentUserId,
    });
  },
});

/** Text one turn's parent a reply, if they can still receive it. Returns
 *  a reason when nothing was delivered. Never logs the number or the text. */
async function textBack(
  ctx: Pick<ActionCtx, "runQuery">,
  turnId: Id<"parentSmsInbound">,
  body: string,
  requireRunning: boolean,
): Promise<string | null> {
  const to: string | null = await ctx.runQuery(
    internal.parentSms.smsReplyTarget,
    { turnId, requireRunning },
  );
  if (!to) return "no-reply-target";
  try {
    const sid = await deliverOffPortal({
      channel: "sms",
      to,
      body: smsBodyFor(body),
    });
    return sid ? null : "sms-not-configured";
  } catch {
    // The provider's error text can echo the number, so it isn't logged.
    console.error("[parent-sms] reply delivery failed");
    return "delivery-failed";
  }
}

/** The watchdog's failure text (scheduled, so the mutation stays pure). */
export const sendSmsTurnFailure = internalAction({
  args: { turnId: v.id("parentSmsInbound") },
  handler: async (ctx, { turnId }) => {
    await textBack(ctx, turnId, SMS_TURN_FAILED_TEXT, false);
  },
});

/**
 * Run this parent's queue: claim the oldest text, answer it, text the reply
 * (or a short failure text), then close the turn, which schedules the next.
 * The reply is sent BEFORE the turn closes, so replies go out in the order
 * the texts arrived.
 */
export const processSmsTurns = internalAction({
  args: { parentUserId: v.id("users") },
  handler: async (ctx, { parentUserId }) => {
    const claim = await ctx.runMutation(internal.parentSms.claimNextSmsTurn, {
      parentUserId,
    });
    if (!claim) return;

    let reply = SMS_TURN_FAILED_TEXT;
    let status: "answered" | "failed" = "failed";
    let reason: string | undefined;
    try {
      const { Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const result = await runParentAideTurn(ctx, {
        anthropic,
        parentUserId,
        content: claim.body,
        channel: { kind: "sms" },
      });
      if (result.content.trim()) {
        reply = result.content;
        status = "answered";
      } else {
        reason = "empty-reply";
      }
    } catch (error) {
      reason = "turn-error";
      // The API's own sentence (credit, rate limit) carries no PII; any
      // other error is named by type only.
      console.error(
        "[parent-sms] turn failed:",
        anthropicErrorMessage(error) ??
          (error instanceof Error ? error.name : typeof error),
      );
    }

    // Decided before delivery: a reply that was produced is already in the
    // thread even if the text then fails to send.
    const noteFailure = status === "failed";
    const undelivered = await textBack(ctx, claim.turnId, reply, true);
    if (undelivered === "delivery-failed") {
      status = "failed";
      reason = reason ?? undelivered;
    } else if (undelivered) {
      reason = reason ?? undelivered;
    }
    await ctx.runMutation(internal.parentSms.finishSmsTurn, {
      turnId: claim.turnId,
      status,
      ...(reason ? { reason } : {}),
      noteFailure,
    });
  },
});

// ── 3. Consent (staff, after verbal consent) ────────────────────────────

/**
 * Record a guardian's verbal consent to text the aide from one number. For
 * staff to run (`npx convex run parentSms:recordSmsConsent …`) after the
 * family says yes; there is no self-serve SMS opt-in and no START keyword.
 *
 * Refuses a user who isn't an eligible guardian (no linked child, a child
 * outside the primary school, a read-only account) and a number already
 * linked to someone else, so one number can never resolve to two families.
 * Re-recording the same guardian's number clears a STOP: that is the
 * re-opt-in path, and the parent must also text START (or UNSTOP) once to
 * lift the toll-free network's block.
 *
 * The first consent on a number also schedules the intro text
 * (sendSmsIntro), so the parent learns what the number does.
 */
export const recordSmsConsent = internalMutation({
  args: {
    parentUserId: v.id("users"),
    phone: v.string(),
    // Who recorded it and how, e.g. "staff-verbal:<staff name>".
    consentSource: v.string(),
    // When the family consented (ms). Defaults to now.
    consentAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const ineligible = await ineligibleReason(ctx, args.parentUserId);
    if (ineligible) {
      throw new Error(`Can't record SMS consent: ${ineligible}`);
    }
    const identity = canonicalPhoneIdentity(args.phone);
    if (identity.length < 11 || identity.length > 15) {
      throw new Error("Can't record SMS consent: not a full phone number");
    }
    const consentSource = args.consentSource.trim();
    if (!consentSource) {
      throw new Error("Can't record SMS consent: say who recorded it and how");
    }
    const rows = await smsRowsFor(ctx, identity);
    if (rows.some((row) => row.parentUserId !== args.parentUserId)) {
      throw new Error(
        "Can't record SMS consent: that number is linked to another account. Remove that row first.",
      );
    }
    if (rows.length > 1) {
      throw new Error(
        "Can't record SMS consent: that number has duplicate rows. Remove the extras first.",
      );
    }
    const fields = {
      optInAt: args.consentAt ?? Date.now(),
      consentSource,
      stopState: false,
      // Texting the aide only: this consent does not turn on teacher
      // messages by SMS (rowCarriesTeacherMessages).
      scope: "aide" as const,
    };
    let identityId: Id<"parentChannelIdentities">;
    if (rows.length === 1) {
      identityId = rows[0]._id;
      await ctx.db.patch(identityId, fields);
    } else {
      identityId = await ctx.db.insert("parentChannelIdentities", {
        parentUserId: args.parentUserId,
        channel: "sms",
        identity,
        ...fields,
      });
    }
    // The intro goes once per row. Not on a re-record that clears a STOP:
    // the number stays carrier-blocked until the parent texts START, so the
    // send would fail (21610) and use up the stamp.
    if (rows[0]?.introSentAt === undefined && rows[0]?.stopState !== true) {
      await ctx.scheduler.runAfter(0, internal.parentSms.sendSmsIntro, {
        identityId,
      });
    }
    return identityId;
  },
});

/**
 * Stamp the intro on the row and hand back what to send, or null when the
 * row can't be texted (a STOP or consent change since it was scheduled) or
 * the intro was already claimed.
 */
export const claimSmsIntro = internalMutation({
  args: { identityId: v.id("parentChannelIdentities") },
  handler: async (
    ctx,
    { identityId },
  ): Promise<{ to: string; body: string; parentUserId: Id<"users"> } | null> => {
    const row = await ctx.db.get(identityId);
    if (
      !row ||
      row.channel !== "sms" ||
      !row.optInAt ||
      row.stopState === true ||
      row.introSentAt !== undefined
    ) {
      return null;
    }
    if ((await smsRowsFor(ctx, row.identity)).length !== 1) return null;
    if (await ineligibleReason(ctx, row.parentUserId)) return null;
    // Eligibility above means every kid is at the live primary school.
    const primary = await livePrimaryInstitution(ctx);
    if (!primary) return null;
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", row.parentUserId))
      .collect();
    const names: string[] = [];
    for (const link of links) {
      const scholar = await ctx.db.get(link.scholarUserId);
      if (scholar) names.push(scholarFirstName(scholar));
    }
    names.sort((a, b) => a.localeCompare(b));
    await ctx.db.patch(identityId, { introSentAt: Date.now() });
    return {
      to: row.identity,
      body: smsIntroText(primary.name, names),
      parentUserId: row.parentUserId,
    };
  },
});

/** Text a newly consented guardian what the number does. Scheduled by
 *  recordSmsConsent. The stamp stays on a failed send: it isn't retried. */
export const sendSmsIntro = internalAction({
  args: { identityId: v.id("parentChannelIdentities") },
  handler: async (ctx, { identityId }) => {
    const claim = await ctx.runMutation(internal.parentSms.claimSmsIntro, {
      identityId,
    });
    if (!claim) return { sent: false };
    let sid: string | null;
    try {
      sid = await deliverOffPortal({ channel: "sms", to: claim.to, body: claim.body });
    } catch {
      // The provider's error text can echo the number, so it isn't logged.
      console.error("[parent-sms] intro delivery failed");
      return { sent: false };
    }
    if (!sid) return { sent: false };
    await ctx.runMutation(internal.parentSms.noteSmsSent, {
      parentUserId: claim.parentUserId,
      content: claim.body,
    });
    return { sent: true };
  },
});

// ── 3. School-night charge reminder ─────────────────────────────────────
//
// At 8 pm school time, when the BunnyPad goes to sleep (shared/bedtime.ts),
// text each guardian whose kid's BunnyPad is low and not known to be
// charging. The rule lives in lib/chargeReminder; the plan is
// review/bunnypad-charge-reminder-plan.html.
//
// Who: every sms row the aide could text back (consent, no STOP, exactly one
// row on the number, an eligible guardian), unless the parent texted NO
// REMINDERS. Andy's ruling (2026-11-04): enrollment covers essential school
// communications, so there is no separate opt-in.
//
// When: only on a night before a school day (a weekday, no closure, inside a
// term), at most once per parent per evening (`chargeReminderLastDayKey`,
// stamped before the send so a doubled cron can't text twice).

/** One guardian to text tonight. The number is fetched again at claim time. */
type ChargeReminderTarget = {
  identityId: Id<"parentChannelIdentities">;
  parentUserId: Id<"users">;
  kids: ChargeReminderKid[];
};

type ChargeReminderPlan = {
  status: "send" | "not-a-school-night" | "no-institution";
  dayKey: string | null;
  schoolName: string;
  afterBreak: boolean;
  targets: ChargeReminderTarget[];
  // Per-reason counts, for the action's log line. No names, no numbers.
  skipped: Record<string, number>;
};

function scholarFirstName(scholar: Doc<"users">): string {
  return (
    scholar.firstName?.trim() ||
    scholar.name?.trim().split(/\s+/)[0] ||
    scholar.username ||
    "Your child"
  );
}

/** Does a term (reporting period) of this school cover `dayKey`? Fails
 *  closed, so the summer, which has no closure row, sends nothing. */
async function dayIsInTerm(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  dayKey: string,
  timeZone: string,
): Promise<boolean> {
  const start = dayStartForDayKey(dayKey, timeZone);
  const end = dayStartForDayKey(shiftDayKey(dayKey, 1), timeZone);
  const [scoped, global] = await Promise.all([
    ctx.db
      .query("reportingPeriods")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect(),
    ctx.db
      .query("reportingPeriods")
      .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
      .collect(),
  ]);
  return [...scoped, ...global].some((p) => p.startsAt < end && p.endsAt >= start);
}

/** A SimpleMDM battery level, dated by when the iPad last reported. */
type MdmReading = { at: number; level: number };

const mdmReadingValidator = v.object({
  serial: v.string(),
  at: v.number(),
  level: v.number(),
});

function laterReading(
  a: MdmReading | null,
  b: MdmReading | null,
): MdmReading | null {
  if (!a) return b;
  if (!b) return a;
  return b.at > a.at ? b : a;
}

/** Battery evidence for one kid's BunnyPad(s); the lowest one that needs a
 *  text wins, so a kid with two claimed iPads gets one line. */
async function kidChargeVerdict(
  ctx: QueryCtx,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
  nowMs: number,
  liveMdm: Map<string, MdmReading>,
): Promise<ChargeVerdict | null> {
  const claims = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  let best: ChargeVerdict | null = null;
  for (const claim of claims) {
    if (claim.claimState === "revoked" || claim.institutionId !== institutionId) {
      continue;
    }
    const snapshot = await ctx.db
      .query("simpleMdmDeviceSnapshots")
      .withIndex("by_institution_serial", (q) =>
        q.eq("institutionId", institutionId).eq("serial", claim.serial),
      )
      .first();
    // The newest check-in from the device this claim is signed in on.
    const heartbeats = await ctx.db
      .query("nativeClientHeartbeats")
      .withIndex("by_managed_device", (q) => q.eq("managedDeviceId", claim._id))
      .collect();
    const heartbeat = heartbeats
      .filter(
        (h) =>
          h.batteryAt !== undefined &&
          h.userId === scholarId &&
          (claim.lastDeviceId === undefined || h.deviceId === claim.lastDeviceId),
      )
      .sort((a, b) => (b.batteryAt ?? 0) - (a.batteryAt ?? 0))[0];
    const evidence: BatteryEvidence = {
      app:
        heartbeat?.batteryAt !== undefined
          ? {
              at: heartbeat.batteryAt,
              level: heartbeat.batteryLevel ?? null,
              state: heartbeat.batteryState ?? "unknown",
            }
          : null,
      // The hourly snapshot or tonight's roster read, whichever is newer.
      mdm: laterReading(
        snapshot?.batteryLevel !== undefined && snapshot.lastSeenAt !== undefined
          ? { at: snapshot.lastSeenAt, level: snapshot.batteryLevel }
          : null,
        liveMdm.get(normalizeSerial(claim.serial)) ?? null,
      ),
    };
    const verdict = chargeReminderVerdict(evidence, nowMs);
    if (!best) best = verdict;
    else if (verdict.send && (!best.send || verdict.level < best.level)) best = verdict;
  }
  return best;
}

export const chargeReminderPlan = internalQuery({
  args: {
    nowMs: v.number(),
    // SimpleMDM's roster as of the run (sendChargeReminders), by serial.
    mdmReadings: v.optional(v.array(mdmReadingValidator)),
  },
  handler: async (ctx, { nowMs, mdmReadings }): Promise<ChargeReminderPlan> => {
    const liveMdm = new Map(
      (mdmReadings ?? []).map(({ serial, at, level }) => [
        normalizeSerial(serial),
        { at, level },
      ]),
    );
    const empty = (
      status: ChargeReminderPlan["status"],
      dayKey: string | null = null,
    ): ChargeReminderPlan => ({
      status,
      dayKey,
      schoolName: "",
      afterBreak: false,
      targets: [],
      skipped: {},
    });
    // First-party only, like the rest of the 833 program and like bedtime.
    const primary = await livePrimaryInstitution(ctx);
    if (!primary) return empty("no-institution");
    const timeZone = effectiveInstitutionTimeZone(primary.timeZone);
    const today = dayKeyForTimezone(nowMs, timeZone);
    const tomorrow = shiftDayKey(today, 1);

    const nextOpen = await nextOpenSchoolDayKey(ctx, primary._id, today, timeZone);
    if (
      nextOpen !== tomorrow ||
      !(await dayIsInTerm(ctx, primary._id, tomorrow, timeZone))
    ) {
      return empty("not-a-school-night", today);
    }
    // The night before school resumes: the last open weekday before tomorrow
    // isn't the plain previous weekday (a break or holiday sat between).
    let previousWeekday = shiftDayKey(tomorrow, -1);
    while ([0, 6].includes(weekdayForDayKey(previousWeekday))) {
      previousWeekday = shiftDayKey(previousWeekday, -1);
    }
    const previousOpen = await prevOpenSchoolDayKey(
      ctx,
      primary._id,
      tomorrow,
      timeZone,
    );
    const afterBreak =
      previousOpen !== previousWeekday ||
      !(await dayIsInTerm(ctx, primary._id, previousWeekday, timeZone));

    const skipped: Record<string, number> = {};
    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };
    const targets: ChargeReminderTarget[] = [];
    const rows = await ctx.db
      .query("parentChannelIdentities")
      .withIndex("by_identity", (q) => q.eq("channel", "sms"))
      .collect();
    for (const row of rows) {
      if (!row.optInAt || row.stopState === true) {
        skip("no-consent");
        continue;
      }
      if (row.chargeRemindersOffAt !== undefined) {
        skip("reminders-off");
        continue;
      }
      if (row.chargeReminderLastDayKey === today) {
        skip("already-sent");
        continue;
      }
      if ((await smsRowsFor(ctx, row.identity)).length !== 1) {
        skip("ambiguous-identity");
        continue;
      }
      if (await ineligibleReason(ctx, row.parentUserId)) {
        skip("ineligible");
        continue;
      }
      const links = await ctx.db
        .query("guardianships")
        .withIndex("by_parent", (q) => q.eq("parentUserId", row.parentUserId))
        .collect();
      const kids: ChargeReminderKid[] = [];
      for (const link of links) {
        const scholar = await ctx.db.get(link.scholarUserId);
        if (!scholar) continue;
        const verdict = await kidChargeVerdict(
          ctx,
          primary._id,
          scholar._id,
          nowMs,
          liveMdm,
        );
        if (!verdict) continue; // no BunnyPad
        if (!verdict.send) {
          skip(verdict.reason);
          continue;
        }
        kids.push({ name: scholarFirstName(scholar), level: verdict.level });
      }
      if (kids.length === 0) continue;
      kids.sort((a, b) => a.name.localeCompare(b.name));
      targets.push({ identityId: row._id, parentUserId: row.parentUserId, kids });
    }
    return {
      status: "send",
      dayKey: today,
      schoolName: primary.name,
      afterBreak,
      targets,
      skipped,
    };
  },
});

/**
 * Stamp tonight's reminder on the row, then hand back the number, or null when
 * the row can no longer be texted (a STOP, NO REMINDERS or consent change since
 * the plan was read, or tonight's reminder already claimed).
 */
export const claimChargeReminder = internalMutation({
  args: { identityId: v.id("parentChannelIdentities"), dayKey: v.string() },
  handler: async (ctx, { identityId, dayKey }): Promise<string | null> => {
    const row = await ctx.db.get(identityId);
    if (
      !row ||
      row.channel !== "sms" ||
      !row.optInAt ||
      row.stopState === true ||
      row.chargeRemindersOffAt !== undefined ||
      row.chargeReminderLastDayKey === dayKey
    ) {
      return null;
    }
    if ((await smsRowsFor(ctx, row.identity)).length !== 1) return null;
    if (await ineligibleReason(ctx, row.parentUserId)) return null;
    await ctx.db.patch(identityId, { chargeReminderLastDayKey: dayKey });
    return row.identity;
  },
});

/** Put a text we sent (a charge reminder, the intro) in the parent's thread,
 *  so a reply ("it's charging") reads in context for the aide and in the
 *  parent portal. */
export const noteSmsSent = internalMutation({
  args: { parentUserId: v.id("users"), content: v.string() },
  handler: async (ctx, { parentUserId, content }) => {
    await ctx.db.insert("parentChatMessages", {
      parentUserId,
      role: "assistant",
      content,
    });
  },
});

/**
 * SimpleMDM's battery levels right now, from one roster read (the same read
 * the hourly snapshot refresh starts with). Null when SimpleMDM isn't set up
 * here or the read fails; the plan then has only the hourly snapshot.
 */
async function liveMdmReadings(): Promise<Array<
  Infer<typeof mdmReadingValidator>
> | null> {
  const apiKey = process.env.SIMPLEMDM_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const roster = await listSimpleMdmDevices(apiKey);
    return [...roster.values()].flatMap((device) =>
      device.batteryLevel !== null && device.lastSeenAt !== null
        ? [{ serial: device.serial, at: device.lastSeenAt, level: device.batteryLevel }]
        : [],
    );
  } catch (error) {
    console.error(
      "[parent-sms] charge reminder: SimpleMDM read failed, using the hourly snapshot:",
      simpleMdmErrorMessage(error, "unknown error"),
    );
    return null;
  }
}

/** The 8 pm cron (crons.ts). `nowMs` is for tests and dry runs. */
export const sendChargeReminders = internalAction({
  args: { nowMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Tonight's battery levels, not only the hourly snapshot (refreshed at
    // :17), which is most of an hour behind SimpleMDM by 8 pm. An iPad put on
    // a charger after school gains tens of percent in that hour: on 2026-11-12
    // a BunnyPad charging at 91% drew a "14%" text from the 19:17 snapshot,
    // though SimpleMDM had heard 71% at 19:32.
    const mdmReadings = await liveMdmReadings();
    const plan: ChargeReminderPlan = await ctx.runQuery(
      internal.parentSms.chargeReminderPlan,
      {
        nowMs: args.nowMs ?? Date.now(),
        ...(mdmReadings ? { mdmReadings } : {}),
      },
    );
    let sent = 0;
    let failed = 0;
    if (plan.status === "send" && plan.dayKey) {
      for (const target of plan.targets) {
        const to: string | null = await ctx.runMutation(
          internal.parentSms.claimChargeReminder,
          { identityId: target.identityId, dayKey: plan.dayKey },
        );
        if (!to) continue;
        const body = chargeReminderText({
          schoolName: plan.schoolName,
          kids: target.kids,
          afterBreak: plan.afterBreak,
        });
        let sid: string | null;
        try {
          sid = await deliverOffPortal({ channel: "sms", to, body });
        } catch {
          // The provider's error text can echo the number, so it isn't
          // logged. The stamp stays: one failed reminder isn't retried.
          failed += 1;
          console.error("[parent-sms] charge reminder delivery failed");
          continue;
        }
        if (!sid) {
          failed += 1;
          continue;
        }
        sent += 1;
        await ctx.runMutation(internal.parentSms.noteSmsSent, {
          parentUserId: target.parentUserId,
          content: body,
        });
      }
    }
    const summary = {
      status: plan.status,
      dayKey: plan.dayKey,
      mdmLive: mdmReadings !== null,
      targets: plan.targets.length,
      sent,
      failed,
      skipped: plan.skipped,
    };
    console.log("[parent-sms] charge reminders", JSON.stringify(summary));
    return summary;
  },
});

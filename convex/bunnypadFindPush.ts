"use node";
/**
 * Find my BunnyPad: the APNs sender. bunnypadFind.ts decides who may ask and
 * which iPads; this sends the visible push (lib/bunnypadFindPayload.ts) with
 * token-based auth over HTTP/2, and reports what APNs said.
 *
 * Config (Convex env, unset until the school's APNs key exists):
 *   APNS_KEY_ID        the key's 10-character id
 *   APNS_TEAM_ID       the Apple Developer team (HKR5398M4S)
 *   APNS_PRIVATE_KEY   the .p8 contents; literal "\n" sequences are accepted
 *   APNS_CRITICAL_ALERTS  "1" once Apple grants the Critical Alerts
 *                      entitlement and the app is re-signed with it
 * Unset keys answer "not set up yet" and send nothing.
 */
import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import type { FindTarget, PreparedFind } from "./bunnypadFind";
import {
  buildFindPayload,
  FIND_EXPIRATION_SECONDS,
  FIND_FOLLOW_UP_INTERVAL_MS,
  FIND_FOLLOW_UPS,
  FIND_NOTIFICATION_KIND,
} from "./lib/bunnypadFindPayload";
import { findOutcomeMessage, type FindOutcome } from "./lib/bunnypadFindMessages";

const HOSTS = {
  production: "https://api.push.apple.com",
  development: "https://api.sandbox.push.apple.com",
} as const;

type ApnsConfig = {
  keyId: string;
  teamId: string;
  key: KeyObject;
  /** Identifies the exact key material, so a rotated key never reuses a cached JWT. */
  fingerprint: string;
  critical: boolean;
};

function readConfig(): ApnsConfig | null {
  const keyId = process.env.APNS_KEY_ID?.trim();
  const teamId = process.env.APNS_TEAM_ID?.trim();
  const pem = process.env.APNS_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
  if (!keyId || !teamId || !pem) return null;
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    // A malformed key is a setup problem: answer "not set up yet" rather than
    // throwing through the parent aide's SMS turn.
    console.error("[bunnypadFind] APNS_PRIVATE_KEY is not a readable key", error);
    return null;
  }
  return {
    keyId,
    teamId,
    key,
    fingerprint: `${keyId}|${teamId}|${createHash("sha256").update(pem).digest("hex")}`,
    critical: process.env.APNS_CRITICAL_ALERTS === "1",
  };
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

// APNs accepts a provider token for an hour and throttles minting a new one
// more often than every 20 minutes, so reuse one for 40.
let cachedJwt: { token: string; fingerprint: string; mintedAt: number } | null = null;

export function apnsJwt(config: ApnsConfig, nowMs = Date.now()): string {
  if (
    cachedJwt &&
    cachedJwt.fingerprint === config.fingerprint &&
    nowMs - cachedJwt.mintedAt < 40 * 60_000
  ) {
    return cachedJwt.token;
  }
  const header = b64url(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = b64url(
    JSON.stringify({ iss: config.teamId, iat: Math.floor(nowMs / 1000) }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: config.key,
    dsaEncoding: "ieee-p1363",
  });
  const token = `${header}.${claims}.${b64url(signature)}`;
  cachedJwt = { token, fingerprint: config.fingerprint, mintedAt: nowMs };
  return token;
}

type SendResult = { status: number; reason: string | null };

function sendOne(config: ApnsConfig, target: FindTarget): Promise<SendResult> {
  return new Promise((resolve) => {
    const client = http2.connect(HOSTS[target.environment]);
    const done = (result: SendResult) => {
      client.close();
      resolve(result);
    };
    client.on("error", (error) => done({ status: 0, reason: error.message }));
    const body = JSON.stringify(buildFindPayload({ critical: config.critical }));
    const request = client.request({
      ":method": "POST",
      ":path": `/3/device/${target.token}`,
      authorization: `bearer ${apnsJwt(config)}`,
      "apns-topic": target.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": FIND_NOTIFICATION_KIND,
      "apns-expiration": String(Math.floor(Date.now() / 1000) + FIND_EXPIRATION_SECONDS),
      "content-type": "application/json",
    });
    let status = 0;
    let text = "";
    request.setTimeout(10_000, () => {
      request.close();
      done({ status: 0, reason: "timeout" });
    });
    request.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => (text += chunk));
    request.on("end", () => {
      let reason: string | null = null;
      try {
        reason = text ? (JSON.parse(text) as { reason?: string }).reason ?? null : null;
      } catch {
        reason = text.slice(0, 100) || null;
      }
      done({ status, reason });
    });
    request.on("error", (error) => done({ status: 0, reason: error.message }));
    request.end(body);
  });
}

/** APNs's answer that the token will never work again. */
function isDeadToken(result: SendResult): boolean {
  return (
    result.status === 410 ||
    (result.status === 400 &&
      (result.reason === "BadDeviceToken" || result.reason === "DeviceTokenNotForTopic"))
  );
}

/** Send one round to every target, forget dead tokens, and schedule the next
 *  follow-up for the targets APNs accepted. */
async function sendRound(
  ctx: ActionCtx,
  config: ApnsConfig,
  targets: FindTarget[],
  followUpsLeft: number,
) {
  const results = await Promise.all(
    targets.map(async (target) => ({
      target,
      result: await sendOne(config, target),
    })),
  );
  const dead = results.filter(({ result }) => isDeadToken(result));
  if (dead.length > 0) {
    await ctx.runMutation(internal.bunnypadFind.recordFindDelivery, {
      deadTokens: dead.map(({ target }) => ({
        pairedDeviceId: target.pairedDeviceId,
        token: target.token,
      })),
    });
  }
  for (const { result } of results) {
    if (result.status !== 200) {
      console.warn(`[bunnypadFind] APNs ${result.status} ${result.reason ?? ""}`);
    }
  }
  const accepted = results
    .filter(({ result }) => result.status === 200)
    .map(({ target }) => target);
  if (accepted.length > 0 && followUpsLeft > 0) {
    await ctx.scheduler.runAfter(
      FIND_FOLLOW_UP_INTERVAL_MS,
      internal.bunnypadFindPush.sendFollowUp,
      { targets: accepted, followUpsLeft: followUpsLeft - 1 },
    );
  }
  return { results, dead };
}

async function sendPrepared(
  ctx: ActionCtx,
  prepared: Extract<PreparedFind, { ok: true }>,
  config: ApnsConfig,
): Promise<FindOutcome> {
  const { results, dead } = await sendRound(
    ctx,
    config,
    prepared.targets,
    FIND_FOLLOW_UPS,
  );
  const sent = results.filter(({ result }) => result.status === 200).length;
  return {
    sent,
    // A dead token is the "needs to open Rabbithole" case, not a failure.
    unregistered: prepared.unregistered + dead.length,
    recentlyFound: prepared.recentlyFound,
    failed: results.length - sent - dead.length,
    notConfigured: false,
  };
}

const NOT_CONFIGURED: FindOutcome = {
  sent: 0,
  unregistered: 0,
  recentlyFound: 0,
  failed: 0,
  notConfigured: true,
};

/** A follow-up round (see FIND_FOLLOW_UPS). Already authorized and audited
 *  by the first round; it only re-sends to the iPads APNs accepted then. */
export const sendFollowUp = internalAction({
  args: {
    targets: v.array(
      v.object({
        pairedDeviceId: v.id("pairedDevices"),
        token: v.string(),
        topic: v.string(),
        environment: v.union(v.literal("production"), v.literal("development")),
      }),
    ),
    followUpsLeft: v.number(),
  },
  handler: async (ctx, args) => {
    const config = readConfig();
    if (!config) return;
    await sendRound(ctx, config, args.targets, args.followUpsLeft);
  },
});

export type FindResult = { ok: boolean; message: string };

/** A parent's find (portal aide or SMS): every BunnyPad paired to the child. */
export const findFromGuardian = internalAction({
  args: {
    guardianUserId: v.id("users"),
    scholarId: v.id("users"),
    source: v.union(v.literal("parent_app"), v.literal("parent_sms")),
  },
  handler: async (ctx, args): Promise<FindResult> => {
    // Config first: with no key, refuse before any audit row says a find ran.
    const config = readConfig();
    if (!config) {
      return { ok: false, message: findOutcomeMessage(NOT_CONFIGURED, { kind: "staff" }) };
    }
    const prepared: PreparedFind = await ctx.runMutation(
      internal.bunnypadFind.prepareFindFromGuardian,
      args,
    );
    if (!prepared.ok) return prepared;
    const outcome = await sendPrepared(ctx, prepared, config);
    return {
      ok: outcome.sent > 0,
      message: findOutcomeMessage(outcome, {
        kind: "child",
        name: prepared.childName ?? "Your child",
      }),
    };
  },
});

/** Staff's find (aide, Slack, MCP): the named paired iPads. */
export const findFromAgent = internalAction({
  args: {
    callerUserId: v.id("users"),
    source: v.union(v.literal("slack"), v.literal("mcp"), v.literal("app")),
    pairedDeviceIds: v.array(v.id("pairedDevices")),
  },
  handler: async (ctx, args): Promise<FindResult> => {
    const config = readConfig();
    if (!config) {
      return { ok: false, message: findOutcomeMessage(NOT_CONFIGURED, { kind: "staff" }) };
    }
    const prepared: PreparedFind = await ctx.runMutation(
      internal.bunnypadFind.prepareFindFromAgent,
      {
        callerUserId: args.callerUserId,
        source: args.source,
        pairedDeviceIds: args.pairedDeviceIds as Id<"pairedDevices">[],
      },
    );
    if (!prepared.ok) return prepared;
    const outcome = await sendPrepared(ctx, prepared, config);
    return { ok: outcome.sent > 0, message: findOutcomeMessage(outcome, { kind: "staff" }) };
  },
});

/**
 * iPad device pairing — camera-free, entitlement-free sign-in for the
 * locked-down 1:1 fleet.
 *
 * ── Why pairing (and not a scanned QR) ──────────────────────────────────
 * Scholars sign in with a username + a short password. On a kiosked 1:1 iPad
 * that is cumbersome. Pairing is the streaming-TV "add this device to your
 * account" model: it needs no camera, no universal links, and no
 * associated-domains entitlement. The load-bearing reason is the last one —
 * it keeps the credential OFF the screen: a QR *is* a credential a bystander
 * can photograph, and the code this shows is not (see the security notes).
 *
 * ⚠️ CORRECTION (2026-08-06): this comment used to claim "the SimpleMDM
 * lockdown removes the Camera app entirely, so scanning a QR is impossible."
 * Only the first half is true. The Camera *app* is absent from the allowlist
 * (mdm/profiles/app-allowlist.mobileconfig), but the camera HARDWARE is
 * deliberately enabled — mdm/profiles/kiosk-restrictions.mobileconfig says in
 * as many words: "Camera left ENABLED (Rabbithole health-doc capture needs
 * it)", and there is no
 * `allowCamera=false` anywhere in mdm/profiles/. An in-app QR scanner would
 * therefore work fine on a locked-down fleet iPad. So QR is a live option that
 * was rejected on a false premise; if anyone revisits it, weigh it on the
 * bystander-credential argument above (and note it would need expo-camera —
 * a native module this app does not currently ship).
 *
 * ── The handshake (the native-client contract) ──────────────────────────
 * The signed-out iPad drives this; THIS PR ships the backend + web console
 * only (the native screen ships separately via a signed build). The contract:
 *
 *   1. Device generates a high-entropy VERIFIER locally (≥32 random bytes,
 *      base64url) and keeps it in memory. It computes `verifierHash =
 *      sha256_hex(verifier)` and calls:
 *          api.devicePairing.registerPairingRequest({
 *            verifierHash, deviceId, deviceLabel? })
 *      `deviceId` is a stable per-iPad id the app persists (e.g. keychain
 *      UUID / identifierForVendor) so re-pairing the same device is durable.
 *      → returns { requestId, code, expiresAt }.
 *      The device DISPLAYS `code` (e.g. "K7QP-2F9M") and NEVER displays the
 *      verifier.
 *   2. Device polls api.devicePairing.pairingStatus({ requestId }) until
 *      status === "approved" (then it may show "Sign in as <scholarName>"),
 *      or re-registers if it goes "expired".
 *   3. A staffer opens the web console (/school/devices), types the code,
 *      picks the scholar, and confirms → approvePairingRequest. This opens a
 *      ~60s single-use exchange window.
 *   4. Device exchanges for a real session by calling Convex Auth signIn:
 *          signIn("devicePair", { requestId, verifier })
 *      The `devicePair` provider (convex/auth.ts) → consumePairingExchange
 *      verifies sha256(verifier) === verifierHash, burns the request
 *      atomically, upserts the durable binding, and returns the scholar's
 *      userId → a normal, revocable Convex Auth session is minted.
 *   5. Immediately after signIn succeeds, the (now authenticated) device
 *      calls api.devicePairing.attachDeviceSession({ deviceId }) so a lost
 *      iPad can later be signed out remotely without disturbing the scholar's
 *      other sessions.
 *
 * ── Security properties (each is enforced below) ────────────────────────
 *   - The verifier is high-entropy, generated ON-DEVICE, never displayed,
 *     never logged, and never stored — only its sha256 hash is persisted.
 *   - The short code is a LOOKUP KEY, not a credential. Possession of it
 *     without the verifier is inert: approval grants a session to whoever
 *     holds the verifier (the device), never to the person who typed the code.
 *     A photographed code is therefore useless.
 *   - The code is drawn from an ambiguity-free 30-char alphabet, 8 chars
 *     (~39 bits), unique among live requests, and lives ~5 min. Guessing a
 *     live code is astronomically unlikely AND buys nothing (see above).
 *   - Approval opens a short single-use exchange window (~60s); the exchange
 *     burns `exchangedAt` inside one transaction, so a second exchange fails.
 *   - Every pairing is INSTITUTION-SCOPED (requireScholarsAccessible) and
 *     audited (approvedBy / scholarId / deviceId / approvedAt).
 *
 * Crypto note: runs in the DEFAULT Convex runtime (Web Crypto via
 * lib/oauthCrypto) — no "use node" — matching the auth provider's `authorize`.
 */
import { v } from "convex/values";
import {
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from "./_generated/server";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { getAuthSessionId } from "@convex-dev/auth/server";
import { sha256Hex } from "./lib/oauthCrypto";
import { resolveInstitutionLens, scholarInLens } from "./lib/institutionLens";
import { ROLES } from "./lib/roles";
import { isEnrolledScholar } from "./lib/enrollmentStanding";
import type { Doc, Id } from "./_generated/dataModel";
import {
  unassignedManagedClaimPatch,
  revokedManagedClaimPatch,
  auditManagedClaim,
} from "./lib/managedDeviceClaimState";
import { scheduleClaimDecommissionLock } from "./lib/deviceAppUnlockScheduling";
import {
  hasSchoolOperationsAccessAtInstitution,
  schoolOperationsInstitutionIds,
} from "./lib/staffCapabilities";

/** A pending code is only good for a few minutes — long enough to walk to the
 *  console and type it, short enough that a stale code on a screen is dead. */
export const PAIRING_REQUEST_TTL_MS = 5 * 60 * 1000; // 5 minutes
/** Approval opens a single-use exchange window — the device only needs a
 *  moment to redeem it. Tight so an approved-but-unexchanged code can't linger. */
export const EXCHANGE_WINDOW_MS = 60 * 1000; // 60 seconds

/** Human-typable, ambiguity-free: no 0/O, 1/I/L, U (word-avoidance). */
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"; // 30 chars
const CODE_LENGTH = 8;

/** A uniformly-random code (rejection sampling — no modulo bias). */
function generateCode(): string {
  const out: string[] = [];
  const max = 256 - (256 % CODE_ALPHABET.length);
  while (out.length < CODE_LENGTH) {
    const buf = new Uint8Array(CODE_LENGTH);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= max) continue; // reject to keep the distribution flat
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]);
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out.join("");
}

/** Normalize operator-typed input to the stored form: uppercase, alphabet-only
 *  (drops spaces / hyphens / stray punctuation from a hand-typed code). */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split("")
    .filter((c) => CODE_ALPHABET.includes(c))
    .join("");
}

/** Display form the device shows: "ABCD-EFGH". */
export function formatCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

/** Delete an auth session + its refresh tokens (mirrors the framework's
 *  deleteSession, and enrollment.prepareScholarForEnroll's loop). Used to
 *  sign a specific device out without touching the scholar's other sessions.
 *  Exported so the managed-claim path (managedDeviceClaims.ts) reuses the exact
 *  same session-revocation plumbing rather than forking it. */
export async function revokeAuthSession(
  ctx: MutationCtx,
  sessionId: Id<"authSessions">,
): Promise<boolean> {
  const session = await ctx.db.get(sessionId);
  if (!session) return false;
  const refreshTokens = await ctx.db
    .query("authRefreshTokens")
    .withIndex("sessionId", (q) => q.eq("sessionId", sessionId))
    .collect();
  for (const rt of refreshTokens) await ctx.db.delete(rt._id);
  await ctx.db.delete(sessionId);
  return true;
}

// Mirrors @convex-dev/auth's own default (sessions.ts) so a mint here behaves
// identically to a normal Convex Auth sign-in when the env override is unset.
const DEFAULT_AUTH_SESSION_TOTAL_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function authSessionDurationMs(): number {
  const raw = process.env.AUTH_SESSION_TOTAL_DURATION_MS;
  if (raw === undefined) return DEFAULT_AUTH_SESSION_TOTAL_DURATION_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_AUTH_SESSION_TOTAL_DURATION_MS;
}

/**
 * Mint a Convex Auth session row directly, inside the CALLER's own mutation
 * transaction, rather than letting `ConvexCredentials.authorize()`'s normal
 * post-authorize `signIn` create one afterward. This is what makes a
 * device-pairing/claim exchange atomic: the `authSessions` row + its
 * enumerable `pairedDeviceAuthSessions` association are written in the SAME
 * transaction that resolves the device binding, so there is no window where a
 * session exists that the server cannot enumerate and revoke (a crash between
 * `authorize()` returning and the client's follow-up `attachDeviceSession`
 * call used to leave exactly such an orphan). `ConvexCredentials.authorize()`
 * accepts a pre-existing `sessionId` for precisely this reason — see
 * node_modules/@convex-dev/auth/src/providers/ConvexCredentials.ts.
 */
export async function mintAuthSessionForUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Id<"authSessions">> {
  return await ctx.db.insert("authSessions", {
    userId,
    expirationTime: Date.now() + authSessionDurationMs(),
  });
}

/**
 * Revoke EVERY auth session ever attached to a paired device, not just the
 * single denormalized `pairedDevices.authSessionId` pointer. That pointer is
 * overwritten on every re-attach, so a device re-paired or reassigned more
 * than once could otherwise leave an earlier attached session alive forever
 * — `pairedDeviceAuthSessions` is ACTIVE revocation state (rows are deleted
 * once revoked, never kept as an append-only audit log — see the table's
 * schema comment), recorded atomically at exchange time by
 * `mintAuthSessionForUser`'s callers, never in a later best-effort attach —
 * see `consumePairingExchange` / managedDeviceClaims's `consumeManagedClaim`),
 * specifically so decommissioning can enumerate and close all of them. Also
 * revokes the current denormalized pointer as a belt-and-suspenders fallback
 * for rows created before this table existed.
 */
export async function revokeAllDeviceAuthSessions(
  ctx: MutationCtx,
  pairedDeviceId: Id<"pairedDevices">,
): Promise<boolean> {
  // Bounded by construction, not because callers might not clean up: rows
  // are deleted the instant they're revoked (see the table's schema
  // comment — this is active state, not an append-only log), so a healthy
  // binding has at most a small handful even across many re-pairs. `.take`
  // rather than `.collect` keeps that an explicit, checkable invariant
  // instead of an implicit one a future regression could silently violate.
  const rows = await ctx.db
    .query("pairedDeviceAuthSessions")
    .withIndex("by_paired_device", (q) => q.eq("pairedDeviceId", pairedDeviceId))
    .take(50);
  let revokedAny = false;
  for (const row of rows) {
    if (await revokeAuthSession(ctx, row.authSessionId)) revokedAny = true;
    await ctx.db.delete(row._id);
  }
  const binding = await ctx.db.get(pairedDeviceId);
  if (binding?.authSessionId) {
    if (await revokeAuthSession(ctx, binding.authSessionId)) revokedAny = true;
  }
  return revokedAny;
}

/**
 * Revoke EVERY session tied to a managed claim by its IMMUTABLE
 * `managedDeviceClaimId` (+ optional `claimGeneration`), rather than by the
 * MUTABLE `pairedDevices` link — which a manual re-pair, unassign, or
 * reassignment can clear/repoint away from the claim well before the session
 * itself is dealt with. This is the primitive that makes decommission/
 * rotation safe even when the physical binding has already moved on: as long
 * as the session's association row still names this claim (it always does —
 * it is stamped once, atomically, at mint time, and never repointed), this
 * finds and closes it. Pass `generation` to scope to exactly the OLD
 * generation being replaced (rotation/rebind, bounding the table to one
 * active session per claim+generation); omit it for a full claim-decommission
 * sweep across every generation ever recorded (bounded via `.take` — this
 * table holds only currently-unrevoked rows, so a healthy claim has at most a
 * handful even across many rotations).
 */
export async function revokeManagedClaimSessions(
  ctx: MutationCtx,
  managedDeviceClaimId: Id<"managedDeviceClaims">,
  generation?: number,
): Promise<boolean> {
  const rows = await ctx.db
    .query("pairedDeviceAuthSessions")
    .withIndex("by_claim_generation", (q) =>
      generation === undefined
        ? q.eq("managedDeviceClaimId", managedDeviceClaimId)
        : q
            .eq("managedDeviceClaimId", managedDeviceClaimId)
            .eq("claimGeneration", generation),
    )
    .take(200);
  let revokedAny = false;
  for (const row of rows) {
    if (await revokeAuthSession(ctx, row.authSessionId)) revokedAny = true;
    await ctx.db.delete(row._id);
  }
  return revokedAny;
}

/** Delete every `pairedDeviceAuthSessions` sidecar row for a binding that is
 *  about to be (or was just) deleted. Belt-and-suspenders: `revokeAllDevice-
 *  AuthSessions` already deletes rows as it revokes them, so this is normally
 *  a no-op by the time it runs, but stays cheap (index-bounded, never an
 *  unbounded table scan) for any row a caller revoked without also deleting. */
export async function deleteDeviceAuthSessionLog(
  ctx: MutationCtx,
  pairedDeviceId: Id<"pairedDevices">,
): Promise<void> {
  const rows = await ctx.db
    .query("pairedDeviceAuthSessions")
    .withIndex("by_paired_device", (q) => q.eq("pairedDeviceId", pairedDeviceId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * The one shared "invalidate this managed claim's credential" sequence,
 * called by every caller that must treat a claim as durably decommissioned:
 * `managedDeviceClaims.revokeManagedDeviceClaim` (the explicit staff action)
 * AND `revokeDeviceSession` below (the "remote sign-out" console action,
 * which — for a managed-native pairing — must have the exact same effect,
 * not merely drop the tracked session and let the durable claim/token
 * silently re-mint one on the device's next foreground).
 *
 * Order matters and is fail-closed throughout:
 *   1. Schedule the device relock BEFORE the claim is invalidated (see
 *      `scheduleClaimDecommissionLock`'s doc comment) — a revoked claim must
 *      not leave the device's SimpleMDM allowlist unlocked until normal
 *      lease expiry just because its credential can no longer be redeemed.
 *   2. Revoke by IMMUTABLE claim+generation, which finds a session even if
 *      `pairedDevices` was manually re-paired/cleared/repointed away from
 *      this claim in the meantime.
 *   3. Bump `claimGeneration` (via `revokedManagedClaimPatch`) so any
 *      in-flight reconciler task carrying the OLD generation can never
 *      mistake a later re-issued claim's fresh unlock for this one's stale
 *      state.
 *
 * Lives here (not in managedDeviceClaims.ts) because managedDeviceClaims.ts
 * already imports from this file — putting the shared helper in the other
 * direction would create a cycle.
 */
export async function decommissionManagedClaim(
  ctx: MutationCtx,
  claim: Doc<"managedDeviceClaims">,
  actorUserId: Id<"users">,
  auditAction: string,
): Promise<{ sessionRevoked: boolean }> {
  await scheduleClaimDecommissionLock(ctx, claim._id);
  const sessionRevoked = await revokeManagedClaimSessions(
    ctx,
    claim._id,
    claim.claimGeneration ?? 0,
  );
  await ctx.db.patch(
    claim._id,
    revokedManagedClaimPatch(Date.now(), claim.claimGeneration, actorUserId),
  );
  await auditManagedClaim(
    ctx,
    actorUserId,
    auditAction,
    claim.scholarId ?? actorUserId,
    `serial ${claim.serial}`,
  );
  return { sessionRevoked };
}

// ── Device-facing (unauthenticated) ───────────────────────────────────

/**
 * A signed-out device registers a pairing request. It sends only the HASH of
 * its locally-generated verifier (never the verifier) plus a stable deviceId.
 * Returns an opaque requestId (held in device memory) and the short code the
 * device displays. Public by necessity — the device has no session yet — and
 * safe: the request is inert until a staffer approves it, and useless to
 * anyone lacking the verifier.
 */
export const registerPairingRequest = mutation({
  args: {
    verifierHash: v.string(),
    deviceId: v.string(),
    deviceLabel: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ requestId: Id<"devicePairingRequests">; code: string; expiresAt: number }> => {
    // Shape guards: verifierHash must look like a sha256 hex digest, and the
    // deviceId must be a sane, bounded string (it's an untrusted label, but we
    // don't want unbounded rows).
    if (!/^[0-9a-f]{64}$/.test(args.verifierHash)) {
      throw new Error("Invalid verifier.");
    }
    const deviceId = args.deviceId.trim();
    if (deviceId.length < 6 || deviceId.length > 200) {
      throw new Error("Invalid device id.");
    }
    const deviceLabel = args.deviceLabel?.trim().slice(0, 120) || undefined;

    const now = Date.now();
    // Generate a code unique among LIVE (still-valid) requests. Collisions are
    // astronomically unlikely; retry a few times defensively.
    let code = generateCode();
    for (let attempt = 0; attempt < 5; attempt++) {
      const clash = await ctx.db
        .query("devicePairingRequests")
        .withIndex("by_code", (q) => q.eq("code", code))
        .collect();
      const liveClash = clash.some(
        (r) => r.status !== "exchanged" && r.expiresAt > now,
      );
      if (!liveClash) break;
      code = generateCode();
    }

    const requestId = await ctx.db.insert("devicePairingRequests", {
      code,
      verifierHash: args.verifierHash,
      deviceId,
      deviceLabel,
      status: "pending",
      createdAt: now,
      expiresAt: now + PAIRING_REQUEST_TTL_MS,
    });
    return { requestId, code, expiresAt: now + PAIRING_REQUEST_TTL_MS };
  },
});

type PairingStatusView = {
  status: "pending" | "approved" | "exchanged" | "expired";
  expiresAt: number;
  approvalExpiresAt: number | null;
  // Present ONLY once approved, so the device can confirm who it's signing in
  // as. The requestId is device-held (never displayed), so this is not a leak.
  scholarName: string | null;
  scholarUsername: string | null;
};

/** The effective status of a request, accounting for both TTLs. */
function effectiveStatus(
  req: Doc<"devicePairingRequests">,
  now: number,
): PairingStatusView["status"] {
  if (req.status === "exchanged") return "exchanged";
  if (req.status === "approved") {
    if (req.approvalExpiresAt && req.approvalExpiresAt > now) return "approved";
    return "expired"; // approval window lapsed without an exchange
  }
  // pending
  return req.expiresAt > now ? "pending" : "expired";
}

/**
 * The device polls this (by its own requestId) to learn when a staffer has
 * approved it. Returns minimal, non-sensitive info; the scholar's display name
 * is revealed only after approval so the device can confirm the account.
 */
export const pairingStatus = query({
  args: { requestId: v.id("devicePairingRequests") },
  handler: async (ctx, args): Promise<PairingStatusView> => {
    const now = Date.now();
    const req = await ctx.db.get(args.requestId);
    if (!req) {
      return {
        status: "expired",
        expiresAt: 0,
        approvalExpiresAt: null,
        scholarName: null,
        scholarUsername: null,
      };
    }
    const status = effectiveStatus(req, now);
    let scholarName: string | null = null;
    let scholarUsername: string | null = null;
    if (status === "approved" && req.scholarId) {
      const scholar = await ctx.db.get(req.scholarId);
      scholarName = scholar?.name ?? null;
      scholarUsername = scholar?.username ?? null;
    }
    return {
      status,
      expiresAt: req.expiresAt,
      approvalExpiresAt: req.approvalExpiresAt ?? null,
      scholarName,
      scholarUsername,
    };
  },
});

// ── Staff console (scholar-admin, institution-scoped) ─────────────────

/**
 * Look up the pending request behind a typed code. Scholar-admin gated (the
 * same authority as Create/Reset PIN). Returns null when there's no LIVE
 * pending request for that code (already approved / exchanged / expired /
 * unknown), so the console can say "no pending request for that code" without
 * leaking which codes exist. Also surfaces the device's CURRENT binding (if
 * any) so a staffer reassigning an iPad sees who it's paired to today.
 */
export const lookupPairingRequestByCode = authedQuery({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const code = normalizeCode(args.code);
    if (code.length !== CODE_LENGTH) return null;
    const now = Date.now();
    const rows = await ctx.db
      .query("devicePairingRequests")
      .withIndex("by_code", (q) => q.eq("code", code))
      .collect();
    const req = rows.find((r) => r.status === "pending" && r.expiresAt > now);
    if (!req) return null;
    const authorizedInstitutionIds = await schoolOperationsInstitutionIds(
      ctx,
      ctx.user,
    );
    if (authorizedInstitutionIds !== "all" && authorizedInstitutionIds.size === 0) {
      throw new Error("Forbidden: school operations access required");
    }

    // Is this physical device already bound to a scholar the caller can see?
    let existingBinding:
      | { scholarName: string | null; scholarUsername: string | null; pairedAt: number }
      | null = null;
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", req.deviceId))
      .collect();
    for (const b of bindings) {
      const visible =
        authorizedInstitutionIds === "all" ||
        authorizedInstitutionIds.has(b.institutionId);
      if (!visible) continue;
      const scholar = await ctx.db.get(b.scholarId);
      if (!scholar) continue;
      existingBinding = {
        scholarName: scholar.name ?? null,
        scholarUsername: scholar.username ?? null,
        pairedAt: b.pairedAt,
      };
      break;
    }

    return {
      requestId: req._id,
      deviceId: req.deviceId,
      deviceLabel: req.deviceLabel ?? null,
      createdAt: req.createdAt,
      expiresAt: req.expiresAt,
      existingBinding,
    };
  },
});

/**
 * Approve a pairing request for a scholar. INSTITUTION-SCOPED via
 * requireScholarsAccessible — a teacher/operations staff/school_admin may only pair a
 * device to a scholar in their own institution (a platform admin is global).
 * This is the exact hole the PIN path had and just closed: a role check alone
 * would let staff@A pair a device to a scholar@B. Opens a ~60s single-use
 * exchange window; the device redeems it via signIn("devicePair", …).
 *
 * Re-approvable while the request is still live (≤5 min) and not yet exchanged,
 * so a staffer can correct a mis-picked scholar. A burnt (exchanged) request is
 * terminal.
 */
export const approvePairingRequest = authedMutation({
  args: {
    requestId: v.id("devicePairingRequests"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const scholar = await ctx.db.get(args.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found.");
    }
    if (!scholar.institutionId) {
      throw new Error("This scholar has no school on file.");
    }
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        scholar.institutionId,
      ))
    ) {
      throw new Error("Forbidden: scholar is not in your current school context");
    }

    const req = await ctx.db.get(args.requestId);
    const now = Date.now();
    if (!req) throw new Error("That pairing request no longer exists.");
    if (req.status === "exchanged") {
      throw new Error("That device has already been paired.");
    }
    if (req.expiresAt <= now) {
      throw new Error("That pairing code has expired — have the device show a new one.");
    }

    await ctx.db.patch(args.requestId, {
      status: "approved",
      scholarId: args.scholarId,
      institutionId: scholar.institutionId,
      approvedBy: ctx.user._id,
      approvedAt: now,
      approvalExpiresAt: now + EXCHANGE_WINDOW_MS,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "device.pair.approve",
      targetUserId: args.scholarId,
      at: now,
      detail: `device ${req.deviceId}${req.deviceLabel ? ` (${req.deviceLabel})` : ""} code ${req.code}`,
    });

    return {
      scholarName: scholar.name ?? null,
      scholarUsername: scholar.username ?? null,
      deviceLabel: req.deviceLabel ?? null,
      approvalExpiresAt: now + EXCHANGE_WINDOW_MS,
    };
  },
});

/**
 * The durable roster: which iPads are currently bound to which scholars, in
 * the caller's institution scope. Drives the "Paired devices" list — it's
 * always obvious which scholar a device belongs to. `hasLiveSession` reflects
 * whether the device still holds a live session (for the revoke affordance).
 */
export function isStaleManagedBinding(
  binding: Doc<"pairedDevices">,
  claimsById: ReadonlyMap<string, Doc<"managedDeviceClaims">>,
  activeDeviceIdsByScholar: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (binding.managedDeviceClaimId) {
    const claim = claimsById.get(String(binding.managedDeviceClaimId));
    return (
      !claim ||
      claim.institutionId !== binding.institutionId ||
      claim.lastDeviceId !== binding.deviceId
    );
  }
  if (binding.lastRequestId) return false;

  // Legacy managed bindings predate managedDeviceClaimId. Manual pairings
  // always carry lastRequestId, so an unowned row is stale only when this
  // scholar has a managed claim whose current install id is somewhere else.
  const activeDeviceIds = activeDeviceIdsByScholar.get(String(binding.scholarId));
  return activeDeviceIds !== undefined && !activeDeviceIds.has(binding.deviceId);
}

export const listPairedDevices = authedQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.institutionScope ?? "");
    const now = Date.now();

    // Which institutions to show: a single-institution lens shows that one; the
    // "all" lens shows every institution the caller may access.
    const institutionIds =
      lens.scope === "all"
        ? [...lens.allowedInstitutionIds]
        : lens.institution
          ? [lens.institution._id]
          : [];
    const operationsInstitutions = await schoolOperationsInstitutionIds(
      ctx,
      ctx.user,
    );
    const authorizedInstitutionIds =
      operationsInstitutions === "all"
        ? institutionIds
        : institutionIds.filter((id) => operationsInstitutions.has(id));

    const rows: Doc<"pairedDevices">[] = [];
    const managedClaims: Doc<"managedDeviceClaims">[] = [];
    for (const instId of authorizedInstitutionIds) {
      const forInst = await ctx.db
        .query("pairedDevices")
        .withIndex("by_institution", (q) => q.eq("institutionId", instId))
        .collect();
      const claimsForInst = await ctx.db
        .query("managedDeviceClaims")
        .withIndex("by_institution", (q) => q.eq("institutionId", instId))
        .collect();
      rows.push(...forInst);
      managedClaims.push(...claimsForInst);
    }

    const claimsById = new Map(
      managedClaims.map((claim) => [String(claim._id), claim]),
    );
    const activeDeviceIdsByScholar = new Map<string, Set<string>>();
    const managedClaimIdByLegacyBinding = new Map<
      string,
      Id<"managedDeviceClaims">
    >();
    for (const claim of managedClaims) {
      if (!claim.scholarId || !claim.lastDeviceId) continue;
      const scholarId = String(claim.scholarId);
      const activeIds = activeDeviceIdsByScholar.get(scholarId) ?? new Set<string>();
      activeIds.add(claim.lastDeviceId);
      activeDeviceIdsByScholar.set(scholarId, activeIds);
      managedClaimIdByLegacyBinding.set(
        `${claim.institutionId}:${claim.scholarId}:${claim.lastDeviceId}`,
        claim._id,
      );
    }

    const enriched = await Promise.all(
      rows
        .filter(
          (row) =>
            !isStaleManagedBinding(
              row,
              claimsById,
              activeDeviceIdsByScholar,
            ),
        )
        .map(async (row) => {
        const scholar = await ctx.db.get(row.scholarId);
        if (!scholar) return null; // scholar deleted — hide the orphan binding
        const pairedByUser = row.pairedBy ? await ctx.db.get(row.pairedBy) : null;
        let hasLiveSession = false;
        if (row.authSessionId) {
          const session = await ctx.db.get(row.authSessionId);
          hasLiveSession = !!session && session.expirationTime > now;
        }
        const rabbitholeLockDesiredState =
          row.rabbitholeLockDesiredState ?? "armed";
        const lockUpdatedAt = row.rabbitholeLockUpdatedAt ?? row.pairedAt;
        const rabbitholeLockAppliedMatchesDesired =
          row.rabbitholeLockAppliedDesiredState ===
            rabbitholeLockDesiredState &&
          row.rabbitholeLockAppliedAt !== undefined &&
          row.rabbitholeLockAppliedAt >= lockUpdatedAt &&
          row.rabbitholeLockInSingleAppMode ===
            (rabbitholeLockDesiredState === "armed");
        return {
          _id: row._id,
          deviceId: row.deviceId,
          deviceLabel: row.deviceLabel ?? null,
          // The devices console uses this exact foreign key to omit managed
          // bindings from its manual-pairing rows. Do not infer ownership from
          // a scholar or a hardware label: one managed iPad is one row.
          managedDeviceClaimId:
            row.managedDeviceClaimId ??
            (!row.lastRequestId
              ? managedClaimIdByLegacyBinding.get(
                  `${row.institutionId}:${row.scholarId}:${row.deviceId}`,
                )
              : undefined) ??
            null,
          scholarId: row.scholarId,
          scholarName: scholar.name ?? null,
          scholarUsername: scholar.username ?? null,
          scholarImage: scholar.image ?? null,
          pairedAt: row.pairedAt,
          pairedByName: pairedByUser?.name ?? null,
          hasLiveSession,
          rabbitholeLockDesiredState,
          rabbitholeLockDisarmMode:
            row.rabbitholeLockDisarmMode ?? null,
          rabbitholeLockAppliedMatchesDesired,
        };
        }),
    );

    return enriched
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.pairedAt - a.pairedAt);
  },
});

async function managedClaimForBinding(
  ctx: MutationCtx,
  row: Doc<"pairedDevices">,
): Promise<Doc<"managedDeviceClaims"> | null> {
  if (row.managedDeviceClaimId) {
    const claim = await ctx.db.get(row.managedDeviceClaimId);
    return claim &&
      claim.institutionId === row.institutionId &&
      claim.scholarId === row.scholarId
      ? claim
      : null;
  }
  if (row.lastRequestId) return null;

  const legacyClaims = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_last_device_id", (q) => q.eq("lastDeviceId", row.deviceId))
    .collect();
  return (
    legacyClaims.find(
      (claim) =>
        claim.institutionId === row.institutionId &&
        claim.scholarId === row.scholarId,
    ) ?? null
  );
}

export async function unpairDeviceBinding(
  ctx: MutationCtx,
  row: Doc<"pairedDevices">,
  actorUserId: Id<"users">,
  auditAction = "device.pair.unpair",
): Promise<{ sessionRevoked: boolean; managedClaimUnassigned: boolean }> {
  const managedClaim = await managedClaimForBinding(ctx, row);
  const sessionRevoked = await revokeAllDeviceAuthSessions(ctx, row._id);

  if (managedClaim) {
    // Force-close any active/warm MDM unlock BEFORE unassigning the claim —
    // same fail-closed ordering as managedDeviceClaims.ts's
    // revoke/remove/unassign handlers (see scheduleClaimDecommissionLock's
    // doc comment). Both entry paths that reach here (staff-initiated
    // unpairDevice, and the lost-device signOutDevice path) must not leave
    // the device's allowlist unlocked past this point.
    await scheduleClaimDecommissionLock(ctx, managedClaim._id);
    await ctx.db.patch(
      managedClaim._id,
      unassignedManagedClaimPatch(Date.now(), managedClaim.claimGeneration),
    );
    await ctx.db.insert("auditLog", {
      actorUserId,
      action: "managed-claim.unassign",
      targetUserId: row.scholarId,
      at: Date.now(),
      detail: `serial ${managedClaim.serial}; source ${auditAction}`,
    });
  }

  await ctx.db.delete(row._id);
  // Delete the sidecar session-log rows now that the binding they log against
  // is gone — sessions are already revoked above, this just prevents an
  // unbounded accumulation of dead log rows across the fleet's lifetime.
  await deleteDeviceAuthSessionLog(ctx, row._id);
  await ctx.db.insert("auditLog", {
    actorUserId,
    action: auditAction,
    targetUserId: row.scholarId,
    at: Date.now(),
    detail: `device ${row.deviceId}${row.deviceLabel ? ` (${row.deviceLabel})` : ""}`,
  });
  return {
    sessionRevoked,
    managedClaimUnassigned: managedClaim !== null,
  };
}

/**
 * Unpair a device (reassignment): remove the durable binding AND sign that
 * device out (revoke its tracked session), so the iPad returns to signed-out
 * and is ready to pair to a different scholar. Institution-scoped — you can
 * only unpair a device bound to a scholar in your context.
 */
export const unpairDevice = authedMutation({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row) throw new Error("That device is no longer paired.");
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        row.institutionId,
      ))
    ) {
      throw new Error("Forbidden: device is not in your current school context");
    }
    return await unpairDeviceBinding(ctx, row, ctx.user._id);
  },
});

/**
 * Sign a device out remotely WITHOUT unpairing it (the lost-iPad case): revoke
 * the device's tracked session but keep the binding visible, so staff still see
 * whose iPad it was and can unpair or re-pair later. This is the "separate
 * explicit way to revoke a device's session" — deliberately distinct from
 * pairing, which never disturbs a scholar's other (e.g. laptop) sessions.
 *
 * ⚠️ For a MANAGED-NATIVE pairing (`row.managedDeviceClaimId` set), this must
 * be a real decommission, not merely dropping the tracked Convex Auth
 * session: the durable claim credential and its MDM allowlist unlock are
 * separate state that a plain session revoke never touches, so the device
 * would otherwise auto-re-exchange its still-valid claim token on next
 * foreground and sign itself right back in — and the managed app would stay
 * unlocked for up to the reconciler's normal recheck interval regardless.
 * So when a managed claim is bound here, this routes through the exact same
 * `decommissionManagedClaim` sequence `revokeManagedDeviceClaim` uses:
 * schedule the relock, revoke by immutable claim+generation, invalidate the
 * claim token, bump the generation. A manually-paired (non-managed) device's
 * session revoke is unaffected.
 */
export const revokeDeviceSession = authedMutation({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.pairedDeviceId);
    if (!row) throw new Error("That device is no longer paired.");
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        row.institutionId,
      ))
    ) {
      throw new Error("Forbidden: device is not in your current school context");
    }

    let managedSessionRevoked = false;
    if (row.managedDeviceClaimId) {
      const claim = await ctx.db.get(row.managedDeviceClaimId);
      // Only an active (still-redeemable) claim needs decommissioning — a
      // claim already unassigned/revoked has no live credential left to kill,
      // and re-running the sequence would just bump the generation again for
      // no reason (harmless, but not what "revoke this device's session"
      // means for an already-inert claim).
      if (claim && claim.scholarId && claim.claimTokenHash) {
        const decommission = await decommissionManagedClaim(
          ctx,
          claim,
          ctx.user._id,
          "managed-claim.revoke",
        );
        managedSessionRevoked = decommission.sessionRevoked;
      }
    }

    const sessionRevoked =
      (await revokeAllDeviceAuthSessions(ctx, args.pairedDeviceId)) ||
      managedSessionRevoked;
    const now = Date.now();
    await ctx.db.patch(args.pairedDeviceId, {
      authSessionId: undefined,
      assignedDeviceCaptureStationId: undefined,
      assignedDeviceCaptureExpiresAt: undefined,
      assignedDeviceCaptureUpdatedAt: Math.max(
        now,
        (row.assignedDeviceCaptureUpdatedAt ?? 0) + 1,
      ),
      assignedDeviceCaptureUpdatedBy: undefined,
    });

    await ctx.db.insert("auditLog", {
      actorUserId: ctx.user._id,
      action: "device.session.revoke",
      targetUserId: row.scholarId,
      at: now,
      detail: `device ${row.deviceId}${row.deviceLabel ? ` (${row.deviceLabel})` : ""}`,
    });
    return { sessionRevoked };
  },
});

/**
 * The lightweight scholar picker for the console: id + name + username only,
 * scoped to the caller's institution lens. A dedicated query (rather than the
 * heavy users.listScholars, which loads sessions/messages/practice per row) so
 * the bulk-pairing picker stays fast. Scholar-admin gated + institution-scoped
 * — an operations staffer only ever sees their own school's scholars to pick from.
 *
 * Enrolled-only by default: Extended Education (program-guest) scholars usually
 * don't have their own paired devices (they use shared capture stations), so
 * they're excluded unless a caller explicitly opts in — matching the
 * roster-wide standard (users.listScholars). `enrollmentStanding` is still
 * returned so a guest-inclusive caller can label them.
 */
export const listPairableScholars = authedQuery({
  args: {
    institutionScope: v.optional(v.string()),
    includeProgramGuests: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const lens = await resolveInstitutionLens(ctx, ctx.user, args.institutionScope ?? "");
    if (
      !lens.institution ||
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        lens.institution._id,
      ))
    ) {
      throw new Error("Forbidden: school operations access required");
    }
    const scholars = await ctx.db
      .query("users")
      .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
      .collect();
    return scholars
      .filter(
        (s) =>
          scholarInLens(lens, s) &&
          (args.includeProgramGuests === true || isEnrolledScholar(s)),
      )
      .map((s) => ({
        _id: s._id,
        name: s.name ?? null,
        username: s.username ?? null,
        enrollmentStanding: s.enrollmentStanding ?? "enrolled",
      }))
      .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  },
});

// ── Device-facing (authenticated, post-exchange) ──────────────────────

/**
 * The just-paired device records its OWN session on its binding, so a lost
 * iPad can later be signed out remotely (revokeDeviceSession) without touching
 * the scholar's other sessions. Called by the native app immediately after a
 * successful signIn("devicePair"/"deviceClaim", …). Keyed on the caller's own
 * getAuthSessionId — unspoofable — and it only ever writes the binding for
 * the authenticated scholar's own device.
 *
 * Both exchange paths (consumePairingExchange / managedDeviceClaims's
 * consumeManagedClaim) now mint + record the session ATOMICALLY inside their
 * own transaction, so by the time the client's normal foreground/idle
 * heartbeat calls this, the session is typically already recorded. This is
 * therefore idempotent — deduped via `pairedDeviceAuthSessions.by_session` —
 * rather than an unconditional insert, so a repeated call (every
 * foreground/idle phase) never accumulates duplicate log rows.
 *
 * Round 5, Finding 3: `pairedDeviceAuthSessions` holds CURRENT active state,
 * not a history — exactly one live row per `pairedDeviceId`. A genuinely
 * DIFFERENT session attaching here (a real re-sign-in on the same physical
 * device) therefore REPLACES the prior row rather than accumulating a
 * second one; otherwise a decommission that revokes only the row it happens
 * to look for could leave an earlier attach permanently unenumerable/
 * unrevoked. The old session is revoked BEFORE `authSessionId` is repointed
 * — repointing first would let the fallback pointer-revoke inside
 * `revokeAllDeviceAuthSessions` revoke the brand-new session instead of the
 * one actually being replaced.
 *
 * Round 6, Finding 1 (rollout regression): existing `pairedDevices` rows
 * from BEFORE this table shipped already have `authSessionId` populated but
 * no sidecar row yet — the table starts empty. On such a binding's first
 * foreground call, `alreadyLogged` (keyed on the sidecar table) finds
 * nothing even though `binding.authSessionId` already IS the caller's
 * current session, so this must NOT be treated as "a different session."
 * Doing so would fall into the revoke branch, whose legacy-pointer fallback
 * would delete the caller's own live session out from under them. The
 * dedicated `binding.authSessionId === typedSessionId` check below backfills
 * the missing sidecar row for that already-live session instead of revoking
 * anything; only a truly different incoming session takes the revoke path.
 */
export const attachDeviceSession = authedMutation({
  args: { deviceId: v.string() },
  handler: async (ctx, args): Promise<{ attached: boolean }> => {
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) return { attached: false };
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", ctx.user._id))
      .collect();
    const binding = bindings.find((b) => b.deviceId === args.deviceId);
    if (!binding) return { attached: false };
    const typedSessionId = sessionId as Id<"authSessions">;

    // Dedupe via the session-keyed index: a repeat call for the SAME session
    // (every foreground/idle phase makes one) must not touch anything.
    const alreadyLogged = await ctx.db
      .query("pairedDeviceAuthSessions")
      .withIndex("by_session", (q) => q.eq("authSessionId", typedSessionId))
      .filter((q) => q.eq(q.field("pairedDeviceId"), binding._id))
      .first();
    if (alreadyLogged) {
      if (binding.authSessionId !== typedSessionId) {
        await ctx.db.patch(binding._id, { authSessionId: typedSessionId });
      }
      return { attached: true };
    }

    const claim = binding.managedDeviceClaimId
      ? await ctx.db.get(binding.managedDeviceClaimId)
      : null;
    const backfillRow = () =>
      ctx.db.insert("pairedDeviceAuthSessions", {
        pairedDeviceId: binding._id,
        authSessionId: typedSessionId,
        scholarId: ctx.user._id,
        attachedAt: Date.now(),
        managedDeviceClaimId: claim?._id,
        claimGeneration: claim ? claim.claimGeneration ?? 0 : undefined,
      });

    if (binding.authSessionId === typedSessionId) {
      // Round 6, Finding 1: this is the SAME live session the binding
      // already points at (a legacy row from before the sidecar table
      // existed, or one this table simply hasn't logged yet) — adopt it,
      // never revoke it.
      await backfillRow();
      return { attached: true };
    }

    // A different session for this same binding is a genuine re-sign-in —
    // revoke/delete whatever this pairedDevice's prior session row(s) were
    // FIRST (see doc comment above on ordering), then record the new one.
    // Enumerable log entry so a later decommission can enumerate + revoke
    // every session this device has attached, not just whichever one
    // happens to be the current denormalized pointer (see
    // revokeAllDeviceAuthSessions). Stamp the claim's CURRENT generation
    // when this binding is claim-owned, for consistency with the atomic
    // mint sites — this fallback path is rarely hit now (both exchange
    // mutations record their session atomically already) but should agree
    // with them when it is.
    await revokeAllDeviceAuthSessions(ctx, binding._id);
    await ctx.db.patch(binding._id, { authSessionId: typedSessionId });
    await backfillRow();
    return { attached: true };
  },
});

// ── Internal: the atomic exchange (called by the auth provider) ───────

/**
 * Atomically consume an approved pairing request, returning the scholar's
 * userId + a freshly minted, already-recorded auth session id (or null). The
 * whole read → validate → burn → bind → mint-session runs in this ONE
 * mutation's transaction, which is what makes it single-use, replay-safe, AND
 * leaves no unenumerable session: unlike a normal Convex Auth sign-in (which
 * mints the session AFTER this `authorize()` callback returns, so a client
 * crash before its follow-up `attachDeviceSession` call used to leave an
 * orphaned session the server never learned the id of), the session row +
 * its `pairedDeviceAuthSessions` association are written right here, and the
 * id is returned so `auth.ts`'s `devicePair` provider can hand it back to
 * Convex Auth as an EXISTING session (see mintAuthSessionForUser's doc
 * comment). Details:
 *   - the request must be `approved`, unexchanged, and within its exchange
 *     window;
 *   - sha256(verifier) must equal the stored verifierHash (possession of the
 *     code alone never suffices);
 *   - we stamp `exchangedAt` (→ status "exchanged"), so a second attempt hits a
 *     burnt row and returns null;
 *   - we upsert the durable pairedDevices binding (institutionId+deviceId). A
 *     re-pair to a DIFFERENT scholar revokes the old scholar's device session
 *     first (clean reassignment) — this only ever touches THIS device's
 *     session, never the scholar's other sessions.
 * Called ONLY by the `devicePair` provider's `authorize` in convex/auth.ts.
 */
export const consumePairingExchange = internalMutation({
  args: { requestId: v.string(), verifier: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{ userId: Id<"users">; sessionId: Id<"authSessions"> } | null> => {
    if (!args.verifier || args.verifier.length < 43) return null;

    // Safe id resolution: a malformed requestId must fail closed, not throw.
    let req: Doc<"devicePairingRequests"> | null = null;
    try {
      req = await ctx.db.get(args.requestId as Id<"devicePairingRequests">);
    } catch {
      return null;
    }
    if (!req) return null;

    const now = Date.now();
    if (req.status !== "approved") return null; // not approved / already burnt
    if (req.exchangedAt !== undefined) return null; // single-use
    if (!req.approvalExpiresAt || req.approvalExpiresAt <= now) return null; // window closed
    if (!req.scholarId || !req.institutionId) return null; // malformed approval

    // The proof: the raw verifier must hash to the stored challenge.
    const verifierHash = await sha256Hex(args.verifier);
    if (verifierHash !== req.verifierHash) return null;

    // Burn first (inside this transaction → replay-safe).
    await ctx.db.patch(req._id, { status: "exchanged", exchangedAt: now });

    // Upsert the durable binding (institutionId + deviceId).
    const existing = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device", (q) =>
        q.eq("institutionId", req.institutionId!).eq("deviceId", req.deviceId),
      )
      .unique();
    const sessionId = await mintAuthSessionForUser(ctx, req.scholarId);
    let pairedDeviceId: Id<"pairedDevices">;
    if (existing) {
      const scholarChanged = existing.scholarId !== req.scholarId;
      const previousManagedClaimId = existing.managedDeviceClaimId;
      // Re-pair: revoke ALL of this device's previously-attached sessions —
      // never the scholar's other (e.g. laptop) sessions — UNCONDITIONALLY,
      // not only when the scholar changed. A same-scholar manual re-pair
      // still detaches this physical device from any managed claim that
      // owned it (managedDeviceClaimId is cleared below), and a
      // claim-authenticated session must not outlive that detachment just
      // because the human on the other end happens to be the same scholar.
      await revokeAllDeviceAuthSessions(ctx, existing._id);
      if (previousManagedClaimId) {
        // This device is leaving the managed claim's ownership right now —
        // nudge its unlock reconciler so the correction is fast. Latency-only:
        // prepareReconcileLock's freshOwner check (no live pairedDevices row
        // for this claim+device) already guarantees the device force-locks
        // within one tick regardless of whether this nudge lands.
        await scheduleClaimDecommissionLock(ctx, previousManagedClaimId);
      }
      await ctx.db.patch(existing._id, {
        scholarId: req.scholarId,
        deviceLabel: req.deviceLabel,
        pairedAt: now,
        pairedBy: req.approvedBy ?? existing.pairedBy,
        lastRequestId: req._id,
        managedDeviceClaimId: undefined,
        authSessionId: sessionId,
        // A genuine handover always starts locked. Re-pairing the SAME scholar
        // preserves an intentional remote disarm (including after a reinstall).
        ...(scholarChanged
          ? {
              rabbitholeLockDesiredState: undefined,
              rabbitholeLockDisarmMode: undefined,
              rabbitholeLockDisarmExpiresAt: undefined,
              rabbitholeLockUpdatedAt: undefined,
              rabbitholeLockUpdatedBy: undefined,
              rabbitholeLockAppliedDesiredState: undefined,
              rabbitholeLockAppliedAt: undefined,
              rabbitholeLockInSingleAppMode: undefined,
              assignedDeviceCaptureStationId: undefined,
              assignedDeviceCaptureExpiresAt: undefined,
              assignedDeviceCaptureUpdatedAt: undefined,
              assignedDeviceCaptureUpdatedBy: undefined,
            }
          : {}),
      });
      pairedDeviceId = existing._id;
    } else {
      pairedDeviceId = await ctx.db.insert("pairedDevices", {
        institutionId: req.institutionId,
        deviceId: req.deviceId,
        scholarId: req.scholarId,
        deviceLabel: req.deviceLabel,
        pairedAt: now,
        pairedBy: req.approvedBy ?? req.scholarId,
        lastRequestId: req._id,
        authSessionId: sessionId,
      });
    }
    // Atomic association — see mintAuthSessionForUser's doc comment: this
    // insert happens in the SAME transaction as the session mint + binding
    // upsert above, so the session can never exist without being enumerable.
    await ctx.db.insert("pairedDeviceAuthSessions", {
      pairedDeviceId,
      authSessionId: sessionId,
      scholarId: req.scholarId,
      attachedAt: now,
    });

    return { userId: req.scholarId, sessionId };
  },
});

/**
 * Sweep dead pairing requests: exchanged (terminal) or past their ~5-min TTL.
 * The durable pairedDevices bindings are never touched here. Bounded scan — the
 * table is small (short TTL). Mirrors enrollment.sweepStaleTokens.
 */
export const sweepStalePairingRequests = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const rows = await ctx.db.query("devicePairingRequests").take(2000);
    let removed = 0;
    for (const row of rows) {
      if (row.status === "exchanged" || row.expiresAt < now) {
        await ctx.db.delete(row._id);
        removed++;
      }
    }
    return { removed };
  },
});

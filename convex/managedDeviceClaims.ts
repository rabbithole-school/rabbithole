/**
 * Managed-claim device provisioning — ZERO-TOUCH iPad sign-in for the
 * ADE-enrolled, SimpleMDM-managed 1:1 fleet.
 *
 * ── Why a second mechanism (and not just pairing) ────────────────────────
 * `devicePairing.ts` still requires a human: the iPad shows a code, a staffer
 * types it into the console. For a stack of freshly-boxed, ADE-enrolled iPads
 * that is 11 walks-to-the-console. The managed-claim path removes the device
 * side of that entirely: NOBODY types anything on the iPad. Each device
 * auto-signs-in as ITS assigned scholar on first open.
 *
 * The hard constraint driving the design: iOS forbids an app from reading its
 * own serial number / UDID. So the device cannot tell the server "I am iPad
 * F9FZ…". Instead the identity is delivered TO the device by MDM **managed app
 * configuration** — the `com.apple.configuration.managed` dictionary SimpleMDM
 * sets PER DEVICE. Rabbithole mints a per-device CLAIM token bound to
 * (scholar, institution, serial); SimpleMDM puts it in that device's AppConfig;
 * the app reconciles it on every launch/foreground and exchanges it for a real
 * session.
 *
 * ── The AppConfig contract (the native-client + SimpleMDM contract) ───────
 * Managed app config dictionary (top-level keys under
 * `com.apple.configuration.managed`, read on iOS via
 * `UserDefaults.standard.dictionary(forKey:"com.apple.configuration.managed")`):
 *
 *     {
 *       "claimToken":   "<the durable per-device claim secret>",  // REQUIRED
 *       "claimSerial":  "<the device serial>",                    // recommended
 *       "claimVersion": "1"                                       // contract rev
 *     }
 *
 * `claimSerial` is informational + a DELIVERY-TIME integrity cross-check; the
 * token alone is the credential. iOS forbids the app from reading its serial,
 * so this check can catch SimpleMDM delivering a payload whose serial disagrees
 * with the claim, but it cannot stop a leaked token being redeemed elsewhere.
 * The real controls for that threat are hashing at rest, rotation, and
 * revocation. The console export bakes in the LITERAL serial (we know it), so
 * the payload needs no MDM-side substitution.
 *
 * The app (see the PR body for the full state machine — the native screen ships
 * separately; this module is server + web console only):
 *   1. Read the managed-config dictionary on EVERY launch AND whenever the app
 *      enters the foreground, then RECONCILE it with the local session by
 *      calling:
 *          signIn("deviceClaim", {
 *            claimToken,
 *            deviceId,          // stable per-install id (identifierForVendor)
 *            deviceLabel?,      // e.g. "iPad (9th gen)"
 *            serial: claimSerial? // optional integrity cross-check
 *          })
 *      The `deviceClaim` provider (convex/auth.ts) → consumeManagedClaim
 *      verifies sha256(claimToken) against the stored hash, records the
 *      consumption + the durable `pairedDevices` binding, audits it, and
 *      returns the assigned scholar's userId → a normal, revocable Convex Auth
 *      session is minted (the SAME path pairing uses — no second auth provider
 *      family).
 *      If a session already exists, re-exchange the delivered claim. A different
 *      returned userId means the device was reassigned; an exchange/auth failure
 *      may mean the old claim or session was revoked. In either case, sign out
 *      locally, clear ALL cached scholar data, and re-exchange the currently
 *      delivered claim before rendering scholar data. Without this foreground
 *      reconciliation, a non-wipe reassignment can leave the device presenting
 *      the previous scholar forever. The server revokes the old session on
 *      reassignment, but the app must handle that revocation by clearing local
 *      state and re-claiming — NEVER render stale scholar data after an auth
 *      failure.
 *   2. Immediately after signIn succeeds, call
 *      api.devicePairing.attachDeviceSession({ deviceId }) so claim lifecycle
 *      actions can revoke that iPad's session without disturbing the scholar's
 *      other sessions.
 *   3. Missing claim → fall back to manual pairing / normal sign-in.
 *      Revoked/invalid claim → signIn throws → show "couldn't auto-sign-in, ask
 *      your teacher" + offer manual pairing.
 *
 * ── Delivery channel ───────────────────────────────────────────────────────
 * SimpleMDM stores `rabbithole_claim_token` as a per-device custom attribute;
 * the app's shared managed configuration references that attribute.
 *
 * ── Single-use vs DURABLE — the deliberate choice ────────────────────────
 * The claim is DURABLE / reusable, NOT burned on first exchange. Reasoning:
 *   - The device is MEANT to stay signed in for its whole life, and the claim
 *     lives in per-device MDM config that PERSISTS across an app reinstall and a
 *     wipe-and-re-enroll (SimpleMDM re-pushes it). A single-use claim would break
 *     zero-touch the moment a device is wiped — someone would have to mint and
 *     re-push a fresh token. Durable keeps it hands-off for the device's life.
 *   - identifierForVendor resets on reinstall, so the ephemeral deviceId is NOT
 *     a durable key; the serial-bound claim is. Re-exchange after a wipe simply
 *     rebuilds the `pairedDevices` binding under the new deviceId.
 *   - The raw token is a SHARED SECRET across Rabbithole (returned once at
 *     mint), SimpleMDM (stored server-side, visible to MDM admins, and transmitted
 *     on check-in), and the device's NSUserDefaults (unencrypted and
 *     backup-eligible). MDM install settings should enable "prevent app data
 *     backup" if available. This is acceptable because the blast radius is one
 *     revocable scholar session and SimpleMDM already holds the device root of
 *     trust. We further mitigate the durable-secret risk by hashing the token at
 *     rest and supporting explicit per-device ROTATION (new token, old
 *     invalidated) and REVOCATION.
 *
 * Crypto note: runs in the DEFAULT Convex runtime (Web Crypto via
 * lib/oauthCrypto) — no "use node" — matching the auth provider's `authorize`.
 */
import { v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import { getAuthUserId } from "@convex-dev/auth/server";
import { requireUser } from "./lib/auth";
import { internal } from "./_generated/api";
import { authedMutation, authedQuery } from "./lib/customFunctions";
import { sha256Hex, randomToken } from "./lib/oauthCrypto";
import { resolveInstitutionLens } from "./lib/institutionLens";
import {
  isStaleManagedBinding,
  revokeAllDeviceAuthSessions,
  revokeManagedClaimSessions,
  deleteDeviceAuthSessionLog,
  mintAuthSessionForUser,
  decommissionManagedClaim,
} from "./devicePairing";
import { ROLES } from "./lib/roles";
import type { Doc, Id } from "./_generated/dataModel";
import {
  unassignedManagedClaimPatch,
  auditManagedClaim,
} from "./lib/managedDeviceClaimState";
import {
  forgetClaimVerification,
  snapshotForInstitutionSerial,
} from "./lib/simpleMdmSnapshots";
import { isTeardownStopped, isUnlockStateSettled } from "./deviceAppUnlock";
import {
  scheduleClaimDecommissionLock,
  scheduleDeviceOwnershipRefresh,
} from "./lib/deviceAppUnlockScheduling";
import {
  hasSchoolOperationsAccessAtInstitution,
  schoolOperationsInstitutionIds,
} from "./lib/staffCapabilities";
import {
  managedAppGrantsForScholar,
  pushedManagedAppKeysForScholar,
} from "./lib/deviceAppProjection";
import {
  managedNativeAppKeyForApp,
  type ManagedNativeAppKey,
} from "./lib/managedNativeApps";
import {
  buildAppAccessRows,
  scheduleByKeyForGroups,
  type AppAccessRow,
  type AppPlacementWindow,
} from "./lib/deviceAppAccess";
import { groupIdsForScholar } from "./lib/scholarGroupMembership";
import { timeZoneForInstitution } from "./lib/institutionTime";
import {
  APP_PLACEMENT_GRACE_MS,
  APP_PLACEMENT_LEAD_MS,
  loadInstitutionClosures,
  parseHHMM,
} from "./masterSchedule";
import { shiftLocalLabel } from "./appAudiences";
import { primaryInstitutionId } from "./lib/primaryInstitution";
import { dayKeyForTimezone } from "../shared/institutionDay";
import { scheduleWeekStartMs } from "../shared/scheduleWeek";
import { dayKeyForWeekday, isClosedDay } from "../shared/schoolClosures";

/** The contract version stamped into every AppConfig payload. Bump only on a
 *  breaking change to the dictionary shape so old + new apps can coexist. */
export const CLAIM_CONTRACT_VERSION = "1";

/** Raw claim token: an `rhc_`-prefixed high-entropy secret. Prefix makes it
 *  greppable/legible in managed config; the entropy makes it unguessable. */
function generateClaimToken(): string {
  return `rhc_${randomToken(32)}`; // 32 random bytes → 64 hex chars
}

/** Normalize a hardware serial to the stored form: trimmed, uppercased. Apple
 *  serials are case-insensitive alphanumerics; normalizing makes the key stable
 *  regardless of how a staffer pasted it. */
export function normalizeSerial(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Apple serials are 10–12 alphanumeric chars (older 12, 2021+ randomized ~10).
 *  Bounded + alnum guard — reject obvious garbage without being over-strict. */
export function isPlausibleSerial(serial: string): boolean {
  return /^[0-9A-Z]{8,14}$/.test(serial);
}

/** The AppConfig dictionary a staffer pushes into SimpleMDM for one device.
 *  Pure + exported so the console and tests build the identical payload. */
export function buildAppConfigPayload(
  serial: string,
  claimToken: string,
): { claimToken: string; claimSerial: string; claimVersion: string } {
  return {
    claimToken,
    claimSerial: serial,
    claimVersion: CLAIM_CONTRACT_VERSION,
  };
}

// ── Staff console (scholar-admin, institution-scoped) ─────────────────

export type MintResult = {
  serial: string;
  ok: boolean;
  error?: string;
  // Present only on success — the raw token is exposed ONCE, here.
  managedDeviceId?: Id<"managedDeviceClaims">;
  scholarName?: string | null;
  scholarUsername?: string | null;
  claimToken?: string;
  payload?: ReturnType<typeof buildAppConfigPayload>;
  reassignedFrom?: string | null; // prior scholar's name, when this was a reassignment
};

type RegisterResult = {
  serial: string;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  managedDeviceId?: Id<"managedDeviceClaims">;
};

async function requireManagedDeviceInstitutionAccessible(
  ctx: MutationCtx,
  user: Doc<"users">,
  row: Doc<"managedDeviceClaims">,
): Promise<void> {
  if (
    !(await hasSchoolOperationsAccessAtInstitution(
      ctx,
      user,
      row.institutionId,
    ))
  ) {
    throw new Error("That device belongs to another school.");
  }
}

/**
 * Pre-load serials before scholar assignments are known. The institution comes
 * only from the caller's active lens; a client cannot register hardware into a
 * different school by supplying an institution id.
 *
 * `institutionScope` is the SAME lens value the console's reads use (a slug,
 * "all", or "" for the caller's home school) — not an institution id, and it
 * still buys no authority: resolveInstitutionLens honors it only for an admin
 * or a member of that school, and the operations check below gates whatever it
 * resolves to. Hardcoding "" here silently filed every registration under the
 * caller's HOME school while the console was lensed at another one, so the row
 * never appeared in the list the operator was looking at.
 */
export const registerManagedDeviceSerials = authedMutation({
  args: {
    serials: v.array(v.string()),
    institutionScope: v.optional(v.string()),
    // Deprecated rollout compatibility for already-open clients. Ignored.
    label: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ results: RegisterResult[] }> => {
    if (args.serials.length === 0) return { results: [] };
    if (args.serials.length > 200) {
      throw new Error("Too many devices in one batch (max 200).");
    }

    const lens = await resolveInstitutionLens(
      ctx,
      ctx.user,
      args.institutionScope ?? "",
    );
    // An unhonored scope means the requested school was unknown or closed to
    // this caller. The lens quietly falls back to their home school for reads;
    // for a WRITE that fallback is the bug this argument exists to fix, so
    // refuse instead of filing the hardware somewhere the operator can't see.
    if (args.institutionScope && !lens.honored) {
      throw new Error("That school isn't available to you.");
    }
    const institution = lens.institution;
    if (!institution || !lens.allowedInstitutionIds.has(institution._id)) {
      // Also the "all" lens, which names no single school to register into.
      throw new Error("Choose a school before registering devices.");
    }
    if (
      !(await hasSchoolOperationsAccessAtInstitution(
        ctx,
        ctx.user,
        institution._id,
      ))
    ) {
      throw new Error("Forbidden: school operations access required");
    }

    const results: RegisterResult[] = [];
    const seen = new Set<string>();
    for (const raw of args.serials) {
      const serial = normalizeSerial(raw);
      if (!isPlausibleSerial(serial)) {
        results.push({ serial, ok: false, error: "Not a valid serial number." });
        continue;
      }
      if (seen.has(serial)) {
        results.push({
          serial,
          ok: false,
          skipped: true,
          error: "Duplicate serial in this batch.",
        });
        continue;
      }
      seen.add(serial);

      const existing = await ctx.db
        .query("managedDeviceClaims")
        .withIndex("by_serial", (q) => q.eq("serial", serial))
        .unique();
      if (existing) {
        // `by_serial` is unique GLOBALLY, so this lookup can land on a row
        // owned by another institution. Say the serial is taken — refusing
        // silently is the no-op bug PR #3477 fixed — but hand back the row's
        // id ONLY when the operator's own school owns it (the console may
        // legitimately link to it). A foreign row's id is an opaque handle
        // into another tenant's data and must not cross the boundary.
        const sameInstitution = existing.institutionId === institution._id;
        results.push({
          serial,
          ok: false,
          skipped: true,
          ...(sameInstitution ? { managedDeviceId: existing._id } : {}),
          error: sameInstitution
            ? "Already on this school's roster."
            : "That serial is already registered.",
        });
        continue;
      }

      const now = Date.now();
      const managedDeviceId = await ctx.db.insert("managedDeviceClaims", {
        institutionId: institution._id,
        serial,
        claimState: "unassigned",
        createdBy: ctx.user._id,
        createdAt: now,
        updatedAt: now,
        // Required by the widening schema; no token exists until assignment.
        claimIssuedAt: now,
        rotationCount: 0,
        claimCount: 0,
      });
      await auditManagedClaim(
        ctx,
        ctx.user._id,
        "managed-claim.register",
        ctx.user._id,
        `serial ${serial}`,
        institution._id,
      );
      results.push({ serial, ok: true, managedDeviceId });
    }
    return { results };
  },
});

/**
 * Mint (or re-mint) claims for a BATCH of devices. The bulk entry point behind
 * the console's "paste serials + assign scholars" flow: one round-trip provisions
 * a whole cart. INSTITUTION-SCOPED — requireScholarsAccessible fails loudly if
 * ANY assigned scholar is outside the caller's context, so staff@A can never
 * provision a device for a scholar@B.
 *
 * Upsert semantics keyed on the (globally-unique) serial:
 *   - New serial → create the roster row + mint a token.
 *   - Existing serial, same/different scholar → REASSIGN + rotate the token
 *     (a fresh token, old one invalidated). Reassigning to a new scholar also
 *     signs the previously-bound device out (clean handover).
 * The raw token is returned ONCE per device (to push into SimpleMDM) and only its
 * hash is persisted.
 */
export const mintManagedDeviceClaims = authedMutation({
  args: {
    devices: v.array(
      v.object({
        serial: v.string(),
        scholarId: v.id("users"),
        // Deprecated rollout compatibility for already-open clients. Ignored.
        label: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, args): Promise<{ results: MintResult[] }> => {
    if (args.devices.length === 0) return { results: [] };
    if (args.devices.length > 200) {
      throw new Error("Too many devices in one batch (max 200).");
    }

    const results: MintResult[] = [];
    const seen = new Set<string>();
    for (const raw of args.devices) {
      const serial = normalizeSerial(raw.serial);

      if (!isPlausibleSerial(serial)) {
        results.push({ serial, ok: false, error: "Not a valid serial number." });
        continue;
      }
      if (seen.has(serial)) {
        results.push({ serial, ok: false, error: "Duplicate serial in this batch." });
        continue;
      }
      seen.add(serial);

      const scholar = await ctx.db.get(raw.scholarId);
      if (!scholar || scholar.role !== ROLES.SCHOLAR) {
        results.push({ serial, ok: false, error: "Scholar not found." });
        continue;
      }
      if (!scholar.institutionId) {
        results.push({ serial, ok: false, error: "That scholar has no school on file." });
        continue;
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

      const result = await mintForSerial(ctx, {
        serial,
        scholar,
        actorId: ctx.user._id,
      });
      results.push(result);
    }
    return { results };
  },
});

/**
 * Assign a scholar and mint the first claim, or reassign an existing device and
 * rotate its claim. This routes through the same helper as batch minting and
 * rotation so every token follows one implementation.
 */
export const assignScholarToManagedDevice = authedMutation({
  args: {
    managedDeviceId: v.id("managedDeviceClaims"),
    scholarId: v.id("users"),
  },
  handler: async (ctx, args): Promise<MintResult> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);

    const scholar = await ctx.db.get(args.scholarId);
    if (
      !scholar ||
      scholar.role !== ROLES.SCHOLAR ||
      !scholar.institutionId
    ) {
      throw new Error("Scholar not found.");
    }
    if (scholar.institutionId !== row.institutionId) {
      throw new Error("That scholar is not in this device's school.");
    }
    // Deliberately NOT gated by requireScholarWithoutAnotherManagedDevice: a
    // staffer manually assigning from the device drawer may intentionally give
    // one scholar a second device. Bulk auto-assign still enforces one-to-one.

    const result = await mintForSerial(ctx, {
      serial: row.serial,
      scholar,
      actorId: ctx.user._id,
      auditAction: "managed-claim.assign",
    });
    if (!result.ok) throw new Error(result.error ?? "Couldn't assign that device.");
    return result;
  },
});

/**
 * Assign several scholars to pre-registered devices in one transaction. The
 * caller supplies the resolved order so the UI can pair table-ordered devices
 * with alphabetically ordered scholars. Every row is validated before the first
 * claim is minted, preventing a race or stale selection from partially assigning
 * the batch.
 */
export const autoAssignManagedDevices = authedMutation({
  args: {
    managedDeviceIds: v.array(v.id("managedDeviceClaims")),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args): Promise<{ results: MintResult[] }> => {
    if (args.scholarIds.length === 0) return { results: [] };
    if (args.scholarIds.length > args.managedDeviceIds.length) {
      throw new Error(
        `Only ${args.managedDeviceIds.length} unassigned ${
          args.managedDeviceIds.length === 1 ? "device is" : "devices are"
        } available.`,
      );
    }
    if (args.scholarIds.length !== args.managedDeviceIds.length) {
      throw new Error("Choose one available device for each selected scholar.");
    }
    if (args.scholarIds.length > 200) {
      throw new Error("Too many devices in one batch (max 200).");
    }

    const uniqueScholarIds = new Set(args.scholarIds.map(String));
    const uniqueDeviceIds = new Set(args.managedDeviceIds.map(String));
    if (uniqueScholarIds.size !== args.scholarIds.length) {
      throw new Error("Each scholar can only be selected once.");
    }
    if (uniqueDeviceIds.size !== args.managedDeviceIds.length) {
      throw new Error("Each device can only be assigned once.");
    }

    const pairs: Array<{
      device: Doc<"managedDeviceClaims">;
      scholar: Doc<"users">;
    }> = [];
    for (let index = 0; index < args.scholarIds.length; index += 1) {
      const device = await ctx.db.get(args.managedDeviceIds[index]);
      if (!device) throw new Error("One of those devices is no longer available.");
      await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, device);
      if (device.scholarId || device.claimState !== "unassigned") {
        throw new Error(`${device.serial} is already assigned.`);
      }
      if (device.autoAssignExcluded) {
        throw new Error(`${device.serial} is skipped from auto assignment.`);
      }

      const scholar = await ctx.db.get(args.scholarIds[index]);
      if (
        !scholar ||
        scholar.role !== ROLES.SCHOLAR ||
        !scholar.institutionId
      ) {
        throw new Error("One of those scholars is no longer available.");
      }
      if (scholar.institutionId !== device.institutionId) {
        throw new Error("A selected scholar is not in this device's school.");
      }

      await requireScholarWithoutAnotherManagedDevice(ctx, scholar);

      pairs.push({ device, scholar });
    }

    const results: MintResult[] = [];
    for (const { device, scholar } of pairs) {
      const result = await mintForSerial(ctx, {
        serial: device.serial,
        scholar,
        actorId: ctx.user._id,
        auditAction: "managed-claim.auto-assign",
      });
      if (!result.ok) {
        throw new Error(result.error ?? `Couldn't assign ${device.serial}.`);
      }
      results.push(result);
    }
    return { results };
  },
});

/** Keep an unassigned device on the roster while excluding it from bulk auto
 * assignment. Manual assignment remains available, and the hold is reversible. */
export const setManagedDeviceAutoAssignExcluded = authedMutation({
  args: {
    managedDeviceId: v.id("managedDeviceClaims"),
    excluded: v.boolean(),
  },
  handler: async (ctx, args): Promise<void> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);
    if (row.scholarId || row.claimState !== "unassigned") {
      throw new Error("Only unassigned devices can be skipped from auto assignment.");
    }
    if (!!row.autoAssignExcluded === args.excluded) return;

    // Do not touch updatedAt: table order is the deterministic auto-assignment
    // order, and temporarily skipping a row must not silently reorder it.
    await ctx.db.patch(row._id, {
      autoAssignExcluded: args.excluded ? true : undefined,
    });
    await auditManagedClaim(
      ctx,
      ctx.user._id,
      args.excluded
        ? "managed-claim.auto-assign-exclude"
        : "managed-claim.auto-assign-include",
      ctx.user._id,
      `serial ${row.serial}`,
      row.institutionId,
    );
  },
});

/** Shared upsert+mint for a single serial. Batch minting, assignment, rotation,
 *  and the SimpleMDM action all route through this one token path. */
export async function mintForSerial(
  ctx: MutationCtx,
  opts: {
    serial: string;
    scholar: Doc<"users">;
    actorId: Id<"users">;
    auditAction?: string;
  },
): Promise<MintResult> {
  const { serial, scholar, actorId } = opts;
  const now = Date.now();
  const claimToken = generateClaimToken();
  const claimTokenHash = await sha256Hex(claimToken);

  const existing = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_serial", (q) => q.eq("serial", serial))
    .unique();

  let reassignedFrom: string | null = null;

  if (existing) {
    // A serial already on the roster. Cross-institution guard: a physical
    // device belongs to ONE school — refuse to yank a serial registered to a
    // different institution into this one (a platform admin, whose context is
    // global, is allowed to move it). Without this, staff@A could re-home a
    // serial that reads as school B's on their own roster.
    if (existing.institutionId !== scholar.institutionId) {
      // The target institution is checked for both the new scholar and the
      // existing hardware row before any cross-school reassignment.
      try {
        const actor = await ctx.db.get(actorId);
        if (!actor) throw new Error("Actor not found.");
        await requireManagedDeviceInstitutionAccessible(ctx, actor, existing);
      } catch {
        return {
          serial,
          ok: false,
          error: "That serial is registered to another school.",
        };
      }
    }

    if (existing.scholarId !== scholar._id) {
      const prev = existing.scholarId
        ? await ctx.db.get(existing.scholarId)
        : null;
      reassignedFrom = prev?.name ?? prev?.username ?? null;
      // Sign the previously-bound physical device out (clean handover) — only
      // that device's own session, never the old scholar's other sessions.
      await signOutBoundDevice(ctx, existing);
    } else {
      // Same-scholar credential ROTATION — this is the "the token may have
      // leaked / re-provision this device" button. The physical pairing
      // survives (unlike a reassignment, nothing about the scholar/device
      // relationship changed), but any session that authenticated via the
      // OLD token must not remain live under the new one, so revoke them
      // without deleting the binding itself.
      await revokeBoundDeviceSessions(ctx, existing);
    }
    // Belt-and-suspenders (Finding 2): the above only finds a session via the
    // MUTABLE `pairedDevices` link, which a prior manual re-pair could have
    // already cleared/repointed away from this claim. Revoke by the
    // IMMUTABLE claim+generation identity too, so a session that survived
    // exactly that gap still closes here.
    await revokeManagedClaimSessions(ctx, existing._id, existing.claimGeneration ?? 0);
    // A rotation always bumps the generation below (see claimGeneration
    // patch) — even a same-scholar one, since the credential itself just
    // changed. Force-close whatever this claim is currently unlocked to
    // BEFORE the claim is repurposed, so neither a reassigned new owner nor
    // a rotated-but-same scholar can inherit a device still OS-level
    // unlocked under the stale generation. A no-op if nothing is unlocked.
    if (existing.scholarId) {
      await scheduleClaimDecommissionLock(ctx, existing._id);
    }

    await ctx.db.patch(existing._id, {
      institutionId: scholar.institutionId!,
      scholarId: scholar._id,
      // Retire the old Rabbithole-only device name whenever this row is touched.
      // SimpleMDM is the canonical device-name source.
      label: undefined,
      claimTokenHash,
      pendingClaimTokenHash: undefined,
      pendingClaimIssuedAt: undefined,
      pendingRotationCount: undefined,
      pendingSimplemdmPushedAt: undefined,
      claimState: "unclaimed",
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: existing.rotationCount + 1,
      firstClaimedAt: undefined,
      lastClaimedAt: undefined,
      claimCount: 0,
      lastDeviceId:
        existing.scholarId === scholar._id ? existing.lastDeviceId : undefined,
      autoAssignExcluded: undefined,
      revokedAt: undefined,
      revokedBy: undefined,
      simplemdmPushedAt: undefined,
      // Bumped on EVERY mint through this path — scholar reassignment AND a
      // same-scholar token rotation both change the claim's credential
      // identity, so the reconciler's atomic gate must treat any unlock
      // state stamped under the OLD generation as stale either way.
      claimGeneration: (existing.claimGeneration ?? 0) + 1,
    });
    await forgetClaimVerification(ctx, existing.institutionId, serial);

    await auditManagedClaim(
      ctx,
      actorId,
      opts.auditAction ?? "managed-claim.mint",
      scholar._id,
      `serial ${serial} (reassign/rotate)`,
      existing.institutionId,
    );
    return mintSuccess(existing._id, serial, scholar, claimToken, reassignedFrom);
  }

  const managedDeviceId = await ctx.db.insert("managedDeviceClaims", {
    institutionId: scholar.institutionId!,
    serial,
    scholarId: scholar._id,
    claimTokenHash,
    claimState: "unclaimed",
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
    claimIssuedAt: now,
    rotationCount: 0,
    claimCount: 0,
  });

  await auditManagedClaim(
    ctx,
    actorId,
    opts.auditAction ?? "managed-claim.mint",
    scholar._id,
    `serial ${serial} (new)`,
    scholar.institutionId ?? null,
  );
  return mintSuccess(managedDeviceId, serial, scholar, claimToken, null);
}

/**
 * Stage a replacement for remote MDM delivery without invalidating the token
 * the iPad may still hold. The replacement is promoted by consumeManagedClaim
 * only after the device presents it.
 */
export async function stageClaimReplacementForSimpleMdm(
  ctx: MutationCtx,
  row: Doc<"managedDeviceClaims">,
  actorId: Id<"users">,
): Promise<{
  claimToken: string;
  pendingClaimIssuedAt: number;
  pendingRotationCount: number;
}> {
  if (!row.scholarId || row.claimState === "revoked") {
    throw new Error("That device is not ready for SimpleMDM provisioning.");
  }

  const claimToken = generateClaimToken();
  const pendingClaimTokenHash = await sha256Hex(claimToken);
  const pendingClaimIssuedAt = Date.now();
  const pendingRotationCount = row.rotationCount + 1;
  await ctx.db.patch(row._id, {
    pendingClaimTokenHash,
    pendingClaimIssuedAt,
    pendingRotationCount,
    pendingSimplemdmPushedAt: undefined,
    updatedAt: pendingClaimIssuedAt,
  });
  await forgetClaimVerification(ctx, row.institutionId, row.serial);
  await auditManagedClaim(
    ctx,
    actorId,
    "managed-claim.simplemdm-mint",
    row.scholarId,
    `serial ${row.serial} (staged replacement)`,
    row.institutionId,
  );
  return {
    claimToken,
    pendingClaimIssuedAt,
    pendingRotationCount,
  };
}

function mintSuccess(
  managedDeviceId: Id<"managedDeviceClaims">,
  serial: string,
  scholar: Doc<"users">,
  claimToken: string,
  reassignedFrom: string | null,
): MintResult {
  return {
    serial,
    ok: true,
    managedDeviceId,
    scholarName: scholar.name ?? null,
    scholarUsername: scholar.username ?? null,
    claimToken,
    payload: buildAppConfigPayload(serial, claimToken),
    reassignedFrom,
  };
}

/**
 * Rotate the claim for one device: mint a fresh token, invalidate the prior
 * one (the old hash is overwritten, so a leaked/old token stops working), and
 * reset the consumption stamps. The durable roster row + its scholar assignment
 * are untouched — this is the "the token leaked / re-provision this device"
 * button. Returns the new raw token + payload ONCE. Institution-scoped.
 */
export const rotateManagedDeviceClaim = authedMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<MintResult> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);
    if (!row.scholarId) {
      throw new Error("Assign a scholar before minting a claim.");
    }

    const scholar = await ctx.db.get(row.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) {
      throw new Error("Scholar not found.");
    }

    const result = await mintForSerial(ctx, {
      serial: row.serial,
      scholar,
      actorId: ctx.user._id,
      auditAction: "managed-claim.rotate",
    });
    if (!result.ok) throw new Error(result.error ?? "Couldn't rotate that claim.");
    return result;
  },
});

/**
 * Return a device to the pre-assignment roster rung. Its claim is removed, and
 * only the currently bound physical device session is revoked.
 */
export const unassignManagedDevice = authedMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<{ sessionRevoked: boolean }> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);

    const priorScholarId = row.scholarId;
    // Schedule the device relock BEFORE the claim is unassigned, so the
    // durable scheduled-function record exists no matter what happens to the
    // claim row afterward (see scheduleClaimDecommissionLock's doc comment).
    // No-op if the device has no active/warm managed-native unlock.
    await scheduleClaimDecommissionLock(ctx, row._id);
    const sessionRevoked = await signOutBoundDevice(ctx, row);
    // Belt-and-suspenders (Finding 2): also revoke by IMMUTABLE claim+
    // generation, which finds a session even if `pairedDevices` was manually
    // re-paired/cleared/repointed away from this claim in the meantime.
    await revokeManagedClaimSessions(ctx, row._id, row.claimGeneration ?? 0);
    await ctx.db.patch(row._id, unassignedManagedClaimPatch(Date.now(), row.claimGeneration));
    await forgetClaimVerification(ctx, row.institutionId, row.serial);

    await auditManagedClaim(
      ctx,
      ctx.user._id,
      "managed-claim.unassign",
      priorScholarId ?? ctx.user._id,
      `serial ${row.serial}`,
      row.institutionId,
    );
    return { sessionRevoked };
  },
});

/**
 * Revoke a device's claim WITHOUT removing it from the roster: invalidate the
 * token (state → "revoked", hash overwritten with an unmatchable value so no
 * token can ever satisfy it again) AND sign the currently-bound device out.
 * The device stays visible (whose iPad it was) and can be re-issued a token by
 * rotating. This is the "lost / stolen / decommission-this-token" action.
 */
export const revokeManagedDeviceClaim = authedMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<{ sessionRevoked: boolean }> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);
    if (!row.scholarId || !row.claimTokenHash) {
      throw new Error("That device does not have an active claim.");
    }

    const sessionRevoked = await signOutBoundDevice(ctx, row);
    // The shared decommission sequence: schedule the relock BEFORE
    // invalidating the claim, revoke by immutable claim+generation, bump
    // the generation, and audit — see decommissionManagedClaim's doc comment.
    await decommissionManagedClaim(
      ctx,
      row,
      ctx.user._id,
      "managed-claim.revoke",
    );
    return { sessionRevoked };
  },
});

/**
 * Remove a device from the roster entirely (decommission / wrong serial): drop
 * the row and sign its bound device out. Distinct from revoke, which keeps the
 * row for re-issue. Institution-scoped.
 */
export const removeManagedDevice = authedMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<{ sessionRevoked: boolean }> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);

    const { sessionRevoked } = await removeManagedDeviceRow(ctx, row);

    await auditManagedClaim(
      ctx,
      ctx.user._id,
      "managed-claim.remove",
      row.scholarId ?? ctx.user._id,
      `serial ${row.serial}`,
      row.institutionId,
    );
    return { sessionRevoked };
  },
});

/**
 * Resolve WHO a delivered claim names, for a device that is already signed in.
 *
 * The iPad reads its claim from MDM app config, but the token is opaque: the
 * device cannot tell a same-scholar token ROTATION (harmless — just re-exchange)
 * from a REASSIGNMENT to a different scholar (a hand-over that must sign the
 * previous scholar out). Only the server knows. The native client asks this
 * before acting on a changed claim, and uses the answer twice: to render
 * "Switching to <name>…" instead of swapping identity silently, and to decide
 * whether a failed exchange should fail closed (sign out) or keep the session.
 *
 * Disclosure: an authenticated caller holding a valid claim token for a device
 * in their own institution learns the assigned scholar's display name. That
 * token is already the credential that BECOMES that scholar, so this reveals
 * nothing the holder could not obtain by redeeming it. Anything else — an
 * unknown token, a revoked/unassigned row, another institution's device —
 * returns "unknown" and no name.
 */
export const claimSubjectForDevice = query({
  args: { claimToken: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<{
    subject: "self" | "other" | "unknown";
    scholarName: string | null;
  }> => {
    const unknown = { subject: "unknown" as const, scholarName: null };
    // Not an authedQuery, on purpose: an iPad can still hold a sign-in for an
    // account that has since been DELETED (2026-10-06: demo accounts deleted
    // before their iPads re-claimed). requireUser throws for that caller, the
    // app reads the throw as "unknown", defers the hand-over forever, and its
    // other queries keep throwing until the app quits on every launch
    // (TRA-466). A claim can never name a deleted account, so for that caller
    // the honest answer is "other" — which makes the app clear the dead
    // session and exchange the claim.
    const userId = await getAuthUserId(ctx);
    if (userId === null) throw new Error("Not authenticated");
    const callerExists = (await ctx.db.get(userId)) !== null;
    const token = args.claimToken.trim();
    // Same shape guard the exchange uses: never let a garbage or "revoked:…"
    // sentinel reach an index lookup.
    if (!/^rhc_[0-9a-f]{64}$/.test(token)) return unknown;

    const claimTokenHash = await sha256Hex(token);
    const row =
      (await ctx.db
        .query("managedDeviceClaims")
        .withIndex("by_claim_hash", (q) => q.eq("claimTokenHash", claimTokenHash))
        .unique()) ??
      (await ctx.db
        .query("managedDeviceClaims")
        .withIndex("by_pending_claim_hash", (q) =>
          q.eq("pendingClaimTokenHash", claimTokenHash),
        )
        .unique());
    if (!row || !row.scholarId) return unknown;
    if (row.claimState === "unassigned" || row.claimState === "revoked") {
      return unknown;
    }
    // Deleted caller: no institution to scope a name to, so no name — only
    // the verdict the app needs to recover.
    if (!callerExists) return { subject: "other", scholarName: null };
    const user = await requireUser(ctx);
    // Institution scoping: the caller is the scholar currently signed in on the
    // iPad, so their own institution is the only one they may learn names from.
    if (!user.institutionId || row.institutionId !== user.institutionId) {
      return unknown;
    }
    if (row.scholarId === user._id) {
      return { subject: "self", scholarName: null };
    }
    const scholar = await ctx.db.get(row.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR) return unknown;
    return { subject: "other", scholarName: scholar.name ?? scholar.username ?? null };
  },
});

/**
 * Every schedule placement that opens one of these managed apps to a group
 * this week, in a term of this school, with the app's window on its day.
 * These are the placements the materializer turns into app pushes
 * (masterSchedule.reconcilePlacement and reconcileAppPlacement): placed on a
 * weekday and block (with or without a teacher, TRA-450), in a term that
 * covers `now`, either recurring or pinned to this week, and not on a day the
 * term's school is closed this week (`placementOnClosedDay`). The window is
 * the block opened APP_PLACEMENT_LEAD_MS before the bell and closed
 * APP_PLACEMENT_GRACE_MS after it.
 *
 * Only this school's terms: its own and, for the primary school, the legacy
 * unstamped ones (the rule the staff aide's `termBelongsTo` applies), read by
 * index, so another school's timetable is neither shown nor read. This query
 * re-runs every minute; a read of every school's placements of these apps
 * would re-run it whenever any school edited one. The rule leaves out one
 * window the materializer does open: a legacy unstamped group placed in
 * another school's term, whose push is stamped with the group's school. While
 * that push is live the console still reads it as the grant it is. Each
 * device then keeps its own scholar's groups.
 */
async function appPlacementWindowsThisWeek(
  ctx: QueryCtx,
  keyByAppId: ReadonlyMap<string, ManagedNativeAppKey>,
  institutionId: Id<"institutions">,
  now: number,
): Promise<AppPlacementWindow[]> {
  const legacyTerms =
    (await primaryInstitutionId(ctx)) === institutionId
      ? await ctx.db
          .query("reportingPeriods")
          .withIndex("by_institution", (q) => q.eq("institutionId", undefined))
          .collect()
      : [];
  const terms = [
    ...(await ctx.db
      .query("reportingPeriods")
      .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
      .collect()),
    ...legacyTerms,
    // The materializer skips a term that does not cover now.
  ].filter((term) => term.startsAt <= now && now <= term.endsAt);
  const windows: AppPlacementWindow[] = [];
  const blocks = new Map<string, Doc<"scheduleBlocks"> | null>();
  for (const term of terms) {
    // This week's Monday on the term's school calendar, with that school's
    // zone and no-school days.
    const timeZone = await timeZoneForInstitution(ctx, term.institutionId);
    const weekStart = scheduleWeekStartMs(now, timeZone);
    const closures = await loadInstitutionClosures(ctx, term.institutionId);
    const placements = await ctx.db
      .query("schedulePlacements")
      .withIndex("by_period", (q) => q.eq("periodId", term._id))
      .collect();
    for (const p of placements) {
      const key = p.externalAppId ? keyByAppId.get(String(p.externalAppId)) : undefined;
      if (!key || p.weekday == null || p.blockId == null) continue;
      if (p.weekStartMs != null && p.weekStartMs !== weekStart) continue;
      if (isClosedDay(dayKeyForWeekday(weekStart, p.weekday, timeZone), closures)) continue;
      let block = blocks.get(String(p.blockId));
      if (block === undefined) {
        block = await ctx.db.get(p.blockId);
        blocks.set(String(p.blockId), block);
      }
      if (!block) continue;
      const start = parseHHMM(block.startLocal);
      const end = parseHHMM(block.endLocal);
      // The materializer never opens a window it cannot resolve.
      if (start === null || end === null || end <= start) continue;
      windows.push({
        key,
        groupId: String(p.groupId),
        weekday: p.weekday,
        subject: p.subject,
        block: block.label,
        opensLocal: shiftLocalLabel(block.startLocal, -APP_PLACEMENT_LEAD_MS / 60_000),
        closesLocal: shiftLocalLabel(block.endLocal, APP_PLACEMENT_GRACE_MS / 60_000),
      });
    }
  }
  return windows;
}

/**
 * The managed-device roster read, factored out of `listManagedDevices` so the
 * agent transports (`lib/deviceOpsTools.ts`) answer from the SAME rows the
 * staff console renders rather than a second, drifting projection. Both
 * institution gates stay here: the caller's lens AND their school:operations
 * grants.
 */
export async function readManagedDevices(
  ctx: QueryCtx,
  user: Doc<"users">,
  opts: { institutionScope?: string } = {},
) {
  const lens = await resolveInstitutionLens(ctx, user, opts.institutionScope ?? "");
  const now = Date.now();

  const institutionIds =
    lens.scope === "all"
      ? [...lens.allowedInstitutionIds]
      : lens.institution
        ? [lens.institution._id]
        : [];
  const operationsInstitutions = await schoolOperationsInstitutionIds(
    ctx,
    user,
  );
  const authorizedInstitutionIds =
    operationsInstitutions === "all"
      ? institutionIds
      : institutionIds.filter((id) => operationsInstitutions.has(id));

  const rows: Doc<"managedDeviceClaims">[] = [];
  for (const instId of authorizedInstitutionIds) {
    const forInst = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_institution", (q) => q.eq("institutionId", instId))
      .collect();
    rows.push(...forInst);
  }

  const claimsById = new Map(rows.map((row) => [String(row._id), row]));
  const bindingsByClaimId = new Map<string, Doc<"pairedDevices">>();
  const legacyClaimByBinding = new Map(
    rows
      .filter(
        (row): row is Doc<"managedDeviceClaims"> & {
          scholarId: Id<"users">;
          lastDeviceId: string;
        } => !!row.scholarId && !!row.lastDeviceId,
      )
      .map((row) => [
        `${row.institutionId}:${row.scholarId}:${row.lastDeviceId}`,
        row,
      ]),
  );
  for (const instId of authorizedInstitutionIds) {
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_institution", (q) => q.eq("institutionId", instId))
      .collect();
    for (const binding of bindings) {
      if (binding.managedDeviceClaimId) {
        // A claim can only have its current install binding here. Keeping the
        // lastDeviceId check aligned with isStaleManagedBinding prevents an old
        // install from being presented as the live managed device.
        const claim = claimsById.get(String(binding.managedDeviceClaimId));
        if (claim?.lastDeviceId === binding.deviceId) {
          bindingsByClaimId.set(String(binding.managedDeviceClaimId), binding);
        }
        continue;
      }
      if (binding.lastRequestId) continue;
      const legacyClaim = legacyClaimByBinding.get(
        `${binding.institutionId}:${binding.scholarId}:${binding.deviceId}`,
      );
      if (legacyClaim && !bindingsByClaimId.has(String(legacyClaim._id))) {
        bindingsByClaimId.set(String(legacyClaim._id), binding);
      }
    }
  }

  // Catalog ids for the managed native apps, resolved ONCE for the whole
  // roster: the truth panel offers a one-click grant through the ordinary
  // `scholarApps` add paths, which need the catalog row, and the mapping is
  // fleet-wide rather than per device.
  const catalogAppIdByKey: Partial<Record<ManagedNativeAppKey, string>> = {};
  const keyByAppId = new Map<string, ManagedNativeAppKey>();
  for (const app of await ctx.db
    .query("externalApps")
    .withIndex("by_archived", (q) => q.eq("archived", undefined))
    .collect()) {
    const key = managedNativeAppKeyForApp(app);
    if (!key) continue;
    if (!catalogAppIdByKey[key]) catalogAppIdByKey[key] = String(app._id);
    keyByAppId.set(String(app._id), key);
  }
  // The blocks that open those apps this week, read once per school; each
  // device keeps its scholar's groups' (TRA-444). The school is the iPad's
  // (its claim's), one the caller was authorized for above, so a scholar
  // since moved to another school never brings that school's blocks with
  // them. The promise is what is cached, since the devices below resolve
  // concurrently.
  const placementWindowsBySchool = new Map<string, Promise<AppPlacementWindow[]>>();
  const placementWindowsFor = (institutionId: Id<"institutions">) => {
    let windows = placementWindowsBySchool.get(String(institutionId));
    if (!windows) {
      windows = appPlacementWindowsThisWeek(ctx, keyByAppId, institutionId, now);
      placementWindowsBySchool.set(String(institutionId), windows);
    }
    return windows;
  };
  const timeZoneByInstitution = new Map<string, string>();
  const institutionTimeZone = async (institutionId: Id<"institutions">) => {
    let timeZone = timeZoneByInstitution.get(String(institutionId));
    if (timeZone === undefined) {
      timeZone = await timeZoneForInstitution(ctx, institutionId);
      timeZoneByInstitution.set(String(institutionId), timeZone);
    }
    return timeZone;
  };

  const enriched = await Promise.all(
    rows.map(async (row) => {
      const scholar = row.scholarId ? await ctx.db.get(row.scholarId) : null;
      // Deleting a scholar leaves their claim here for staff to reassign
      // (lib/cascade.ts purges people, not a school's hardware), so the claim
      // still names an id that resolves to nothing. Keep the row (TRA-434):
      // this roster is the one place staff can reassign the iPad, and while
      // its app-access row keeps retrying a reset SimpleMDM refuses, the one
      // place that error can surface. It reads as unassigned, since nobody is
      // left to hold a grant, and `scholarDeleted` says why it still needs a
      // person.
      const scholarId = scholar?._id ?? null;
      const scholarDeleted = !!row.scholarId && !scholar;
      const createdByUser = row.createdBy ? await ctx.db.get(row.createdBy) : null;
      let hasLiveSession = false;
      const binding = bindingsByClaimId.get(String(row._id)) ?? null;
      if (binding?.authSessionId) {
        const session = await ctx.db.get(binding.authSessionId);
        hasLiveSession = !!session && session.expirationTime > now;
      }
      // The dated SimpleMDM read-back (simplemdm.ts writes it; the console
      // renders it as-is and never fetches SimpleMDM on its own).
      const snapshot = await snapshotForInstitutionSerial(
        ctx,
        row.institutionId,
        row.serial,
      );
      // Device truth panel (TRA-241 step 1) — the four-fact "App access"
      // row set. Reads only already-stored state, exactly like `snapshot`
      // above: bindings/states via their `by_managed_device` index, the
      // granted/pushed key sets via the same helpers the projector itself
      // uses, and the tiled set from the committed layout constant.
      const appUnlockBinding = await ctx.db
        .query("deviceAppUnlockBindings")
        .withIndex("by_managed_device", (q) =>
          q.eq("managedDeviceClaimId", row._id),
        )
        .unique();
      const unlockState = await ctx.db
        .query("deviceAppUnlockStates")
        .withIndex("by_managed_device", (q) =>
          q.eq("managedDeviceClaimId", row._id),
        )
        .unique();
      // An earlier, removed registration of this same iPad may still owe its
      // old dedicated profile a relock (`cleanupAfterLockIntent`). Its claim
      // row is gone, so the serial is the only handle staff have on it.
      let unfinishedTeardown: {
        simpleMdmProfileId: string;
        lastError: string | null;
        stopped: boolean;
      } | null = null;
      for (const earlier of await ctx.db
        .query("deviceAppUnlockBindings")
        .withIndex("by_serial", (q) => q.eq("serial", row.serial))
        .collect()) {
        if (
          earlier.managedDeviceClaimId === row._id ||
          earlier.institutionId !== row.institutionId
        ) {
          continue;
        }
        const earlierState = await ctx.db
          .query("deviceAppUnlockStates")
          .withIndex("by_managed_device", (q) =>
            q.eq("managedDeviceClaimId", earlier.managedDeviceClaimId),
          )
          .unique();
        if (!earlierState?.cleanupAfterLockIntent) continue;
        unfinishedTeardown = {
          simpleMdmProfileId: earlier.simpleMdmProfileId,
          lastError: earlierState.lastMdmError ?? null,
          stopped: isTeardownStopped(earlierState),
        };
      }
      const [grants, pushedKeys]: [
        Map<ManagedNativeAppKey, { endsAt: number | null }>,
        Set<ManagedNativeAppKey>,
      ] = scholarId
        ? await Promise.all([
            managedAppGrantsForScholar(ctx, scholarId),
            pushedManagedAppKeysForScholar(ctx, scholarId),
          ])
        : [new Map(), new Set()];
      // The school's calendar: the day a grant that ends runs through, and
      // today, which "Open all day today" and "Open until…" start from.
      const timeZone = await institutionTimeZone(row.institutionId);
      const grantThroughDayByKey: Partial<Record<ManagedNativeAppKey, string>> = {};
      for (const [key, { endsAt }] of grants) {
        // An end is always a local midnight, so the millisecond before it
        // falls on the last day the grant covers.
        if (endsAt !== null) grantThroughDayByKey[key] = dayKeyForTimezone(endsAt - 1, timeZone);
      }
      const scheduleByKey = scholar
        ? scheduleByKeyForGroups(
            await placementWindowsFor(row.institutionId),
            new Set((await groupIdsForScholar(ctx, scholar)).map(String)),
          )
        : {};
      const appAccess: AppAccessRow[] = buildAppAccessRows({
        hasScholar: scholarId !== null,
        grantedKeys: new Set(grants.keys()),
        grantThroughDayByKey,
        scheduleByKey,
        pushedKeys,
        hasBinding: !!appUnlockBinding,
        profilePayloadIdentifier:
          appUnlockBinding?.profilePayloadIdentifier ?? null,
        desiredBundleIds:
          unlockState?.desiredBundleIds ??
          appUnlockBinding?.baselineBundleIds ??
          null,
        appliedBundleIds: unlockState?.appliedBundleIds,
        projectionFormatVersion: unlockState?.projectionFormatVersion,
        installedBundleIds: snapshot?.installedBundleIds ?? null,
        installedAppsAt: snapshot?.installedAppsAt ?? null,
        catalogAppIdByKey,
      });
      return {
        _id: row._id,
        serial: row.serial,
        scholarId,
        scholarDeleted,
        scholarName: scholar?.name ?? null,
        scholarUsername: scholar?.username ?? null,
        scholarImage: scholar?.image ?? null,
        claimState: row.claimState,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        claimIssuedAt: row.claimIssuedAt,
        rotationCount: row.rotationCount,
        claimCount: row.claimCount,
        lastClaimedAt: row.lastClaimedAt ?? null,
        createdByName: createdByUser?.name ?? null,
        hasLiveSession,
        pairedDeviceId: binding?._id ?? null,
        pairedDeviceLabel: binding?.deviceLabel ?? null,
        autoAssignExcluded: row.autoAssignExcluded ?? false,
        simplemdmPushedAt: row.simplemdmPushedAt ?? null,
        hasPendingClaim: row.pendingClaimTokenHash !== undefined,
        pendingSimplemdmPushedAt: row.pendingSimplemdmPushedAt ?? null,
        simpleMdm: snapshot
          ? {
              // null = SimpleMDM has never been asked about this serial
              // (the row may hold only a push outcome).
              checkedAt: snapshot.inventoryAt ?? null,
              foundInSimpleMdm: snapshot.foundInSimpleMdm ?? null,
              name: snapshot.name ?? null,
              batteryLevel: snapshot.batteryLevel ?? null,
              lastSeenAt: snapshot.lastSeenAt ?? null,
              isSupervised: snapshot.isSupervised ?? null,
              lostModeEnabled: snapshot.lostModeEnabled ?? null,
              claimVerifyStatus: snapshot.claimVerifyStatus ?? null,
              claimVerifiedAt: snapshot.claimVerifiedAt ?? null,
              lastPushAt: snapshot.lastPushAt ?? null,
              lastPushStatus: snapshot.lastPushStatus ?? null,
              lastPushMessage: snapshot.lastPushMessage ?? null,
            }
          : null,
        appAccess,
        // Today on the school's calendar ("YYYY-MM-DD"), judged at the server
        // clock this read re-arms on. "Open until…" picks a day from it.
        todayDayKey: dayKeyForTimezone(now, timeZone),
        // Device-level projection clock for the App access panel's hovers.
        // Read straight off the state row the projector already keeps; no
        // history table exists, so `expectedAvailableAt` is the projector's
        // own estimate for the in-flight change, not a fleet average.
        // NOTE `mdmAcceptedAt`/`expectedAvailableAt` are UNLOCK-LEASE fields
        // the projection path never writes; do not read them as projection
        // progress.
        appAccessProjection: appUnlockBinding
          ? {
              appliedAt: unlockState?.projectionAppliedAt ?? null,
              verifiedAt: unlockState?.projectionVerifiedAt ?? null,
              dueAt: unlockState?.projectionDueAt ?? null,
              mdmAcceptedAt: unlockState?.mdmAcceptedAt ?? null,
              operationStartedAt: unlockState?.operationStartedAt ?? null,
              // Which kind of work holds the profile. An unlock ceremony and
              // the allowlist projector share `operationStartedAt`, so
              // without this the panel would describe a lock/unlock as an
              // allowlist push. Absent means no operation is in flight;
              // otherwise it is a ceremony (see `operationKind`).
              operationKind: unlockState?.operationStartedAt
                ? unlockState.tokenKind === "projection"
                  ? ("projection" as const)
                  : ("ceremony" as const)
                : null,
              expectedAvailableAt: unlockState?.expectedAvailableAt ?? null,
              lastError:
                unlockState?.projectionError ??
                unlockState?.lastMdmError ??
                null,
              updatedAt: unlockState?.updatedAt ?? null,
            }
          : null,
        unfinishedTeardown,
      };
    }),
  );

  return enriched.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * The managed-device roster for the console, scoped to the caller's institution
 * lens. Never returns the token or its hash — only the assignment + claim
 * state. `hasLiveSession` reflects the linked `pairedDevices` binding (via the
 * last device that exchanged), so the console can show which iPads are actually
 * signed in right now.
 */
export const listManagedDevices = authedQuery({
  args: {
    institutionScope: v.optional(v.string()),
    // Minute-rounded client clock, same cache-buster contract as
    // `pushes.livePushesForMe` and never a time authority. This read reports
    // which managed apps each device can currently reach, which consults push
    // liveness (`pushedManagedAppKeysForScholar`) — and that is day-scoped, so
    // it changes at the institution day boundary with no database write for a
    // subscription to notice. Without this the staff device table would keep
    // claiming an app is reachable after its push stopped showing.
    now: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    void args.now;
    return await readManagedDevices(ctx, ctx.user, {
      institutionScope: args.institutionScope,
    });
  },
});

/**
 * The agent-transport view of the same roster (Slack bot + MCP connector, via
 * `lib/deviceOpsTools.ts`). Scoped with `institutionScope: "all"`, which
 * resolves to the caller's OWN allowed institutions — not every school — and
 * is then intersected with their school:operations grants inside
 * `readManagedDevices`. A chat client has no URL to carry a lens, so asking
 * for one school would silently hide a second school's iPads from a staffer
 * who legitimately runs both.
 *
 * The payload is trimmed on purpose: the console's row carries projection
 * clocks, rotation counters and avatars that cost a model tokens and answer
 * no question it can act on. What survives is the four-fact app-access answer
 * (`appAccess[].blocker` is the first thing standing in the way) plus the
 * ids — `pairedDeviceId` above all — a follow-up write needs, plus what the
 * console tells staff about a stuck iPad: that its scholar was deleted
 * (`scholarDeleted`), and the last error updating its app access.
 *
 * NO `now` ARG, deliberately. `listManagedDevices` takes a minute-rounded
 * client clock because a SUBSCRIBED console must re-run when day-scoped push
 * liveness rolls over with no database write to notice. An agent turn is a
 * one-shot read from an action — nothing subscribes, and `readManagedDevices`
 * takes a fresh `Date.now()` on every call — so the staleness that arg exists
 * to defeat cannot occur here, and carrying it would be an inert parameter a
 * model has to guess a value for.
 */
export const listForAgent = internalQuery({
  args: {
    callerUserId: v.id("users"),
    search: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) {
      return { ok: false as const, message: "Forbidden: school staff role required" };
    }
    const operations = await schoolOperationsInstitutionIds(ctx, caller);
    if (operations !== "all" && operations.size === 0) {
      return {
        ok: false as const,
        message: "Forbidden: school operations access required",
      };
    }
    const rows = await readManagedDevices(ctx, caller, {
      institutionScope: "all",
    });
    const search = args.search?.trim().toLowerCase() ?? "";
    const devices = rows
      .filter((row) => {
        if (!search) return true;
        return [
          String(row._id),
          row.serial,
          row.scholarName,
          row.scholarUsername,
          row.pairedDeviceLabel,
        ].some((value) => value?.toLowerCase().includes(search));
      })
      .slice(0, 50)
      .map((row) => ({
        serial: row.serial,
        scholar: row.scholarName ?? row.scholarUsername ?? null,
        // The iPad of a scholar who has since been deleted (TRA-434): no
        // scholar, and staff need to reassign it, exactly as the console
        // shows it.
        scholarDeleted: row.scholarDeleted,
        claimState: row.claimState,
        hasLiveSession: row.hasLiveSession,
        // The handle every write tool takes. Null means this iPad has never
        // completed a sign-in binding, so Rabbithole Lock cannot address it.
        pairedDeviceId: row.pairedDeviceId,
        pairedDeviceLabel: row.pairedDeviceLabel,
        simpleMdm: row.simpleMdm,
        // Why an iPad's apps are stuck, when the last attempt to update its
        // app-access profile failed; null otherwise. It retries on its own.
        appAccessError: row.appAccessProjection?.lastError ?? null,
        appAccess: row.appAccess.map((app) => ({
          key: app.key,
          label: app.label,
          bundleId: app.bundleId,
          granted: app.granted,
          allowed: app.allowed,
          installed: app.installed,
          tiled: app.tiled,
          onDevice: app.onDevice,
          blocker: app.blocker,
        })),
      }));
    return { ok: true as const, devices };
  },
});

// ── Internal: the exchange (called by the `deviceClaim` auth provider) ──

/**
 * Consume a managed claim: the app presents its claimToken (from MDM config);
 * we resolve the assigned scholar, record the exchange, upsert the durable
 * `pairedDevices` binding (reusing pairing's roster + remote-sign-out plumbing),
 * audit it, and return the scholar's userId — which the auth provider turns
 * into a normal Convex Auth session.
 *
 * DURABLE by design (see the file header): the claim is NOT burned. A second
 * exchange (a reinstall, a wipe-and-re-enroll) succeeds again, which is what
 * keeps a managed iPad zero-touch for its whole life. State moves
 * unclaimed → claimed on first use; a revoked claim (or an unknown/garbage
 * token) returns null and mints nothing.
 *
 * Called ONLY by the `deviceClaim` provider's `authorize` in convex/auth.ts.
 */
export const consumeManagedClaim = internalMutation({
  args: {
    claimToken: v.string(),
    deviceId: v.optional(v.string()),
    deviceLabel: v.optional(v.string()),
    serial: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ userId: Id<"users">; sessionId: Id<"authSessions"> } | null> => {
    const token = args.claimToken.trim();
    // Shape guard: our tokens are `rhc_` + 64 hex. Reject anything else fast
    // (and never let a "revoked:…" sentinel be presentable).
    if (!/^rhc_[0-9a-f]{64}$/.test(token)) return null;

    const claimTokenHash = await sha256Hex(token);
    let row = await ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_claim_hash", (q) => q.eq("claimTokenHash", claimTokenHash))
      .unique();
    let isPendingReplacement = false;
    if (!row) {
      row = await ctx.db
        .query("managedDeviceClaims")
        .withIndex("by_pending_claim_hash", (q) =>
          q.eq("pendingClaimTokenHash", claimTokenHash),
        )
        .unique();
      isPendingReplacement = row !== null;
    }
    if (!row) return null;
    if (
      row.claimState === "unassigned" ||
      row.claimState === "revoked" ||
      !row.scholarId ||
      !row.claimTokenHash
    ) {
      return null;
    }
    // Optional integrity cross-check: if the app forwarded the config serial,
    // it must match the claim's serial (defense in depth; the token is the
    // real credential).
    if (args.serial && normalizeSerial(args.serial) !== row.serial) return null;

    const scholar = await ctx.db.get(row.scholarId);
    if (!scholar || scholar.role !== ROLES.SCHOLAR || !scholar.institutionId) {
      return null;
    }
    if (scholar.institutionId !== row.institutionId) return null; // stale assignment

    const now = Date.now();
    const presentedDeviceId = args.deviceId?.trim();
    const deviceId =
      presentedDeviceId &&
      presentedDeviceId.length >= 6 &&
      presentedDeviceId.length <= 200
        ? presentedDeviceId
        : undefined;
    // Fail closed (Finding 1): a managed claim session must never exist
    // without an atomic device binding. Reject the WHOLE exchange before any
    // claim/session mutation rather than silently skipping the binding block
    // below — an app that somehow presented no/malformed deviceId must not
    // walk away with a working session it can use from anywhere.
    if (!deviceId) return null;
    const deviceLabel = args.deviceLabel?.trim().slice(0, 120) || undefined;

    // A rebind under the SAME token to a DIFFERENT physical device, or a
    // remotely-issued replacement token being promoted, both change which
    // physical device/credential this claim's identity refers to — treat
    // both as a claim-generation change (Finding 3), exactly like
    // `mintForSerial`'s reassignment/rotation path: revoke the OLD
    // generation's session(s) and nudge its unlock closed BEFORE the new
    // generation's session is minted, so a still-unlocked old device can
    // never inherit the new generation's authority, and a stale unlock under
    // the old generation is force-closed rather than left to expire on its
    // own lease.
    const isDeviceRebind =
      !isPendingReplacement &&
      row.lastDeviceId !== undefined &&
      row.lastDeviceId !== deviceId;
    const isGenerationChange = isPendingReplacement || isDeviceRebind;
    const oldGeneration = row.claimGeneration ?? 0;
    const newGeneration = isGenerationChange ? oldGeneration + 1 : oldGeneration;

    await removeStaleBindingsForExchange(ctx, row, deviceId);
    // Bound to exactly one active session per claim+generation (Finding 2):
    // revoke whatever session is currently associated with the generation
    // about to be superseded/reused, by IMMUTABLE claim+generation — this
    // finds it even if `pairedDevices` was manually re-paired, cleared, or
    // repointed away from this claim in the meantime.
    await revokeManagedClaimSessions(ctx, row._id, oldGeneration);
    if (isGenerationChange) {
      // Force-close whatever this claim is currently unlocked to under the
      // OLD generation before the row is repurposed for the new one. A
      // no-op if nothing is unlocked; latency-only otherwise — the
      // reconciler's freshOwner/generation check independently guarantees
      // correctness within one tick regardless of this nudge.
      await scheduleClaimDecommissionLock(ctx, row._id);
    }

    // A remotely delivered replacement becomes current only after the iPad
    // proves it received the token. Until this exchange, the previous token
    // remains valid so an interrupted MDM push cannot strand a signed-out app.
    if (isPendingReplacement) {
      if (
        !row.pendingClaimTokenHash ||
        row.pendingClaimIssuedAt === undefined ||
        row.pendingRotationCount === undefined
      ) {
        return null;
      }
      await ctx.db.patch(row._id, {
        claimTokenHash: row.pendingClaimTokenHash,
        pendingClaimTokenHash: undefined,
        pendingClaimIssuedAt: undefined,
        pendingRotationCount: undefined,
        // The iPad can exchange the replacement BEFORE recordSimpleMdmPush
        // lands (it polls managed config every few seconds), so the pending
        // stamp may still be unset here. Never degrade a real prior push
        // timestamp to undefined — that would strand the row as "Pending
        // setup" forever. recordSimpleMdmPush recognizes this promoted-while-
        // pushing case and stamps the current claim itself.
        simplemdmPushedAt: row.pendingSimplemdmPushedAt ?? row.simplemdmPushedAt,
        pendingSimplemdmPushedAt: undefined,
        claimState: "claimed",
        claimIssuedAt: row.pendingClaimIssuedAt,
        rotationCount: row.pendingRotationCount,
        firstClaimedAt: now,
        lastClaimedAt: now,
        claimCount: 1,
        lastDeviceId: deviceId,
        claimGeneration: newGeneration,
        updatedAt: now,
      });
    } else {
      // Record an ordinary durable exchange (the current token is not burned).
      await ctx.db.patch(row._id, {
        claimState: "claimed",
        firstClaimedAt: row.firstClaimedAt ?? now,
        lastClaimedAt: now,
        claimCount: row.claimCount + 1,
        lastDeviceId: deviceId,
        claimGeneration: newGeneration,
        updatedAt: now,
      });
    }

    // Upsert the durable `pairedDevices` binding so the existing "Paired
    // devices" roster and session attachment cover managed devices too —
    // reuse, not a parallel roster. Keyed on
    // (institutionId, deviceId); deviceId is now guaranteed present (fail-
    // closed above).
    const sessionId = await mintAuthSessionForUser(ctx, row.scholarId);
    {
      const existing = await ctx.db
        .query("pairedDevices")
        .withIndex("by_device", (q) =>
          q.eq("institutionId", row.institutionId).eq("deviceId", deviceId),
        )
        .unique();
      let pairedDeviceId: Id<"pairedDevices">;
      if (existing) {
        const scholarChanged = existing.scholarId !== row.scholarId;
        const previousManagedClaimId = existing.managedDeviceClaimId;
        // Round 5, Finding 3: revoke unconditionally, not merely when the
        // scholar changed. This physical device's existing binding may have
        // been a manual pairing (no managedDeviceClaimId) or bound to a
        // DIFFERENT claim entirely — `revokeManagedClaimSessions` above only
        // finds sessions tagged with THIS claim's identity, so it would
        // miss a stale session left over from either of those cases. This
        // is what keeps "exactly one live pairedDeviceAuthSessions row per
        // pairedDeviceId" true across a manual-pair -> managed-claim
        // transition, not merely across a plain scholar reassignment.
        await revokeAllDeviceAuthSessions(ctx, existing._id);
        if (previousManagedClaimId && previousManagedClaimId !== row._id) {
          // Round 6, Finding 2: this device is being taken over from a
          // DIFFERENT prior claim right now — nudge that claim's unlock
          // reconciler so the correction is fast, matching the equivalent
          // manual re-pair path in consumePairingExchange. Latency-only:
          // prepareReconcileLock's freshOwner check (no live pairedDevices
          // row for the old claim+device once this binding is repointed)
          // already guarantees the device force-locks within one
          // reconciler tick regardless of whether this nudge lands —
          // without it, the new owner could otherwise inherit the prior
          // claim's widened profile for up to the cron interval.
          await scheduleClaimDecommissionLock(ctx, previousManagedClaimId);
        }
        await ctx.db.patch(existing._id, {
          scholarId: row.scholarId,
          deviceLabel,
          pairedAt: now,
          pairedBy: row.createdBy,
          managedDeviceClaimId: row._id,
          authSessionId: sessionId,
          // Durable claims exchange again on reinstall. Preserve an intentional
          // disarm for the same scholar; only a real handover resets to armed.
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
          institutionId: row.institutionId,
          deviceId,
          scholarId: row.scholarId,
          deviceLabel,
          pairedAt: now,
          pairedBy: row.createdBy,
          managedDeviceClaimId: row._id,
          authSessionId: sessionId,
        });
      }
      // Atomic association — see mintAuthSessionForUser's doc comment: this
      // insert happens in the SAME transaction as the session mint + binding
      // upsert above, so the session can never exist without being
      // enumerable for a later decommission/revocation to find. Stamped with
      // the IMMUTABLE claim+generation identity (Finding 2) so a later
      // rotation/decommission can find and close it even if `pairedDevices`
      // is subsequently manually re-paired, cleared, or repointed away.
      await ctx.db.insert("pairedDeviceAuthSessions", {
        pairedDeviceId,
        authSessionId: sessionId,
        scholarId: row.scholarId,
        attachedAt: now,
        managedDeviceClaimId: row._id,
        claimGeneration: newGeneration,
      });
    }

    // The exchange just wrote the `pairedDevices` row the allowlist
    // projection's owner derivation reads, so THIS is the moment a bound iPad
    // stops being ownerless and starts being this scholar's. Before it, the
    // projection could only resolve bare baseline; after it, the scholar's
    // granted apps belong on the device. Nothing else on this path nudges it:
    // a FIRST exchange changes no grant and, on the ordinary durable path,
    // need not change the claim generation either, so without this the device
    // waits out a cron interval before its very first real projection.
    await scheduleDeviceOwnershipRefresh(ctx, row._id);

    await auditManagedClaim(
      ctx,
      row.scholarId,
      "managed-claim.exchange",
      row.scholarId,
      `serial ${row.serial} device ${deviceId}`,
      row.institutionId,
    );

    return { userId: row.scholarId, sessionId };
  },
});

/** One-time cleanup for legacy duplicate bindings already at rest. Safe for the
 * small paired-device roster: manual pairings carry lastRequestId and survive. */
export const sweepStaleManagedDeviceBindings = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ removed: number; sessionsRevoked: number }> => {
    const [bindings, managedClaims] = await Promise.all([
      ctx.db.query("pairedDevices").collect(),
      ctx.db.query("managedDeviceClaims").collect(),
    ]);
    const claimsById = new Map(
      managedClaims.map((claim) => [String(claim._id), claim]),
    );
    const activeDeviceIdsByScholar = new Map<string, Set<string>>();
    for (const claim of managedClaims) {
      if (!claim.scholarId || !claim.lastDeviceId) continue;
      const scholarId = String(claim.scholarId);
      const activeIds = activeDeviceIdsByScholar.get(scholarId) ?? new Set<string>();
      activeIds.add(claim.lastDeviceId);
      activeDeviceIdsByScholar.set(scholarId, activeIds);
    }

    let removed = 0;
    let sessionsRevoked = 0;
    for (const binding of bindings) {
      if (
        !isStaleManagedBinding(
          binding,
          claimsById,
          activeDeviceIdsByScholar,
        )
      ) {
        continue;
      }
      if (await revokeAllDeviceAuthSessions(ctx, binding._id)) {
        sessionsRevoked += 1;
      }
      await ctx.db.delete(binding._id);
      await deleteDeviceAuthSessionLog(ctx, binding._id);
      removed += 1;
    }
    return { removed, sessionsRevoked };
  },
});

// ── helpers ───────────────────────────────────────────────────────────

async function requireScholarWithoutAnotherManagedDevice(
  ctx: MutationCtx,
  scholar: Doc<"users">,
  excludedDeviceId?: Id<"managedDeviceClaims">,
): Promise<void> {
  const assignedDevices = await ctx.db
    .query("managedDeviceClaims")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholar._id))
    .collect();
  if (assignedDevices.some((device) => device._id !== excludedDeviceId)) {
    throw new Error(
      `${scholar.name ?? scholar.username ?? "That scholar"} already has a device.`,
    );
  }
}

async function removeStaleBindingsForExchange(
  ctx: MutationCtx,
  row: Doc<"managedDeviceClaims">,
  currentDeviceId: string,
): Promise<void> {
  if (!row.scholarId) return;

  const [scholarClaims, scholarBindings] = await Promise.all([
    ctx.db
      .query("managedDeviceClaims")
      .withIndex("by_scholar", (q) => q.eq("scholarId", row.scholarId))
      .collect(),
    ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", row.scholarId!))
      .collect(),
  ]);
  const otherActiveDeviceIds = new Set(
    scholarClaims
      .filter((claim) => claim._id !== row._id)
      .map((claim) => claim.lastDeviceId)
      .filter((deviceId): deviceId is string => !!deviceId),
  );

  for (const binding of scholarBindings) {
    if (
      binding.institutionId !== row.institutionId ||
      binding.deviceId === currentDeviceId
    ) {
      continue;
    }
    const belongsToThisClaim = binding.managedDeviceClaimId === row._id;
    const isLegacyManagedBinding =
      !binding.managedDeviceClaimId &&
      !binding.lastRequestId &&
      !otherActiveDeviceIds.has(binding.deviceId);
    if (!belongsToThisClaim && !isLegacyManagedBinding) continue;

    await revokeAllDeviceAuthSessions(ctx, binding._id);
    await ctx.db.delete(binding._id);
    await deleteDeviceAuthSessionLog(ctx, binding._id);
  }
}

/**
 * The roster-removal sequence behind `removeManagedDevice`, without its
 * authorization or audit: sign the bound iPad out and drop its binding,
 * schedule the relock, revoke by immutable claim+generation, settle the
 * dedicated-profile unlock rows, then delete the claim. Also run for every
 * claim when an institution is deleted (`lib/cascade.ts`), so a field iPad
 * loses its session and falls back to manual pairing exactly as it does when
 * staff remove it. Returns whether a live session was killed.
 */
export async function removeManagedDeviceRow(
  ctx: MutationCtx,
  row: Doc<"managedDeviceClaims">,
): Promise<{ sessionRevoked: boolean }> {
  const sessionRevoked = await signOutBoundDevice(ctx, row);
  // Schedule the device relock BEFORE deleting the claim row (see
  // scheduleClaimDecommissionLock's doc comment). deviceAppUnlockStates/
  // deviceAppUnlockBindings are separate tables keyed by managedDeviceClaimId
  // and are looked up by that id regardless of whether the claim doc itself
  // still exists, so ordering here is about documenting fail-closed intent
  // (never depend on a post-delete read succeeding), not working around a
  // real lookup failure.
  await scheduleClaimDecommissionLock(ctx, row._id);
  // Belt-and-suspenders (Finding 2): also revoke by IMMUTABLE claim+
  // generation, which finds a session even if `pairedDevices` was manually
  // re-paired/cleared/repointed away from this claim in the meantime —
  // must happen BEFORE the row itself is deleted below.
  await revokeManagedClaimSessions(ctx, row._id, row.claimGeneration ?? 0);

  // Finding 3 (final gate): deleting the claim row must never orphan its
  // dedicated-profile binding/unlock-state rows — they are looked up by
  // managedDeviceClaimId regardless of whether the claim doc still exists,
  // so `deviceAppUnlockBindings.by_profile`'s pointer to this (about to be
  // deleted) claim id would otherwise block a fresh re-registration of the
  // same serial/profile forever, and deleting them unconditionally here
  // could strand an in-flight relock PATCH with nothing left to record
  // success/failure against. So stamp durable cleanup-after-lock intent and
  // let `recordMdmPatch`'s accepted=true branch finish the deletion once the
  // baseline PATCH the reconciler just scheduled is durably accepted.
  // Stamping intent leaves the revision and token alone, so a relock already
  // in flight still records against this row. Its target was projected for
  // the scholar being removed and can carry their apps, which is why that
  // branch deletes only on a PATCH of the bare baseline (TRA-436).
  //
  // A BOUND device takes that path even when its state row is settled
  // (TRA-427). "Settled" meant "the profile holds the bare baseline" under
  // the lease model; under the grant projection a settled row's profile
  // holds baseline ∪ the scholar's granted and pushed apps, and deleting the
  // binding here would leave them on the iPad with nothing left to narrow
  // them. `normalizeCleanupIntent` moves the row onto the pending-lock path,
  // which relocks to baseline (the claim is gone). Without a state row,
  // nothing has written the profile since `configureDedicatedProfile`
  // verified it at baseline, so the binding can go now.
  const activeState = await ctx.db
    .query("deviceAppUnlockStates")
    .withIndex("by_managed_device", (q) =>
      q.eq("managedDeviceClaimId", row._id),
    )
    .unique();
  const binding = await ctx.db
    .query("deviceAppUnlockBindings")
    .withIndex("by_managed_device", (q) =>
      q.eq("managedDeviceClaimId", row._id),
    )
    .unique();
  if (activeState && (binding || !isUnlockStateSettled(activeState))) {
    await ctx.db.patch(activeState._id, { cleanupAfterLockIntent: true });
  } else {
    if (activeState) await ctx.db.delete(activeState._id);
    if (binding) await ctx.db.delete(binding._id);
  }

  await ctx.db.delete(row._id);
  return { sessionRevoked };
}

/** Sign out and remove the physical-device binding owned by a managed claim,
 * without touching the scholar's other sessions. The serial-keyed managed row
 * remains the canonical roster entry. Returns whether a live session was killed. */
async function signOutBoundDevice(
  ctx: MutationCtx,
  row: Doc<"managedDeviceClaims">,
): Promise<boolean> {
  if (!row.lastDeviceId) return false;
  const binding = await ctx.db
    .query("pairedDevices")
    .withIndex("by_device", (q) =>
      q.eq("institutionId", row.institutionId).eq("deviceId", row.lastDeviceId!),
    )
    .unique();
  if (!binding) return false;
  const belongsToThisClaim = binding.managedDeviceClaimId
    ? binding.managedDeviceClaimId === row._id
    : !binding.lastRequestId;
  if (!belongsToThisClaim) return false;

  // Enumerate + revoke EVERY session this binding has ever attached, not just
  // the current denormalized pointer — see revokeAllDeviceAuthSessions.
  const revoked = await revokeAllDeviceAuthSessions(ctx, binding._id);
  await ctx.db.delete(binding._id);
  await deleteDeviceAuthSessionLog(ctx, binding._id);
  return revoked;
}

/** Revoke every session this claim's currently-bound physical device has ever
 * attached, WITHOUT deleting the pairedDevices binding row itself. Used for a
 * same-scholar credential rotation: the device/scholar pairing is unchanged,
 * but a rotated (possibly leaked) token must not leave a session that
 * authenticated under the old one still live. Returns whether a live session
 * was killed. */
async function revokeBoundDeviceSessions(
  ctx: MutationCtx,
  row: Doc<"managedDeviceClaims">,
): Promise<boolean> {
  if (!row.lastDeviceId) return false;
  const binding = await ctx.db
    .query("pairedDevices")
    .withIndex("by_device", (q) =>
      q.eq("institutionId", row.institutionId).eq("deviceId", row.lastDeviceId!),
    )
    .unique();
  if (!binding) return false;
  const belongsToThisClaim = binding.managedDeviceClaimId
    ? binding.managedDeviceClaimId === row._id
    : !binding.lastRequestId;
  if (!belongsToThisClaim) return false;
  return await revokeAllDeviceAuthSessions(ctx, binding._id);
}

// Re-exported so existing importers (e.g. simplemdm.ts) are unaffected — the
// implementation now lives in the neutral lib module so devicePairing.ts can
// also share it (see the doc comment on the canonical definition).
export { auditManagedClaim };

/**
 * Staff "Re-sync" for one iPad's app-access projection: pulls the projector's
 * next tick forward to now for this device and kicks the reconciler. The
 * scholar-side twin is `deviceAppUnlock.nudgeProjection` (keyed by the
 * iPad's own pairing); this one is keyed by the roster row and gated by the
 * same institution check as every other drawer action. It does not touch
 * SimpleMDM directly and does not re-inventory apps — that is "Check now".
 */
export const resyncManagedDeviceProjection = authedMutation({
  args: { managedDeviceId: v.id("managedDeviceClaims") },
  handler: async (ctx, args): Promise<{ nudged: boolean }> => {
    const row = await ctx.db.get(args.managedDeviceId);
    if (!row) throw new Error("That device is no longer on the roster.");
    await requireManagedDeviceInstitutionAccessible(ctx, ctx.user, row);
    const binding = await ctx.db
      .query("deviceAppUnlockBindings")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", row._id),
      )
      .unique();
    if (!binding) return { nudged: false };
    const state = await ctx.db
      .query("deviceAppUnlockStates")
      .withIndex("by_managed_device", (q) =>
        q.eq("managedDeviceClaimId", row._id),
      )
      .unique();
    if (state) await ctx.db.patch(state._id, { projectionDueAt: 0 });
    await ctx.scheduler.runAfter(0, internal.deviceAppUnlock.reconcileActiveUnlocks, {});
    return { nudged: true };
  },
});

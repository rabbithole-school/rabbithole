import { ConvexError, v } from "convex/values";
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server";
import {
  authedMutation,
  authedQuery,
  scholarAdminMutation,
} from "./lib/customFunctions";
import { randomToken, sha256Hex } from "./lib/oauthCrypto";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { getAuthSessionId } from "@convex-dev/auth/server";
import { reconcilePortfolioMaterialization } from "./portfolioMaterialize";
import { captureRosterName } from "./lib/schoolMediaConsent";
import {
  EXTENDED_EDUCATION_LABEL,
  includesProgramGuests,
} from "../shared/scholarGroupRouting";
import {
  requireProgramCaptureCleanupAccess,
  requireProgramCaptureReviewAccess,
  reviewableProgramGroups,
} from "./lib/programGroupAccess";
import { hasSchoolOperationsAccessAtInstitution } from "./lib/staffCapabilities";
import { effectiveInstitutionTimeZone } from "./lib/institutionTime";
import {
  dayKeyForTimezone,
  instantForLocalMinutes,
} from "../shared/institutionDay";
import {
  LABEL_MAX_LENGTH,
  labelGraphemeCount,
} from "../shared/portfolioLabel";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const UNDO_WINDOW_MS = 10 * 60 * 1000;
const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
const POSTER_MAX_BYTES = 2 * 1024 * 1024;
const MAX_UPLOAD_URLS_PER_SESSION = 60;
const MAX_CAPTURES_PER_SESSION = 40;
const MAX_REGISTERED_BYTES_PER_SESSION = 1024 * 1024 * 1024;
const UPLOAD_RESERVATION_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIVE_SESSIONS_PER_STATION = 2;
const MAX_SESSIONS_PER_ENROLLMENT_WINDOW = 3;
// Pressure caps apply per scope — the permanent station's own sessions are one
// scope, and each assigned device's temporary sessions are another — so a
// station's worst-case reservation rows scale with the number of assigned
// devices that have used capture mode, not a station-wide constant.
// Sized as "one stuck capture + one new capture": a video with a poster holds
// TWO open reservations from mint to register, so the margin is 2×2 (the
// pre-poster cap of 2 encoded the same invariant at one reservation per
// capture).
const MAX_OPEN_UPLOAD_RESERVATIONS_PER_PRESSURE_SCOPE = 4;
const MAX_ABANDONED_UPLOAD_RESERVATIONS_PER_PRESSURE_SCOPE = 3;
const ASSIGNED_DEVICE_CAPTURE_CUTOFF_HOUR = 16;
const ASSIGNED_DEVICE_CAPTURE_CUTOFF_MINUTE = 40;
const MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
  "video/mp4",
  "video/quicktime",
]);

type Capability = {
  station: Doc<"captureStations">;
  session: Doc<"captureStationSessions">;
};

type CapabilityCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;
type ReservationCleanupCtx = Pick<MutationCtx, "db" | "storage">;
type DeviceControlCtx = QueryCtx | MutationCtx;

function token(prefix: string) {
  return `${prefix}${randomToken(32)}`;
}

async function expireUploadReservation(
  ctx: ReservationCleanupCtx,
  reservation: Doc<"captureStationUploadReservations">,
  now: number,
) {
  if (reservation.status === "finalized") {
    await ctx.db.delete(reservation._id);
    return "deleted" as const;
  }
  if (reservation.status === "abandoned") return "abandoned" as const;
  if (reservation.expiresAt > now) return "active" as const;

  if (!reservation.storageId) {
    // Convex direct-upload URLs only reveal a storage id to the client after
    // upload. This durable tombstone is therefore the only safe accounting for
    // a blob a disconnected/malicious client never reports. Issuance is capped
    // against these rows before another URL can be minted.
    await ctx.db.patch(reservation._id, {
      status: "abandoned",
      updatedAt: now,
    });
    return "abandoned" as const;
  }

  const capture = await ctx.db
    .query("captureStationCaptures")
    .withIndex("by_storage", (q) => q.eq("storageId", reservation.storageId!))
    .first();
  if (!capture) await ctx.storage.delete(reservation.storageId);
  await ctx.db.delete(reservation._id);
  return "deleted" as const;
}

async function reservationPressure(
  ctx: ReservationCleanupCtx,
  session: Doc<"captureStationSessions">,
  now: number,
) {
  let open = 0;
  let abandoned = 0;
  const reservations = await ctx.db
    .query("captureStationUploadReservations")
    .withIndex("by_station", (q) =>
      q.eq("captureStationId", session.captureStationId),
    )
    .collect();
  for (const reservation of reservations) {
    const state = await expireUploadReservation(ctx, reservation, now);
    const owner = await ctx.db.get(reservation.sessionId);
    if (!owner) continue;
    const samePressureScope = session.pairedDeviceId
      ? owner.pairedDeviceId === session.pairedDeviceId
      : !owner.pairedDeviceId;
    if (!samePressureScope) continue;
    if (state === "active") open++;
    if (state === "abandoned") abandoned++;
  }
  return { open, abandoned };
}

async function capability(
  ctx: CapabilityCtx,
  sessionToken: string,
  deviceId: string,
  allowRecovery = false,
): Promise<Capability> {
  const now = Date.now();
  const device = deviceId.trim();
  if (device.length < 6 || device.length > 200) throw new Error("Invalid device.");
  const hash = await sha256Hex(sessionToken.trim());
  const session = await ctx.db
    .query("captureStationSessions")
    .withIndex("by_session_token_hash", (q) =>
      q.eq("sessionTokenHash", hash),
    )
    .unique();
  if (
    !session ||
    session.deviceId !== device ||
    session.revokedAt ||
    session.expiresAt <= now
  ) {
    throw new Error("Capture session expired.");
  }
  const station = await ctx.db.get(session.captureStationId);
  if (!station || !station.enabled || station.revokedAt) {
    throw new Error("Capture station is unavailable.");
  }
  if (session.pairedDeviceId) {
    const binding = await ctx.db.get(session.pairedDeviceId);
    const mode = binding && activeAssignedDeviceCapture(binding, now);
    if (
      !binding ||
      binding.deviceId !== device ||
      !mode ||
      mode.captureStationId !== station._id ||
      mode.updatedAt !== session.assignedDeviceCaptureUpdatedAt
    ) {
      throw new Error("Assigned capture mode has ended.");
    }
    await requireCurrentManagedBinding(ctx, binding);
  }
  if (session.recoveryOnly && !allowRecovery) {
    throw new Error("Capture session is recovering an upload.");
  }
  const [institution, group] = await Promise.all([
    ctx.db.get(station.institutionId),
    ctx.db.get(station.scholarGroupId),
  ]);
  if (
    !institution ||
    institution.disabledAt ||
    !group ||
    group.institutionId !== station.institutionId ||
    !includesProgramGuests(group)
  ) {
    throw new Error("Capture station is unavailable.");
  }
  return { station, session };
}

/**
 * A freshly enrolled session on the same physical device may finish an upload
 * reserved by its predecessor. The reservation remains bound to its issuing
 * session for quota/accounting purposes; this merely lets token rotation avoid
 * stranding an already-uploaded blob.
 */
async function reservationOwningSession(
  ctx: CapabilityCtx,
  reservation: Doc<"captureStationUploadReservations">,
  station: Doc<"captureStations">,
  session: Doc<"captureStationSessions">,
) {
  if (reservation.captureStationId !== station._id) return null;
  const owner = await ctx.db.get(reservation.sessionId);
  if (
    !owner ||
    owner.captureStationId !== station._id ||
    owner.deviceId !== session.deviceId
  ) {
    return null;
  }
  return owner;
}

async function groupRoster(
  ctx: CapabilityCtx,
  station: Doc<"captureStations">,
) {
  const group = await ctx.db.get(station.scholarGroupId);
  if (
    !group ||
    group.institutionId !== station.institutionId ||
    !includesProgramGuests(group)
  ) {
    throw new Error("Capture station group is unavailable.");
  }
  const allScholars = [];
  for (const scholarId of group.scholarIds) {
    const scholar = await ctx.db.get(scholarId);
    if (
      scholar &&
      scholar.role === "scholar" &&
      scholar.institutionId === station.institutionId
    ) {
      allScholars.push(scholar);
    }
  }
  return {
    group,
    scholars: allScholars,
  };
}

function sameDayCaptureCutoff(now: number, timeZone: string): number {
  return instantForLocalMinutes(
    dayKeyForTimezone(now, timeZone),
    ASSIGNED_DEVICE_CAPTURE_CUTOFF_HOUR * 60 +
      ASSIGNED_DEVICE_CAPTURE_CUTOFF_MINUTE,
    timeZone,
  );
}

function activeAssignedDeviceCapture(
  binding: Doc<"pairedDevices">,
  now: number,
) {
  if (
    !binding.assignedDeviceCaptureStationId ||
    !binding.assignedDeviceCaptureExpiresAt ||
    !binding.assignedDeviceCaptureUpdatedAt ||
    binding.assignedDeviceCaptureExpiresAt <= now
  ) {
    return null;
  }
  return {
    captureStationId: binding.assignedDeviceCaptureStationId,
    expiresAt: binding.assignedDeviceCaptureExpiresAt,
    updatedAt: binding.assignedDeviceCaptureUpdatedAt,
  };
}

async function currentManagedBinding(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  binding: Doc<"pairedDevices">,
) {
  if (!binding.managedDeviceClaimId) return null;
  const claim = await ctx.db.get(binding.managedDeviceClaimId);
  if (
    !claim ||
    claim.claimState !== "claimed" ||
    claim.institutionId !== binding.institutionId ||
    claim.scholarId !== binding.scholarId ||
    claim.lastDeviceId !== binding.deviceId
  ) {
    return null;
  }
  return claim;
}

async function requireCurrentManagedBinding(
  ctx: Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">,
  binding: Doc<"pairedDevices">,
) {
  const claim = await currentManagedBinding(ctx, binding);
  if (!claim) throw new Error("That iPad is no longer the assigned managed device.");
  return claim;
}

async function requireAssignedCaptureStation(
  ctx: DeviceControlCtx,
  user: Doc<"users">,
  stationId: Id<"captureStations">,
  institutionId: Id<"institutions">,
) {
  const station = await ctx.db.get(stationId);
  if (
    !station ||
    station.institutionId !== institutionId ||
    !station.enabled ||
    station.revokedAt
  ) {
    throw new Error("That capture station is unavailable.");
  }
  const group = await ctx.db.get(station.scholarGroupId);
  if (!group || group.institutionId !== institutionId || !includesProgramGuests(group)) {
    throw new Error("That capture station is unavailable.");
  }
  await requireProgramCaptureReviewAccess(ctx, user, group);
  return { station, group };
}

async function requireAssignedDeviceControlAccess(
  ctx: DeviceControlCtx,
  user: Doc<"users">,
  binding: Doc<"pairedDevices">,
) {
  await requireAssignedDeviceInstitutionAccess(ctx, user, binding);
  await requireCurrentManagedBinding(ctx, binding);
}

async function requireAssignedDeviceInstitutionAccess(
  ctx: DeviceControlCtx,
  user: Doc<"users">,
  binding: Doc<"pairedDevices">,
) {
  if (
    !(await hasSchoolOperationsAccessAtInstitution(
      ctx,
      user,
      binding.institutionId,
    ))
  ) {
    throw new Error("Forbidden: device is not in your current school context");
  }
}

function nextAssignedDeviceCaptureRevision(
  binding: Doc<"pairedDevices">,
  now: number,
) {
  return Math.max(now, (binding.assignedDeviceCaptureUpdatedAt ?? 0) + 1);
}

/** Staff-only enrollment secret. The raw secret is returned exactly once. */
/**
 * Register a program group as a capture target. This is the ONLY step the
 * assigned-device capture path needs: that path authenticates off the
 * scholar's existing paired session, so it never redeems an enrollment token.
 * Provisioning a dedicated kiosk device is a separate, opt-in step —
 * `createOrRotateForGroup` — so ordinary setup never mints a live credential
 * that nobody will use.
 */
export const createForGroup = scholarAdminMutation({
  args: { scholarGroupId: v.id("scholarGroups"), label: v.string() },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.scholarGroupId);
    const label = args.label.trim().slice(0, 120);
    if (!group || !label || !group.institutionId || !includesProgramGuests(group)) {
      throw new Error(
        `Choose a program group that includes ${EXTENDED_EDUCATION_LABEL} scholars in your school.`,
      );
    }
    await requireProgramCaptureReviewAccess(ctx, ctx.user, group);
    const now = Date.now();
    const existing = await ctx.db
      .query("captureStations")
      .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
      .unique();
    if (existing) {
      // Re-enabling a revoked station keeps any kiosk enrollment revoked: the
      // operator must reissue a token deliberately.
      await ctx.db.patch(existing._id, {
        label,
        enabled: true,
        revokedAt: undefined,
      });
      return { captureStationId: existing._id };
    }
    const captureStationId = await ctx.db.insert("captureStations", {
      institutionId: group.institutionId,
      scholarGroupId: group._id,
      label,
      enabled: true,
      enrollmentEpoch: 1,
      sessionWindowStartedAt: now,
      sessionsIssuedInWindow: 0,
      createdBy: ctx.user._id,
      createdAt: now,
    });
    return { captureStationId };
  },
});

/**
 * Drop a station's kiosk enrollment without revoking the station itself.
 * Assigned-device capture keeps working; only the static kiosk path stops.
 */
export const clearEnrollmentToken = scholarAdminMutation({
  args: { captureStationId: v.id("captureStations") },
  handler: async (ctx, args) => {
    const station = await ctx.db.get(args.captureStationId);
    if (!station) throw new Error("That capture station no longer exists.");
    await requireProgramCaptureCleanupAccess(
      ctx,
      ctx.user,
      await ctx.db.get(station.scholarGroupId),
    );
    const now = Date.now();
    await ctx.db.patch(station._id, {
      enrollmentTokenHash: undefined,
      enrolledDeviceIdHash: undefined,
      enrollmentEpoch: (station.enrollmentEpoch ?? 1) + 1,
    });
    // Kiosk sessions die with the token; assigned-device sessions are bound to
    // a pairedDevice and stay alive.
    for (const session of await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
      .collect()) {
      if (!session.revokedAt && !session.pairedDeviceId) {
        await ctx.db.patch(session._id, { revokedAt: now });
      }
    }
  },
});

export const createOrRotateForGroup = scholarAdminMutation({
  args: { scholarGroupId: v.id("scholarGroups"), label: v.string() },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.scholarGroupId);
    const label = args.label.trim().slice(0, 120);
    if (!group || !label || !group.institutionId || !includesProgramGuests(group)) {
      throw new Error(
        `Choose a program group that includes ${EXTENDED_EDUCATION_LABEL} scholars in your school.`,
      );
    }
    await requireProgramCaptureReviewAccess(ctx, ctx.user, group);
    const now = Date.now();
    const enrollmentToken = token("rhcapture_");
    const enrollmentTokenHash = await sha256Hex(enrollmentToken);
    const existing = await ctx.db
      .query("captureStations")
      .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
      .unique();
    if (existing) {
      for (const session of await ctx.db
        .query("captureStationSessions")
        .withIndex("by_station", (q) =>
          q.eq("captureStationId", existing._id),
        )
        .collect()) {
        if (!session.revokedAt) {
          const reservations = await ctx.db
            .query("captureStationUploadReservations")
            .withIndex("by_session", (q) => q.eq("sessionId", session._id))
            .collect();
          const hasRecoverableReservation = reservations.some(
            (reservation) =>
              reservation.expiresAt > now &&
              (reservation.status === "issued" || reservation.status === "uploaded"),
          );
          await ctx.db.patch(
            session._id,
            hasRecoverableReservation ? { recoveryOnly: true } : { revokedAt: now },
          );
        }
      }
      await ctx.db.patch(existing._id, {
        label,
        enrollmentTokenHash,
        enrolledDeviceIdHash: undefined,
        enrollmentEpoch: (existing.enrollmentEpoch ?? 1) + 1,
        sessionWindowStartedAt: now,
        sessionsIssuedInWindow: 0,
        enabled: true,
        rotatedAt: now,
        revokedAt: undefined,
      });
      return { captureStationId: existing._id, enrollmentToken };
    }
    const captureStationId = await ctx.db.insert("captureStations", {
      institutionId: group.institutionId,
      scholarGroupId: group._id,
      label,
      enrollmentTokenHash,
      enabled: true,
      enrollmentEpoch: 1,
      sessionWindowStartedAt: now,
      sessionsIssuedInWindow: 0,
      createdBy: ctx.user._id,
      createdAt: now,
    });
    return { captureStationId, enrollmentToken };
  },
});

export const revoke = scholarAdminMutation({
  args: { captureStationId: v.id("captureStations") },
  handler: async (ctx, args) => {
    const station = await ctx.db.get(args.captureStationId);
    if (!station) return;
    await requireProgramCaptureCleanupAccess(
      ctx,
      ctx.user,
      await ctx.db.get(station.scholarGroupId),
    );
    const now = Date.now();
    await ctx.db.patch(station._id, { enabled: false, revokedAt: now });
    for (const session of await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
      .collect()) {
      if (!session.revokedAt) await ctx.db.patch(session._id, { revokedAt: now });
    }
  },
});

export const statusForGroup = authedQuery({
  args: { scholarGroupId: v.id("scholarGroups") },
  handler: async (ctx, args) => {
    const group = await ctx.db.get(args.scholarGroupId);
    if (!group?.institutionId || !includesProgramGuests(group)) {
      throw new Error(
        `Choose a program group that includes ${EXTENDED_EDUCATION_LABEL} scholars in your school.`,
      );
    }
    await requireProgramCaptureReviewAccess(ctx, ctx.user, group);
    const station = await ctx.db
      .query("captureStations")
      .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
      .unique();
    if (!station) return null;
    const sessions = await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
      .collect();
    const now = Date.now();
    const { scholars } = await groupRoster(ctx, station);
    return {
      captureStationId: station._id,
      label: station.label,
      enabled: station.enabled && !station.revokedAt,
      // Whether a KIOSK device is provisioned. Independent of `enabled`:
      // assigned-device capture works with no enrollment token at all.
      hasEnrollmentToken: !!station.enrollmentTokenHash,
      createdAt: station.createdAt,
      rotatedAt: station.rotatedAt ?? null,
      revokedAt: station.revokedAt ?? null,
      activeSessionCount: sessions.filter(
        (session) => !session.revokedAt && session.expiresAt > now,
      ).length,
      lastUsedAt:
        sessions.reduce<number | null>(
          (latest, session) =>
            session.lastUsedAt && (latest === null || session.lastUsedAt > latest)
              ? session.lastUsedAt
              : latest,
          null,
        ),
      rosterCount: scholars.length,
    };
  },
});

/** Program groups and their station state for the School > Devices surface. */
export const listForSchool = authedQuery({
  args: { institutionScope: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const groups = await reviewableProgramGroups(
      ctx,
      ctx.user,
      args.institutionScope,
    );
    return groups.map((group) => ({
      groupId: group._id,
      groupName: group.name,
    }));
  },
});

/**
 * Staff control model for a managed scholar iPad. The caller must hold both
 * device-control authority and capture-review authority; a device roster entry
 * alone never grants the ability to turn it into a capture surface.
 */
export const assignedDeviceCaptureControlState = authedQuery({
  args: { pairedDeviceId: v.id("pairedDevices") },
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.pairedDeviceId);
    if (!binding) throw new Error("That iPad is no longer paired.");
    await requireAssignedDeviceInstitutionAccess(ctx, ctx.user, binding);
    const institution = await ctx.db.get(binding.institutionId);
    const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
    if (!(await currentManagedBinding(ctx, binding))) {
      return {
        pairedDeviceId: binding._id,
        scholarId: binding.scholarId,
        availableStations: [],
        active: null,
        timeZone,
      };
    }

    const groups = await reviewableProgramGroups(ctx, ctx.user);
    const stations = (
      await Promise.all(
        groups
          .filter((group) => group.institutionId === binding.institutionId)
          .map(async (group) => {
            const station = await ctx.db
              .query("captureStations")
              .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
              .unique();
            if (!station || !station.enabled || station.revokedAt) return null;
            return {
              captureStationId: station._id,
              label: station.label,
              scholarGroupId: group._id,
              groupName: group.name,
            };
          }),
      )
    ).filter((station): station is NonNullable<typeof station> => !!station);
    const mode = activeAssignedDeviceCapture(binding, Date.now());
    const activeStation = mode
      ? stations.find(
          (station) => station.captureStationId === mode.captureStationId,
        )
      : null;
    return {
      pairedDeviceId: binding._id,
      scholarId: binding.scholarId,
      availableStations: stations,
      active:
        mode && activeStation
          ? { ...mode, groupName: activeStation.groupName }
          : null,
      timeZone,
    };
  },
});

async function applyAssignedDeviceCaptureMode(
  ctx: MutationCtx,
  {
    actor,
    pairedDeviceId,
    captureStationId,
    enabled,
  }: {
    actor: Doc<"users">;
    pairedDeviceId: Id<"pairedDevices">;
    captureStationId?: Id<"captureStations">;
    enabled: boolean;
  },
) {
  const binding = await ctx.db.get(pairedDeviceId);
  if (!binding) throw new Error("That iPad is no longer paired.");
  await requireAssignedDeviceControlAccess(ctx, actor, binding);
  const now = Date.now();
  const current = activeAssignedDeviceCapture(binding, now);

  if (!enabled) {
    if (!current) {
      return { enabled: false as const, changed: false as const, expiresAt: null };
    }
    if (
      captureStationId &&
      captureStationId !== current.captureStationId
    ) {
      throw new Error("That iPad is active for a different capture station.");
    }
    await requireAssignedCaptureStation(
      ctx,
      actor,
      current.captureStationId,
      binding.institutionId,
    );
    const updatedAt = nextAssignedDeviceCaptureRevision(binding, now);
    await ctx.db.patch(binding._id, {
      assignedDeviceCaptureStationId: undefined,
      assignedDeviceCaptureExpiresAt: undefined,
      assignedDeviceCaptureUpdatedAt: updatedAt,
      assignedDeviceCaptureUpdatedBy: undefined,
    });
    await ctx.db.insert("auditLog", {
      actorUserId: actor._id,
      action: "device.capture-mode.stop",
      targetUserId: binding.scholarId,
      at: now,
      detail: `device ${binding.deviceId}; station ${current.captureStationId}`,
    });
    return { enabled: false as const, changed: true as const, expiresAt: null };
  }

  if (!captureStationId) throw new Error("Choose a capture station.");
  const institution = await ctx.db.get(binding.institutionId);
  const timeZone = effectiveInstitutionTimeZone(institution?.timeZone);
  const cutoff = sameDayCaptureCutoff(now, timeZone);
  if (now >= cutoff) {
    throw new Error("Capture mode cannot start at or after 4:40 PM school time.");
  }
  await requireAssignedCaptureStation(
    ctx,
    actor,
    captureStationId,
    binding.institutionId,
  );
  if (
    current &&
    current.captureStationId === captureStationId &&
    current.expiresAt === cutoff
  ) {
    return {
      enabled: true as const,
      changed: false as const,
      expiresAt: current.expiresAt,
      updatedAt: current.updatedAt,
    };
  }

  const updatedAt = nextAssignedDeviceCaptureRevision(binding, now);
  await ctx.db.patch(binding._id, {
    assignedDeviceCaptureStationId: captureStationId,
    assignedDeviceCaptureExpiresAt: cutoff,
    assignedDeviceCaptureUpdatedAt: updatedAt,
    assignedDeviceCaptureUpdatedBy: actor._id,
  });
  await ctx.scheduler.runAt(cutoff, internal.captureStations.expireAssignedDeviceCapture, {
    pairedDeviceId: binding._id,
    expectedUpdatedAt: updatedAt,
  });
  await ctx.db.insert("auditLog", {
    actorUserId: actor._id,
    action: "device.capture-mode.start",
    targetUserId: binding.scholarId,
    at: now,
    detail: `device ${binding.deviceId}; station ${captureStationId}; expires ${cutoff}`,
  });
  return {
    enabled: true as const,
    changed: true as const,
    expiresAt: cutoff,
    updatedAt,
  };
}

export const setAssignedDeviceCaptureMode = authedMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    captureStationId: v.optional(v.id("captureStations")),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) =>
    await applyAssignedDeviceCaptureMode(ctx, { actor: ctx.user, ...args }),
});

export const expireAssignedDeviceCapture = internalMutation({
  args: {
    pairedDeviceId: v.id("pairedDevices"),
    expectedUpdatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const binding = await ctx.db.get(args.pairedDeviceId);
    if (
      !binding ||
      binding.assignedDeviceCaptureUpdatedAt !== args.expectedUpdatedAt ||
      !binding.assignedDeviceCaptureStationId ||
      !binding.assignedDeviceCaptureExpiresAt ||
      binding.assignedDeviceCaptureExpiresAt > Date.now()
    ) {
      return { expired: false };
    }
    const updatedAt = nextAssignedDeviceCaptureRevision(binding, Date.now());
    await ctx.db.patch(binding._id, {
      assignedDeviceCaptureStationId: undefined,
      assignedDeviceCaptureExpiresAt: undefined,
      assignedDeviceCaptureUpdatedAt: updatedAt,
      assignedDeviceCaptureUpdatedBy: undefined,
    });
    await ctx.db.insert("auditLog", {
      actorUserId: binding.assignedDeviceCaptureUpdatedBy ?? binding.pairedBy,
      action: "device.capture-mode.expire",
      targetUserId: binding.scholarId,
      at: Date.now(),
      detail: `device ${binding.deviceId}`,
    });
    return { expired: true };
  },
});

/**
 * Authenticated device read. A matching scholar account is insufficient: the
 * currently authenticated session must be the session attached to this exact
 * managed-device binding.
 */
export const assignedDeviceCaptureState = authedQuery({
  args: { deviceId: v.string() },
  handler: async (ctx, args) => {
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) return null;
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", args.deviceId.trim()))
      .take(2);
    if (bindings.length !== 1) return null;
    const binding = bindings[0];
    if (
      binding.scholarId !== ctx.user._id ||
      binding.authSessionId !== sessionId
    ) {
      return null;
    }
    if (!(await currentManagedBinding(ctx, binding))) return null;
    const mode = activeAssignedDeviceCapture(binding, Date.now());
    if (!mode) return null;
    const station = await ctx.db.get(mode.captureStationId);
    if (!station || !station.enabled || station.revokedAt) return null;
    return mode;
  },
});

export const startAssignedDeviceCapture = authedMutation({
  args: { deviceId: v.string(), expectedUpdatedAt: v.number() },
  handler: async (ctx, args) => {
    const sessionId = await getAuthSessionId(ctx);
    if (!sessionId) throw new Error("This iPad session is unavailable.");
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_device_id", (q) => q.eq("deviceId", args.deviceId.trim()))
      .take(2);
    if (bindings.length !== 1) throw new Error("This iPad is unavailable.");
    const binding = bindings[0];
    if (
      binding.scholarId !== ctx.user._id ||
      binding.authSessionId !== sessionId
    ) {
      throw new Error("This session is not attached to the assigned iPad.");
    }
    await requireCurrentManagedBinding(ctx, binding);
    const mode = activeAssignedDeviceCapture(binding, Date.now());
    if (!mode || mode.updatedAt !== args.expectedUpdatedAt) {
      throw new Error("Assigned capture mode has ended.");
    }
    const station = await ctx.db.get(mode.captureStationId);
    if (!station || !station.enabled || station.revokedAt) {
      throw new Error("Capture station is unavailable.");
    }
    const now = Date.now();
    for (const existing of await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) =>
        q.eq("captureStationId", station._id),
      )
      .collect()) {
      if (
        existing.pairedDeviceId !== binding._id ||
        existing.revokedAt ||
        existing.expiresAt <= now
      ) {
        continue;
      }
      const reservations = await ctx.db
        .query("captureStationUploadReservations")
        .withIndex("by_session", (q) => q.eq("sessionId", existing._id))
        .collect();
      const captures = await ctx.db
        .query("captureStationCaptures")
        .withIndex("by_session", (q) => q.eq("sessionId", existing._id))
        .collect();
      const hasRecoverableReservation = reservations.some(
        (reservation) =>
          reservation.expiresAt > now &&
          (reservation.status === "issued" || reservation.status === "uploaded"),
      );
      if (!hasRecoverableReservation) {
        if (reservations.length === 0 && captures.length === 0) {
          await ctx.db.delete(existing._id);
        } else {
          await ctx.db.patch(existing._id, { revokedAt: now });
        }
      }
    }
    const sessionToken = token("rhcs_");
    await ctx.db.insert("captureStationSessions", {
      captureStationId: station._id,
      deviceId: binding.deviceId,
      sessionTokenHash: await sha256Hex(sessionToken),
      createdAt: now,
      expiresAt: mode.expiresAt,
      lastUsedAt: now,
      pairedDeviceId: binding._id,
      assignedDeviceCaptureUpdatedAt: mode.updatedAt,
    });
    return { sessionToken, expiresAt: mode.expiresAt };
  },
});

export const findAssignedDeviceCaptureTargetsForSlack = internalQuery({
  args: { callerUserId: v.id("users"), scholarQuery: v.string() },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) return [];
    const needle = args.scholarQuery.trim().toLocaleLowerCase();
    if (!needle) return [];
    const bindings = await ctx.db.query("pairedDevices").collect();
    const groups = await reviewableProgramGroups(ctx, caller);
    const results = [];
    for (const binding of bindings) {
      const scholar = await ctx.db.get(binding.scholarId);
      if (
        !scholar ||
        ![scholar.name, scholar.username]
          .filter((value): value is string => !!value)
          .some((value) => value.toLocaleLowerCase().includes(needle))
      ) {
        continue;
      }
      try {
        await requireAssignedDeviceControlAccess(ctx, caller, binding);
      } catch {
        continue;
      }
      const stations = (
        await Promise.all(
          groups
            .filter((group) => group.institutionId === binding.institutionId)
            .map(async (group) => {
              const station = await ctx.db
                .query("captureStations")
                .withIndex("by_group", (q) => q.eq("scholarGroupId", group._id))
                .unique();
              return station && station.enabled && !station.revokedAt
                ? { captureStationId: station._id, label: station.label }
                : null;
            }),
        )
      ).filter((station): station is NonNullable<typeof station> => !!station);
      if (!stations.length) continue;
      results.push({
        scholarId: scholar._id,
        scholarName: scholar.name ?? null,
        scholarUsername: scholar.username ?? null,
        pairedDeviceId: binding._id,
        stations,
        mode: activeAssignedDeviceCapture(binding, Date.now()),
      });
    }
    return results;
  },
});

export const setAssignedDeviceCaptureModeFromSlack = internalMutation({
  args: {
    callerUserId: v.id("users"),
    scholarId: v.id("users"),
    captureStationId: v.id("captureStations"),
    enabled: v.boolean(),
  },
  handler: async (ctx, args) => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller) throw new Error("Slack caller no longer exists.");
    const bindings = await ctx.db
      .query("pairedDevices")
      .withIndex("by_scholar", (q) => q.eq("scholarId", args.scholarId))
      .collect();
    const eligible = [];
    for (const binding of bindings) {
      try {
        await requireAssignedDeviceControlAccess(ctx, caller, binding);
        await requireAssignedCaptureStation(
          ctx,
          caller,
          args.captureStationId,
          binding.institutionId,
        );
        eligible.push(binding);
      } catch {
        // A caller may have other bindings or another-school matches; only an
        // unambiguous, fully authorized target can be controlled from Slack.
      }
    }
    if (eligible.length !== 1) {
      throw new Error("No unique authorized managed iPad was found for that scholar.");
    }
    return await applyAssignedDeviceCaptureMode(ctx, {
      actor: caller,
      pairedDeviceId: eligible[0]._id,
      captureStationId: args.captureStationId,
      enabled: args.enabled,
    });
  },
});

export const exchangeEnrollmentToken = mutation({
  args: { token: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const deviceId = args.deviceId.trim();
    if (deviceId.length < 6 || deviceId.length > 200) throw new Error("Invalid device.");
    const enrollmentTokenHash = await sha256Hex(args.token.trim());
    const station = await ctx.db
      .query("captureStations")
      .withIndex("by_enrollment_token_hash", (q) =>
        q.eq("enrollmentTokenHash", enrollmentTokenHash),
      )
      .unique();
    if (!station || !station.enabled || station.revokedAt) {
      throw new Error("Capture station is unavailable.");
    }
    const now = Date.now();
    const [institution, group] = await Promise.all([
      ctx.db.get(station.institutionId),
      ctx.db.get(station.scholarGroupId),
    ]);
    if (
      !institution ||
      institution.disabledAt ||
      !group ||
      group.institutionId !== station.institutionId ||
      !includesProgramGuests(group)
    ) {
      throw new Error("Capture station is unavailable.");
    }
    const deviceIdHash = await sha256Hex(deviceId);
    if (
      station.enrolledDeviceIdHash &&
      station.enrolledDeviceIdHash !== deviceIdHash
    ) {
      throw new ConvexError({ kind: "enrollment_device_bound" });
    }

    if (!station.enrolledDeviceIdHash) {
      // Existing stations widen into this bound on their next legitimate
      // enrollment. Any prior session for another device is invalidated now,
      // closing the pre-fix capability window instead of letting it run to TTL.
      for (const session of await ctx.db
        .query("captureStationSessions")
        .withIndex("by_station", (q) =>
          q.eq("captureStationId", station._id),
        )
        .collect()) {
        if (session.deviceId !== deviceId && !session.revokedAt) {
          await ctx.db.patch(session._id, { revokedAt: now });
        }
      }
      await ctx.db.patch(station._id, {
        enrolledDeviceIdHash: deviceIdHash,
        enrollmentEpoch: station.enrollmentEpoch ?? 1,
      });
    }

    const windowStartedAt =
      station.sessionWindowStartedAt &&
      station.sessionWindowStartedAt + SESSION_TTL_MS > now
        ? station.sessionWindowStartedAt
        : now;
    const sessionsIssuedInWindow =
      windowStartedAt === station.sessionWindowStartedAt
        ? station.sessionsIssuedInWindow ?? 0
        : 0;
    if (sessionsIssuedInWindow >= MAX_SESSIONS_PER_ENROLLMENT_WINDOW) {
      throw new ConvexError({ kind: "capture_session_quota" });
    }

    for (const session of await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) =>
        q.eq("captureStationId", station._id),
      )
      .collect()) {
      if (session.deviceId === deviceId && !session.revokedAt) {
        const reservations = await ctx.db
          .query("captureStationUploadReservations")
          .withIndex("by_session", (q) => q.eq("sessionId", session._id))
          .collect();
        const hasRecoverableReservation = reservations.some(
          (reservation) =>
            reservation.expiresAt > now &&
            (reservation.status === "issued" || reservation.status === "uploaded"),
        );
        if (hasRecoverableReservation) continue;
        await ctx.db.patch(session._id, { revokedAt: now });
      }
    }
    const activeSessions = await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) =>
        q.eq("captureStationId", station._id),
      )
      .collect();
    if (
      activeSessions.filter(
        (session) =>
          !session.pairedDeviceId &&
          !session.revokedAt &&
          session.expiresAt > now,
      ).length >= MAX_ACTIVE_SESSIONS_PER_STATION
    ) {
      throw new ConvexError({ kind: "capture_session_recovery_quota" });
    }
    const sessionToken = token("rhcs_");
    await ctx.db.insert("captureStationSessions", {
      captureStationId: station._id,
      deviceId,
      sessionTokenHash: await sha256Hex(sessionToken),
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
      lastUsedAt: now,
    });
    await ctx.db.patch(station._id, {
      sessionWindowStartedAt: windowStartedAt,
      sessionsIssuedInWindow: sessionsIssuedInWindow + 1,
    });
    return { sessionToken, expiresAt: now + SESSION_TTL_MS };
  },
});

export const bootstrap = mutation({
  args: { sessionToken: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const { station, session } = await capability(ctx, args.sessionToken, args.deviceId);
    const { group, scholars } = await groupRoster(ctx, station);
    return {
      label: station.label,
      groupName: group.name,
      // The web device-settings page for this managed iPad (assigned capture
      // only). The exit dialog turns it into a teacher QR + serial operation,
      // mirroring the ASAM parent gate; null for a static (non-managed) station.
      deviceSettingsPath: session.pairedDeviceId
        ? `/school/devices/${session.pairedDeviceId}`
        : null,
      roster: scholars
        .map((scholar) => ({
          id: scholar._id,
          name: captureRosterName(scholar),
          image: scholar.image ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  },
});

/**
 * Every upload URL this station mints — media or poster — is metered by the
 * same reservation row: it counts against the per-session URL cap and the
 * per-scope open/abandoned pressure caps, and it schedules its own cleanup so
 * a blob the client never claims is swept rather than orphaned.
 */
async function issueUploadReservation(
  ctx: MutationCtx,
  station: Doc<"captureStations">,
  session: Doc<"captureStationSessions">,
  purpose?: "poster",
) {
  const now = Date.now();
  const pressure = await reservationPressure(ctx, session, now);
  if (pressure.open >= MAX_OPEN_UPLOAD_RESERVATIONS_PER_PRESSURE_SCOPE) {
    throw new ConvexError({ kind: "upload_pending_quota" });
  }
  if (
    pressure.abandoned >= MAX_ABANDONED_UPLOAD_RESERVATIONS_PER_PRESSURE_SCOPE
  ) {
    throw new ConvexError({ kind: "upload_abandoned_quota" });
  }
  const uploadUrlsIssued = session.uploadUrlsIssued ?? 0;
  if (uploadUrlsIssued >= MAX_UPLOAD_URLS_PER_SESSION) {
    throw new ConvexError({ kind: "upload_url_quota" });
  }
  await ctx.db.patch(session._id, {
    uploadUrlsIssued: uploadUrlsIssued + 1,
    lastUsedAt: now,
  });
  const reservationId = await ctx.db.insert(
    "captureStationUploadReservations",
    {
      captureStationId: session.captureStationId,
      sessionId: session._id,
      enrollmentEpoch: station.enrollmentEpoch ?? 1,
      ...(purpose ? { purpose } : {}),
      status: "issued",
      createdAt: now,
      updatedAt: now,
      expiresAt: now + UPLOAD_RESERVATION_TTL_MS,
    },
  );
  await ctx.scheduler.runAfter(
    UPLOAD_RESERVATION_TTL_MS,
    internal.captureStations.cleanupUploadReservation,
    { reservationId },
  );
  return {
    uploadUrl: await ctx.storage.generateUploadUrl(),
    reservationId,
    expiresAt: now + UPLOAD_RESERVATION_TTL_MS,
  };
}

export const generateUploadUrl = mutation({
  args: { sessionToken: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const { station, session } = await capability(
      ctx,
      args.sessionToken,
      args.deviceId,
    );
    return await issueUploadReservation(ctx, station, session);
  },
});

/**
 * The video poster's own metered reservation. The client uploads to this URL
 * and reports the blob through `recordUploadedBlob` exactly like the media,
 * then hands `registerCapture` the reservation id — never a raw storage id, so
 * no device can nominate another capture's live blob as its "poster".
 */
export const generatePosterUploadUrl = mutation({
  args: { sessionToken: v.string(), deviceId: v.string() },
  handler: async (ctx, args) => {
    const { station, session } = await capability(
      ctx,
      args.sessionToken,
      args.deviceId,
    );
    return await issueUploadReservation(ctx, station, session, "poster");
  },
});

export const recordUploadedBlob = mutation({
  args: {
    sessionToken: v.string(),
    deviceId: v.string(),
    reservationId: v.id("captureStationUploadReservations"),
    storageId: v.id("_storage"),
    mimeType: v.string(),
    sizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const { station, session } = await capability(
      ctx,
      args.sessionToken,
      args.deviceId,
      true,
    );
    const reservation = await ctx.db.get(args.reservationId);
    const reservationSession =
      reservation &&
      (await reservationOwningSession(ctx, reservation, station, session));
    if (
      !reservation ||
      !reservationSession ||
      reservation.expiresAt <= Date.now() ||
      reservation.status === "cancelled" ||
      reservation.status === "abandoned"
    ) {
      throw new Error("Upload reservation expired.");
    }
    if (
      reservation.status === "uploaded" ||
      reservation.status === "finalized"
    ) {
      if (reservation.storageId !== args.storageId) {
        throw new Error("Upload reservation is already in use.");
      }
      return { accepted: true as const };
    }
    const claimed = await ctx.db
      .query("captureStationUploadReservations")
      .withIndex("by_storage", (q) => q.eq("storageId", args.storageId))
      .unique();
    if (claimed && claimed._id !== reservation._id) {
      throw new Error("Upload is already registered.");
    }
    const mimeType = args.mimeType.trim().toLowerCase();
    const metadata = await ctx.db.system.get("_storage", args.storageId);
    // Convex direct-upload URLs yield the storage id only after the client
    // uploads. A blob not created after this reservation therefore cannot
    // belong to this upload flow and must neither be claimed nor deleted.
    if (metadata && metadata._creationTime <= reservation.createdAt) {
      throw new Error("Upload does not belong to this reservation.");
    }
    // A poster is a small still, and the client that uploads one always sends a
    // Content-Type, so it is held to the tighter contract: image/* only, the
    // poster ceiling, and a declared content type (no undefined tolerance).
    const isPoster = reservation.purpose === "poster";
    const maxBytes = isPoster
      ? POSTER_MAX_BYTES
      : mimeType.startsWith("video/")
        ? VIDEO_MAX_BYTES
        : PHOTO_MAX_BYTES;
    const valid =
      MEDIA_TYPES.has(mimeType) &&
      (!isPoster || mimeType.startsWith("image/")) &&
      metadata !== null &&
      metadata.size > 0 &&
      metadata.size <= maxBytes &&
      args.sizeBytes === metadata.size &&
      (isPoster
        ? metadata.contentType !== undefined &&
          metadata.contentType.toLowerCase() === mimeType
        : metadata.contentType === undefined ||
          metadata.contentType.toLowerCase() === mimeType);
    const now = Date.now();
    if (!valid) {
      await ctx.db.patch(reservation._id, {
        status: "cancelled",
        ...(metadata
          ? {
              storageId: args.storageId,
              mimeType,
              sizeBytes: metadata.size,
            }
          : {}),
        updatedAt: now,
        // Cleanup, rather than this validation path, owns deletion of every
        // reservation-bound blob. It can prove the blob is still unclaimed
        // before removing it.
        expiresAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.captureStations.cleanupUploadReservation,
        { reservationId: reservation._id },
      );
      return { accepted: false as const };
    }
    await ctx.db.patch(reservation._id, {
      status: "uploaded",
      storageId: args.storageId,
      mimeType,
      sizeBytes: metadata.size,
      updatedAt: now,
    });
    return { accepted: true as const };
  },
});

/**
 * Resolves the poster reservation a client offers for this capture.
 *
 * Returns null unless the reservation is a poster reservation this station and
 * device actually hold; `storageId: null` marks one that is ours but whose blob
 * fails the small-image contract, so the caller can expire it for cleanup. The
 * blob is reached only THROUGH the reservation — a device can never name a
 * storage id directly — and it must have been created after the reservation
 * was issued, the same provenance proof `recordUploadedBlob` uses. Together
 * those make nominating (and then deleting) another capture's live blob
 * impossible by construction rather than by validation.
 */
async function claimPosterReservation(
  ctx: MutationCtx,
  station: Doc<"captureStations">,
  session: Doc<"captureStationSessions">,
  posterReservationId: Id<"captureStationUploadReservations">,
  now: number,
): Promise<{
  reservation: Doc<"captureStationUploadReservations">;
  storageId: Id<"_storage"> | null;
} | null> {
  const reservation = await ctx.db.get(posterReservationId);
  if (
    !reservation ||
    reservation.purpose !== "poster" ||
    !(await reservationOwningSession(ctx, reservation, station, session))
  ) {
    return null;
  }
  if (
    reservation.status !== "uploaded" ||
    reservation.expiresAt <= now ||
    !reservation.storageId
  ) {
    return null;
  }
  const metadata = await ctx.db.system.get("_storage", reservation.storageId);
  const valid =
    metadata !== null &&
    metadata._creationTime > reservation.createdAt &&
    metadata.contentType !== undefined &&
    metadata.contentType.toLowerCase().startsWith("image/") &&
    metadata.size > 0 &&
    metadata.size <= POSTER_MAX_BYTES &&
    reservation.sizeBytes === metadata.size;
  return { reservation, storageId: valid ? reservation.storageId : null };
}

export const registerCapture = mutation({
  args: {
    sessionToken: v.string(),
    deviceId: v.string(),
    reservationId: v.id("captureStationUploadReservations"),
    scholarIds: v.array(v.id("users")),
    videoDurationMs: v.optional(v.number()),
    posterReservationId: v.optional(
      v.id("captureStationUploadReservations"),
    ),
  },
  handler: async (ctx, args) => {
    const { station, session } = await capability(
      ctx,
      args.sessionToken,
      args.deviceId,
      true,
    );
    const reservation = await ctx.db.get(args.reservationId);
    const reservationSession =
      reservation &&
      (await reservationOwningSession(ctx, reservation, station, session));
    if (
      !reservation ||
      !reservationSession ||
      // A poster reservation is never the capture's own media.
      reservation.purpose === "poster" ||
      reservation.expiresAt <= Date.now() ||
      reservation.status === "issued" ||
      reservation.status === "cancelled" ||
      reservation.status === "abandoned" ||
      !reservation.storageId ||
      !reservation.mimeType ||
      reservation.sizeBytes === undefined
    ) {
      throw new Error("Upload reservation is not ready.");
    }
    if (reservation.status === "finalized" && reservation.captureId) {
      const capture = await ctx.db.get(reservation.captureId);
      if (capture) {
        return {
          captureId: capture._id,
          portfolioItemId: capture.portfolioItemId,
        };
      }
    }
    if ((reservationSession.capturesRegistered ?? 0) >= MAX_CAPTURES_PER_SESSION) {
      throw new ConvexError({ kind: "capture_count_quota" });
    }
    const mimeType = reservation.mimeType;
    const metadata = await ctx.db.system.get("_storage", reservation.storageId);
    if (!metadata) throw new Error("Upload was not found.");
    const maxBytes = mimeType.startsWith("video/") ? VIDEO_MAX_BYTES : PHOTO_MAX_BYTES;
    if (
      metadata.size <= 0 ||
      metadata.size > maxBytes ||
      reservation.sizeBytes !== metadata.size ||
      (metadata.contentType !== undefined &&
        metadata.contentType.toLowerCase() !== mimeType)
    ) {
      throw new Error("This file is too large or invalid.");
    }
    if (
      (reservationSession.registeredBytes ?? 0) + metadata.size >
      MAX_REGISTERED_BYTES_PER_SESSION
    ) {
      throw new ConvexError({ kind: "capture_storage_quota" });
    }
    const { group, scholars } = await groupRoster(ctx, station);
    const allowed = new Set(scholars.map((scholar) => String(scholar._id)));
    const scholarIds = [
      ...new Map(args.scholarIds.map((id) => [String(id), id])).values(),
    ];
    if (!scholarIds.length || scholarIds.some((id) => !allowed.has(String(id)))) {
      throw new Error("Choose one or more scholars in this group.");
    }
    const now = Date.now();
    // Poster and duration describe a video; ignore both on a photo.
    const isVideo = mimeType.startsWith("video/");
    const videoDurationMs = isVideo ? args.videoDurationMs : undefined;
    // A bad poster must never block the real capture — drop it silently
    // (store undefined) rather than throwing.
    const poster =
      isVideo &&
      args.posterReservationId &&
      args.posterReservationId !== args.reservationId
        ? await claimPosterReservation(
            ctx,
            station,
            session,
            args.posterReservationId,
            now,
          )
        : null;
    const videoThumbStorageId = poster?.storageId ?? undefined;
    if (poster && !videoThumbStorageId) {
      // Ours, but unusable: expire it now so cleanup can delete the blob
      // instead of leaving it to sit out the reservation TTL.
      await ctx.db.patch(poster.reservation._id, {
        status: "cancelled",
        updatedAt: now,
        expiresAt: now,
      });
      await ctx.scheduler.runAfter(
        0,
        internal.captureStations.cleanupUploadReservation,
        { reservationId: poster.reservation._id },
      );
    }
    const portfolioItemId = await ctx.db.insert("portfolioItems", {
      scholarId: scholarIds[0],
      institutionId: station.institutionId,
      title: `${group.name} build · ${new Date(now).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "Pacific/Honolulu",
      })}`,
      source: "capture_station",
      fileStorageId: reservation.storageId,
      fileMimeType: mimeType,
      fileSizeBytes: metadata.size,
      matchStatus: "confirmed",
      assignmentStatus: "none",
      processingStatus: "ready",
      familyVisibility: "staff_only",
      ...(mimeType.startsWith("image/")
        ? { thumbStatus: "pending" as const }
        : {}),
    });
    for (const scholarId of scholarIds) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId,
        scholarId,
        attributedAt: now,
      });
    }
    const captureId = await ctx.db.insert("captureStationCaptures", {
      captureStationId: station._id,
      sessionId: reservationSession._id,
      portfolioItemId,
      storageId: reservation.storageId,
      scholarIds,
      mimeType,
      sizeBytes: metadata.size,
      createdAt: now,
      ...(videoDurationMs !== undefined ? { videoDurationMs } : {}),
      ...(videoThumbStorageId !== undefined ? { videoThumbStorageId } : {}),
    });
    if (poster && videoThumbStorageId) {
      await ctx.db.patch(poster.reservation._id, {
        status: "finalized",
        captureId,
        updatedAt: now,
      });
    }
    if (mimeType.startsWith("image/")) {
      await ctx.scheduler.runAfter(0, internal.portfolioThumbs.generate, {
        itemId: portfolioItemId,
      });
    }
    await ctx.db.patch(reservationSession._id, {
      capturesRegistered: (reservationSession.capturesRegistered ?? 0) + 1,
      registeredBytes: (reservationSession.registeredBytes ?? 0) + metadata.size,
      lastUsedAt: now,
    });
    await ctx.db.patch(reservation._id, {
      status: "finalized",
      captureId,
      updatedAt: now,
    });
    return { captureId, portfolioItemId };
  },
});

export const cleanupUploadReservation = internalMutation({
  args: { reservationId: v.id("captureStationUploadReservations") },
  handler: async (ctx, args) => {
    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation) {
      return { cleaned: false };
    }
    if (reservation.status === "abandoned") return { cleaned: true };
    if (reservation.expiresAt > Date.now()) {
      await ctx.scheduler.runAfter(
        reservation.expiresAt - Date.now(),
        internal.captureStations.cleanupUploadReservation,
        args,
      );
      return { cleaned: false };
    }
    await expireUploadReservation(ctx, reservation, Date.now());
    return { cleaned: true };
  },
});

export const undoCapture = mutation({
  args: { sessionToken: v.string(), deviceId: v.string(), captureId: v.id("captureStationCaptures") },
  handler: async (ctx, args) => {
    const { session } = await capability(ctx, args.sessionToken, args.deviceId);
    const capture = await ctx.db.get(args.captureId);
    if (
      !capture ||
      capture.sessionId !== session._id ||
      capture.undoneAt ||
      capture.createdAt + UNDO_WINDOW_MS < Date.now()
    ) {
      throw new Error("This capture can no longer be undone.");
    }
    const item = await ctx.db.get(capture.portfolioItemId);
    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) =>
        q.eq("portfolioItemId", capture.portfolioItemId),
      )
      .collect();
    const currentScholarIds = attributions
      .map((attribution) => String(attribution.scholarId))
      .sort();
    const capturedScholarIds = capture.scholarIds.map(String).sort();
    const attachments = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", capture.storageId))
      .take(1);
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_portfolioItem", (q) =>
        q.eq("portfolioItemId", capture.portfolioItemId),
      )
      .take(1);
    if (
      !item ||
      item.familyVisibility !== "staff_only" ||
      item.assignmentId ||
      item.activityId ||
      attachments.length > 0 ||
      deliverables.length > 0 ||
      currentScholarIds.length !== capturedScholarIds.length ||
      currentScholarIds.some((id, index) => id !== capturedScholarIds[index])
    ) {
      throw new Error("This capture has already been curated and cannot be undone.");
    }
    for (const attribution of attributions) {
      await ctx.db.delete(attribution._id);
    }
    await ctx.db.delete(capture.portfolioItemId);
    await reconcilePortfolioMaterialization(ctx, capture.portfolioItemId);
    for (const storageId of new Set([
      capture.storageId,
      item.thumbStorageId,
      item.magicStorageId,
      item.magicThumbStorageId,
      capture.videoThumbStorageId,
    ])) {
      if (storageId) await ctx.storage.delete(storageId);
    }
    const now = Date.now();
    await ctx.db.patch(capture._id, { undoneAt: now, scholarIds: [] });
    await ctx.db.patch(session._id, {
      uploadUrlsIssued: Math.max(0, (session.uploadUrlsIssued ?? 0) - 1),
      capturesRegistered: Math.max(
        0,
        (session.capturesRegistered ?? 0) - 1,
      ),
      registeredBytes: Math.max(
        0,
        (session.registeredBytes ?? 0) - capture.sizeBytes,
      ),
      lastUsedAt: now,
    });
  },
});

export const listRecentCaptures = query({
  args: { sessionToken: v.string(), deviceId: v.string() },
  handler: async (
    ctx,
    args,
  ): Promise<
    Array<{
      captureId: Id<"captureStationCaptures">;
      mediaType: "image" | "video";
      thumbUrl: string | null;
      durationMs: number | null;
      videoUrl: string | null;
      createdAt: number;
      scholarIds: Array<Id<"users">>;
      scholarNames: string[];
      label: string | null;
      editable: boolean;
    }>
  > => {
    const { station } = await capability(
      ctx,
      args.sessionToken,
      args.deviceId,
    );
    const captures = (
      await ctx.db
        .query("captureStationCaptures")
        .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
        .order("desc")
        .take(60)
    )
      .filter((capture) => capture.undoneAt === undefined)
      .slice(0, 30);

    return await Promise.all(
      captures.map(async (capture) => {
        const isImage = capture.mimeType.startsWith("image/");
        const [item, scholars] = await Promise.all([
          ctx.db.get(capture.portfolioItemId),
          Promise.all(capture.scholarIds.map((scholarId) => ctx.db.get(scholarId))),
        ]);
        const thumbId =
          item?.thumbStatus === "ready" && item.thumbStorageId
            ? item.thumbStorageId
            : capture.storageId;

        return {
          captureId: capture._id,
          mediaType: isImage ? "image" : "video",
          thumbUrl: isImage
            ? await ctx.storage.getUrl(thumbId)
            : capture.videoThumbStorageId
              ? await ctx.storage.getUrl(capture.videoThumbStorageId)
              : null,
          durationMs: capture.videoDurationMs ?? null,
          videoUrl: isImage ? null : await ctx.storage.getUrl(capture.storageId),
          createdAt: capture.createdAt,
          scholarIds: capture.scholarIds,
          scholarNames: scholars
            .filter((scholar): scholar is Doc<"users"> => scholar !== null)
            .map(captureRosterName),
          // The human-assigned name a scholar/staffer gave this work, prefilled
          // back into the editor's name field. undefined (never set / cleared)
          // shows as an empty field, not the auto-synthesized title.
          label: item?.label ?? null,
          // The capture is still an uncurated staff-only item, so re-tag/
          // delete will be accepted. Mirrors the item-level curation gate
          // shared with updateCaptureScholars/deleteCapture.
          editable:
            !capture.undoneAt &&
            item !== null &&
            item.familyVisibility === "staff_only" &&
            !item.assignmentId &&
            !item.activityId,
        };
      }),
    );
  },
});

export const updateCaptureScholars = mutation({
  args: {
    sessionToken: v.string(),
    deviceId: v.string(),
    captureId: v.id("captureStationCaptures"),
    scholarIds: v.array(v.id("users")),
  },
  handler: async (ctx, args) => {
    const { station } = await capability(ctx, args.sessionToken, args.deviceId);
    const capture = await ctx.db.get(args.captureId);
    if (
      !capture ||
      capture.captureStationId !== station._id ||
      capture.undoneAt
    ) {
      throw new Error("This capture can no longer be edited.");
    }
    const item = await ctx.db.get(capture.portfolioItemId);
    if (
      !item ||
      item.familyVisibility !== "staff_only" ||
      item.assignmentId ||
      item.activityId
    ) {
      throw new Error("This capture has already been curated.");
    }
    const { scholars } = await groupRoster(ctx, station);
    const allowed = new Set(scholars.map((scholar) => String(scholar._id)));
    const scholarIds = [
      ...new Map(args.scholarIds.map((id) => [String(id), id])).values(),
    ];
    if (!scholarIds.length || scholarIds.some((id) => !allowed.has(String(id)))) {
      throw new Error("Choose one or more scholars in this group.");
    }
    const nextIds = new Set(scholarIds.map(String));
    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) =>
        q.eq("portfolioItemId", capture.portfolioItemId),
      )
      .collect();
    const existingIds = new Set<string>();
    for (const attribution of attributions) {
      if (nextIds.has(String(attribution.scholarId))) {
        existingIds.add(String(attribution.scholarId));
      } else {
        await ctx.db.delete(attribution._id);
      }
    }
    const now = Date.now();
    for (const scholarId of scholarIds) {
      if (!existingIds.has(String(scholarId))) {
        await ctx.db.insert("portfolioAttributions", {
          portfolioItemId: capture.portfolioItemId,
          scholarId,
          attributedAt: now,
        });
      }
    }
    await ctx.db.patch(capture._id, { scholarIds });
    await ctx.db.patch(capture.portfolioItemId, { scholarId: scholarIds[0] });
    return { ok: true as const };
  },
});

export const setCaptureLabel = mutation({
  args: {
    sessionToken: v.string(),
    deviceId: v.string(),
    captureId: v.id("captureStationCaptures"),
    label: v.string(),
  },
  // The scholar naming a capture on the kiosk and a staffer naming it in the
  // uploads queue write the SAME portfolioItems.label field — last-writer-wins.
  // We deliberately do NOT software-enforce which one wins: a teacher is in the
  // room and can rename in the queue, so per .claude/rules/necessity-bar.md
  // rule 6 we don't encode a norm a present adult already enforces. This is a
  // human writer of a human-only field; no AI/extraction path ever writes label.
  handler: async (ctx, args) => {
    const { station } = await capability(ctx, args.sessionToken, args.deviceId);
    // Naming is a separate, explicit action from capturing, so rejecting a bad
    // label here only fails THIS call — it never corrupts or blocks a capture.
    const label = args.label.trim();
    // Count user-perceived characters (grapheme clusters), NOT UTF-16 code
    // units, so a scholar naming a capture in emoji isn't rejected at half the
    // visible length. This is the SAME count the native input clamps to.
    if (labelGraphemeCount(label) > LABEL_MAX_LENGTH) {
      throw new Error(`Keep the name to ${LABEL_MAX_LENGTH} characters or fewer.`);
    }
    const capture = await ctx.db.get(args.captureId);
    if (
      !capture ||
      capture.captureStationId !== station._id ||
      capture.undoneAt
    ) {
      throw new Error("This capture can no longer be named.");
    }
    const item = await ctx.db.get(capture.portfolioItemId);
    if (
      !item ||
      item.familyVisibility !== "staff_only" ||
      item.assignmentId ||
      item.activityId
    ) {
      throw new Error("This capture has already been curated.");
    }
    // Empty/whitespace-only clears the label (patch to undefined removes it),
    // mirroring the staff path's `trim() || undefined`.
    await ctx.db.patch(capture.portfolioItemId, { label: label || undefined });
    return { ok: true as const };
  },
});

export const deleteCapture = mutation({
  args: {
    sessionToken: v.string(),
    deviceId: v.string(),
    captureId: v.id("captureStationCaptures"),
  },
  handler: async (ctx, args) => {
    const { station } = await capability(ctx, args.sessionToken, args.deviceId);
    const capture = await ctx.db.get(args.captureId);
    if (
      !capture ||
      capture.captureStationId !== station._id ||
      capture.undoneAt
    ) {
      throw new Error("This capture can no longer be deleted.");
    }
    const item = await ctx.db.get(capture.portfolioItemId);
    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) =>
        q.eq("portfolioItemId", capture.portfolioItemId),
      )
      .collect();
    const currentScholarIds = attributions
      .map((attribution) => String(attribution.scholarId))
      .sort();
    const capturedScholarIds = capture.scholarIds.map(String).sort();
    const attachments = await ctx.db
      .query("parentMessageAttachments")
      .withIndex("by_storage", (q) => q.eq("storageId", capture.storageId))
      .take(1);
    const deliverables = await ctx.db
      .query("deliverables")
      .withIndex("by_portfolioItem", (q) =>
        q.eq("portfolioItemId", capture.portfolioItemId),
      )
      .take(1);
    if (
      !item ||
      item.familyVisibility !== "staff_only" ||
      item.assignmentId ||
      item.activityId ||
      attachments.length > 0 ||
      deliverables.length > 0 ||
      currentScholarIds.length !== capturedScholarIds.length ||
      currentScholarIds.some((id, index) => id !== capturedScholarIds[index])
    ) {
      throw new Error("This capture has already been curated and cannot be deleted.");
    }
    for (const attribution of attributions) {
      await ctx.db.delete(attribution._id);
    }
    await ctx.db.delete(capture.portfolioItemId);
    await reconcilePortfolioMaterialization(ctx, capture.portfolioItemId);
    for (const storageId of new Set([
      capture.storageId,
      item.thumbStorageId,
      item.magicStorageId,
      item.magicThumbStorageId,
      capture.videoThumbStorageId,
    ])) {
      if (storageId) await ctx.storage.delete(storageId);
    }
    const now = Date.now();
    await ctx.db.patch(capture._id, { undoneAt: now, scholarIds: [] });
    const owningSession = await ctx.db.get(capture.sessionId);
    if (owningSession) {
      await ctx.db.patch(owningSession._id, {
        uploadUrlsIssued: Math.max(0, (owningSession.uploadUrlsIssued ?? 0) - 1),
        capturesRegistered: Math.max(
          0,
          (owningSession.capturesRegistered ?? 0) - 1,
        ),
        registeredBytes: Math.max(
          0,
          (owningSession.registeredBytes ?? 0) - capture.sizeBytes,
        ),
        lastUsedAt: now,
      });
    }
  },
});

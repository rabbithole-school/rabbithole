import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";

import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { emptyHealthRecordFields } from "../lib/healthRecord";
import { sha256Hex } from "../lib/oauthCrypto";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

async function staff(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
) {
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name: "Capture staff",
      username: "capture-staff",
      role: "teacher",
    }),
  );
  const sessionId = await t.run(async (ctx) => {
    await ctx.db.insert("memberships", {
      userId,
      institutionId,
      role: "teacher",
    });
    return await ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    });
  });

  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function grantCaptureReview(
  t: ReturnType<typeof convexTest>,
  groupId: Id<"scholarGroups">,
  {
    userId,
    capability = "captures:review",
    revokedAt,
  }: {
    userId?: Id<"users">;
    capability?: "captures:review" | "program:publish";
    revokedAt?: number;
  } = {},
) {
  return await t.run(async (ctx) => {
    const group = await ctx.db.get(groupId);
    if (!group?.institutionId) throw new Error("Missing test group");
    return await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: userId ?? group.teacherId,
      institutionId: group.institutionId,
      scholarGroupId: groupId,
      capability,
      grantedBy: group.teacherId,
      grantedAt: Date.now(),
      revokedAt,
    });
  });
}

async function setup() {
  const t = convexTest(schema, modules);
  const institutionId = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Moli",
      slug: "moli",
      kind: "school",
    }),
  );
  const otherInstitutionId = await t.run((ctx) =>
    ctx.db.insert("institutions", {
      name: "Other",
      slug: "other",
      kind: "school",
    }),
  );
  const owner = await staff(t, institutionId);
  const [scholarA, scholarB, outsider] = await t.run(async (ctx) => [
    await ctx.db.insert("users", {
      name: "Ada",
      username: "ada",
      role: "scholar",
      institutionId,
    }),
    await ctx.db.insert("users", {
      name: "Lin",
      username: "lin",
      role: "scholar",
      institutionId,
    }),
    await ctx.db.insert("users", {
      name: "Outsider",
      username: "outsider",
      role: "scholar",
      institutionId: otherInstitutionId,
    }),
  ]);
  const { guardianId, consentRecordIds } = await t.run(async (ctx) => {
    const guardianId = await ctx.db.insert("users", {
      name: "Capture parent",
      username: "capture-parent",
      role: "parent",
    });
    const consentRecordIds = [];
    for (const [scholarId, childName, publicMediaOptOut] of [
      [scholarA, "Ada", false],
      [scholarB, "Lin", true],
    ] as const) {
      await ctx.db.insert("guardianships", {
        parentUserId: guardianId,
        scholarUserId: scholarId,
        createdBy: guardianId,
      });
      consentRecordIds.push(
        await ctx.db.insert("scholarHealthRecords", {
          scholarId,
          guardianId,
          ...emptyHealthRecordFields({
            childName,
            guardianName: "Capture parent",
          }),
          publicMediaOptOut,
          privateSchoolMediaOptOut: false,
          signerName: "Capture parent",
          signerAgreement: true,
          signerUserId: guardianId,
          signedAt: Date.now(),
          submittedAt: Date.now(),
          standardProgramAcknowledgedAt: Date.now(),
          revision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
    }
    return { guardianId, consentRecordIds };
  });
  const groupId = await owner.mutation(api.scholarGroups.create, {
    name: "Robotics",
    type: "robotics",
    participation: "includes_program_guests",
    scholarIds: [scholarA, scholarB],
  });
  await grantCaptureReview(t, groupId);
  const enrollment = await owner.mutation(
    api.captureStations.createOrRotateForGroup,
    { scholarGroupId: groupId, label: "Robotics capture" },
  );
  const session = await t.mutation(
    api.captureStations.exchangeEnrollmentToken,
    {
      token: enrollment.enrollmentToken,
      deviceId: "capture-ipad-01",
    },
  );
  return {
    t,
    owner,
    institutionId,
    otherInstitutionId,
    scholarA,
    scholarB,
    outsider,
    groupId,
    enrollment,
    session,
    guardianId,
    consentRecordIds,
  };
}

async function seedAssignedManagedDevice(
  t: ReturnType<typeof convexTest>,
  institutionId: Id<"institutions">,
  scholarId: Id<"users">,
  deviceId = "assigned-capture-ipad-01",
) {
  const now = Date.now();
  const authSessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId: scholarId,
      expirationTime: now + 60 * 60 * 1000,
    }),
  );
  const managedDeviceId = await t.run((ctx) =>
    ctx.db.insert("managedDeviceClaims", {
      institutionId,
      serial: "CAPTUREASSIGNED01",
      scholarId,
      claimTokenHash: "not-a-real-token",
      claimState: "claimed",
      createdBy: scholarId,
      createdAt: now,
      updatedAt: now,
      claimIssuedAt: now,
      rotationCount: 0,
      claimCount: 1,
      lastDeviceId: deviceId,
    }),
  );
  const pairedDeviceId = await t.run((ctx) =>
    ctx.db.insert("pairedDevices", {
      institutionId,
      deviceId,
      scholarId,
      pairedAt: now,
      pairedBy: scholarId,
      managedDeviceClaimId: managedDeviceId,
      authSessionId,
    }),
  );
  return {
    managedDeviceId,
    pairedDeviceId,
    asDevice: t.withIdentity({
      subject: `${scholarId}|${authSessionId}`,
      issuer: "https://convex.dev",
    }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

async function reserveUploadedBlob(
  t: ReturnType<typeof convexTest>,
  sessionToken: string,
  contents = "robot",
  mimeType = "image/jpeg",
) {
  const reservation = await t.mutation(
    api.captureStations.generateUploadUrl,
    {
      sessionToken,
      deviceId: "capture-ipad-01",
    },
  );
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([contents], { type: mimeType })),
  );
  const metadata = await t.run((ctx) =>
    ctx.db.system.get("_storage", storageId),
  );
  if (!metadata) throw new Error("Missing test storage metadata");
  const recorded = await t.mutation(api.captureStations.recordUploadedBlob, {
    sessionToken,
    deviceId: "capture-ipad-01",
    reservationId: reservation.reservationId,
    storageId,
    mimeType: metadata.contentType ?? mimeType,
    sizeBytes: metadata.size,
  });
  expect(recorded).toEqual({ accepted: true });
  return { reservationId: reservation.reservationId, storageId, metadata };
}

/**
 * Stores a blob AND stamps the Content-Type the real backend records from the
 * upload request. convex-test's in-memory storage tracks only size + sha256
 * (`storage/storeBlob`), so without this the poster contract — which requires a
 * declared image content type — could never be exercised.
 */
async function storeBlobWithContentType(
  t: ReturnType<typeof convexTest>,
  contents: BlobPart,
  contentType: string,
) {
  const storageId = await t.run((ctx) =>
    ctx.storage.store(new Blob([contents], { type: contentType })),
  );
  await t.run(async (ctx) => {
    await (
      ctx.db as unknown as {
        patch: (
          id: Id<"_storage">,
          value: { contentType: string },
        ) => Promise<void>;
      }
    ).patch(storageId, { contentType });
  });
  const metadata = await t.run((ctx) =>
    ctx.db.system.get("_storage", storageId),
  );
  if (!metadata) throw new Error("Missing test storage metadata");
  return { storageId, metadata };
}

/** The real client poster path: reserve → upload → report. */
async function reservePosterBlob(
  t: ReturnType<typeof convexTest>,
  sessionToken: string,
  {
    deviceId = "capture-ipad-01",
    contents = "poster-bytes" as BlobPart,
    contentType = "image/jpeg",
  } = {},
) {
  const upload = await t.mutation(
    api.captureStations.generatePosterUploadUrl,
    { sessionToken, deviceId },
  );
  expect(upload.uploadUrl).toBeTypeOf("string");
  const { storageId, metadata } = await storeBlobWithContentType(
    t,
    contents,
    contentType,
  );
  const recorded = await t.mutation(api.captureStations.recordUploadedBlob, {
    sessionToken,
    deviceId,
    reservationId: upload.reservationId,
    storageId,
    mimeType: contentType,
    sizeBytes: metadata.size,
  });
  return {
    reservationId: upload.reservationId,
    storageId,
    metadata,
    recorded,
  };
}

describe("capture stations", () => {
  test("a scoped curriculum designer can administer only their program station", async () => {
    const { t, groupId } = await setup();
    const specialistId = await t.run(async (ctx) => {
      const group = await ctx.db.get(groupId);
      if (!group?.institutionId) throw new Error("Missing test group");
      const userId = await ctx.db.insert("users", {
        name: "Program specialist",
        username: "program-specialist",
        role: "curriculum_designer",
      });
      await ctx.db.insert("memberships", {
        userId,
        institutionId: group.institutionId,
        role: "curriculum_designer",
      });
      return userId;
    });
    await grantCaptureReview(t, groupId, { userId: specialistId });
    const specialist = await withUser(t, specialistId);

    await expect(
      specialist.query(api.captureStations.listForSchool, {}),
    ).resolves.toEqual([{ groupId, groupName: "Robotics" }]);
    await expect(
      specialist.query(api.captureStations.statusForGroup, {
        scholarGroupId: groupId,
      }),
    ).resolves.toMatchObject({ enabled: true, rosterCount: 2 });
    await expect(
      specialist.mutation(api.captureStations.createOrRotateForGroup, {
        scholarGroupId: groupId,
        label: "Robotics capture",
      }),
    ).rejects.toThrow(/scholar-admin role/i);
  });

  test("requires explicit guest participation and supports non-robotics programs", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await t.run((ctx) =>
      ctx.db.insert("institutions", { name: "Moli", slug: "moli", kind: "school" }),
    );
    const owner = await staff(t, institutionId);
    const scholar = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Guest",
        username: "guest",
        role: "scholar",
        institutionId,
      }),
    );
    const robotics = await owner.mutation(api.scholarGroups.create, {
      name: "Robotics",
      type: "robotics",
      scholarIds: [scholar],
    });
    await expect(
      owner.mutation(api.captureStations.createOrRotateForGroup, {
        scholarGroupId: robotics,
        label: "Robotics capture",
      }),
    ).rejects.toThrow(/includes Extended Education/i);
    expect(await owner.query(api.captureStations.listForSchool, {})).toEqual([]);

    const drama = await owner.mutation(api.scholarGroups.create, {
      name: "Drama workshop",
      type: "drama",
      participation: "includes_program_guests",
      scholarIds: [scholar],
    });
    await grantCaptureReview(t, drama);
    await expect(
      owner.mutation(api.captureStations.createOrRotateForGroup, {
        scholarGroupId: drama,
        label: "Drama capture",
      }),
    ).resolves.toMatchObject({ captureStationId: expect.any(String) });
    await expect(
      owner.query(api.captureStations.statusForGroup, { scholarGroupId: drama }),
    ).resolves.toMatchObject({ label: "Drama capture" });
    await expect(
      owner.mutation(api.scholarGroups.setScholars, {
        groupId: drama,
        scholarIds: [scholar],
        participation: "enrolled_only",
      }),
    ).rejects.toThrow(/must remain an Extended education group/i);
  });

  test("lists only guest-participation groups in the active institution", async () => {
    const t = convexTest(schema, modules);
    const moli = await t.run((ctx) =>
      ctx.db.insert("institutions", { name: "Moli", slug: "moli", kind: "school" }),
    );
    const kona = await t.run((ctx) =>
      ctx.db.insert("institutions", { name: "Kona", slug: "kona", kind: "school" }),
    );
    const owner = await staff(t, moli);
    const [moliScholar, konaScholar] = await t.run(async (ctx) => [
      await ctx.db.insert("users", {
        name: "Moli scholar", username: "moli-scholar", role: "scholar", institutionId: moli,
      }),
      await ctx.db.insert("users", {
        name: "Kona scholar", username: "kona-scholar", role: "scholar", institutionId: kona,
      }),
    ]);
    const localProgram = await owner.mutation(api.scholarGroups.create, {
      name: "Local program",
      participation: "includes_program_guests",
      scholarIds: [moliScholar],
    });
    await grantCaptureReview(t, localProgram);
    await owner.mutation(api.scholarGroups.create, {
      name: "Local class",
      scholarIds: [moliScholar],
    });
    const foreignTeacher = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Foreign teacher",
        username: "foreign-teacher",
        role: "teacher",
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: foreignTeacher,
        institutionId: kona,
        name: "Foreign program",
        participation: "includes_program_guests",
        scholarIds: [konaScholar],
      }),
    );
    expect(await owner.query(api.captureStations.listForSchool, {})).toEqual([
      { groupId: localProgram, groupName: "Local program" },
    ]);
  });

  test("bootstrap exposes only the configured group's minimal roster", async () => {
    const { t, owner, session, scholarA, scholarB, groupId } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(scholarA, { image: "https://example.com/ada.jpg" }),
    );
    const bootstrap = await t.mutation(api.captureStations.bootstrap, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    expect(bootstrap).toEqual({
      label: "Robotics capture",
      groupName: "Robotics",
      deviceSettingsPath: null,
      roster: [
        { id: scholarA, name: "Ada", image: "https://example.com/ada.jpg" },
        { id: scholarB, name: "Lin", image: null },
      ],
    });
    await expect(
      owner.query(api.captureStations.statusForGroup, {
        scholarGroupId: groupId,
      }),
    ).resolves.toMatchObject({
      enabled: true,
      activeSessionCount: 1,
      rosterCount: 2,
    });
  });

  test("station roster includes every group member regardless of media consent", async () => {
    const { t, owner, groupId, consentRecordIds, scholarA, scholarB } =
      await setup();
    await t.run((ctx) =>
      ctx.db.patch(consentRecordIds[1], {
        privateSchoolMediaOptOut: true,
      }),
    );

    await expect(
      owner.query(api.captureStations.statusForGroup, {
        scholarGroupId: groupId,
      }),
    ).resolves.toMatchObject({
      rosterCount: 2,
    });

    const enrollment = await owner.mutation(
      api.captureStations.createOrRotateForGroup,
      { scholarGroupId: groupId, label: "Robotics capture" },
    );
    const session = await t.mutation(
      api.captureStations.exchangeEnrollmentToken,
      {
        token: enrollment.enrollmentToken,
        deviceId: "capture-ipad-consent",
      },
    );
    const bootstrap = await t.mutation(api.captureStations.bootstrap, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-consent",
    });
    expect(bootstrap.roster).toEqual([
      { id: scholarA, name: "Ada", image: null },
      { id: scholarB, name: "Lin", image: null },
    ]);
  });

  test("only an active capture reviewer or an admin can review captures", async () => {
    const { t, owner, institutionId, groupId, session, scholarA } =
      await setup();
    const otherStaffId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Other staff",
        username: "other-capture-staff",
        role: "teacher",
      });

      await ctx.db.insert("memberships", {
        userId,
        institutionId,
        role: "teacher",
      });
      await ctx.db.patch(groupId, { ownerId: userId });
      return userId;
    });
    const otherStaff = await withUser(t, otherStaffId);
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await expect(
      owner.query(api.portfolio.scannerFeed, { programGroupId: groupId }),
    ).resolves.toMatchObject({
      processed: expect.arrayContaining([
        expect.objectContaining({ _id: capture.portfolioItemId }),
      ]),
    });
    await expect(
      otherStaff.query(api.captureStations.listForSchool, {}),
    ).resolves.toEqual([]);
    await expect(
      otherStaff.query(api.captureStations.statusForGroup, {
        scholarGroupId: groupId,
      }),
    ).rejects.toThrow(/program group/i);
    await expect(
      otherStaff.query(api.portfolio.scannerFeed, {
        programGroupId: groupId,
      }),
    ).rejects.toThrow(/program group/i);
    await expect(
      otherStaff.query(api.portfolio.getFileUrl, {
        itemId: capture.portfolioItemId,
      }),
    ).rejects.toThrow(/program group/i);
    await expect(
      owner.query(api.portfolio.listForScholar, { scholarId: scholarA }),
    ).resolves.toEqual([]);
    await expect(
      otherStaff.query(api.portfolio.listForScholar, { scholarId: scholarA }),
    ).resolves.toEqual([]);
  });

  test("requires the active capture-review grant for this group, not publish or ownership", async () => {
    const { t, owner, institutionId, groupId, session, scholarA } = await setup();
    const ownerId = await t.run(async (ctx) => (await ctx.db.get(groupId))!.teacherId);
    const otherGroupId = await t.run((ctx) =>
      ctx.db.insert("scholarGroups", {
        teacherId: ownerId,
        institutionId,
        name: "Other program",
        participation: "includes_program_guests",
        scholarIds: [scholarA],
      }),
    );
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });
    const magicStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["magic"], { type: "image/jpeg" })),
    );
    await t.run((ctx) =>
      ctx.db.patch(capture.portfolioItemId, { magicStorageId }),
    );

    const publishOnly = await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        name: "Publisher",
        username: "capture-publisher",
        role: "teacher",
      });
      await ctx.db.insert("memberships", {
        userId,
        institutionId,
        role: "teacher",
      });
      return userId;
    });
    await grantCaptureReview(t, groupId, {
      userId: publishOnly,
      capability: "program:publish",
    });
    const asPublisher = await withUser(t, publishOnly);
    await expect(
      asPublisher.query(api.captureStations.statusForGroup, { scholarGroupId: groupId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      asPublisher.query(api.portfolio.getFileUrl, { itemId: capture.portfolioItemId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      asPublisher.query(api.portfolio.getMagicFileUrl, { itemId: capture.portfolioItemId }),
    ).rejects.toThrow(/program group/i);

    await grantCaptureReview(t, groupId, { userId: publishOnly });
    await expect(
      asPublisher.query(api.captureStations.statusForGroup, { scholarGroupId: groupId }),
    ).resolves.toMatchObject({ captureStationId: expect.any(String) });
    await expect(
      asPublisher.query(api.captureStations.statusForGroup, {
        scholarGroupId: otherGroupId,
      }),
    ).rejects.toThrow(/program group/i);

    const stationId = await t.run(async (ctx) =>
      (await ctx.db
        .query("captureStations")
        .withIndex("by_group", (q) => q.eq("scholarGroupId", groupId))
        .unique())!._id,
    );
    await t.run(async (ctx) => {
      for (const grant of await ctx.db.query("staffCapabilityGrants").collect()) {
        if (
          grant.granteeUserId === ownerId &&
          grant.scholarGroupId === groupId &&
          grant.capability === "captures:review" &&
          !grant.revokedAt
        ) {
          await ctx.db.patch(grant._id, { revokedAt: Date.now() });
        }
      }
    });
    await expect(
      owner.query(api.captureStations.statusForGroup, { scholarGroupId: groupId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      owner.mutation(api.captureStations.revoke, { captureStationId: stationId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      owner.query(api.portfolio.scannerFeed, { programGroupId: groupId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      owner.query(api.portfolio.scannerCounts, { programGroupId: groupId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      owner.query(api.portfolio.getFileUrl, { itemId: capture.portfolioItemId }),
    ).rejects.toThrow(/program group/i);
    await expect(
      owner.query(api.portfolio.getMagicFileUrl, { itemId: capture.portfolioItemId }),
    ).rejects.toThrow(/program group/i);
  });

  test("capability stops working when its group or institution is removed", async () => {
    const groupSetup = await setup();
    await groupSetup.t.run((ctx) => ctx.db.delete(groupSetup.groupId));
    await expect(
      groupSetup.t.mutation(api.captureStations.bootstrap, {
        sessionToken: groupSetup.session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/unavailable/i);

    const institutionSetup = await setup();
    await institutionSetup.t.run((ctx) =>
      ctx.db.delete(institutionSetup.institutionId),
    );
    await expect(
      institutionSetup.t.mutation(api.captureStations.bootstrap, {
        sessionToken: institutionSetup.session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  test("rejects replay from another device and sessions revoked by rotation", async () => {
    const { t, owner, groupId, session } = await setup();
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "different-device",
      }),
    ).rejects.toThrow(/expired/i);

    await owner.mutation(api.captureStations.createOrRotateForGroup, {
      scholarGroupId: groupId,
      label: "Robotics capture",
    });
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("open-reservation headroom fits one stuck video-with-poster plus one new one", async () => {
    const { t, session } = await setup();
    // A video with a poster holds TWO open reservations from mint to register.
    // The cap must leave room for a stuck pair plus a fresh pair (2×2)…
    for (let pair = 0; pair < 2; pair += 1) {
      await t.mutation(api.captureStations.generateUploadUrl, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      });
      await t.mutation(api.captureStations.generatePosterUploadUrl, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      });
    }
    // …and refuse the fifth open reservation in the scope.
    await expect(
      t.mutation(api.captureStations.generateUploadUrl, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toMatchObject({ data: { kind: "upload_pending_quota" } });
  });

  test("keeps a prior same-device session through an issued or uploaded reservation", async () => {
    const { t, enrollment, session, scholarA } = await setup();
    const reservation = await t.mutation(api.captureStations.generateUploadUrl, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["robot"], { type: "image/jpeg" })),
    );
    const metadata = await t.run((ctx) => ctx.db.system.get("_storage", storageId));
    if (!metadata) throw new Error("Missing test storage metadata");

    const replacement = await t.mutation(api.captureStations.exchangeEnrollmentToken, {
      token: enrollment.enrollmentToken,
      deviceId: "capture-ipad-01",
    });
    await expect(
      t.mutation(api.captureStations.recordUploadedBlob, {
        sessionToken: replacement.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: reservation.reservationId,
        storageId,
        mimeType: metadata.contentType ?? "image/jpeg",
        sizeBytes: metadata.size,
      }),
    ).resolves.toEqual({ accepted: true });

    const secondReplacement = await t.mutation(api.captureStations.exchangeEnrollmentToken, {
      token: enrollment.enrollmentToken,
      deviceId: "capture-ipad-01",
    });
    await expect(
      t.mutation(api.captureStations.registerCapture, {
        sessionToken: secondReplacement.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: reservation.reservationId,
        scholarIds: [scholarA],
      }),
    ).resolves.toMatchObject({ captureId: expect.any(String) });
  });

  test("keeps an interrupted same-device upload recoverable through station rotation", async () => {
    const { t, owner, groupId, session, scholarA } = await setup();
    const reservation = await t.mutation(api.captureStations.generateUploadUrl, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["rotating robot"], { type: "image/jpeg" })),
    );
    const metadata = await t.run((ctx) => ctx.db.system.get("_storage", storageId));
    if (!metadata) throw new Error("Missing test storage metadata");

    const replacement = await owner.mutation(api.captureStations.createOrRotateForGroup, {
      scholarGroupId: groupId,
      label: "Rotated robotics capture",
    });
    await t.mutation(api.captureStations.exchangeEnrollmentToken, {
      token: replacement.enrollmentToken,
      deviceId: "capture-ipad-01",
    });
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/recovering an upload/i);
    await expect(
      t.mutation(api.captureStations.recordUploadedBlob, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: reservation.reservationId,
        storageId,
        mimeType: metadata.contentType ?? "image/jpeg",
        sizeBytes: metadata.size,
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      t.mutation(api.captureStations.registerCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: reservation.reservationId,
        scholarIds: [scholarA],
      }),
    ).resolves.toMatchObject({ captureId: expect.any(String) });
  });

  test("same-device enrollment rotation revokes an idle prior session", async () => {
    const { t, enrollment, session } = await setup();
    const replacement = await t.mutation(api.captureStations.exchangeEnrollmentToken, {
      token: enrollment.enrollmentToken,
      deviceId: "capture-ipad-01",
    });

    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/expired/i);
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: replacement.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).resolves.toMatchObject({ roster: expect.any(Array) });
  });

  test("bounds repeated same-device session minting within one enrollment window", async () => {
    const { t, enrollment, session } = await setup();
    await t.mutation(api.captureStations.exchangeEnrollmentToken, {
      token: enrollment.enrollmentToken,
      deviceId: "capture-ipad-01",
    });
    await t.mutation(api.captureStations.exchangeEnrollmentToken, {
      token: enrollment.enrollmentToken,
      deviceId: "capture-ipad-01",
    });
    await expect(
      t.mutation(api.captureStations.exchangeEnrollmentToken, {
        token: enrollment.enrollmentToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toMatchObject({ data: { kind: "capture_session_quota" } });
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("suspending a station's institution denies enrollment and active capabilities", async () => {
    const { t, enrollment, institutionId, session } = await setup();
    await t.run((ctx) =>
      ctx.db.patch(institutionId, { disabledAt: Date.now() }),
    );

    await expect(
      t.mutation(api.captureStations.exchangeEnrollmentToken, {
        token: enrollment.enrollmentToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/unavailable/i);
    await expect(
      t.mutation(api.captureStations.generateUploadUrl, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  test("binds an enrollment token to its first iPad and rejects fresh-device minting", async () => {
    const { t, enrollment, groupId, session } = await setup();

    for (const deviceId of [
      "leaked-ipad-01",
      "leaked-ipad-02",
      "leaked-ipad-03",
    ]) {
      await expect(
        t.mutation(api.captureStations.exchangeEnrollmentToken, {
          token: enrollment.enrollmentToken,
          deviceId,
        }),
      ).rejects.toMatchObject({ data: { kind: "enrollment_device_bound" } });
    }

    const { station, sessions } = await t.run(async (ctx) => {
      const station = await ctx.db
        .query("captureStations")
        .withIndex("by_group", (q) => q.eq("scholarGroupId", groupId))
        .unique();
      if (!station) throw new Error("Missing capture station");
      return {
        station,
        sessions: await ctx.db
          .query("captureStationSessions")
          .withIndex("by_station", (q) =>
            q.eq("captureStationId", station._id),
          )
          .collect(),
      };
    });
    expect(station.enrolledDeviceIdHash).toBeTruthy();
    expect(station.enrolledDeviceIdHash).not.toBe("capture-ipad-01");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionTokenHash).not.toBe(session.sessionToken);
  });

  test("stores one capture with one attribution per selected scholar", async () => {
    const { t, owner, session, scholarA, scholarB, institutionId } = await setup();
    const nonmember = await t.run((ctx) =>
      ctx.db.insert("users", {
        name: "Nonmember",
        username: "nonmember",
        role: "scholar",
        institutionId,
      }),
    );
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const result = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA, scholarB],
    });
    const [items, attributions] = await t.run(async (ctx) => [
      await ctx.db.query("portfolioItems").collect(),
      await ctx.db
        .query("portfolioAttributions")
        .withIndex("by_item", (q) =>
          q.eq("portfolioItemId", result.portfolioItemId),
        )
        .collect(),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].familyVisibility).toBe("staff_only");
    expect(new Set(attributions.map((row) => row.scholarId))).toEqual(
      new Set([scholarA, scholarB]),
    );
    await expect(
      owner.mutation(api.portfolio.setAttributions, {
        itemId: result.portfolioItemId,
        scholarIds: [scholarA, nonmember],
      }),
    ).rejects.toThrow(/program group/i);

    const provenanceLessItemId = await t.run((ctx) =>
      ctx.db.insert("portfolioItems", {
        scholarId: scholarA,
        institutionId,
        title: "Orphaned capture",
        source: "capture_station",
        matchStatus: "confirmed",
        assignmentStatus: "none",
        processingStatus: "ready",
      }),
    );
    await expect(
      owner.mutation(api.portfolio.setAttributions, {
        itemId: provenanceLessItemId,
        scholarIds: [scholarA],
      }),
    ).rejects.toThrow(/provenance/i);
  });

  test("rejects cross-group tags and mismatched storage metadata", async () => {
    const { t, session, scholarA, outsider } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    await expect(
      t.mutation(api.captureStations.registerCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: upload.reservationId,
        scholarIds: [scholarA, outsider],
      }),
    ).rejects.toThrow(/scholars? in this group/i);

    const reservation = await t.mutation(
      api.captureStations.generateUploadUrl,
      {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      },
    );
    const mismatchedStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["robot"], { type: "image/jpeg" })),
    );
    const metadata = await t.run((ctx) =>
      ctx.db.system.get("_storage", mismatchedStorageId),
    );
    if (!metadata) throw new Error("Missing test storage metadata");
    await expect(
      t.mutation(api.captureStations.recordUploadedBlob, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: reservation.reservationId,
        storageId: mismatchedStorageId,
        mimeType: metadata.contentType ?? "image/jpeg",
        sizeBytes: metadata.size + 1,
      }),
    ).resolves.toEqual({ accepted: false });
    await t.mutation(internal.captureStations.cleanupUploadReservation, {
      reservationId: reservation.reservationId,
    });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", mismatchedStorageId)),
    ).toBeNull();
  });

  test("rejects an existing unowned blob without deleting it", async () => {
    const { t, session } = await setup();
    const storageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["someone else's photo"], { type: "image/jpeg" })),
    );
    const metadata = await t.run((ctx) => ctx.db.system.get("_storage", storageId));
    if (!metadata) throw new Error("Missing test storage metadata");
    const reservation = await t.mutation(api.captureStations.generateUploadUrl, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    await t.run((ctx) =>
      ctx.db.patch(reservation.reservationId, {
        createdAt: metadata._creationTime + 1,
      }),
    );

    await expect(
      t.mutation(api.captureStations.recordUploadedBlob, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: reservation.reservationId,
        storageId,
        mimeType: metadata.contentType ?? "image/jpeg",
        sizeBytes: metadata.size,
      }),
    ).rejects.toThrow(/does not belong/i);
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", storageId)),
    ).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get(reservation.reservationId)),
    ).toMatchObject({ status: "issued" });
  });

  test("allows classroom attribution without allowing unconsented family sharing", async () => {
    const { t, owner, session, scholarA, scholarB, consentRecordIds } =
      await setup();
    await t.run((ctx) =>
      ctx.db.patch(consentRecordIds[1], { privateSchoolMediaOptOut: true }),
    );
    const bootstrap = await t.mutation(api.captureStations.bootstrap, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    expect(bootstrap.roster).toEqual([
      { id: scholarA, name: "Ada", image: null },
      { id: scholarB, name: "Lin", image: null },
    ]);

    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarB],
    });
    await expect(
      owner.mutation(api.portfolio.setFamilyVisibility, {
        itemId: capture.portfolioItemId,
        familyVisibility: "attributed_families",
      }),
    ).rejects.toThrow(/signed media consent/i);
  });

  test("lists current station captures with thumbnails, scholarIds, and undo", async () => {
    const { t, session, scholarA, scholarB } = await setup();
    const register = async (scholarId: Id<"users">, mimeType = "image/jpeg") => {
      const upload = await reserveUploadedBlob(
        t,
        session.sessionToken,
        "robot",
        mimeType,
      );
      return await t.mutation(api.captureStations.registerCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: upload.reservationId,
        scholarIds: [scholarId],
      });
    };

    const image = await register(scholarA);
    const video = await register(scholarB, "video/mp4");
    const recent = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });

    expect(recent.map((capture) => capture.captureId)).toEqual([
      video.captureId,
      image.captureId,
    ]);
    expect(recent[0]).toMatchObject({
      captureId: video.captureId,
      mediaType: "video",
      thumbUrl: null,
      durationMs: null,
      scholarIds: [scholarB],
      scholarNames: ["Lin"],
      editable: true,
    });
    expect(recent[0].videoUrl).not.toBeNull();
    expect(recent[1]).toMatchObject({
      captureId: image.captureId,
      mediaType: "image",
      durationMs: null,
      videoUrl: null,
      scholarIds: [scholarA],
      scholarNames: ["Ada"],
      editable: true,
    });
    expect(recent[1].thumbUrl).not.toBeNull();

    const undone = await register(scholarA);
    await t.mutation(api.captureStations.undoCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: undone.captureId,
    });
    const afterUndo = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    expect(afterUndo.map((capture) => capture.captureId)).not.toContain(
      undone.captureId,
    );
  });

  test("registers a video capture with a poster thumbnail and duration", async () => {
    const { t, session, scholarB } = await setup();
    const upload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "movie-bytes",
      "video/mp4",
    );
    const poster = await reservePosterBlob(t, session.sessionToken);
    expect(poster.recorded).toEqual({ accepted: true });

    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarB],
      videoDurationMs: 4200,
      posterReservationId: poster.reservationId,
    });

    // The poster is metered by its own reservation, which this capture claims.
    expect(
      await t.run((ctx) => ctx.db.get(poster.reservationId)),
    ).toMatchObject({
      purpose: "poster",
      status: "finalized",
      captureId: capture.captureId,
    });
    const recent = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const row = recent.find((c) => c.captureId === capture.captureId);
    expect(row).toBeDefined();
    expect(row?.mediaType).toBe("video");
    expect(row?.durationMs).toBe(4200);
    expect(row?.thumbUrl).not.toBeNull();
    expect(row?.videoUrl).not.toBeNull();
  });

  test("a poster upload URL is metered and its unclaimed blob is swept", async () => {
    const { t, session } = await setup();
    const poster = await reservePosterBlob(t, session.sessionToken);
    expect(poster.recorded).toEqual({ accepted: true });
    const capabilitySession = await t.run(async (ctx) => {
      const reservation = await ctx.db.get(poster.reservationId);
      return reservation ? await ctx.db.get(reservation.sessionId) : null;
    });
    expect(capabilitySession).toMatchObject({ uploadUrlsIssued: 1 });

    // Never claimed by a capture (the client dropped it): the ordinary expiry
    // path deletes the blob rather than orphaning it.
    await t.run((ctx) =>
      ctx.db.patch(poster.reservationId, { expiresAt: Date.now() - 1 }),
    );
    await t.mutation(internal.captureStations.cleanupUploadReservation, {
      reservationId: poster.reservationId,
    });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", poster.storageId)),
    ).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(poster.reservationId))).toBeNull();
  });

  test("a poster reservation cannot stand in for the capture's own media", async () => {
    const { t, session, scholarA } = await setup();
    const poster = await reservePosterBlob(t, session.sessionToken);
    expect(poster.recorded).toEqual({ accepted: true });

    await expect(
      t.mutation(api.captureStations.registerCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: poster.reservationId,
        scholarIds: [scholarA],
      }),
    ).rejects.toThrow(/not ready/i);
  });

  test("ignores an invalid poster (oversized blob) rather than failing the capture", async () => {
    const { t, session, scholarB } = await setup();
    const upload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "movie-bytes",
      "video/mp4",
    );
    const poster = await reservePosterBlob(t, session.sessionToken, {
      contents: new Uint8Array(2 * 1024 * 1024 + 1),
    });
    // Oversized: the report is refused, so the reservation never reaches the
    // "uploaded" state a capture can claim.
    expect(poster.recorded).toEqual({ accepted: false });

    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarB],
      videoDurationMs: 1000,
      posterReservationId: poster.reservationId,
    });

    const recent = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const row = recent.find((c) => c.captureId === capture.captureId);
    expect(row).toBeDefined();
    expect(row?.thumbUrl).toBeNull();
    expect(row?.durationMs).toBe(1000);
  });

  test("a poster blob failing provenance is dropped, not attached", async () => {
    const { t, session, scholarB } = await setup();
    const upload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "movie-bytes",
      "video/mp4",
    );
    const poster = await reservePosterBlob(t, session.sessionToken);
    // A blob that predates its reservation cannot have come from that upload
    // URL, so register refuses it — silently, and reclaims the reservation.
    await t.run((ctx) =>
      ctx.db.patch(poster.reservationId, {
        createdAt: poster.metadata._creationTime + 1,
      }),
    );

    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarB],
      posterReservationId: poster.reservationId,
    });

    const stored = await t.run((ctx) => ctx.db.get(capture.captureId));
    expect(stored?.videoThumbStorageId).toBeUndefined();
    expect(
      await t.run((ctx) => ctx.db.get(poster.reservationId)),
    ).toMatchObject({ status: "cancelled" });
  });

  test("cannot nominate another capture's poster and then delete it", async () => {
    const { t, session, scholarA, scholarB } = await setup();
    const firstUpload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "movie-one",
      "video/mp4",
    );
    const poster = await reservePosterBlob(t, session.sessionToken);
    const first = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: firstUpload.reservationId,
      scholarIds: [scholarA],
      posterReservationId: poster.reservationId,
    });

    const secondUpload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "movie-two",
      "video/mp4",
    );
    const second = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: secondUpload.reservationId,
      scholarIds: [scholarB],
      posterReservationId: poster.reservationId,
    });
    expect(second.captureId).not.toBe(first.captureId);
    const secondStored = await t.run((ctx) => ctx.db.get(second.captureId));
    expect(secondStored?.videoThumbStorageId).toBeUndefined();

    // Deleting the second capture must not take the first capture's poster
    // blob with it — the deletion oracle the raw-storage-id contract allowed.
    await t.mutation(api.captureStations.deleteCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: second.captureId,
    });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", poster.storageId)),
    ).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get(first.captureId)),
    ).toMatchObject({ videoThumbStorageId: poster.storageId });
  });

  test("refuses a poster reservation issued to another capability session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
    const { t, owner, institutionId, scholarA, scholarB, enrollment, session } =
      await setup();
    const { pairedDeviceId, asDevice } = await seedAssignedManagedDevice(
      t,
      institutionId,
      scholarA,
    );
    const mode = await owner.mutation(
      api.captureStations.setAssignedDeviceCaptureMode,
      {
        pairedDeviceId,
        captureStationId: enrollment.captureStationId,
        enabled: true,
      },
    );
    const temporarySession = await asDevice.mutation(
      api.captureStations.startAssignedDeviceCapture,
      {
        deviceId: "assigned-capture-ipad-01",
        expectedUpdatedAt: mode.updatedAt!,
      },
    );
    // A poster reserved by the assigned iPad's own session…
    const foreignPoster = await reservePosterBlob(
      t,
      temporarySession.sessionToken,
      { deviceId: "assigned-capture-ipad-01" },
    );
    expect(foreignPoster.recorded).toEqual({ accepted: true });

    // …is not usable by the dedicated station's session.
    const upload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "movie-bytes",
      "video/mp4",
    );
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarB],
      posterReservationId: foreignPoster.reservationId,
    });

    const foreignStored = await t.run((ctx) => ctx.db.get(capture.captureId));
    expect(foreignStored?.videoThumbStorageId).toBeUndefined();
    // The other session's reservation is left untouched, not reclaimed.
    expect(
      await t.run((ctx) => ctx.db.get(foreignPoster.reservationId)),
    ).toMatchObject({ status: "uploaded" });
    expect(
      await t.run((ctx) =>
        ctx.db.system.get("_storage", foreignPoster.storageId),
      ),
    ).not.toBeNull();
  });

  test("ignores poster and duration on a photo capture", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const poster = await reservePosterBlob(t, session.sessionToken);

    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
      videoDurationMs: 9000,
      posterReservationId: poster.reservationId,
    });

    const photo = await t.run((ctx) => ctx.db.get(capture.captureId));
    expect(photo?.videoDurationMs).toBeUndefined();
    expect(photo?.videoThumbStorageId).toBeUndefined();
  });

  test("does not offer edit/delete on a capture whose item has been curated", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(
      t,
      session.sessionToken,
      "robot",
      "image/jpeg",
    );
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    const before = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    expect(
      before.find((c) => c.captureId === capture.captureId)?.editable,
    ).toBe(true);

    // A staffer curates the item (shares it with families) — updateCaptureScholars
    // and deleteCapture would now reject, so the gallery must not offer them.
    await t.run((ctx) =>
      ctx.db.patch(capture.portfolioItemId, {
        familyVisibility: "attributed_families",
      }),
    );

    const after = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const row = after.find((c) => c.captureId === capture.captureId);
    expect(row).toBeDefined();
    expect(row?.editable).toBe(false);
  });

  test("updateCaptureScholars re-tags a capture within roster bounds", async () => {
    const { t, session, scholarA, scholarB, outsider } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await t.mutation(api.captureStations.updateCaptureScholars, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      scholarIds: [scholarA, scholarB],
    });

    const recent = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const row = recent.find((c) => c.captureId === capture.captureId);
    expect(row?.scholarIds.map(String).sort()).toEqual(
      [scholarA, scholarB].map(String).sort(),
    );
    expect(row?.scholarNames.slice().sort()).toEqual(["Ada", "Lin"]);

    await expect(
      t.mutation(api.captureStations.updateCaptureScholars, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: capture.captureId,
        scholarIds: [outsider],
      }),
    ).rejects.toThrow(/choose one or more scholars/i);

    await expect(
      t.mutation(api.captureStations.updateCaptureScholars, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: capture.captureId,
        scholarIds: [],
      }),
    ).rejects.toThrow(/choose one or more scholars/i);

    await t.run((ctx) =>
      ctx.db.patch(capture.portfolioItemId, {
        familyVisibility: "attributed_families",
      }),
    );
    await expect(
      t.mutation(api.captureStations.updateCaptureScholars, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: capture.captureId,
        scholarIds: [scholarA],
      }),
    ).rejects.toThrow(/already been curated/i);
  });

  test("setCaptureLabel names a capture the kiosk session owns", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: "  Line-follower v2  ",
    });

    const item = await t.run((ctx) => ctx.db.get(capture.portfolioItemId));
    expect(item?.label).toBe("Line-follower v2");

    // The name prefills back through the same query that feeds the editor.
    const recent = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    expect(recent.find((c) => c.captureId === capture.captureId)?.label).toBe(
      "Line-follower v2",
    );

    // A name exactly at the cap is accepted (boundary).
    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: "x".repeat(80),
    });
    expect(
      (await t.run((ctx) => ctx.db.get(capture.portfolioItemId)))?.label,
    ).toBe("x".repeat(80));
  });

  test("setCaptureLabel rejects a capture from another station's session", async () => {
    const { t, owner, session, scholarA, scholarB } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    // A second, unrelated station on its own device — a genuinely foreign
    // session that must not be able to name station A's capture.
    const otherGroupId = await owner.mutation(api.scholarGroups.create, {
      name: "Robotics B",
      type: "robotics",
      participation: "includes_program_guests",
      scholarIds: [scholarB],
    });
    await grantCaptureReview(t, otherGroupId);
    const otherEnrollment = await owner.mutation(
      api.captureStations.createOrRotateForGroup,
      { scholarGroupId: otherGroupId, label: "Robotics B capture" },
    );
    const otherSession = await t.mutation(
      api.captureStations.exchangeEnrollmentToken,
      { token: otherEnrollment.enrollmentToken, deviceId: "capture-ipad-02" },
    );

    await expect(
      t.mutation(api.captureStations.setCaptureLabel, {
        sessionToken: otherSession.sessionToken,
        deviceId: "capture-ipad-02",
        captureId: capture.captureId,
        label: "Sneaky rename",
      }),
    ).rejects.toThrow(/no longer be named/i);

    const item = await t.run((ctx) => ctx.db.get(capture.portfolioItemId));
    expect(item?.label).toBeUndefined();
  });

  test("setCaptureLabel names a capture from a DIFFERENT session on the SAME station", async () => {
    // DELIBERATE DESIGN: a capture's ownership is checked at STATION scope, not
    // SESSION scope (setCaptureLabel gates on `capture.captureStationId ===
    // station._id`, never on the session that created it). Naming is optional
    // and after-the-fact, so the kiosk token can rotate — a new session, or the
    // same iPad re-enrolled — between capturing and naming. This test pins the
    // widening: if ownership were ever narrowed to session scope, legitimate
    // after-the-fact naming would silently break while the other label tests
    // (which name within the same session) all kept passing.
    const { t, enrollment, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    // Rotate to a brand-new session on the SAME station + device. The original
    // session token is now different (and its finalized reservation makes it
    // eligible for revocation), so this is a genuinely separate session.
    const rotated = await t.mutation(
      api.captureStations.exchangeEnrollmentToken,
      { token: enrollment.enrollmentToken, deviceId: "capture-ipad-01" },
    );
    expect(rotated.sessionToken).not.toBe(session.sessionToken);

    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: rotated.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: "Named the next session",
    });

    const item = await t.run((ctx) => ctx.db.get(capture.portfolioItemId));
    expect(item?.label).toBe("Named the next session");
  });

  test("setCaptureLabel rejects an over-length name", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await expect(
      t.mutation(api.captureStations.setCaptureLabel, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: capture.captureId,
        label: "x".repeat(81),
      }),
    ).rejects.toThrow(/80 characters or fewer/i);

    const item = await t.run((ctx) => ctx.db.get(capture.portfolioItemId));
    expect(item?.label).toBeUndefined();
  });

  test("setCaptureLabel counts the cap in grapheme clusters, not UTF-16 units", async () => {
    // An emoji is one user-perceived character but two UTF-16 code units. The
    // cap counts what the scholar sees, so 80 emoji fit and 81 don't — a naive
    // `label.length` check would have rejected a 40-emoji name (80 units) and
    // the native input clamps to the SAME grapheme count.
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    // 80 emoji = 160 UTF-16 units but 80 graphemes — accepted (boundary).
    const eightyEmoji = "🙂".repeat(80);
    expect(eightyEmoji.length).toBe(160);
    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: eightyEmoji,
    });
    expect(
      (await t.run((ctx) => ctx.db.get(capture.portfolioItemId)))?.label,
    ).toBe(eightyEmoji);

    // 81 emoji — one grapheme over the cap — rejected.
    await expect(
      t.mutation(api.captureStations.setCaptureLabel, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: capture.captureId,
        label: "🙂".repeat(81),
      }),
    ).rejects.toThrow(/80 characters or fewer/i);
    // The rejected write left the accepted 80-emoji name intact.
    expect(
      (await t.run((ctx) => ctx.db.get(capture.portfolioItemId)))?.label,
    ).toBe(eightyEmoji);
  });

  test("setCaptureLabel clears the name when given whitespace only", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: "Gripper arm",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(capture.portfolioItemId)))?.label,
    ).toBe("Gripper arm");

    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: "   ",
    });
    expect(
      (await t.run((ctx) => ctx.db.get(capture.portfolioItemId)))?.label,
    ).toBeUndefined();
  });

  test("a capture-side write does not overwrite the scholar's name", async () => {
    const { t, session, scholarA, scholarB } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await t.mutation(api.captureStations.setCaptureLabel, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      label: "Chassis rev C",
    });

    // Re-tagging is a capture-side write that patches the SAME portfolioItem
    // (scholarId + attributions); the human name must survive it untouched.
    await t.mutation(api.captureStations.updateCaptureScholars, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
      scholarIds: [scholarA, scholarB],
    });

    const item = await t.run((ctx) => ctx.db.get(capture.portfolioItemId));
    expect(item?.label).toBe("Chassis rev C");
  });

  test("setCaptureLabel refuses once the capture has been curated — each guard independently", async () => {
    // The curation gate rejects a name when the item has left the kiosk's
    // staff-only pool by ANY of three means: shared with families
    // (familyVisibility), pulled into a lesson activity (activityId), or
    // attached to an assignment (assignmentId). Each sub-case pins exactly ONE
    // condition — the other two stay in their nameable state — so dropping any
    // single guard clause makes this test fail (not just the visibility one).
    const { t, session, scholarA } = await setup();

    const makeCapture = async () => {
      const upload = await reserveUploadedBlob(t, session.sessionToken);
      return t.mutation(api.captureStations.registerCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: upload.reservationId,
        scholarIds: [scholarA],
      });
    };
    // Real ids so the schema-validated patches are legitimate FKs; the guard
    // only checks that the field is present.
    const activityId = await t.run((ctx) =>
      ctx.db.insert("activities", {
        title: "Curated activity",
        kind: "online",
        order: 0,
      }),
    );
    const assignmentId = await t.run((ctx) =>
      ctx.db.insert("assignments", {
        teacherId: scholarA,
        scholarIds: [scholarA],
        startedAt: Date.now(),
      }),
    );

    // (1) Shared with families — the visibility guard.
    const visibilityCapture = await makeCapture();
    await t.run((ctx) =>
      ctx.db.patch(visibilityCapture.portfolioItemId, {
        familyVisibility: "attributed_families",
      }),
    );
    await expect(
      t.mutation(api.captureStations.setCaptureLabel, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: visibilityCapture.captureId,
        label: "Too late — visibility",
      }),
    ).rejects.toThrow(/already been curated/i);

    // (2) Pulled into a lesson activity — the activity guard. Visibility stays
    // staff_only so ONLY the activityId clause can be doing the rejecting.
    const activityCapture = await makeCapture();
    await t.run((ctx) =>
      ctx.db.patch(activityCapture.portfolioItemId, { activityId }),
    );
    await expect(
      t.mutation(api.captureStations.setCaptureLabel, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: activityCapture.captureId,
        label: "Too late — activity",
      }),
    ).rejects.toThrow(/already been curated/i);

    // (3) Attached to an assignment — the assignment guard. Visibility again
    // stays staff_only so ONLY the assignmentId clause can reject.
    const assignmentCapture = await makeCapture();
    await t.run((ctx) =>
      ctx.db.patch(assignmentCapture.portfolioItemId, { assignmentId }),
    );
    await expect(
      t.mutation(api.captureStations.setCaptureLabel, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: assignmentCapture.captureId,
        label: "Too late — assignment",
      }),
    ).rejects.toThrow(/already been curated/i);
  });

  test("deleteCapture removes a capture regardless of the undo time window", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    // Push the capture outside the 10-minute undo window — deleteCapture must
    // still accept it, unlike undoCapture.
    await t.run((ctx) =>
      ctx.db.patch(capture.captureId, {
        createdAt: Date.now() - 60 * 60 * 1000,
      }),
    );

    await t.mutation(api.captureStations.deleteCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: capture.captureId,
    });

    const recent = await t.query(api.captureStations.listRecentCaptures, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    expect(recent.map((c) => c.captureId)).not.toContain(capture.captureId);

    const item = await t.run((ctx) => ctx.db.get(capture.portfolioItemId));
    expect(item).toBeNull();
  });

  test("deleteCapture rejects a capture whose item has been curated", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const capture = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await t.run((ctx) =>
      ctx.db.patch(capture.portfolioItemId, {
        familyVisibility: "attributed_families",
      }),
    );

    await expect(
      t.mutation(api.captureStations.deleteCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: capture.captureId,
      }),
    ).rejects.toThrow(/already been curated/i);
  });

  test("rejects recent-capture reads with invalid or expired capabilities", async () => {
    const { t, session } = await setup();
    await expect(
      t.query(api.captureStations.listRecentCaptures, {
        sessionToken: "not-a-capture-token",
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/expired/i);

    const hash = await sha256Hex(session.sessionToken);
    await t.run(async (ctx) => {
      const capabilitySession = await ctx.db
        .query("captureStationSessions")
        .withIndex("by_session_token_hash", (q) =>
          q.eq("sessionTokenHash", hash),
        )
        .unique();
      if (!capabilitySession) throw new Error("Missing capability session");
      await ctx.db.patch(capabilitySession._id, { expiresAt: Date.now() - 1 });
    });
    await expect(
      t.query(api.captureStations.listRecentCaptures, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow(/expired/i);
  });

  test("caps upload URLs issued by one capability session", async () => {
    const { t, session } = await setup();
    await t.run(async (ctx) => {
      const capabilitySession = await ctx.db
        .query("captureStationSessions")
        .first();
      if (!capabilitySession) throw new Error("Missing capability session");
      await ctx.db.patch(capabilitySession._id, { uploadUrlsIssued: 60 });
    });
    await expect(
      t.mutation(api.captureStations.generateUploadUrl, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toMatchObject({ data: { kind: "upload_url_quota" } });
  });

  test("reports capture-count exhaustion separately from upload URLs", async () => {
    const { t, session, scholarA } = await setup();
    await t.run(async (ctx) => {
      const capabilitySession = await ctx.db
        .query("captureStationSessions")
        .first();
      if (!capabilitySession) throw new Error("Missing capability session");
      await ctx.db.patch(capabilitySession._id, { capturesRegistered: 40 });
    });
    const upload = await reserveUploadedBlob(t, session.sessionToken);

    await expect(
      t.mutation(api.captureStations.registerCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        reservationId: upload.reservationId,
        scholarIds: [scholarA],
      }),
    ).rejects.toMatchObject({ data: { kind: "capture_count_quota" } });
  });

  test("finalization is idempotent and counts one capture", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const args = {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    };
    const first = await t.mutation(api.captureStations.registerCapture, args);
    const second = await t.mutation(api.captureStations.registerCapture, args);
    expect(second).toEqual(first);
    const counters = await t.run(async (ctx) => {
      const reservation = await ctx.db.get(upload.reservationId);
      return reservation ? await ctx.db.get(reservation.sessionId) : null;
    });
    expect(counters).toMatchObject({
      capturesRegistered: 1,
      registeredBytes: upload.metadata.size,
    });
  });

  test("expired uploaded reservations clean up known abandoned blobs", async () => {
    const { t, session } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    await t.run((ctx) =>
      ctx.db.patch(upload.reservationId, { expiresAt: Date.now() - 1 }),
    );
    await t.mutation(internal.captureStations.cleanupUploadReservation, {
      reservationId: upload.reservationId,
    });
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", upload.storageId)),
    ).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.get(upload.reservationId)),
    ).toBeNull();
  });

  test("keeps unreported direct-upload debt across token rotation", async () => {
    const { t, owner, groupId, session } = await setup();
    const unreportedStorageIds: Id<"_storage">[] = [];

    for (let index = 0; index < 3; index += 1) {
      const reservation = await t.mutation(
        api.captureStations.generateUploadUrl,
        {
          sessionToken: session.sessionToken,
          deviceId: "capture-ipad-01",
        },
      );
      // This models a client using a direct-upload URL and disconnecting before
      // it can tell us the returned storage id.
      unreportedStorageIds.push(
        await t.run((ctx) =>
          ctx.storage.store(new Blob([`unreported-${index}`], {
            type: "image/jpeg",
          })),
        ),
      );
      await t.run((ctx) =>
        ctx.db.patch(reservation.reservationId, { expiresAt: Date.now() - 1 }),
      );
      await t.mutation(internal.captureStations.cleanupUploadReservation, {
        reservationId: reservation.reservationId,
      });
      expect(
        await t.run((ctx) => ctx.db.get(reservation.reservationId)),
      ).toMatchObject({ status: "abandoned" });
    }

    expect(
      await Promise.all(
        unreportedStorageIds.map((storageId) =>
          t.run((ctx) => ctx.db.system.get("_storage", storageId)),
        ),
      ),
    ).not.toContain(null);
    await expect(
      t.mutation(api.captureStations.generateUploadUrl, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toMatchObject({ data: { kind: "upload_abandoned_quota" } });

    const replacement = await owner.mutation(
      api.captureStations.createOrRotateForGroup,
      { scholarGroupId: groupId, label: "Robotics capture" },
    );
    const recoveredSession = await t.mutation(
      api.captureStations.exchangeEnrollmentToken,
      {
        token: replacement.enrollmentToken,
        deviceId: "replacement-ipad-01",
      },
    );
    await expect(
      t.mutation(api.captureStations.generateUploadUrl, {
        sessionToken: recoveredSession.sessionToken,
        deviceId: "replacement-ipad-01",
      }),
    ).rejects.toMatchObject({ data: { kind: "upload_abandoned_quota" } });
  });

  test("expired finalized reservations are reclaimed without deleting captures", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const result = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });
    await t.run((ctx) =>
      ctx.db.patch(upload.reservationId, { expiresAt: Date.now() - 1 }),
    );

    await t.mutation(internal.captureStations.cleanupUploadReservation, {
      reservationId: upload.reservationId,
    });

    expect(await t.run((ctx) => ctx.db.get(upload.reservationId))).toBeNull();
    expect(await t.run((ctx) => ctx.db.get(result.captureId))).not.toBeNull();
  });

  test("only the creating capability session can undo its capture", async () => {
    const { t, enrollment, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const result = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });
    const thumbStorageId = await t.run((ctx) =>
      ctx.storage.store(new Blob(["thumb"], { type: "image/jpeg" })),
    );
    await t.run((ctx) =>
      ctx.db.patch(result.portfolioItemId, {
        thumbStorageId,
        thumbStatus: "ready",
      }),
    );
    await t.run(async (ctx) => {
      const capture = await ctx.db.get(result.captureId);
      if (!capture) throw new Error("Missing capture");
      await ctx.db.patch(capture.sessionId, { uploadUrlsIssued: 1 });
    });
    // Keep the original session recoverable while a replacement session is
    // minted, matching the iPad's interrupted-upload recovery path.
    await t.mutation(api.captureStations.generateUploadUrl, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
    });
    const otherSession = await t.mutation(
      api.captureStations.exchangeEnrollmentToken,
      {
        token: enrollment.enrollmentToken,
        deviceId: "capture-ipad-01",
      },
    );
    await expect(
      t.mutation(api.captureStations.undoCapture, {
        sessionToken: otherSession.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: result.captureId,
      }),
    ).rejects.toThrow(/no longer be undone/i);

    await t.mutation(api.captureStations.undoCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      captureId: result.captureId,
    });
    expect(
      await t.run((ctx) => ctx.db.get(result.portfolioItemId)),
    ).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", thumbStorageId)),
    ).toBeNull();
    const counters = await t.run(async (ctx) => {
      const capture = await ctx.db.get(result.captureId);
      return capture ? await ctx.db.get(capture.sessionId) : null;
    });
    expect(counters).toMatchObject({
      uploadUrlsIssued: 1,
      capturesRegistered: 0,
      registeredBytes: 0,
    });
    expect(
      await t.run((ctx) => ctx.db.get(result.captureId)),
    ).toMatchObject({ scholarIds: [] });
  });

  test("staff deletion removes capture provenance and its blob", async () => {
    const { t, owner, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const result = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });

    await owner.mutation(api.portfolio.deleteItem, {
      itemId: result.portfolioItemId,
    });

    expect(await t.run((ctx) => ctx.db.get(result.captureId))).toBeNull();
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", upload.storageId)),
    ).toBeNull();
  });

  test("cannot undo a capture after staff shares it with families", async () => {
    const { t, session, scholarA } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const result = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA],
    });
    await t.run((ctx) =>
      ctx.db.patch(result.portfolioItemId, {
        familyVisibility: "attributed_families",
      }),
    );

    await expect(
      t.mutation(api.captureStations.undoCapture, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
        captureId: result.captureId,
      }),
    ).rejects.toThrow(/curated/i);
    expect(await t.run((ctx) => ctx.db.get(result.portfolioItemId))).not.toBeNull();
    expect(
      await t.run((ctx) => ctx.db.system.get("_storage", upload.storageId)),
    ).not.toBeNull();
  });

  test("withdrawing consent hides an already shared group capture", async () => {
    const {
      t,
      owner,
      session,
      scholarA,
      scholarB,
      guardianId,
      consentRecordIds,
    } = await setup();
    const upload = await reserveUploadedBlob(t, session.sessionToken);
    const result = await t.mutation(api.captureStations.registerCapture, {
      sessionToken: session.sessionToken,
      deviceId: "capture-ipad-01",
      reservationId: upload.reservationId,
      scholarIds: [scholarA, scholarB],
    });
    await owner.mutation(api.portfolio.setFamilyVisibility, {
      itemId: result.portfolioItemId,
      familyVisibility: "attributed_families",
    });
    const guardian = await withUser(t, guardianId);
    await expect(
      guardian.query(api.portfolio.listForGuardian, { scholarId: scholarA }),
    ).resolves.toHaveLength(1);

    await t.run((ctx) =>
      ctx.db.patch(consentRecordIds[0], { privateSchoolMediaOptOut: true }),
    );

    await expect(
      guardian.query(api.portfolio.listForGuardian, { scholarId: scholarA }),
    ).resolves.toEqual([]);
    await expect(
      guardian.query(api.portfolio.listForGuardian, { scholarId: scholarB }),
    ).resolves.toEqual([]);
    await expect(
      guardian.query(api.portfolio.getFileUrlForGuardian, {
        itemId: result.portfolioItemId,
      }),
    ).resolves.toBeNull();
    await expect(
      owner.mutation(api.parentMessages.registerPortfolioAttachment, {
        portfolioItemId: result.portfolioItemId,
        scholarId: scholarB,
      }),
    ).rejects.toThrow(/no signed media consent/i);
  });
    test("requires both device-control and capture-review authority for assigned-device mode", async () => {
      vi.useFakeTimers();
      // Pin a mid-morning school-time clock: assigned-device capture mode
      // refuses to start at/after 4:40 PM local, so a real clock makes these
      // tests fail for anyone running them in the evening (as CI did).
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, otherInstitutionId, scholarA, enrollment } =
        await setup();
      const { pairedDeviceId } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );
      const stationId = enrollment.captureStationId;

      await expect(
        owner.query(api.captureStations.assignedDeviceCaptureControlState, {
          pairedDeviceId,
        }),
      ).resolves.toMatchObject({
        pairedDeviceId,
        availableStations: [{ captureStationId: stationId }],
        active: null,
      });

      const sameSchoolWithoutGrant = await staff(t, institutionId);
      await expect(
        sameSchoolWithoutGrant.mutation(
          api.captureStations.setAssignedDeviceCaptureMode,
          { pairedDeviceId, captureStationId: stationId, enabled: true },
        ),
      ).rejects.toThrow(/program group/i);

      const otherSchoolStaff = await staff(t, otherInstitutionId);
      await expect(
        otherSchoolStaff.query(api.captureStations.assignedDeviceCaptureControlState, {
          pairedDeviceId,
        }),
      ).rejects.toThrow(/device is not in your current school context/i);
    });

    test("manual pairings render as ineligible instead of failing the device details query", async () => {
      const { t, owner, institutionId, scholarA } = await setup();
      const pairedDeviceId = await t.run((ctx) =>
        ctx.db.insert("pairedDevices", {
          institutionId,
          deviceId: "manual-capture-ipad-01",
          scholarId: scholarA,
          pairedAt: Date.now(),
          pairedBy: scholarA,
        }),
      );

      await expect(
        owner.query(api.captureStations.assignedDeviceCaptureControlState, {
          pairedDeviceId,
        }),
      ).resolves.toMatchObject({
        pairedDeviceId,
        availableStations: [],
        active: null,
      });
    });

    test("the native assignment read fails closed while a managed claim is rotating", async () => {
      const { t, institutionId, scholarA } = await setup();
      const { managedDeviceId, asDevice } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );
      await t.run((ctx) =>
        ctx.db.patch(managedDeviceId, { claimState: "unclaimed" }),
      );

      await expect(
        asDevice.query(api.captureStations.assignedDeviceCaptureState, {
          deviceId: "assigned-capture-ipad-01",
        }),
      ).resolves.toBeNull();
    });

    test("expires at the institution-local cutoff and rejects late activation", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T14:00:00.000Z")); // 10:00 AM EDT
      const { t, owner, institutionId, scholarA, enrollment } = await setup();
      await t.run(async (ctx) => {
        await ctx.db.patch(institutionId, { timeZone: "America/New_York" });
      });
      const { pairedDeviceId } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );

      const started = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      expect(started).toMatchObject({
        enabled: true,
        expiresAt: Date.parse("2026-08-18T20:40:00.000Z"),
      });

      vi.setSystemTime(new Date("2026-08-18T20:40:00.000Z"));
      await expect(
        owner.mutation(api.captureStations.setAssignedDeviceCaptureMode, {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        }),
      ).rejects.toThrow(/at or after 4:40 PM school time/i);
    });

    test("stopping, stale expiry, and claim revocation invalidate assigned-mode sessions", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, scholarA, enrollment } = await setup();
      const { pairedDeviceId, managedDeviceId, asDevice } =
        await seedAssignedManagedDevice(t, institutionId, scholarA);
      const first = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const deviceId = "assigned-capture-ipad-01";
      const session = await asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        { deviceId, expectedUpdatedAt: first.updatedAt! },
      );
      await asDevice.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId,
      });

      await owner.mutation(api.captureStations.setAssignedDeviceCaptureMode, {
        pairedDeviceId,
        captureStationId: enrollment.captureStationId,
        enabled: false,
      });
      await expect(
        t.mutation(api.captureStations.bootstrap, {
          sessionToken: session.sessionToken,
          deviceId,
        }),
      ).rejects.toThrow(/assigned capture mode has ended/i);

      const second = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      await expect(
        t.mutation(internal.captureStations.expireAssignedDeviceCapture, {
          pairedDeviceId,
          expectedUpdatedAt: first.updatedAt!,
        }),
      ).resolves.toEqual({ expired: false });
      const freshSession = await asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        { deviceId, expectedUpdatedAt: second.updatedAt! },
      );
      await t.run((ctx) =>
        ctx.db.patch(managedDeviceId, { claimState: "revoked" }),
      );
      await expect(
        t.mutation(api.captureStations.bootstrap, {
          sessionToken: freshSession.sessionToken,
          deviceId,
        }),
      ).rejects.toThrow(/assigned managed device/i);
    });

    test("temporary session refreshes do not accumulate rows or consume the dedicated station quota", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const {
        t,
        owner,
        institutionId,
        scholarA,
        scholarB,
        enrollment,
      } = await setup();
      const firstDevice = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
        "assigned-capture-ipad-a",
      );
      const secondDevice = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarB,
        "assigned-capture-ipad-b",
      );
      const firstMode = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId: firstDevice.pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const firstSession = await firstDevice.asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-a",
          expectedUpdatedAt: firstMode.updatedAt!,
        },
      );
      await firstDevice.asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-a",
          expectedUpdatedAt: firstMode.updatedAt!,
        },
      );
      const firstSessionHash = await sha256Hex(firstSession.sessionToken);
      const replacedSession = await t.run((ctx) =>
        ctx.db
          .query("captureStationSessions")
          .withIndex("by_session_token_hash", (q) =>
            q.eq("sessionTokenHash", firstSessionHash),
          )
          .unique(),
      );
      expect(replacedSession).toBeNull();
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await firstDevice.asDevice.mutation(
          api.captureStations.startAssignedDeviceCapture,
          {
            deviceId: "assigned-capture-ipad-a",
            expectedUpdatedAt: firstMode.updatedAt!,
          },
        );
      }
      const retainedFirstDeviceSessions = await t.run(async (ctx) =>
        (
          await ctx.db
            .query("captureStationSessions")
            .withIndex("by_station", (q) =>
              q.eq("captureStationId", enrollment.captureStationId),
            )
            .collect()
        ).filter(
          (captureSession) =>
            captureSession.pairedDeviceId === firstDevice.pairedDeviceId,
        ),
      );
      expect(retainedFirstDeviceSessions).toHaveLength(1);

      const secondMode = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId: secondDevice.pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      await secondDevice.asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-b",
          expectedUpdatedAt: secondMode.updatedAt!,
        },
      );

      await expect(
        t.mutation(api.captureStations.exchangeEnrollmentToken, {
          token: enrollment.enrollmentToken,
          deviceId: "capture-ipad-01",
        }),
      ).resolves.toMatchObject({ expiresAt: expect.any(Number) });
    });

    test("temporary upload pressure cannot lock out the dedicated station", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, scholarA, enrollment, session } =
        await setup();
      const { pairedDeviceId, asDevice } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );
      const mode = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const temporarySession = await asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-01",
          expectedUpdatedAt: mode.updatedAt!,
        },
      );
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const reservation = await t.mutation(
          api.captureStations.generateUploadUrl,
          {
            sessionToken: temporarySession.sessionToken,
            deviceId: "assigned-capture-ipad-01",
          },
        );
        await t.run((ctx) =>
          ctx.db.patch(reservation.reservationId, {
            expiresAt: Date.now() - 1,
          }),
        );
        await t.mutation(
          internal.captureStations.cleanupUploadReservation,
          { reservationId: reservation.reservationId },
        );
      }
      await expect(
        t.mutation(api.captureStations.generateUploadUrl, {
          sessionToken: temporarySession.sessionToken,
          deviceId: "assigned-capture-ipad-01",
        }),
      ).rejects.toMatchObject({ data: { kind: "upload_abandoned_quota" } });
      await expect(
        t.mutation(api.captureStations.generateUploadUrl, {
          sessionToken: session.sessionToken,
          deviceId: "capture-ipad-01",
        }),
      ).resolves.toMatchObject({ reservationId: expect.any(String) });
    });

    test("remote sign-out immediately invalidates assigned capture mode", async () => {
      vi.useFakeTimers();
      // Pin a mid-morning school-time clock: assigned-device capture mode
      // refuses to start at/after 4:40 PM local, so a real clock makes these
      // tests fail for anyone running them in the evening (as CI did).
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, scholarA, enrollment } = await setup();
      const { pairedDeviceId, asDevice } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );
      const started = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const session = await asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-01",
          expectedUpdatedAt: started.updatedAt!,
        },
      );

      await owner.mutation(api.devicePairing.revokeDeviceSession, {
        pairedDeviceId,
      });
      const signedOutBinding = await t.run((ctx) =>
        ctx.db.get(pairedDeviceId),
      );
      expect(signedOutBinding?.authSessionId).toBeUndefined();
      expect(signedOutBinding).not.toHaveProperty(
        "assignedDeviceCaptureStationId",
      );
      expect(signedOutBinding?.assignedDeviceCaptureUpdatedAt).toBeGreaterThan(
        started.updatedAt!,
      );
      await expect(
        t.mutation(api.captureStations.bootstrap, {
          sessionToken: session.sessionToken,
          deviceId: "assigned-capture-ipad-01",
        }),
      ).rejects.toThrow(/assigned capture mode has ended/i);
    });

    test("a managed-claim handover clears capture mode and invalidates its capability", async () => {
      vi.useFakeTimers();
      // Pin a mid-morning school-time clock: assigned-device capture mode
      // refuses to start at/after 4:40 PM local, so a real clock makes these
      // tests fail for anyone running them in the evening (as CI did).
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, scholarA, scholarB, enrollment } =
        await setup();
      const { pairedDeviceId, managedDeviceId, asDevice } =
        await seedAssignedManagedDevice(t, institutionId, scholarA);
      const started = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const session = await asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-01",
          expectedUpdatedAt: started.updatedAt!,
        },
      );
      const replacementToken = `rhc_${"b".repeat(64)}`;
      await t.run(async (ctx) => {
        await ctx.db.patch(managedDeviceId, {
          scholarId: scholarB,
          claimTokenHash: await sha256Hex(replacementToken),
          claimState: "unclaimed",
        });
      });
      await t.mutation(internal.managedDeviceClaims.consumeManagedClaim, {
        claimToken: replacementToken,
        deviceId: "assigned-capture-ipad-01",
      });
      const handedOverBinding = await t.run((ctx) =>
        ctx.db.get(pairedDeviceId),
      );
      expect(handedOverBinding).toMatchObject({ scholarId: scholarB });
      expect(handedOverBinding).not.toHaveProperty(
        "assignedDeviceCaptureStationId",
      );
      expect(handedOverBinding).not.toHaveProperty(
        "assignedDeviceCaptureExpiresAt",
      );
      expect(handedOverBinding).not.toHaveProperty(
        "assignedDeviceCaptureUpdatedAt",
      );
      expect(handedOverBinding).not.toHaveProperty(
        "assignedDeviceCaptureUpdatedBy",
      );
      await expect(
        t.mutation(api.captureStations.bootstrap, {
          sessionToken: session.sessionToken,
          deviceId: "assigned-capture-ipad-01",
        }),
      ).rejects.toThrow(/assigned capture mode has ended/i);
    });

    test("the revision-checked cutoff job ends a live assigned-device capability", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, scholarA, enrollment } = await setup();
      const { pairedDeviceId, asDevice } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );
      const started = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const session = await asDevice.mutation(
        api.captureStations.startAssignedDeviceCapture,
        {
          deviceId: "assigned-capture-ipad-01",
          expectedUpdatedAt: started.updatedAt!,
        },
      );
      vi.setSystemTime(new Date(started.expiresAt!));
      await expect(
        t.mutation(internal.captureStations.expireAssignedDeviceCapture, {
          pairedDeviceId,
          expectedUpdatedAt: started.updatedAt!,
        }),
      ).resolves.toEqual({ expired: true });
      await expect(
        t.mutation(api.captureStations.bootstrap, {
          sessionToken: session.sessionToken,
          deviceId: "assigned-capture-ipad-01",
        }),
      ).rejects.toThrow(/capture session expired/i);
    });

    test("the cutoff expiry audit log attributes to the staff who started capture, not the scholar who paired the device", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, owner, institutionId, scholarA, enrollment } = await setup();
      const { pairedDeviceId } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );
      const staffId = await t.run(
        async (ctx) =>
          (
            await ctx.db
              .query("users")
              .withIndex("by_username", (q) => q.eq("username", "capture-staff"))
              .unique()
          )!._id,
      );
      const started = await owner.mutation(
        api.captureStations.setAssignedDeviceCaptureMode,
        {
          pairedDeviceId,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      vi.setSystemTime(new Date(started.expiresAt!));
      await expect(
        t.mutation(internal.captureStations.expireAssignedDeviceCapture, {
          pairedDeviceId,
          expectedUpdatedAt: started.updatedAt!,
        }),
      ).resolves.toEqual({ expired: true });
      const expiryEntry = await t.run(async (ctx) =>
        (await ctx.db.query("auditLog").collect()).find(
          (entry) => entry.action === "device.capture-mode.expire",
        ),
      );
      expect(expiryEntry?.actorUserId).toBe(staffId);
      expect(expiryEntry?.actorUserId).not.toBe(scholarA);
    });

    test("Slack target resolution is authorized, secret-free, and mode changes are idempotent", async () => {
      vi.useFakeTimers();
      // Pin a mid-morning school-time clock: assigned-device capture mode
      // refuses to start at/after 4:40 PM local, so a real clock makes these
      // tests fail for anyone running them in the evening (as CI did).
      vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
      const { t, institutionId, scholarA, enrollment } = await setup();
      const callerId = await t.run(async (ctx) => {
        const caller = await ctx.db
          .query("users")
          .withIndex("by_username", (q) => q.eq("username", "capture-staff"))
          .unique();
        if (!caller) throw new Error("Missing capture staff");
        return caller._id;
      });
      const { pairedDeviceId } = await seedAssignedManagedDevice(
        t,
        institutionId,
        scholarA,
      );

      const targets = await t.query(
        internal.captureStations.findAssignedDeviceCaptureTargetsForSlack,
        { callerUserId: callerId, scholarQuery: "ada" },
      );
      expect(targets).toEqual([
        expect.objectContaining({
          scholarId: scholarA,
          pairedDeviceId,
          stations: [{ captureStationId: enrollment.captureStationId, label: "Robotics capture" }],
        }),
      ]);
      expect(JSON.stringify(targets)).not.toContain("rhcapture_");

      const ungrantedCallerId = await t.run(async (ctx) => {
        const caller = await ctx.db.insert("users", {
          name: "Untrusted capture staff",
          username: "untrusted-capture-staff",
          role: "teacher",
        });
        await ctx.db.insert("memberships", {
          userId: caller,
          institutionId,
          role: "teacher",
        });
        return caller;
      });
      await expect(
        t.query(internal.captureStations.findAssignedDeviceCaptureTargetsForSlack, {
          callerUserId: ungrantedCallerId,
          scholarQuery: "ada",
        }),
      ).resolves.toEqual([]);

      const first = await t.mutation(
        internal.captureStations.setAssignedDeviceCaptureModeFromSlack,
        {
          callerUserId: callerId,
          scholarId: scholarA,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      const second = await t.mutation(
        internal.captureStations.setAssignedDeviceCaptureModeFromSlack,
        {
          callerUserId: callerId,
          scholarId: scholarA,
          captureStationId: enrollment.captureStationId,
          enabled: true,
        },
      );
      expect(first.changed).toBe(true);
      expect(second).toMatchObject({ enabled: true, changed: false });
    });
});

describe("token-free station creation", () => {
  test("createForGroup registers a capture target without minting a credential", async () => {
    const { t, owner, scholarA } = await setup();
    const groupId = await owner.mutation(api.scholarGroups.create, {
      name: "Makers",
      type: "robotics",
      participation: "includes_program_guests",
      scholarIds: [scholarA],
    });
    await grantCaptureReview(t, groupId);

    const { captureStationId } = await owner.mutation(
      api.captureStations.createForGroup,
      { scholarGroupId: groupId, label: "Makers capture" },
    );

    const stored = await t.run((ctx) => ctx.db.get(captureStationId));
    expect(stored?.enrollmentTokenHash).toBeUndefined();
    expect(stored?.enabled).toBe(true);

    const status = await owner.query(api.captureStations.statusForGroup, {
      scholarGroupId: groupId,
    });
    expect(status).toMatchObject({ enabled: true, hasEnrollmentToken: false });
  });

  test("a token-free station still offers assigned-device capture mode", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
    const { t, owner, institutionId, scholarA } = await setup();
    const groupId = await owner.mutation(api.scholarGroups.create, {
      name: "Makers",
      type: "robotics",
      participation: "includes_program_guests",
      scholarIds: [scholarA],
    });
    await grantCaptureReview(t, groupId);
    const { captureStationId } = await owner.mutation(
      api.captureStations.createForGroup,
      { scholarGroupId: groupId, label: "Makers capture" },
    );
    const { pairedDeviceId } = await seedAssignedManagedDevice(
      t,
      institutionId,
      scholarA,
      "assigned-tokenfree-01",
    );

    const state = await owner.query(
      api.captureStations.assignedDeviceCaptureControlState,
      { pairedDeviceId },
    );
    expect(
      state.availableStations.map((station) => station.captureStationId),
    ).toContain(captureStationId);

    // …and the staff toggle actually starts it.
    const result = await owner.mutation(
      api.captureStations.setAssignedDeviceCaptureMode,
      { pairedDeviceId, captureStationId, enabled: true },
    );
    expect(result).toMatchObject({ enabled: true, changed: true });
  });

  test("a token-free station cannot be enrolled by a guessed kiosk token", async () => {
    const { t, owner, scholarA } = await setup();
    const groupId = await owner.mutation(api.scholarGroups.create, {
      name: "Makers",
      type: "robotics",
      participation: "includes_program_guests",
      scholarIds: [scholarA],
    });
    await grantCaptureReview(t, groupId);
    await owner.mutation(api.captureStations.createForGroup, {
      scholarGroupId: groupId,
      label: "Makers capture",
    });

    await expect(
      t.mutation(api.captureStations.exchangeEnrollmentToken, {
        token: "rhcapture_not-a-real-token-value",
        deviceId: "rogue-kiosk-01",
      }),
    ).rejects.toThrow(/unavailable/i);
  });

  test("clearEnrollmentToken drops the kiosk but keeps assigned capture alive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T20:00:00.000Z"));
    const { t, owner, institutionId, scholarA, groupId, session } =
      await setup();
    const status = await owner.query(api.captureStations.statusForGroup, {
      scholarGroupId: groupId,
    });
    expect(status).toMatchObject({ hasEnrollmentToken: true });
    const captureStationId = status!.captureStationId;

    const { pairedDeviceId } = await seedAssignedManagedDevice(
      t,
      institutionId,
      scholarA,
      "assigned-keepalive-01",
    );
    await owner.mutation(api.captureStations.setAssignedDeviceCaptureMode, {
      pairedDeviceId,
      captureStationId,
      enabled: true,
    });

    await owner.mutation(api.captureStations.clearEnrollmentToken, {
      captureStationId,
    });

    const after = await owner.query(api.captureStations.statusForGroup, {
      scholarGroupId: groupId,
    });
    expect(after).toMatchObject({ enabled: true, hasEnrollmentToken: false });

    // The kiosk session is gone…
    await expect(
      t.mutation(api.captureStations.bootstrap, {
        sessionToken: session.sessionToken,
        deviceId: "capture-ipad-01",
      }),
    ).rejects.toThrow();

    // …while the assigned iPad can still open a capture session.
    const state = await owner.query(
      api.captureStations.assignedDeviceCaptureControlState,
      { pairedDeviceId },
    );
    expect(state.active).not.toBeNull();
  });
});

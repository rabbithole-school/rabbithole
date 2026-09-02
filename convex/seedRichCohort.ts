// ─── Rich-cohort seed: the INSERTER ───────────────────────────────────────
//
// Resolves the static fixture (convex/seed/rich/*) into real Convex rows in
// dependency order, mapping every stable string KEY → the Id minted at insert
// time. Now-anchored: relative offsets in the fixture become absolute ms via
// `Date.now() - offset`, so live "active now" / growth-over-time widgets light
// up regardless of the calendar date.
//
// Idempotent: a marker check (the cohort teacher "kawena") short-circuits a
// re-run. Self-contained for the test harness — it runs on an EMPTY
// convex-test db and every FK-by-key resolves — but additive on a real
// deployment (it appends the rich cohort alongside the base seed's users).
//
// Verified by convex/__tests__/richSeed.test.ts, which runs this through the
// LIVE schema validators (the drift detector) plus referential + coverage
// invariants.

import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { ROLES } from "./lib/roles";
import { richSeed } from "./seed/rich";
import { assignDevInstitutions } from "./seed/institutions";
import type { Key } from "./seed/rich/types";
import { sha256Hex } from "./lib/oauthCrypto";
import { emptyHealthRecordFields } from "./lib/healthRecord";
import { SCHOLAR_GROUP_PARTICIPATION } from "../shared/scholarGroupRouting";
import { reconcilePlacementById } from "./masterSchedule";

const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

/** A relative "N days ago" offset → absolute ms timestamp. */
const daysAgo = (now: number, d: number) => now - d * DAY_MS;
/** A relative "N minutes ago" offset → absolute ms timestamp. */
const minsAgo = (now: number, m: number) => now - m * MIN_MS;

/** Insert the rich cohort. Returns a small summary (also used by the CLI). */
export async function insertRichCohort(
  ctx: MutationCtx,
  now: number = Date.now(),
): Promise<{
  inserted: boolean;
  counts: Record<string, number>;
  captureStationToken?: string;
}> {
  const s = richSeed;

  // ── Idempotency marker ──────────────────────────────────────────────────
  const marker = s.teachers[0]?.username;
  if (marker) {
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", marker))
      .first();
    if (existing) return { inserted: false, counts: {} };
  }

  const counts: Record<string, number> = {};
  const bump = (t: string, n = 1) => (counts[t] = (counts[t] ?? 0) + n);

  // Per-entity key → Id resolution maps.
  const userId = new Map<Key, Id<"users">>();
  const groupId = new Map<Key, Id<"scholarGroups">>();
  const unitId = new Map<Key, Id<"units">>();
  const lessonId = new Map<Key, Id<"lessons">>();
  const activityId = new Map<Key, Id<"activities">>();
  const assignmentId = new Map<Key, Id<"assignments">>();
  const sessionId = new Map<Key, Id<"sessions">>();
  const masteryId = new Map<Key, Id<"masteryObservations">>();
  const profileId = new Map<Key, Id<"syntheticScholarProfiles">>();
  const variantId = new Map<Key, Id<"curriculumVariants">>();
  const experimentId = new Map<Key, Id<"curriculumExperiments">>();
  const periodId = new Map<Key, Id<"reportingPeriods">>();
  const scheduleBlockId = new Map<Key, Id<"scheduleBlocks">>();
  const externalAppId = new Map<Key, Id<"externalApps">>();

  const reqUser = (k: Key) => mustGet(userId, k, "user");
  const reqUnit = (k: Key) => mustGet(unitId, k, "unit");
  const reqActivity = (k: Key) => mustGet(activityId, k, "activity");
  const reqSession = (k: Key) => mustGet(sessionId, k, "session");
  const reqGroup = (k: Key) => mustGet(groupId, k, "scholar group");
  const reqPeriod = (k: Key) => mustGet(periodId, k, "reporting period");
  const reqScheduleBlock = (k: Key) =>
    mustGet(scheduleBlockId, k, "schedule block");

  // ── 1. Users (teachers, scholars, parents) ──────────────────────────────
  for (const t of s.teachers) {
    const id = await ctx.db.insert("users", {
      name: t.name,
      email: t.email,
      username: t.username,
      externalId: t.username, // keeps the row /dev-login-able (reconcile-safe)
      role: t.role ?? ROLES.TEACHER,
    });
    userId.set(t.key, id);
    bump("users");
  }
  for (const sc of s.scholars) {
    const id = await ctx.db.insert("users", {
      name: sc.name,
      username: sc.username,
      externalId: sc.username,
      role: ROLES.SCHOLAR,
      readingLevel: sc.readingLevel,
      readingLevelSuggestion: sc.readingLevelSuggestion,
      dateOfBirth: sc.dateOfBirth,
      preferredFont: sc.preferredFont,
      enrollmentStanding: sc.enrollmentStanding,
      profileSetupComplete: true,
    });
    userId.set(sc.key, id);
    bump("users");
  }
  for (const p of s.parents) {
    const id = await ctx.db.insert("users", {
      name: p.name,
      email: p.email,
      username: p.username,
      externalId: p.username,
      role: ROLES.PARENT,
    });
    userId.set(p.key, id);
    bump("users");
    if (p.notificationPrefs) {
      await ctx.db.insert("notificationPrefs", {
        userId: id,
        ...p.notificationPrefs,
      });
      bump("notificationPrefs");
    }
  }

  // ── 2. Guardianships (parent → child links) ─────────────────────────────
  for (const p of s.parents) {
    const parentUserId = reqUser(p.key);
    for (const childKey of p.childKeys) {
      await ctx.db.insert("guardianships", {
        parentUserId,
        scholarUserId: reqUser(childKey),
        createdBy: parentUserId, // self-attributed in the seed
      });
      bump("guardianships");
    }
  }

  // ── 3. Groups (scholarGroups) + teacher affinities ──────────────────────
  const groupsIncludingProgramGuests = new Set(["group.robotics"]);
  for (const group of s.groups) {
    const id = await ctx.db.insert("scholarGroups", {
      teacherId: reqUser(group.teacherKey),
      name: group.name,
      emoji: group.emoji,
      type: group.type,
      participation: groupsIncludingProgramGuests.has(group.key)
        ? SCHOLAR_GROUP_PARTICIPATION.INCLUDES_PROGRAM_GUESTS
        : undefined,
      scholarIds: group.scholarKeys.map(reqUser),
    });
    groupId.set(group.key, id);
    bump("scholarGroups");
  }
  for (const aff of s.teacherAffinities) {
    await ctx.db.insert("teacherAffinities", {
      teacherId: reqUser(aff.teacherKey),
      scholarIds: aff.scholarKeys.map(reqUser),
      groupIds: aff.groupKeys.map(reqGroup),
    });
    bump("teacherAffinities");
  }

  // ── Institutions: drop the cohort into the fictional "Moli School" (most)
  //    with a couple of outside testers in "Guests", so the roster's
  //    hide-guests default is testable straight out of the seed. ───────────
  const { moli, assignedMoli, assignedGuests } =
    await assignDevInstitutions(ctx);
  bump("institutionAssignments", assignedMoli + assignedGuests);
  for (const id of groupId.values()) {
    await ctx.db.patch(id, { institutionId: moli });
  }

  // Leave one Robotics member unsigned so the realistic fixture demonstrates
  // the eligible/total roster distinction. Enrolled scholars use their signed
  // health intake or consent forms.
  const roboticsScholarKeys = s.groups.find(
    (group) => group.key === "group.robotics",
  )?.scholarKeys ?? [];
  for (const scholarKey of roboticsScholarKeys.filter(
    (key) => key !== "s.luca",
  )) {
    const parent = s.parents.find((candidate) =>
      candidate.childKeys.includes(scholarKey),
    );
    const scholar = s.scholars.find((candidate) => candidate.key === scholarKey);
    if (!parent || !scholar) continue;
    const guardianId = reqUser(parent.key);
    if (scholar.enrollmentStanding === "program_guest") {
      continue;
    }
    await ctx.db.insert("scholarHealthRecords", {
      scholarId: reqUser(scholarKey),
      guardianId,
      ...emptyHealthRecordFields({
        childName: scholar.name,
        childDob: scholar.dateOfBirth,
        guardianName: parent.name,
        guardianEmail: parent.email,
      }),
      publicMediaOptOut: scholarKey === "s.leilani",
      privateSchoolMediaOptOut: false,
      signerName: parent.name,
      signerAgreement: true,
      signerUserId: guardianId,
      signedAt: now,
      submittedAt: now,
      standardProgramAcknowledgedAt: now,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    bump("scholarHealthRecords");
  }

  // ── Shared Robotics captures: one item, many scholar attributions. The
  // seedRoboticsMedia action attaches each pre-baked SVG after this mutation.
  for (const item of s.portfolioItems) {
    const scholarIds = item.scholarKeys.map(reqUser);
    const portfolioItemId = await ctx.db.insert("portfolioItems", {
      scholarId: scholarIds[0],
      institutionId: moli,
      title: item.title,
      source: "capture_station",
      fileMimeType: "image/svg+xml",
      fileSizeBytes: new TextEncoder().encode(item.svg).byteLength,
      aiCaption: item.caption,
      matchStatus: "confirmed",
      matchConfidence: 1,
      assignmentStatus: "none",
      familyVisibility: "attributed_families",
      processingStatus: "ready",
    });
    bump("portfolioItems");
    for (const scholarKey of item.scholarKeys) {
      await ctx.db.insert("portfolioAttributions", {
        portfolioItemId,
        scholarId: reqUser(scholarKey),
        attributedAt: now,
        attributedBy: reqUser("t.lehua"),
      });
      bump("portfolioAttributions");
    }
  }

  const roboticsGroupId = reqGroup("group.robotics");
  const captureStationToken = generateCaptureStationEnrollmentToken();
  await ctx.db.insert("captureStations", {
    institutionId: moli,
    scholarGroupId: roboticsGroupId,
    label: "Moli School - Robotics",
    enrollmentTokenHash: await sha256Hex(captureStationToken),
    enabled: true,
    createdBy: reqUser("t.lehua"),
    createdAt: now,
  });
  bump("captureStations");

  // ── 4. Weekly timetable: current term + shared bell blocks ───────────────
  for (const period of s.reportingPeriods) {
    const id = await ctx.db.insert("reportingPeriods", {
      label: period.label,
      startsAt: daysAgo(now, period.startsAgoDays),
      endsAt: now + period.endsInDays * DAY_MS,
      status: period.status,
      institutionId: moli,
    });
    periodId.set(period.key, id);
    bump("reportingPeriods");
  }
  for (const block of s.scheduleBlocks) {
    const id = await ctx.db.insert("scheduleBlocks", {
      periodId: reqPeriod(block.periodKey),
      key: block.key,
      label: block.label,
      startLocal: block.startLocal,
      endLocal: block.endLocal,
      weekdays: block.weekdays,
      order: block.order,
      staffNeed: block.staffNeed,
      kind: block.kind,
    });
    scheduleBlockId.set(block.key, id);
    bump("scheduleBlocks");
  }
  // The "standing assignment" demo's catalog row (review/app-access-
  // unification-plan.html §robotics) — a schedulePlacement below references
  // it via externalAppId.
  for (const app of s.externalApps) {
    const id = await ctx.db.insert("externalApps", {
      name: app.name,
      webUrl: app.webUrl,
      nativeUrlScheme: app.nativeUrlScheme,
      iconEmoji: app.iconEmoji,
      color: app.color,
    });
    externalAppId.set(app.key, id);
    bump("externalApps");
  }

  // ── 5. Dossiers, directives, reading-level history ──────────────────────
  for (const d of s.dossiers) {
    await ctx.db.insert("scholarDossiers", {
      scholarId: reqUser(d.scholarKey),
      content: d.content,
    });
    bump("scholarDossiers");
  }
  for (const d of s.directives) {
    await ctx.db.insert("teacherDirectives", {
      scholarId: reqUser(d.scholarKey),
      label: d.label,
      content: d.content,
      authorId: reqUser(d.authorKey),
      isActive: d.isActive ?? true,
      updatedAt: now,
    });
    bump("teacherDirectives");
  }
  for (const r of s.readingLevelHistory) {
    await ctx.db.insert("readingLevelHistory", {
      scholarId: reqUser(r.scholarKey),
      level: r.level,
      source: r.source,
      changedBy: r.changedByKey ? reqUser(r.changedByKey) : undefined,
    });
    bump("readingLevelHistory");
  }

  // ── 6. Design: units → lessons → activities ─────────────────────────────
  for (const u of s.units) {
    // Independent-study units are authored by a scholar: teacherId ===
    // authorScholarId === the scholar (mirrors createQuest).
    const unitTeacherId = u.authorScholarKey
      ? reqUser(u.authorScholarKey)
      : reqUser(u.teacherKey);
    const uId = await ctx.db.insert("units", {
      teacherId: unitTeacherId,
      authorScholarId: u.authorScholarKey
        ? reqUser(u.authorScholarKey)
        : undefined,
      title: u.title,
      slug: u.slug,
      emoji: u.emoji,
      subject: u.subject,
      gradeLevel: u.gradeLevel,
      bigIdea: u.bigIdea,
      description: u.description,
      scholarDescription: u.scholarDescription,
      targetBloomLevel: u.targetBloomLevel,
      essentialQuestions: u.essentialQuestions,
      enduringUnderstandings: u.enduringUnderstandings,
      badgeOnCompletion: u.badgeOnCompletion,
      isActive: true,
    });
    unitId.set(u.key, uId);
    bump("units");

    for (const l of u.lessons) {
      const lId = await ctx.db.insert("lessons", {
        unitId: uId,
        title: l.title,
        order: l.order,
        strand: l.strand,
        systemPrompt: l.systemPrompt,
        durationMinutes: l.durationMinutes,
      });
      lessonId.set(l.key, lId);
      bump("lessons");

      for (const a of l.activities) {
        const aId = await ctx.db.insert("activities", {
          lessonId: lId,
          title: a.title,
          order: a.order,
          kind: a.kind,
          description: a.description,
          scholarDescription: a.scholarDescription,
          systemPrompt: a.systemPrompt,
          durationMinutes: a.durationMinutes,
          deliverable: a.deliverable,
          defaultMode: a.defaultMode,
          hasScholarAngles: a.hasScholarAngles,
          recipe: a.recipe,
          webUrl: a.webUrl,
          webAllowedHosts: a.webAllowedHosts,
          shareBackRecipe: a.shareBackRecipe,
          facilitationFocus: a.facilitationFocus,
        });
        activityId.set(a.key, aId);
        bump("activities");
      }
    }
  }

  // ── 7. Execution: assignments ───────────────────────────────────────────
  for (const a of s.assignments) {
    const id = await ctx.db.insert("assignments", {
      teacherId: reqUser(a.teacherKey),
      unitId: reqUnit(a.unitKey),
      scholarIds: a.scholarKeys.map(reqUser),
      title: a.title,
      startedAt: daysAgo(now, a.startedAgoDays),
      activitySchedule: a.schedule?.map((e) => ({
        activityId: reqActivity(e.activityKey),
        mode: e.mode,
        startsAt:
          e.startsInDays != null ? now + e.startsInDays * DAY_MS : undefined,
        setAt: e.setAgoMinutes != null ? minsAgo(now, e.setAgoMinutes) : undefined,
        endsAt: e.endsInMinutes != null ? now + e.endsInMinutes * MIN_MS : undefined,
        dueAt: e.dueInDays != null ? now + e.dueInDays * DAY_MS : undefined,
      })),
    });
    assignmentId.set(a.key, id);
    bump("assignments");
  }
  const reqAssignment = (k: Key) => mustGet(assignmentId, k, "assignment");
  const optAssignment = (k?: Key) => (k ? reqAssignment(k) : undefined);
  const reqExternalApp = (k: Key) => mustGet(externalAppId, k, "external app");

  // The timetable remains structural. Rich assignments use this same subject
  // vocabulary directly, so the auto-materializer cannot replace their
  // durable showcase pushes with future planned entries.
  for (const placement of s.schedulePlacements) {
    const placementId = await ctx.db.insert("schedulePlacements", {
      periodId: reqPeriod(placement.periodKey),
      groupId: reqGroup(placement.groupKey),
      weekday: placement.weekday,
      blockId: reqScheduleBlock(placement.blockKey),
      subject: placement.subject,
      teacherId: placement.teacherKey
        ? reqUser(placement.teacherKey)
        : undefined,
      externalAppId: placement.externalAppKey
        ? reqExternalApp(placement.externalAppKey)
        : undefined,
    });
    // An app-target placement is inserted directly (bypassing corePlaceClass),
    // so give it the same write-time materialization a teacher's edit gets —
    // otherwise the standing-assignment demo (LEGO SPIKE / Robotics Block E)
    // sits inert until the 15-minute cron backstop next runs. Every other
    // seeded placement is bare structure (no assignmentId/activityId), for
    // which this is a no-op, so it's safe to leave unscoped to just app rows.
    if (placement.externalAppKey) {
      await reconcilePlacementById(ctx, placementId);
    }
    bump("schedulePlacements");
  }

  // ── 8. Execution: sessions + their messages ─────────────────────────────
  for (const sess of s.sessions) {
    const lastMessageAt = minsAgo(now, sess.lastMessageAgoMinutes);
    const msgs = sess.messages ?? [];
    // Most-recent message (smallest agoMinutes) defines the preview/role.
    const lastMsg = msgs.length
      ? msgs.reduce((a, b) => (a.agoMinutes <= b.agoMinutes ? a : b))
      : undefined;
    const id = await ctx.db.insert("sessions", {
      userId: reqUser(sess.scholarKey),
      unitId: sess.unitKey ? reqUnit(sess.unitKey) : undefined,
      lessonId: sess.lessonKey ? mustGet(lessonId, sess.lessonKey, "lesson") : undefined,
      activityId: sess.activityKey ? reqActivity(sess.activityKey) : undefined,
      assignmentId: optAssignment(sess.assignmentKey),
      title: sess.title,
      isArchived: sess.isArchived ?? false,
      isOffline: sess.isOffline,
      seedExemplar: sess.seedExemplar ?? true,
      pulseScore: sess.pulseScore,
      analysisSummary: sess.analysisSummary,
      teacherWhisper: sess.teacherWhisper,
      activityCompletedAt:
        sess.activityCompletedAgoMinutes != null
          ? minsAgo(now, sess.activityCompletedAgoMinutes)
          : undefined,
      lastMessageAt: msgs.length ? lastMessageAt : undefined,
      lastMessageRole: lastMsg?.role,
      lastMessagePreview: lastMsg?.content.slice(0, 120),
    });
    sessionId.set(sess.key, id);
    bump("sessions");

    // Messages anchor relative to the session's lastMessageAt.
    for (const m of msgs) {
      await ctx.db.insert("messages", {
        sessionId: id,
        role: m.role,
        content: m.content,
        flagged: m.flagged ?? false,
        flagReason: m.flagReason,
        toolAction: m.toolAction,
        model: m.model,
      });
      bump("messages");
    }

    // Process state (deferred for shard 1, but support it if authored).
    if (sess.processState) {
      // Resolving a process by slug is a later-shard concern; skip for now.
    }
  }

  // ── 9. Observation: analyses (one per session) ──────────────────────────
  for (const an of s.analyses) {
    await ctx.db.insert("analyses", {
      sessionId: reqSession(an.sessionKey),
      engagementScore: an.engagementScore,
      complexityLevel: an.complexityLevel,
      onTaskScore: an.onTaskScore,
      topics: an.topics,
      learningIndicators: an.learningIndicators,
      concernFlags: an.concernFlags,
      summary: an.summary,
      suggestedIntervention: an.suggestedIntervention,
    });
    bump("analyses");
  }

  // ── 10. Execution: deliverable submissions ──────────────────────────────
  for (const d of s.deliverables) {
    await ctx.db.insert("deliverables", {
      activityId: reqActivity(d.activityKey),
      scholarId: reqUser(d.scholarKey),
      sessionId: reqSession(d.sessionKey),
      assignmentId: optAssignment(d.assignmentKey),
      textContent: d.textContent,
      submittedAt: minsAgo(now, d.submittedAgoMinutes),
      rubricPassed: d.rubricPassed,
      rubricFeedback: d.rubricFeedback,
      rubricCheckedBy: d.rubricCheckedBy,
      rubricCheckedAt:
        d.rubricCheckedAgoMinutes != null
          ? minsAgo(now, d.rubricCheckedAgoMinutes)
          : undefined,
      overall: d.overall,
      verdicts: d.verdicts,
    });
    bump("deliverables");
  }

  // ── 11. Execution: activity completions ─────────────────────────────────
  for (const c of s.completions) {
    await ctx.db.insert("activityCompletions", {
      scholarId: reqUser(c.scholarKey),
      activityId: reqActivity(c.activityKey),
      lessonId: c.lessonKey ? mustGet(lessonId, c.lessonKey, "lesson") : undefined,
      unitId: c.unitKey ? reqUnit(c.unitKey) : undefined,
      sessionId: c.sessionKey ? reqSession(c.sessionKey) : undefined,
      assignmentId: optAssignment(c.assignmentKey),
      completedAt: minsAgo(now, c.completedAgoMinutes),
      note: c.note,
    });
    bump("activityCompletions");
  }

  // ── 12. Observation: mastery (two-pass for supersession chains) ─────────
  for (const m of s.mastery) {
    const id = await ctx.db.insert("masteryObservations", {
      scholarId: reqUser(m.scholarKey),
      conceptLabel: m.conceptLabel,
      domain: m.domain,
      observedAt: daysAgo(now, m.observedAgoDays),
      sessionId: reqSession(m.sessionKey),
      transcriptExcerpt: m.transcriptExcerpt,
      masteryLevel: m.masteryLevel,
      confidenceScore: m.confidenceScore,
      evidenceSummary: m.evidenceSummary,
      evidenceType: m.evidenceType,
      attemptContext: m.attemptContext,
      studentInitiated: m.studentInitiated,
      isSuperseded: m.isSuperseded ?? false,
      misconceptionStatus: m.misconceptionStatus,
      misconceptionAddressedAt:
        m.misconceptionAddressedAgoDays != null
          ? daysAgo(now, m.misconceptionAddressedAgoDays)
          : undefined,
      misconceptionAddressedBy: m.misconceptionAddressedByKey
        ? reqUser(m.misconceptionAddressedByKey)
        : undefined,
      misconceptionNote: m.misconceptionNote,
    });
    masteryId.set(m.key, id);
    bump("masteryObservations");
  }
  // Second pass: link supersedesId now that every mastery row has an Id.
  for (const m of s.mastery) {
    if (m.supersedesKey) {
      await ctx.db.patch(mustGet(masteryId, m.key, "mastery"), {
        supersedesId: mustGet(masteryId, m.supersedesKey, "mastery"),
      });
    }
  }

  // ── 13. Observation: granule evidence ───────────────────────────────────
  for (const g of s.granuleEvidence) {
    await ctx.db.insert("granuleEvidence", {
      scholarId: reqUser(g.scholarKey),
      unitId: reqUnit(g.unitKey),
      granuleKey: g.granuleKey,
      assignmentId: optAssignment(g.assignmentKey),
      sessionId: reqSession(g.sessionKey),
      observedAt: daysAgo(now, g.observedAgoDays),
      outcome: g.outcome,
      transcriptExcerpt: g.transcriptExcerpt,
      evidenceSummary: g.evidenceSummary,
      bloomLevel: g.bloomLevel,
      phase: g.phase,
    });
    bump("granuleEvidence");
  }

  // ── 14. Observation: signals, connections, seeds, observations ──────────
  for (const sig of s.signals) {
    await ctx.db.insert("sessionSignals", {
      scholarId: reqUser(sig.scholarKey),
      sessionId: reqSession(sig.sessionKey),
      signalType: sig.signalType,
      description: sig.description,
      intensity: sig.intensity,
      transcriptExcerpt: sig.transcriptExcerpt,
    });
    bump("sessionSignals");
  }
  for (const c of s.connections) {
    await ctx.db.insert("crossDomainConnections", {
      scholarId: reqUser(c.scholarKey),
      domains: c.domains,
      conceptLabels: c.conceptLabels,
      description: c.description,
      sessionId: reqSession(c.sessionKey),
      studentInitiated: c.studentInitiated,
      transcriptExcerpt: c.transcriptExcerpt,
    });
    bump("crossDomainConnections");
  }
  for (const seed of s.seeds) {
    await ctx.db.insert("seeds", {
      scholarId: reqUser(seed.scholarKey),
      origin: seed.origin,
      status: seed.status,
      topic: seed.topic,
      domain: seed.domain,
      suggestionType: seed.suggestionType,
      rationale: seed.rationale,
      scholarInvitation: seed.scholarInvitation,
      approachHint: seed.approachHint,
      connectionTo: seed.connectionTo,
      sessionId: seed.sessionKey ? reqSession(seed.sessionKey) : undefined,
      teacherId: seed.teacherKey ? reqUser(seed.teacherKey) : undefined,
      currentBloomsLevel: seed.currentBloomsLevel,
      targetBloomsLevel: seed.targetBloomsLevel,
    });
    bump("seeds");
  }
  for (const o of s.observations) {
    await ctx.db.insert("observations", {
      teacherId: reqUser(o.teacherKey),
      scholarId: reqUser(o.scholarKey),
      sessionId: o.sessionKey ? reqSession(o.sessionKey) : undefined,
      note: o.note,
      type: o.type,
    });
    bump("observations");
  }

  // ── Badges: earned unit-completion + custom awards ──────────────────────────
  // Seeded directly (not via badges.awardUnitBadge) and WITHOUT scheduling
  // generative art — artStatus "ready" + no imageStorageId means BadgeArt shows
  // the emoji fallback, so re-seeding every worktree stays cheap.
  for (const b of s.badges) {
    await ctx.db.insert("scholarUnitBadges", {
      scholarId: reqUser(b.scholarKey),
      ...(b.unitKey ? { unitId: reqUnit(b.unitKey) } : {}),
      earnedAt: Date.now() - (b.earnedAgoDays ?? 0) * 86_400_000,
      badgeSnapshot: {
        title: b.title,
        description: b.description,
        icon: b.icon,
      },
      style: b.style ?? "patch",
      colorway: b.colorway ?? "auto",
      artStatus: "ready",
      rerollsUsed: 0,
    });
    bump("scholarUnitBadges");
  }

  // ── 15. Sims: profiles → variants → experiments → simulated sessions ────
  for (const p of s.syntheticProfiles) {
    const id = await ctx.db.insert("syntheticScholarProfiles", {
      ownerId: reqUser(p.ownerKey),
      name: p.name,
      readingLevel: p.readingLevel,
      dossier: p.dossier,
      traits: p.traits,
      archetype: p.archetype,
    });
    profileId.set(p.key, id);
    bump("syntheticScholarProfiles");
  }
  // Variants first (experiments reference baselineVariantId); experimentId is
  // back-patched once experiments exist.
  for (const v of s.variants) {
    const id = await ctx.db.insert("curriculumVariants", {
      activityId: reqActivity(v.activityKey),
      parentVariantId: v.parentVariantKey
        ? mustGet(variantId, v.parentVariantKey, "variant")
        : undefined,
      generation: v.generation,
      systemPrompt: v.systemPrompt,
      origin: v.origin,
      rationale: v.rationale,
      aggregateScores: v.aggregateScores,
      status: v.status,
    });
    variantId.set(v.key, id);
    bump("curriculumVariants");
  }
  for (const e of s.experiments) {
    const id = await ctx.db.insert("curriculumExperiments", {
      activityId: reqActivity(e.activityKey),
      teacherId: reqUser(e.teacherKey),
      mode: e.mode,
      config: {
        castProfileIds: e.castProfileKeys.map((k) =>
          mustGet(profileId, k, "profile"),
        ),
        maxTurns: e.maxTurns,
        learningGoal: e.learningGoal,
        generations: e.generations,
        variantsPerGen: e.variantsPerGen,
      },
      status: e.status,
      progress: {
        sessionsDone: e.sessionsDone,
        sessionsTotal: e.sessionsTotal,
      },
      baselineVariantId: e.baselineVariantKey
        ? mustGet(variantId, e.baselineVariantKey, "variant")
        : undefined,
      bestVariantId: e.bestVariantKey
        ? mustGet(variantId, e.bestVariantKey, "variant")
        : undefined,
      overallVerdict: e.overallVerdict,
      grounding: e.grounding,
      startedAt: daysAgo(now, e.startedAgoDays),
      finishedAt:
        e.finishedAgoDays != null ? daysAgo(now, e.finishedAgoDays) : undefined,
    });
    experimentId.set(e.key, id);
    bump("curriculumExperiments");
  }
  // Back-patch each variant's experimentId.
  for (const v of s.variants) {
    if (v.experimentKey) {
      await ctx.db.patch(mustGet(variantId, v.key, "variant"), {
        experimentId: mustGet(experimentId, v.experimentKey, "experiment"),
      });
    }
  }
  for (const sim of s.simulatedSessions) {
    await ctx.db.insert("simulatedSessions", {
      experimentId: mustGet(experimentId, sim.experimentKey, "experiment"),
      variantId: mustGet(variantId, sim.variantKey, "variant"),
      profileId: mustGet(profileId, sim.profileKey, "profile"),
      transcript: sim.transcript,
      stopReason: sim.stopReason,
      verdict: sim.verdict,
      goalReached: sim.goalReached,
    });
    bump("simulatedSessions");
  }
  // Grounded verdicts: one judge verdict per completed real session. Drives the
  // violet Sessions distribution (activitySessions.ts reads fitness by activity).
  for (const gv of s.groundedVerdicts) {
    await ctx.db.insert("groundedSessionVerdicts", {
      activityId: reqActivity(gv.activityKey),
      sessionId: reqSession(gv.sessionKey),
      experimentId: mustGet(experimentId, gv.experimentKey, "experiment"),
      scholarId: gv.scholarKey ? reqUser(gv.scholarKey) : undefined,
      profileName: gv.profileName,
      readingLevel: gv.readingLevel,
      verdict: gv.verdict,
      fitness: gv.fitness,
      goalAttainment: gv.goalAttainment,
      excerpt: gv.excerpt,
      judgedAt: minsAgo(now, gv.judgedAgoMinutes),
    });
    bump("groundedSessionVerdicts");
  }

  // ── 16. Sims: unit reviews, reflections, moment triage ──────────────────
  for (const r of s.unitReviews) {
    await ctx.db.insert("unitReviews", {
      unitId: reqUnit(r.unitKey),
      reviewedBy: reqUser(r.reviewedByKey),
      reviewedAt: daysAgo(now, r.reviewedAgoDays),
      openGapCount: r.openGapCount,
      summary: r.summary,
    });
    bump("unitReviews");
  }
  for (const r of s.activityReflections) {
    await ctx.db.insert("activityReflections", {
      activityId: reqActivity(r.activityKey),
      teacherId: reqUser(r.teacherKey),
      content: r.content,
      updatedAt: daysAgo(now, r.updatedAgoDays),
    });
    bump("activityReflections");
  }
  for (const m of s.momentTriage) {
    await ctx.db.insert("momentTriage", {
      teacherId: reqUser(m.teacherKey),
      activityId: reqActivity(m.activityKey),
      source: m.source,
      sourceId: mustGet(masteryId, m.sourceMasteryKey, "mastery"),
      verdict: m.verdict,
      triagedAt: daysAgo(now, m.triagedAgoDays),
    });
    bump("momentTriage");
  }

  // ── 17. Teacher chat: chats + curriculumMessages ───────────────────────
  for (const c of s.chats) {
    const teacherId = reqUser(c.teacherKey);
    const unitId_ = c.unitKey ? reqUnit(c.unitKey) : undefined;
    const scholarId = c.scholarKey ? reqUser(c.scholarKey) : undefined;
    const chatId_ = await ctx.db.insert("chats", {
      teacherId,
      title: c.title,
      pinned: c.pinned ?? false,
      unitId: unitId_,
      scholarId,
      lastMessageAt: minsAgo(now, c.lastMessageAgoMinutes),
    });
    bump("chats");
    // Author oldest-first so _creationTime order is chronological.
    const ordered = [...c.messages].sort((a, b) => b.agoMinutes - a.agoMinutes);
    for (const m of ordered) {
      await ctx.db.insert("curriculumMessages", {
        teacherId,
        chatId: chatId_,
        unitId: unitId_,
        scholarId,
        role: m.role,
        content: m.content,
        model: m.model,
      });
      bump("curriculumMessages");
    }
  }

  // ── 18. Practice-engine mastery (math practice graph — dev realism) ─────
  // Deterministic mid-journey practiceMastery so the practice flow serves a
  // real, sustained, interleaved "Today's blend" out of the box instead of the
  // cold-start placement band. Domain + strand are derived from the knowledge
  // graph node; a skill whose node isn't present (a seed path that skipped the
  // graph build, e.g. richSeed.test.ts) is SKIPPED, so this never throws.
  // See convex/seed/rich/practice.ts for the fixture + rationale.
  const mappedPracticeDomains = new Map<
    string,
    { scholarId: Id<"users">; domain: string }
  >();
  for (const pm of s.practiceMastery) {
    const scholarId = reqUser(pm.scholarKey);
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", pm.skillKey))
      .first();
    if (!node) continue;
    mappedPracticeDomains.set(`${scholarId}:${node.domain}`, {
      scholarId,
      domain: node.domain,
    });
    const existing = await ctx.db
      .query("practiceMastery")
      .withIndex("by_scholar_skill", (q) =>
        q.eq("scholarId", scholarId).eq("skillKey", pm.skillKey),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("practiceMastery", {
      scholarId,
      skillKey: pm.skillKey,
      domain: node.domain,
      strand: node.strand,
      repetition: pm.repetition,
      halfLifeDays: pm.halfLifeDays ?? (pm.frontier ? 2 : 100),
      lastPracticedAt: now - (pm.lastPracticedAgoDays ?? 1) * DAY_MS,
      frontier: pm.frontier,
      source: "practice",
      updatedAt: now,
    });
    bump("practiceMastery");
  }
  for (const { scholarId, domain } of mappedPracticeDomains.values()) {
    const existing = await ctx.db
      .query("practicePlacements")
      .withIndex("by_scholar_domain", (q) =>
        q.eq("scholarId", scholarId).eq("domain", domain),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("practicePlacements", {
      scholarId,
      domain,
      status: "complete",
      probesAnswered: 0,
      updatedAt: now,
    });
    bump("practicePlacements");
  }

  // ── 19. Practice-engine misses (math practice graph — dev realism) ─────
  // Deterministic, clearly-fictional MISS rows WITH their Option-2 snapshot
  // (stemSnapshot + expectedAnswer) already attached, so the new "recent
  // misses" teacher surfaces (SkillDetailPanel, ReportSkillRow) render real
  // content instead of blank out of the box. Domain is derived from the
  // knowledge graph node; a skill whose node isn't present is SKIPPED, so
  // this never throws. See convex/seed/rich/practice.ts for the fixture.
  for (const pa of s.practiceAttempts) {
    const scholarId = reqUser(pa.scholarKey);
    const node = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_nodeKey", (q) => q.eq("nodeKey", pa.skillKey))
      .first();
    if (!node) continue;
    const createdAt = minsAgo(now, pa.agoMinutes);
    const existing = await ctx.db
      .query("practiceAttempts")
      .withIndex("by_scholar_node_createdAt", (q) =>
        q.eq("scholarId", scholarId).eq("nodeKey", pa.skillKey).eq("createdAt", createdAt),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("practiceAttempts", {
      scholarId,
      nodeKey: pa.skillKey,
      correct: false,
      answerText: pa.wrongAnswer,
      domain: node.domain,
      strand: node.strand,
      lane: "frontier",
      breakerEligible: true,
      source: "seed",
      stemSnapshot: pa.stem,
      expectedAnswer: pa.expectedAnswer,
      createdAt,
    });
    bump("practiceAttempts");
  }

  return { inserted: true, counts, captureStationToken };
}

function generateCaptureStationEnrollmentToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return `rhcapture_${Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")}`;
}

function mustGet<V>(map: Map<Key, V>, key: Key, label: string): V {
  const v = map.get(key);
  if (v === undefined) {
    throw new Error(`rich seed: unresolved ${label} key "${key}"`);
  }
  return v;
}

export const seedAll = internalMutation({
  args: {},
  handler: async (ctx) => {
    const { inserted, counts, captureStationToken } =
      await insertRichCohort(ctx);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(
      inserted
        ? `Rich cohort seeded: ${total} rows — ${JSON.stringify(counts)}`
        : "Rich cohort already present — skipped.",
    );
    return { inserted, counts, captureStationToken };
  },
});

export const findRoboticsPortfolioItem = internalQuery({
  args: { title: v.string() },
  handler: async (ctx, { title }) =>
    await ctx.db
      .query("portfolioItems")
      .filter((q) =>
        q.and(
          q.eq(q.field("source"), "capture_station"),
          q.eq(q.field("title"), title),
        ),
      )
      .first(),
});

export const attachRoboticsPortfolioMedia = internalMutation({
  args: {
    portfolioItemId: v.id("portfolioItems"),
    fileStorageId: v.id("_storage"),
    fileSizeBytes: v.number(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.portfolioItemId);
    if (!item || item.source !== "capture_station") return;
    if (!item.fileStorageId) {
      await ctx.db.patch(args.portfolioItemId, {
        fileStorageId: args.fileStorageId,
        fileSizeBytes: args.fileSizeBytes,
      });
    }

    const attributions = await ctx.db
      .query("portfolioAttributions")
      .withIndex("by_item", (q) =>
        q.eq("portfolioItemId", args.portfolioItemId),
      )
      .collect();
    const attributedIds = new Set(
      attributions.map((attribution) => attribution.scholarId),
    );
    const roboticsGroup = (
      await ctx.db
        .query("scholarGroups")
        .withIndex("by_institution", (q) =>
          q.eq("institutionId", item.institutionId),
        )
        .collect()
    ).find(
      (group) =>
        group.type === "robotics" &&
        [...attributedIds].every((scholarId) =>
          group.scholarIds.includes(scholarId),
        ),
    );
    const station = roboticsGroup
      ? await ctx.db
          .query("captureStations")
          .withIndex("by_group", (q) =>
            q.eq("scholarGroupId", roboticsGroup._id),
          )
          .unique()
      : null;
    if (!station) return;

    let session = await ctx.db
      .query("captureStationSessions")
      .withIndex("by_station", (q) => q.eq("captureStationId", station._id))
      .first();
    if (!session) {
      const seededAt = item._creationTime;
      const sessionId = await ctx.db.insert("captureStationSessions", {
        captureStationId: station._id,
        deviceId: "rich-seed-capture-station",
        sessionTokenHash: `rich-seed-${station._id}`,
        createdAt: seededAt,
        expiresAt: seededAt,
        revokedAt: seededAt,
      });
      session = await ctx.db.get(sessionId);
    }
    if (!session) return;

    const existingCapture = await ctx.db
      .query("captureStationCaptures")
      .withIndex("by_portfolio_item", (q) =>
        q.eq("portfolioItemId", args.portfolioItemId),
      )
      .unique();
    if (existingCapture) return;

    await ctx.db.insert("captureStationCaptures", {
      captureStationId: station._id,
      sessionId: session._id,
      portfolioItemId: args.portfolioItemId,
      storageId: args.fileStorageId,
      scholarIds: attributions.map((attribution) => attribution.scholarId),
      mimeType: "image/svg+xml",
      sizeBytes: args.fileSizeBytes,
      createdAt: item._creationTime,
    });
  },
});

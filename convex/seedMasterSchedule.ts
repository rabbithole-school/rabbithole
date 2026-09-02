// Dev-only seed for the Master Schedule (review/master-schedule-plan.html).
// Stamps a realistic weekly timetable onto a term so the grid has content to
// render + click through — the bell-schedule rows from the reference photo
// (Morning Circle, Block A–D, Recess A/B, Lunch, Scholar’s Prep) plus a scatter of
// class cells across two groups, a shelf item, a deliberately-understaffed
// recess, and one double-booking so the coverage rail + conflict badges show.
//
// Run it (plane mode / dev): npx convex run seedMasterSchedule:seedSample '{}'
// Idempotent: skips a term that already has blocks unless { force: true }.

import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { isTeacherRole } from "./lib/roles";

export const seedSample = internalMutation({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    // 1. A term to hang it on — the current open/writing period, else make one.
    const periods = await ctx.db.query("reportingPeriods").collect();
    let period =
      periods.find((p) => p.status === "writing") ??
      periods.find((p) => p.status === "open") ??
      periods[0] ??
      null;
    if (!period) {
      const now = Date.now();
      const id = await ctx.db.insert("reportingPeriods", {
        label: "Fall 2026",
        startsAt: now,
        endsAt: now + 90 * 86_400_000,
        status: "open",
      });
      period = (await ctx.db.get(id))!;
    }
    const periodId = period._id;

    // Bail if already seeded (unless forced — then wipe this term's rows).
    const existingBlocks = await ctx.db
      .query("scheduleBlocks")
      .withIndex("by_period", (q) => q.eq("periodId", periodId))
      .collect();
    if (existingBlocks.length > 0) {
      if (!force) {
        return { skipped: true, reason: "term already has a schedule", periodId, term: period.label };
      }
      const existingPlacements = await ctx.db
        .query("schedulePlacements")
        .withIndex("by_period", (q) => q.eq("periodId", periodId))
        .collect();
      for (const p of existingPlacements) await ctx.db.delete(p._id);
      for (const b of existingBlocks) await ctx.db.delete(b._id);
    }

    // 2. Two scholar groups (make them if the seed cohort has none).
    let groups = await ctx.db.query("scholarGroups").take(2);
    const anyTeacher = (await ctx.db.query("users").collect()).find((u) =>
      isTeacherRole(u.role as never),
    );
    const creatorId = (anyTeacher?._id ?? (await ctx.db.query("users").first())?._id) as Id<"users">;
    if (groups.length < 2 && creatorId) {
      const need = [
        { name: "Geckos", emoji: "🦎" },
        { name: "Honu", emoji: "🐢" },
      ].slice(groups.length);
      for (const g of need) {
        await ctx.db.insert("scholarGroups", {
          teacherId: creatorId,
          name: g.name,
          emoji: g.emoji,
          scholarIds: [],
        });
      }
      groups = await ctx.db.query("scholarGroups").take(2);
    }
    const [g1, g2] = groups;

    // 3. A few teachers to fill the avatars with (whoever exists).
    const teachers = (await ctx.db.query("users").collect())
      .filter((u) => isTeacherRole(u.role as never))
      .slice(0, 3);
    const t0 = teachers[0]?._id as Id<"users"> | undefined;
    const t1 = (teachers[1]?._id ?? t0) as Id<"users"> | undefined;
    const t2 = (teachers[2]?._id ?? t1) as Id<"users"> | undefined;

    // 4. The bell-schedule rows (shared across groups).
    const blockDefs: {
      key: string;
      label: string;
      startLocal: string;
      endLocal: string;
      kind?: "class" | "recess" | "lunch" | "prep";
    }[] = [
      { key: "morning-circle", label: "Morning Circle", startLocal: "08:00", endLocal: "08:30" },
      { key: "block-a", label: "Block A", startLocal: "08:30", endLocal: "09:40" },
      { key: "block-b", label: "Block B", startLocal: "09:40", endLocal: "10:50" },
      { key: "recess-a", label: "Recess A", startLocal: "10:50", endLocal: "11:05", kind: "recess" },
      { key: "block-c", label: "Block C", startLocal: "11:10", endLocal: "12:20" },
      { key: "lunch", label: "Lunch", startLocal: "12:20", endLocal: "13:00", kind: "lunch" },
      { key: "block-d", label: "Block D", startLocal: "13:00", endLocal: "14:10" },
      { key: "recess-b", label: "Recess B", startLocal: "14:10", endLocal: "14:25", kind: "recess" },
      { key: "scholar-practice-lab", label: "Scholar’s Prep", startLocal: "14:30", endLocal: "15:00" },
    ];
    const blockId: Record<string, Id<"scheduleBlocks">> = {};
    let order = 0;
    for (const b of blockDefs) {
      blockId[b.key] = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: b.key,
        label: b.label,
        startLocal: b.startLocal,
        endLocal: b.endLocal,
        weekdays: [1, 2, 3, 4, 5],
        order: order++,
        kind: b.kind,
      });
    }

    // 5. Class cells. (weekday 1–5 = Mon–Fri.)
    let placed = 0;
    const place = async (args: {
      groupId: Id<"scholarGroups">;
      subject: string;
      weekday?: number;
      block?: string;
      teacherId?: Id<"users">;
      note?: string;
    }) => {
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: args.groupId,
        subject: args.subject,
        weekday: args.weekday,
        blockId: args.block ? blockId[args.block] : undefined,
        teacherId: args.teacherId,
        note: args.note,
      });
      placed++;
    };

    if (g1) {
      await place({ groupId: g1._id, subject: "Math Workshop", weekday: 1, block: "block-a", teacherId: t0 });
      await place({ groupId: g1._id, subject: "Reading", weekday: 1, block: "block-b", teacherId: t1 });
      await place({ groupId: g1._id, subject: "Science", weekday: 2, block: "block-a", teacherId: t0 });
      await place({ groupId: g1._id, subject: "PE", weekday: 3, block: "block-c", teacherId: t2 });
      await place({ groupId: g1._id, subject: "Writing", weekday: 4, block: "block-b", teacherId: t1 });
      await place({ groupId: g1._id, subject: "Practice Lab", weekday: 5, block: "scholar-practice-lab", teacherId: t0 });
      // Block D across the week so the live "Now" cross-section has content on any
      // weekday, not just an empty slot.
      await place({ groupId: g1._id, subject: "Studio Time", weekday: 1, block: "block-d", teacherId: t0 });
      await place({ groupId: g1._id, subject: "Studio Time", weekday: 3, block: "block-d", teacherId: t0 });
      await place({ groupId: g1._id, subject: "Studio Time", weekday: 5, block: "block-d", teacherId: t2 });
      // Understaffed recess (need 2, one adult) — coverage rail flags it.
      await place({ groupId: g1._id, subject: "Recess duty", weekday: 1, block: "recess-a", teacherId: t0 });
      // Shelf item (tentative).
      await place({ groupId: g1._id, subject: "Guest speaker (some Wed)", note: "tentative — week 4?" });
    }
    if (g2) {
      await place({ groupId: g2._id, subject: "Humanities", weekday: 1, block: "block-a", teacherId: t1 });
      await place({ groupId: g2._id, subject: "Math", weekday: 2, block: "block-b", teacherId: t2 });
      await place({ groupId: g2._id, subject: "Art", weekday: 3, block: "block-a", teacherId: t2 });
      await place({ groupId: g2._id, subject: "Music", weekday: 4, block: "block-c", teacherId: t1 });
      await place({ groupId: g2._id, subject: "Book Club", weekday: 1, block: "block-d", teacherId: t1 });
      await place({ groupId: g2._id, subject: "Book Club", weekday: 3, block: "block-d", teacherId: t1 });
      await place({ groupId: g2._id, subject: "Book Club", weekday: 5, block: "block-d", teacherId: t1 });
      // Deliberate double-booking: t0 is also on g2 Mon Block A (already on g1
      // Mon Block A above) → conflict badge.
      if (t0) await place({ groupId: g2._id, subject: "Coding", weekday: 1, block: "block-a", teacherId: t0 });
    }

    // 6. Homework due rail — chips pinned to the term's virtual homework block so
    //    the top-of-day "Homework due" rail renders (mode: "homework").
    if (g1) {
      const hwBlock = await ctx.db.insert("scheduleBlocks", {
        periodId,
        key: "homework-due",
        label: "Homework due",
        startLocal: "08:00",
        endLocal: "08:00",
        weekdays: [1, 2, 3, 4, 5],
        order: 9999,
        staffNeed: 0,
        kind: "homework",
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: g1._id,
        subject: "Reading log",
        mode: "homework",
        weekday: 2,
        blockId: hwBlock,
        teacherId: t1,
      });
      placed++;
      if (g2) {
        await ctx.db.insert("schedulePlacements", {
          periodId,
          groupId: g2._id,
          subject: "Math problem set",
          mode: "homework",
          weekday: 4,
          blockId: hwBlock,
          teacherId: t2,
        });
        placed++;
      }
    }

    // 7. An out-of-order unit sequence: two activities share a sequenceId, but the
    //    later step sits EARLIER in the week than the first, so the grid flags
    //    both chips out-of-order (the "teacher called an audible" case). Both on
    //    otherwise-free Block C days, so it doesn't also trip conflict/overload.
    if (g1) {
      const seqId = "seed-seq-aqua";
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: g1._id,
        subject: "Aquaponics · step 1",
        weekday: 4,
        blockId: blockId["block-c"],
        teacherId: t0,
        sequenceId: seqId,
        sequenceIndex: 0,
      });
      await ctx.db.insert("schedulePlacements", {
        periodId,
        groupId: g1._id,
        subject: "Aquaponics · step 2",
        weekday: 2,
        blockId: blockId["block-c"],
        teacherId: t0,
        sequenceId: seqId,
        sequenceIndex: 1,
      });
      placed += 2;
    }

    return { skipped: false, periodId, term: period.label, blocks: blockDefs.length, placements: placed };
  },
});

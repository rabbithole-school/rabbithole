// messageAccessAudit:run (TRA-388) — one seeded violation per invariant, a
// clean thread that reports nothing, and cursor pagination.

import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "../schema";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AuditPosition, MessageAccessViolation } from "../messageAccessAudit";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const makeT = () => convexTest(schema, modules);
type T = ReturnType<typeof makeT>;

async function seed(t: T) {
  return await t.run(async (ctx) => {
    const a = await ctx.db.insert("institutions", { name: "Alder", slug: "alder-au", kind: "school", isPrimary: true });
    const c = await ctx.db.insert("institutions", { name: "Cedar", slug: "cedar-au", kind: "school" });
    const user = async (username: string, role: "scholar" | "teacher" | "staff" | "parent", institutionId?: Id<"institutions">) =>
      await ctx.db.insert("users", { username, name: username, role, ...(institutionId ? { institutionId } : {}) });
    const scholar = await user("au-scholar", "scholar", a);
    const other = await user("au-other", "scholar", a);
    const moved = await user("au-moved", "scholar", c);
    const teacher = await user("au-teacher", "teacher");
    await ctx.db.insert("memberships", { userId: teacher, role: "teacher", institutionId: a });
    const mentor = await user("au-mentor", "staff");
    await ctx.db.insert("memberships", { userId: mentor, role: "staff", institutionId: a });
    await ctx.db.insert("staffCapabilityGrants", {
      granteeUserId: mentor, institutionId: a, capability: "scholars:mentor", grantedBy: teacher, grantedAt: 1,
    });
    const stranger = await user("au-stranger", "staff");
    const parent = await user("au-parent", "parent");

    const thread = async (
      kind: "mentor" | "workshop" | undefined,
      scholarId: Id<"users">,
      opts: { institutionId?: Id<"institutions">; scholarSide?: Id<"users">[]; staff?: Id<"users">[] } = {},
    ) => {
      const threadId = await ctx.db.insert("parentThreads", {
        parentUserId: kind ? scholarId : parent,
        scholarId,
        institutionId: opts.institutionId ?? a,
        lastMessageAt: 1,
        ...(kind ? { kind } : {}),
      });
      for (const id of opts.scholarSide ?? (kind ? [scholarId] : [])) {
        await ctx.db.insert("parentThreadParticipants", { threadId, parentUserId: id, side: "scholar" });
      }
      for (const id of opts.staff ?? []) {
        await ctx.db.insert("parentThreadParticipants", { threadId, parentUserId: id, side: "staff" });
      }
      if (!kind) await ctx.db.insert("parentThreadParticipants", { threadId, parentUserId: parent });
      return threadId;
    };

    const clean = await thread("mentor", scholar, { staff: [teacher, mentor] });
    const noScholar = await thread("mentor", scholar, { scholarSide: [] });
    const stray = await thread("workshop", scholar, { scholarSide: [scholar, other] });
    const staleName = await thread("mentor", scholar, { staff: [stranger] });
    const history = await thread("mentor", moved);
    const suggestion = await ctx.db.insert("scholarSuggestions", {
      scholarId: other, title: "x", scholarWords: "x", createdAt: 1, updatedAt: 1,
    });
    const mismatch = await thread("workshop", scholar);
    await ctx.db.patch(mismatch, { suggestionId: suggestion });
    const family = await thread(undefined, scholar);
    const familyMessage = await ctx.db.insert("parentMessages", {
      threadId: family, authorType: "teacher", authorUserId: teacher, body: "hi",
    });
    await ctx.db.insert("messageDeliveries", {
      messageId: familyMessage, parentUserId: scholar, channel: "sms", status: "queued",
    });
    // A portal row to a scholar is fine.
    const mentorMessage = await ctx.db.insert("parentMessages", {
      threadId: clean, authorType: "teacher", authorUserId: teacher, body: "hi",
    });
    await ctx.db.insert("messageDeliveries", {
      messageId: mentorMessage, parentUserId: scholar, channel: "portal", status: "sent",
    });
    const withdrawn = await ctx.db.insert("parentMessages", {
      threadId: family, authorType: "parent", authorUserId: parent, body: "x", retracted: true,
    });
    const storageId = await ctx.storage.store(new Blob(["x"]));
    await ctx.db.insert("parentMessageAttachments", {
      messageId: withdrawn, threadId: family, storageId, uploaderId: parent,
      fileName: "x.png", mimeType: "image/png", sizeBytes: 1,
    });
    return { clean, noScholar, stray, staleName, history, mismatch, family, other, stranger };
  });
}

async function runAll(t: T, budget?: number) {
  const violations: MessageAccessViolation[] = [];
  let position: AuditPosition | undefined;
  let calls = 0;
  let maxWork = 0;
  for (;;) {
    const slice: {
      violations: MessageAccessViolation[];
      next: AuditPosition | null;
      isDone: boolean;
      truncated: boolean;
      work: number;
    } = await t.query(internal.messageAccessAudit.run, {
      ...(position ? { position } : {}),
      ...(budget ? { budget } : {}),
    });
    violations.push(...slice.violations);
    calls++;
    maxWork = Math.max(maxWork, slice.work);
    expect(slice.truncated).toBe(!slice.isDone);
    if (slice.isDone) break;
    position = slice.next!;
    if (calls > 500) throw new Error("audit made no progress");
  }
  return { violations, calls, maxWork };
}

const signature = (v: MessageAccessViolation) => `${v.invariant}|${v.threadId}|${JSON.stringify(v.detail)}`;

describe("messageAccessAudit:run", () => {
  test("reports each invariant on exactly the thread that breaks it", async () => {
    const t = makeT();
    const w = await seed(t);
    const { violations } = await runAll(t);
    const by = (invariant: string) => violations.filter((v) => v.invariant === invariant);

    expect(violations.filter((v) => v.threadId === w.clean)).toEqual([]);
    // The stray thread has TWO scholar-side rows, so it breaks the count too.
    expect(by("scholarParticipantCount").map((v) => v.threadId).sort()).toEqual([w.noScholar, w.stray].sort());
    expect(by("strayScholarSide")).toMatchObject([{ threadId: w.stray, detail: { userId: w.other } }]);
    expect(by("namedStaffWithoutStanding")).toMatchObject([{ threadId: w.staleName, detail: { userId: w.stranger } }]);
    expect(by("transferredHistory").map((v) => v.threadId)).toEqual([w.history]);
    expect(by("suggestionScholarMismatch").map((v) => v.threadId)).toEqual([w.mismatch]);
    expect(by("offPlatformToScholar")).toMatchObject([{ threadId: w.family, detail: { channel: "sms" } }]);
    expect(by("liveAttachmentOnWithdrawnMessage").map((v) => v.threadId)).toEqual([w.family]);
    // Ids only: no free text leaves the audit.
    for (const v of violations) {
      for (const value of Object.values(v.detail)) expect(String(value)).not.toMatch(/\s/);
    }
  });

  test("a tiny budget resumes INSIDE a thread and reports exactly the same findings", async () => {
    const t = makeT();
    const w = await seed(t);
    // One long thread: 40 messages, a scholar-addressed SMS row on the last.
    await t.run(async (ctx) => {
      let last: Id<"parentMessages"> | null = null;
      for (let i = 0; i < 40; i++) {
        last = await ctx.db.insert("parentMessages", {
          threadId: w.family, authorType: "teacher", body: `m${i}`,
        });
      }
      const scholar = (await ctx.db.get(w.family))!.scholarId!;
      await ctx.db.insert("messageDeliveries", {
        messageId: last!, parentUserId: scholar, channel: "email", status: "queued",
      });
    });
    const whole = await runAll(t);
    const sliced = await runAll(t, 5);
    expect(whole.calls).toBe(1);
    expect(sliced.calls).toBeGreaterThan(10);
    // Bounded: a call overshoots its budget by at most one message's rows.
    expect(sliced.maxWork).toBeLessThanOrEqual(5 + 3);
    expect(sliced.violations.map(signature).sort()).toEqual(whole.violations.map(signature).sort());
    expect(whole.violations.filter((v) => v.invariant === "offPlatformToScholar")).toHaveLength(2);
  });

  test("even a budget of 1 makes progress", async () => {
    const t = makeT();
    await seed(t);
    const whole = await runAll(t);
    const crawl = await runAll(t, 1);
    expect(crawl.violations.map(signature).sort()).toEqual(whole.violations.map(signature).sort());
  });
});

// Fictional scholar ↔ staff messaging fixtures (DEV + PREVIEW ONLY; called from
// seedDevPersonas, which refuses prod). Idempotent: every row is found before
// it is created, so re-running `db:seed` or a preview rebuild never duplicates
// a thread or a message.
//
//   test-mentor-001 — "Chris Mentor-Test", base staff @ Moli with an
//                     institution-wide `scholars:mentor` grant (mentor-only:
//                     no other capability, so the inbox shows just Messages).
//   mentor thread   — Chris ↔ kai_kahale: Chris opened it, Kai replied once.
//   workshop idea   — lani_kahale's idea, Lehua replied, Lani answered back.
//   staff-started   — Lehua opened a Workshop conversation with oliver_stone
//                     (no idea behind it).
//
// Writes go straight through the engine helpers (not the public mutations) so
// seeding never schedules a mentor email or a Slack post.

import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { ROLES } from "../lib/roles";
import { ensureMembership } from "../memberships";
import { ensureActiveStaffCapabilityGrant } from "../lib/staffCapabilities";
import {
  appendMessage,
  createThread,
  ensureThreadParticipants,
} from "../parentMessages";
import { ensureWorkshopThreadForSuggestion } from "../scholarMessages";

export const SEEDED_MENTOR_USERNAME = "test-mentor-001";
const SEEDED_IDEA_TITLE = "Let me pick the color of my quest cards";

async function userByUsername(ctx: MutationCtx, username: string) {
  return await ctx.db
    .query("users")
    .withIndex("by_username", (q) => q.eq("username", username))
    .unique();
}

async function threadsFor(
  ctx: MutationCtx,
  scholarId: Id<"users">,
  kind: "mentor" | "workshop",
): Promise<Doc<"parentThreads">[]> {
  return (
    await ctx.db
      .query("parentThreads")
      .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
      .collect()
  ).filter((thread) => thread.kind === kind);
}

async function participantIds(ctx: MutationCtx, threadId: Id<"parentThreads">) {
  return (
    await ctx.db
      .query("parentThreadParticipants")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .collect()
  ).map((row) => row.parentUserId);
}

async function post(
  ctx: MutationCtx,
  threadId: Id<"parentThreads">,
  authorType: "scholar" | "teacher",
  authorUserId: Id<"users">,
  body: string,
  now: number,
) {
  await appendMessage(ctx, {
    threadId,
    parentUserIds: await participantIds(ctx, threadId),
    authorType,
    authorUserId,
    body,
    now,
  });
  if (authorType === "teacher") {
    await ctx.db.patch(threadId, { lastReadByTeacherAt: now });
  } else {
    const row = await ctx.db
      .query("parentThreadParticipants")
      .withIndex("by_thread_parent", (q) =>
        q.eq("threadId", threadId).eq("parentUserId", authorUserId),
      )
      .unique();
    if (row) await ctx.db.patch(row._id, { lastReadAt: now });
  }
}

export async function seedScholarMessagingFixtures(
  ctx: MutationCtx,
  moli: Id<"institutions">,
): Promise<void> {
  // ── The mentor ─────────────────────────────────────────────────────────
  const existingMentor = await userByUsername(ctx, SEEDED_MENTOR_USERNAME);
  const mentorId =
    existingMentor?._id ??
    (await ctx.db.insert("users", {
      username: SEEDED_MENTOR_USERNAME,
      name: "Chris Mentor-Test",
      email: "test-mentor-001@test.rabbithole.dev",
      role: ROLES.STAFF,
      emailVerificationTime: Date.now(),
    }));
  await ensureMembership(ctx, {
    userId: mentorId,
    role: ROLES.STAFF,
    institutionId: moli,
  });
  await ensureActiveStaffCapabilityGrant(ctx, {
    granteeUserId: mentorId,
    institutionId: moli,
    capability: "scholars:mentor",
    grantedBy: mentorId,
  });

  const kai = await userByUsername(ctx, "kai_kahale");
  const lani = await userByUsername(ctx, "lani_kahale");
  const oliver = await userByUsername(ctx, "oliver_stone");
  const lehua = await userByUsername(ctx, "lehua");
  const now = Date.now();

  // ── Mentor thread: Chris opened it, Kai replied ────────────────────────
  if (kai?.institutionId === moli) {
    const hasThread = (await threadsFor(ctx, kai._id, "mentor")).length > 0;
    if (!hasThread) {
      const threadId = await createThread(ctx, {
        kind: "mentor",
        parentUserIds: [kai._id],
        scholarId: kai._id,
        institutionId: moli,
        teacherId: mentorId,
        now,
      });
      await ensureThreadParticipants(ctx, threadId, [mentorId], "staff");
      await post(
        ctx,
        threadId,
        "teacher",
        mentorId,
        "Aloha Kai! I'm Chris, your aquaponics mentor. When your tank does something surprising, message me here. Photos welcome!",
        now,
      );
      await post(
        ctx,
        threadId,
        "scholar",
        kai._id,
        "The water went kind of cloudy since Monday. Is that bad for the fish?",
        now + 1,
      );
    }
  }

  // ── Workshop idea with a back-and-forth ────────────────────────────────
  if (lani?.institutionId === moli && lehua) {
    const ideas = await ctx.db
      .query("scholarSuggestions")
      .withIndex("by_scholar", (q) => q.eq("scholarId", lani._id))
      .collect();
    if (!ideas.some((idea) => idea.title === SEEDED_IDEA_TITLE)) {
      const suggestionId = await ctx.db.insert("scholarSuggestions", {
        scholarId: lani._id,
        title: SEEDED_IDEA_TITLE,
        scholarWords: `${SEEDED_IDEA_TITLE}. Blue is my favorite and all mine are orange.`,
        createdAt: now,
        updatedAt: now,
      });
      const idea = (await ctx.db.get(suggestionId))!;
      const threadId = await ensureWorkshopThreadForSuggestion(ctx, idea, now);
      if (threadId) {
        await post(
          ctx,
          threadId,
          "teacher",
          lehua._id,
          "Love this idea, Lani. Would you want to pick one color for everything, or a different color for each quest?",
          now + 1,
        );
        await post(
          ctx,
          threadId,
          "scholar",
          lani._id,
          "A different one for each quest!!",
          now + 2,
        );
      }
    }
  }

  // ── A Workshop conversation the team started ───────────────────────────
  if (oliver?.institutionId === moli && lehua) {
    const staffStarted = (await threadsFor(ctx, oliver._id, "workshop")).filter(
      (thread) => thread.suggestionId === undefined,
    );
    if (staffStarted.length === 0) {
      const threadId = await createThread(ctx, {
        kind: "workshop",
        parentUserIds: [oliver._id],
        scholarId: oliver._id,
        institutionId: moli,
        teacherId: lehua._id,
        now,
      });
      await post(
        ctx,
        threadId,
        "teacher",
        lehua._id,
        "Quick question about the reading timer\nDid the timer on the reading page stop by itself today? We're trying to track down a bug.",
        now,
      );
    }
  }
}

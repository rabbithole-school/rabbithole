import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { MESSAGE_EDIT_WINDOW_MS } from "../../shared/messageEditWindow";
import {
  grantInstitutionMembership,
  grantStaffCapability,
  seedTestInstitution,
} from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

const makeTestConvex = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof makeTestConvex>;

afterEach(() => {
  vi.useRealTimers();
});

type Role = "scholar" | "teacher" | "staff" | "parent";

async function seedUser(
  t: TestConvex,
  role: Role,
  username: string,
  name: string,
  email?: string,
) {
  const institutionId = await seedTestInstitution(t, {
    slug: "parent-message-edit-retract",
  });
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", {
      name,
      username,
      role,
      email,
      ...(role === "scholar" ? { institutionId } : {}),
    }),
  );
  if (role === "teacher" || role === "staff") {
    await grantInstitutionMembership(t, userId, institutionId, role);
  }
  if (role === "staff") {
    await grantStaffCapability(
      t,
      userId,
      institutionId,
      "school:operations",
    );
  }
  return userId;
}

async function link(
  t: TestConvex,
  parentId: Id<"users">,
  scholarId: Id<"users">,
) {
  await t.run((ctx) =>
    ctx.db.insert("guardianships", {
      parentUserId: parentId,
      scholarUserId: scholarId,
      createdBy: parentId,
    }),
  );
}

async function withUser(t: TestConvex, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function seedStaffThread(t: TestConvex) {
  const teacher = await seedUser(
    t,
    "teacher",
    "lehua-edit",
    "Lehua Torres",
  );
  const otherStaff = await seedUser(
    t,
    "staff",
    "hoku-edit",
    "Hoku Makani",
  );
  const scholar = await seedUser(
    t,
    "scholar",
    "avery-edit",
    "Avery Stone",
  );
  const parent = await seedUser(
    t,
    "parent",
    "sloane-edit",
    "Sloane Kahale",
    "sloane@example.com",
  );
  await link(t, parent, scholar);
  const asTeacher = await withUser(t, teacher);
  const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
    scholarId: scholar,
    body: "Original message",
  });
  const threadId = sent.threadIds[0];
  const message = await t.run((ctx) =>
    ctx.db
      .query("parentMessages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .first(),
  );
  if (!message) throw new Error("Message was not created");
  return {
    teacher,
    otherStaff,
    scholar,
    parent,
    asTeacher,
    threadId,
    messageId: message._id,
  };
}

async function registerAttachment(
  t: TestConvex,
  userId: Id<"users">,
  fileName: string,
  mimeType: string,
) {
  const asUser = await withUser(t, userId);
  const blob = new Blob([fileName], { type: mimeType });
  const { reservationId } = await asUser.mutation(
    api.parentMessages.generateAttachmentUploadUrl,
    { sizeBytes: blob.size },
  );
  const storageId = await t.run((ctx) => ctx.storage.store(blob));
  return await asUser.mutation(
    api.parentMessages.registerAttachmentUpload,
    {
      reservationId,
      storageId,
      fileName,
      mimeType,
      sizeBytes: fileName.length,
    },
  );
}

describe("parentMessages — edit and retract", () => {
  test("the author can edit while preserving oldest-first history", async () => {
    const t = makeTestConvex();
    const fixture = await seedStaffThread(t);

    await fixture.asTeacher.mutation(api.parentMessages.editMessage, {
      messageId: fixture.messageId,
      body: "  Corrected message  ",
      as: "staff",
    });
    await fixture.asTeacher.mutation(api.parentMessages.editMessage, {
      messageId: fixture.messageId,
      body: "Final message",
      as: "staff",
    });

    const row = await t.run((ctx) => ctx.db.get(fixture.messageId));
    expect(row?.body).toBe("Final message");
    expect(row?.editedAt).toEqual(expect.any(Number));
    expect(row?.editHistory).toEqual([
      {
        body: "Original message",
        replacedAt: expect.any(Number),
      },
      {
        body: "Corrected message",
        replacedAt: expect.any(Number),
      },
    ]);

    const thread = await fixture.asTeacher.query(api.parentMessages.getThread, {
      threadId: fixture.threadId,
      as: "staff",
    });
    expect(thread?.messages[0]).toMatchObject({
      body: "Final message",
      editedAt: row?.editedAt,
      retracted: false,
      // Edits don't restart the window.
      editableUntil: row!._creationTime + MESSAGE_EDIT_WINDOW_MS,
      offPortalDelivered: [],
    });
  });

  // T11: a reactive query isn't re-run as time passes, so the read carries
  // WHEN the window closes and each client runs the clock against it.
  test("a thread read says when the window closes (null when never yours), and time alone doesn't change it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-25T20:00:00Z"));
    const t = makeTestConvex();
    const fixture = await seedStaffThread(t);
    const asParent = await withUser(t, fixture.parent);
    const asOtherStaff = await withUser(t, fixture.otherStaff);
    const sentAt = (await t.run((ctx) => ctx.db.get(fixture.messageId)))!
      ._creationTime;
    // A copy that already left by email is named in the author's dialogs
    // whatever the time — the query can't know whether the window is open.
    await t.run(async (ctx) => {
      const email = (
        await ctx.db
          .query("messageDeliveries")
          .withIndex("by_message", (q) => q.eq("messageId", fixture.messageId))
          .collect()
      ).find((delivery) => delivery.channel === "email");
      await ctx.db.patch(email!._id, { status: "sent" });
    });
    const read = async () => ({
      author: await fixture.asTeacher.query(api.parentMessages.getThread, {
        threadId: fixture.threadId,
        as: "staff",
      }),
      otherStaff: await asOtherStaff.query(api.parentMessages.getThread, {
        threadId: fixture.threadId,
        as: "staff",
      }),
      guardian: await asParent.query(api.parentMessages.getThread, {
        threadId: fixture.threadId,
        as: "parent",
      }),
    });

    const before = await read();
    expect(before.author?.messages[0]).toMatchObject({
      editableUntil: sentAt + MESSAGE_EDIT_WINDOW_MS,
      copiedChannels: ["email"],
    });
    for (const view of [before.otherStaff, before.guardian]) {
      expect(view?.messages[0]).toMatchObject({ editableUntil: null });
    }
    // Old web bundles show Edit on `canEdit` alone, with no clock; the family
    // read must not hand them one.
    for (const view of [before.author, before.otherStaff, before.guardian]) {
      expect(view?.messages[0]).not.toHaveProperty("canEdit");
    }

    // Past the window the reads are identical — no clock inside them — while
    // the author's changes are refused.
    vi.setSystemTime(new Date(sentAt + MESSAGE_EDIT_WINDOW_MS + 1000));
    expect(await read()).toEqual(before);
    await expect(
      fixture.asTeacher.mutation(api.parentMessages.editMessage, {
        messageId: fixture.messageId,
        body: "Too late",
        as: "staff",
      }),
    ).rejects.toThrow(/10 minutes/);
    await expect(
      fixture.asTeacher.mutation(api.parentMessages.retractMessage, {
        messageId: fixture.messageId,
        as: "staff",
      }),
    ).rejects.toThrow(/10 minutes/);
  });

  test("operations staff and parent participants cannot change another author's message", async () => {
    const t = makeTestConvex();
    const fixture = await seedStaffThread(t);
    const asOtherStaff = await withUser(t, fixture.otherStaff);
    const asParent = await withUser(t, fixture.parent);

    await expect(
      asOtherStaff.mutation(api.parentMessages.editMessage, {
        messageId: fixture.messageId,
        body: "Staff rewrite",
        as: "staff",
      }),
    ).rejects.toThrow(/only the message author/i);
    await expect(
      asOtherStaff.mutation(api.parentMessages.retractMessage, {
        messageId: fixture.messageId,
        as: "staff",
      }),
    ).rejects.toThrow(/only the message author/i);
    await expect(
      asParent.mutation(api.parentMessages.editMessage, {
        messageId: fixture.messageId,
        body: "Parent rewrite",
        as: "parent",
      }),
    ).rejects.toThrow(/only the message author/i);
    await expect(
      asParent.mutation(api.parentMessages.retractMessage, {
        messageId: fixture.messageId,
        as: "parent",
      }),
    ).rejects.toThrow(/only the message author/i);
  });

  test("a parent author can edit and retract from the parent surface", async () => {
    const t = makeTestConvex();
    const staff = await seedUser(
      t,
      "staff",
      "hoku-parent-author",
      "Hoku Makani",
    );
    const scholar = await seedUser(
      t,
      "scholar",
      "avery-parent-author",
      "Avery Stone",
    );
    const parent = await seedUser(
      t,
      "parent",
      "sloane-parent-author",
      "Sloane Kahale",
    );
    await link(t, parent, scholar);
    const asParent = await withUser(t, parent);
    const { threadId } = await asParent.mutation(
      api.parentMessages.startThread,
      {
        scholarId: scholar,
        body: "Original parent message",
        as: "parent",
      },
    );
    const message = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first(),
    );
    if (!message) throw new Error("Message was not created");

    await asParent.mutation(api.parentMessages.editMessage, {
      messageId: message._id,
      body: "Corrected parent message",
      as: "parent",
    });
    await asParent.mutation(api.parentMessages.retractMessage, {
      messageId: message._id,
      as: "parent",
    });
    await expect(
      asParent.mutation(api.parentMessages.retractMessage, {
        messageId: message._id,
        as: "parent",
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      asParent.mutation(api.parentMessages.editMessage, {
        messageId: message._id,
        body: "Too late to change this",
        as: "parent",
      }),
    ).rejects.toThrow(/withdrawn/i);

    const parentThread = await asParent.query(api.parentMessages.getThread, {
      threadId,
      as: "parent",
    });
    const staffThread = await (
      await withUser(t, staff)
    ).query(api.parentMessages.getThread, {
      threadId,
      as: "staff",
    });
    for (const thread of [parentThread, staffThread]) {
      expect(thread?.messages[0]).toMatchObject({
        body: "",
        editedAt: expect.any(Number),
        retracted: true,
        editableUntil: null,
        offPortalDelivered: [],
      });
    }
    const row = await t.run((ctx) => ctx.db.get(message._id));
    expect(row).toMatchObject({
      body: "Corrected parent message",
      retractedAt: expect.any(Number),
      retractedByUserId: parent,
    });
  });

  test("message withdrawal tombstones reads, attachments, previews, and queued dispatch", async () => {
    const t = makeTestConvex();
    const teacher = await seedUser(
      t,
      "teacher",
      "lehua-withdraw",
      "Lehua Torres",
    );
    const scholar = await seedUser(
      t,
      "scholar",
      "avery-withdraw",
      "Avery Stone",
    );
    const parent = await seedUser(
      t,
      "parent",
      "sloane-withdraw",
      "Sloane Kahale",
      "sloane-withdraw@example.com",
    );
    await link(t, parent, scholar);
    const attachment = await registerAttachment(
      t,
      teacher,
      "field-notes.pdf",
      "application/pdf",
    );
    const asTeacher = await withUser(t, teacher);
    const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
      scholarId: scholar,
      body: "Read https://example.com/field-notes",
      attachmentIds: [attachment.attachmentId],
    });
    const threadId = sent.threadIds[0];
    const message = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .first(),
    );
    if (!message) throw new Error("Message was not created");
    await t.run(async (ctx) => {
      const deliveries = await ctx.db
        .query("messageDeliveries")
        .withIndex("by_message", (q) => q.eq("messageId", message._id))
        .collect();
      const email = deliveries.find((delivery) => delivery.channel === "email");
      if (!email) throw new Error("Email delivery was not created");
      await ctx.db.patch(email._id, { status: "sent" });
      await ctx.db.insert("messageDeliveries", {
        messageId: message._id,
        parentUserId: parent,
        channel: "whatsapp",
        status: "delivered",
      });
      await ctx.db.insert("messageDeliveries", {
        messageId: message._id,
        parentUserId: parent,
        channel: "sms",
        status: "queued",
      });
    });

    const before = await asTeacher.query(api.parentMessages.getThread, {
      threadId,
      as: "staff",
    });
    expect(before?.messages[0].offPortalDelivered).toEqual([
      "email",
      "whatsapp",
    ]);
    expect(
      (
        await (await withUser(t, parent)).query(
          api.parentMessages.getThread,
          { threadId, as: "parent" },
        )
      )?.messages[0].offPortalDelivered,
    ).toEqual([]);

    await asTeacher.mutation(api.parentMessages.retractMessage, {
      messageId: message._id,
      as: "staff",
    });
    const asParent = await withUser(t, parent);
    for (const thread of [
      await asTeacher.query(api.parentMessages.getThread, {
        threadId,
        as: "staff",
      }),
      await asParent.query(api.parentMessages.getThread, {
        threadId,
        as: "parent",
      }),
    ]) {
      expect(thread?.messages[0]).toMatchObject({
        body: "",
        retracted: true,
        editableUntil: null,
        offPortalDelivered: [],
      });
    }
    expect(
      await asParent.query(api.parentMessages.getThreadAttachments, {
        threadId,
        as: "parent",
      }),
    ).toEqual([]);
    expect(
      await asTeacher.query(api.parentMessages.listMyThreads, {}),
    ).toMatchObject([{ lastPreview: "Message withdrawn" }]);
    expect(
      await asParent.query(api.parentMessages.getMessageLinkPreviewRequest, {
        messageId: message._id,
        url: "https://example.com/field-notes",
        as: "parent",
      }),
    ).toBeNull();

    await t.action(internal.parentMessageSend.dispatch, {
      messageIds: [message._id],
    });
    const smsDelivery = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("messageDeliveries")
          .withIndex("by_message", (q) => q.eq("messageId", message._id))
          .collect()
      ).find((delivery) => delivery.channel === "sms"),
    );
    expect(smsDelivery?.status).toBe("queued");

    const rawMessage = await t.run((ctx) => ctx.db.get(message._id));
    const rawAttachment = await t.run((ctx) =>
      ctx.db.get(attachment.attachmentId),
    );
    expect(rawMessage).toMatchObject({
      body: "Read https://example.com/field-notes",
      retractedAt: expect.any(Number),
      retractedByUserId: teacher,
    });
    expect(rawAttachment).toMatchObject({
      fileName: "field-notes.pdf",
      retractedAt: expect.any(Number),
      retractedByUserId: teacher,
    });
  });

  test("retracting one attachment leaves the message and other file visible", async () => {
    const t = makeTestConvex();
    const teacher = await seedUser(
      t,
      "teacher",
      "lehua-one-file",
      "Lehua Torres",
    );
    const scholar = await seedUser(
      t,
      "scholar",
      "avery-one-file",
      "Avery Stone",
    );
    const parent = await seedUser(
      t,
      "parent",
      "sloane-one-file",
      "Sloane Kahale",
    );
    const otherStaff = await seedUser(
      t,
      "staff",
      "hoku-one-file",
      "Hoku Makani",
    );
    await link(t, parent, scholar);
    const first = await registerAttachment(
      t,
      teacher,
      "first.pdf",
      "application/pdf",
    );
    const second = await registerAttachment(
      t,
      teacher,
      "second.pdf",
      "application/pdf",
    );
    const asTeacher = await withUser(t, teacher);
    const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
      scholarId: scholar,
      body: "Two files",
      attachmentIds: [first.attachmentId, second.attachmentId],
    });
    const message = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", sent.threadIds[0]))
        .first(),
    );
    if (!message) throw new Error("Message was not created");

    await expect(
      (
        await withUser(t, otherStaff)
      ).mutation(api.parentMessages.retractAttachment, {
        attachmentId: first.attachmentId,
        as: "staff",
      }),
    ).rejects.toThrow(/only the message author/i);
    await expect(
      (
        await withUser(t, parent)
      ).mutation(api.parentMessages.retractAttachment, {
        attachmentId: first.attachmentId,
        as: "parent",
      }),
    ).rejects.toThrow(/only the message author/i);
    await asTeacher.mutation(api.parentMessages.retractAttachment, {
      attachmentId: first.attachmentId,
      as: "staff",
    });
    await expect(
      asTeacher.mutation(api.parentMessages.retractAttachment, {
        attachmentId: first.attachmentId,
        as: "staff",
      }),
    ).resolves.toEqual({ ok: true });

    const attachments = await asTeacher.query(
      api.parentMessages.getThreadAttachments,
      { threadId: sent.threadIds[0], as: "staff" },
    );
    // Staff still see the withdrawn file, flagged; the guardian never does.
    expect(attachments.map((row) => [row.fileName, row.withdrawn])).toEqual([
      ["first.pdf", true],
      ["second.pdf", false],
    ]);
    const guardianAttachments = await (await withUser(t, parent)).query(
      api.parentMessages.getThreadAttachments,
      { threadId: sent.threadIds[0], as: "parent" },
    );
    expect(guardianAttachments.map((row) => row.fileName)).toEqual(["second.pdf"]);
    expect(await t.run((ctx) => ctx.db.get(message._id))).not.toHaveProperty(
      "retractedAt",
    );
  });

  test("retracting the last file from an attachment-only message retracts the message", async () => {
    const t = makeTestConvex();
    const teacher = await seedUser(
      t,
      "teacher",
      "lehua-last-file",
      "Lehua Torres",
    );
    const scholar = await seedUser(
      t,
      "scholar",
      "avery-last-file",
      "Avery Stone",
    );
    const parent = await seedUser(
      t,
      "parent",
      "sloane-last-file",
      "Sloane Kahale",
    );
    await link(t, parent, scholar);
    const attachment = await registerAttachment(
      t,
      teacher,
      "only-photo.jpg",
      "image/jpeg",
    );
    const asTeacher = await withUser(t, teacher);
    const sent = await asTeacher.mutation(api.parentMessages.sendMessage, {
      scholarId: scholar,
      body: "",
      attachmentIds: [attachment.attachmentId],
    });
    const message = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", sent.threadIds[0]))
        .first(),
    );
    if (!message) throw new Error("Message was not created");

    await asTeacher.mutation(api.parentMessages.retractAttachment, {
      attachmentId: attachment.attachmentId,
      as: "staff",
    });

    expect(await t.run((ctx) => ctx.db.get(message._id))).toMatchObject({
      body: "",
      retractedAt: expect.any(Number),
      retractedByUserId: teacher,
    });
    expect(
      await asTeacher.query(api.parentMessages.listMyThreads, {}),
    ).toMatchObject([{ lastPreview: "Message withdrawn" }]);
  });

  test("the inbox falls back to the previous live human message", async () => {
    const t = makeTestConvex();
    const fixture = await seedStaffThread(t);
    await fixture.asTeacher.mutation(api.parentMessages.replyInThread, {
      threadId: fixture.threadId,
      body: "Newest message",
      as: "staff",
    });
    const messages = await t.run((ctx) =>
      ctx.db
        .query("parentMessages")
        .withIndex("by_thread", (q) => q.eq("threadId", fixture.threadId))
        .collect(),
    );
    await fixture.asTeacher.mutation(api.parentMessages.retractMessage, {
      messageId: messages[messages.length - 1]._id,
      as: "staff",
    });

    expect(
      await fixture.asTeacher.query(api.parentMessages.listMyThreads, {}),
    ).toMatchObject([{ lastPreview: "Original message" }]);
  });

  test("editing to attachment-only is allowed, but an empty message is rejected", async () => {
    const t = makeTestConvex();
    const fixture = await seedStaffThread(t);
    await expect(
      fixture.asTeacher.mutation(api.parentMessages.editMessage, {
        messageId: fixture.messageId,
        body: "   ",
        as: "staff",
      }),
    ).rejects.toThrow(/message is empty/i);

    const attachment = await registerAttachment(
      t,
      fixture.teacher,
      "supporting.pdf",
      "application/pdf",
    );
    await t.run((ctx) =>
      ctx.db.patch(attachment.attachmentId, {
        messageId: fixture.messageId,
        threadId: fixture.threadId,
      }),
    );
    await expect(
      fixture.asTeacher.mutation(api.parentMessages.editMessage, {
        messageId: fixture.messageId,
        body: "   ",
        as: "staff",
      }),
    ).resolves.toEqual({ ok: true });
    expect(await t.run((ctx) => ctx.db.get(fixture.messageId))).toMatchObject({
      body: "",
      editedAt: expect.any(Number),
    });
  });

  test("a withdrawn parent message is not posted to Slack", async () => {
    const previousToken = process.env.SLACK_BOT_TOKEN;
    const realFetch = globalThis.fetch;
    process.env.SLACK_BOT_TOKEN = "xoxb-test";
    globalThis.fetch = (async () => {
      throw new Error("Slack should not be called for a withdrawn message");
    }) as typeof fetch;

    try {
      const t = makeTestConvex();
      const scholar = await seedUser(
        t,
        "scholar",
        "avery-slack-withdraw",
        "Avery Stone",
      );
      const parent = await seedUser(
        t,
        "parent",
        "sloane-slack-withdraw",
        "Sloane Kahale",
      );
      await link(t, parent, scholar);
      const asParent = await withUser(t, parent);
      const { threadId } = await asParent.mutation(
        api.parentMessages.startThread,
        {
          scholarId: scholar,
          body: "Please withdraw this",
          as: "parent",
        },
      );
      const message = await t.run((ctx) =>
        ctx.db
          .query("parentMessages")
          .withIndex("by_thread", (q) => q.eq("threadId", threadId))
          .first(),
      );
      if (!message) throw new Error("Message was not created");
      await t.run((ctx) =>
        ctx.db.insert("parentMessageChannel", {
          slackChannelId: "C_PARENT_MESSAGES",
          linkedBy: parent,
          linkedAt: Date.now(),
        }),
      );
      await asParent.mutation(api.parentMessages.retractMessage, {
        messageId: message._id,
        as: "parent",
      });

      await expect(
        t.action(internal.parentMessageSlack.notifyParentMessageChannel, {
          messageId: message._id,
        }),
      ).resolves.toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      if (previousToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousToken;
      }
    }
  });
});

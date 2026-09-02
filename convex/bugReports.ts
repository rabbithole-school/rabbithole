import { v } from "convex/values";
import { customMutation } from "convex-helpers/server/customFunctions";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { getActiveOverlay, getSessionOwner } from "./lib/auth";
import {
  assertInstitutionActive,
  requireScholarsAccessible,
} from "./lib/access";
import { raiseAlert } from "./alerts";
import { isPlatformAdminRole, ROLES, type Role } from "./lib/roles";
import {
  escapeSlackText,
  postMessage,
  uploadImageToSlack,
} from "./lib/slackApi";
import { MODELS } from "./lib/models";
import { requireAnthropicApiKey } from "./lib/anthropic";
import { recordAnthropicUsage } from "./usage";
import { sessionPath, siteUrl, withBase } from "./lib/channels";

const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg"]);
const AUDIO_MIME_TYPES = new Set([
  "audio/mp4",
  "audio/m4a",
  "audio/webm",
]);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;
const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000];
const STUCK_AFTER_MS = 15 * 60_000;

type PipelineStep = "transcribe" | "post" | "files" | "bridge" | "triage";

interface ProcessingContext {
  report: Doc<"bugReports">;
  actor: {
    id: Id<"users">;
    name: string;
    role: string;
  };
  viewed: {
    id: Id<"users">;
    name: string;
    role: string;
  } | null;
  session: {
    id: Id<"sessions">;
    title: string;
    ownerId: Id<"users">;
  } | null;
  channelId: string | null;
  operatorId: Id<"users"> | null;
}

interface TriageExchange {
  userContent: string;
  assistantContent: string;
}

function compactOptional(value: string | undefined, max: number) {
  const compact = value?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return compact ? compact.slice(0, max) : undefined;
}

function sanitizeReportUrl(raw: string): string {
  const compact = raw.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  if (!compact) return "/";
  try {
    const parsed = new URL(compact, "https://rabbithole.invalid");
    return `${parsed.pathname}${parsed.search}`.slice(0, 2_000) || "/";
  } catch {
    return compact.startsWith("/") ? compact.slice(0, 2_000) : "/";
  }
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * Bug reporting is the one write that remains available during view-as. It
 * creates an operator report about what the real session owner can currently
 * see; it never mutates the impersonation target or any target-owned record.
 */
const bugReportMutation = customMutation(mutation, {
  args: {},
  input: async (ctx) => {
    const actor = await getSessionOwner(ctx);
    if (!actor) throw new Error("Not authenticated");
    await assertInstitutionActive(ctx, actor);
    const overlay = await getActiveOverlay(ctx);
    return { ctx: { ...ctx, actor, overlay }, args: {} };
  },
});

async function resolveClaimedViewedUser(
  ctx: Parameters<typeof requireScholarsAccessible>[0],
  actor: Doc<"users">,
  claimedViewedUserId: Id<"users"> | undefined,
): Promise<Id<"users"> | undefined> {
  if (!claimedViewedUserId || claimedViewedUserId === actor._id) return undefined;
  const claimed = await ctx.db.get(claimedViewedUserId);
  if (!claimed || claimed.role !== ROLES.SCHOLAR) return undefined;
  try {
    await requireScholarsAccessible(ctx, actor, [claimedViewedUserId]);
    return claimedViewedUserId;
  } catch {
    return undefined;
  }
}

async function validateStoredBlob(
  ctx: MutationCtx,
  storageId: Id<"_storage">,
  kind: "audio" | "screenshot",
): Promise<string | null> {
  const metadata = await ctx.db.system.get("_storage", storageId);
  if (!metadata) {
    return kind === "audio"
      ? "The uploaded audio is unavailable"
      : "The uploaded screenshot is unavailable";
  }
  const type = metadata.contentType ?? "";
  const allowed = kind === "audio" ? AUDIO_MIME_TYPES : IMAGE_MIME_TYPES;
  const maxBytes = kind === "audio" ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
  if (allowed.has(type) && metadata.size <= maxBytes) return null;

  // Return (rather than throw) so this transactional delete commits.
  await ctx.storage.delete(storageId);
  const expected =
    kind === "audio"
      ? "M4A, MP4 audio, or WebM audio up to 15 MB"
      : "PNG or JPEG up to 8 MB";
  return `Bug-report ${kind} must be ${expected}`;
}

export const submit = bugReportMutation({
  args: {
    surface: v.union(v.literal("native"), v.literal("web")),
    url: v.string(),
    clientReportId: v.optional(v.string()),
    sessionId: v.optional(v.id("sessions")),
    viewedUserId: v.optional(v.id("users")),
    viewingMode: v.optional(v.string()),
    deviceModel: v.optional(v.string()),
    osVersion: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    appVersion: v.optional(v.string()),
    appBuild: v.optional(v.string()),
    description: v.optional(v.string()),
    audioStorageId: v.optional(v.id("_storage")),
    screenshotStorageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const clientReportId = compactOptional(args.clientReportId, 200);
    if (clientReportId) {
      const existing = await ctx.db
        .query("bugReports")
        .withIndex("by_client_id", (q) =>
          q
            .eq("clientReportId", clientReportId)
            .eq("actorUserId", ctx.actor._id),
        )
        .first();
      if (existing) {
        return {
          ok: true as const,
          reportId: existing._id,
          status: existing.status,
        };
      }
    }

    const validationErrors: string[] = [];
    if (args.screenshotStorageId) {
      const error = await validateStoredBlob(
        ctx,
        args.screenshotStorageId,
        "screenshot",
      );
      if (error) validationErrors.push(error);
    }
    if (args.audioStorageId) {
      const error = await validateStoredBlob(ctx, args.audioStorageId, "audio");
      if (error) validationErrors.push(error);
    }
    if (validationErrors.length > 0) {
      return { ok: false as const, error: validationErrors.join(". ") };
    }

    const viewedUserId =
      ctx.overlay?.targetUserId ??
      (await resolveClaimedViewedUser(ctx, ctx.actor, args.viewedUserId));
    const viewingMode = ctx.overlay
      ? "actAs"
      : viewedUserId
        ? "inspect"
        : undefined;

    let sessionId: Id<"sessions"> | undefined;
    let institutionId: Id<"institutions"> | undefined;
    if (args.sessionId) {
      const session = await ctx.db.get(args.sessionId);
      const owner = session ? await ctx.db.get(session.userId) : null;
      const belongsToVisibleScholar =
        owner?.role === ROLES.SCHOLAR &&
        (owner._id === ctx.actor._id || owner._id === viewedUserId);
      if (session && owner && belongsToVisibleScholar) {
        sessionId = session._id;
        institutionId = owner.institutionId;
      }
    }
    if (!institutionId && ctx.actor.role === ROLES.SCHOLAR) {
      institutionId = ctx.actor.institutionId;
    }

    const channel = await ctx.db.query("bugReportChannel").first();
    const status = channel ? ("received" as const) : ("waiting_for_channel" as const);
    const reportId = await ctx.db.insert("bugReports", {
      actorUserId: ctx.actor._id,
      actorRole: ctx.actor.role ?? "unknown",
      clientReportId,
      viewedUserId,
      institutionId,
      surface: args.surface,
      url: sanitizeReportUrl(args.url),
      sessionId,
      viewingMode,
      deviceModel: compactOptional(args.deviceModel, 300),
      osVersion: compactOptional(args.osVersion, 200),
      userAgent: compactOptional(args.userAgent, 1_000),
      appVersion: compactOptional(args.appVersion, 100),
      appBuild: compactOptional(args.appBuild, 100),
      description: compactOptional(args.description, 8_000),
      audioStorageId: args.audioStorageId,
      screenshotStorageId: args.screenshotStorageId,
      attempts: 0,
      status,
    });

    if (channel) {
      await ctx.scheduler.runAfter(0, internal.bugReports.processReport, {
        reportId,
      });
    } else {
      await raiseAlert(ctx, {
        kind: "bug_report_channel_unbound",
        severity: "warning",
        audience: "platform",
        title: "Bug report saved with no triage channel",
        body:
          "A report is waiting. Link a private Slack channel with " +
          "link_bug_report_channel to drain the backlog.",
        source: "bugReports.submit",
        dedupKey: "bug-report-channel-unbound",
      });
    }
    return { ok: true as const, reportId, status };
  },
});

export const processingContext = internalQuery({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args): Promise<ProcessingContext | null> => {
    const report = await ctx.db.get(args.reportId);
    if (!report) return null;
    const actor = await ctx.db.get(report.actorUserId);
    if (!actor) return null;
    const viewed = report.viewedUserId
      ? await ctx.db.get(report.viewedUserId)
      : null;
    const session = report.sessionId ? await ctx.db.get(report.sessionId) : null;
    const channels = await ctx.db.query("bugReportChannel").collect();
    channels.sort((a, b) => b.linkedAt - a.linkedAt);
    const operators = (await ctx.db.query("users").collect())
      .filter((user) =>
        isPlatformAdminRole(user.role as Role | undefined),
      )
      .sort((a, b) => a._creationTime - b._creationTime);
    return {
      report,
      actor: {
        id: actor._id,
        name: actor.name ?? actor.username ?? "Unknown reporter",
        role: actor.role ?? "unknown",
      },
      viewed: viewed
        ? {
            id: viewed._id,
            name: viewed.name ?? viewed.username ?? "Unknown user",
            role: viewed.role ?? "unknown",
          }
        : null,
      session: session
        ? {
            id: session._id,
            title: session.title,
            ownerId: session.userId,
          }
        : null,
      channelId: channels[0]?.slackChannelId ?? null,
      operatorId: operators[0]?._id ?? null,
    };
  },
});

export const recentOneLiners = internalQuery({
  args: { reportId: v.id("bugReports"), limit: v.optional(v.number()) },
  handler: async (
    ctx,
    args,
  ): Promise<Array<{ createdAt: number; surface: string; url: string; summary: string }>> => {
    const limit = Math.min(Math.max(args.limit ?? 10, 0), 10);
    const reports = (await ctx.db.query("bugReports").collect())
      .filter((report) => report._id !== args.reportId)
      .sort((a, b) => b._creationTime - a._creationTime)
      .slice(0, limit);
    return reports.map((report) => ({
      createdAt: report._creationTime,
      surface: report.surface,
      url: report.url,
      summary:
        report.description
          ?.replace(/\s+/g, " ")
          .trim()
          .slice(0, 180) ?? "(no description)",
    }));
  },
});

export const existingTriageExchange = internalQuery({
  args: { chatId: v.id("chats") },
  handler: async (ctx, args): Promise<TriageExchange | null> => {
    const messages = await ctx.db
      .query("curriculumMessages")
      .withIndex("by_chat", (q) => q.eq("chatId", args.chatId))
      .order("asc")
      .collect();
    const user = messages.find((message) => message.role === "user");
    const assistant = messages.find((message) => message.role === "assistant");
    return user && assistant
      ? { userContent: user.content, assistantContent: assistant.content }
      : null;
  },
});

export const markTranscribed = internalMutation({
  args: {
    reportId: v.id("bugReports"),
    transcript: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.transcribedAt) return;
    const transcript = compactOptional(args.transcript, 8_000);
    const description = transcript
      ? report.description
        ? `${report.description}\n\nSpoken report:\n${transcript}`.slice(0, 8_000)
        : transcript
      : report.description;
    await ctx.db.patch(args.reportId, {
      description,
      transcribedAt: Date.now(),
    });
  },
});

export const commitPosted = internalMutation({
  args: {
    reportId: v.id("bugReports"),
    channelId: v.string(),
    threadTs: v.string(),
  },
  handler: async (ctx, args): Promise<boolean> => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.postedAt) return false;
    await ctx.db.patch(args.reportId, {
      slackChannelId: args.channelId,
      slackThreadTs: args.threadTs,
      postedAt: Date.now(),
    });
    return true;
  },
});

export const commitFiles = internalMutation({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.filesAt) return;
    await ctx.db.patch(args.reportId, {
      filesAt: Date.now(),
      lastError: undefined,
    });
  },
});

export const commitBridge = internalMutation({
  args: {
    reportId: v.id("bugReports"),
    chatId: v.id("chats"),
  },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.bridgedAt) return;
    await ctx.db.patch(args.chatId, {
      title: `Bug report · ${report.surface} · ${report.url}`.slice(0, 180),
      lastMessageAt: Date.now(),
    });
    await ctx.db.patch(args.reportId, {
      chatId: args.chatId,
      bridgedAt: Date.now(),
      status: "posted",
    });
  },
});

export const commitTriaged = internalMutation({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.triagedAt) return;
    await ctx.db.patch(args.reportId, {
      triagedAt: Date.now(),
      status: "triaged",
      ...(report.filesAt ? { lastError: undefined } : {}),
    });
  },
});

export const markWaitingForChannel = internalMutation({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.status === "resolved" || report.status === "failed") return;
    await ctx.db.patch(args.reportId, { status: "waiting_for_channel" });
    await raiseAlert(ctx, {
      kind: "bug_report_channel_unbound",
      severity: "warning",
      audience: "platform",
      title: "Bug report saved with no triage channel",
      body:
        "A report is waiting. Link a private Slack channel with " +
        "link_bug_report_channel to drain the backlog.",
      source: "bugReports.processReport",
      dedupKey: "bug-report-channel-unbound",
    });
  },
});

export const recordFailure = internalMutation({
  args: {
    reportId: v.id("bugReports"),
    step: v.union(
      v.literal("transcribe"),
      v.literal("post"),
      v.literal("files"),
      v.literal("bridge"),
      v.literal("triage"),
    ),
    error: v.string(),
    nonFatal: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const report = await ctx.db.get(args.reportId);
    if (!report || report.status === "resolved" || report.status === "failed") {
      return;
    }
    const attempts = (report.attempts ?? 0) + 1;
    const exhausted = attempts >= RETRY_DELAYS_MS.length;
    const lastError = `${args.step}: ${args.error}`.slice(0, 700);
    await ctx.db.patch(args.reportId, {
      attempts,
      lastError,
      ...(!args.nonFatal && exhausted ? { status: "failed" as const } : {}),
    });
    if (!exhausted) {
      await ctx.scheduler.runAfter(
        RETRY_DELAYS_MS[attempts - 1],
        internal.bugReports.processReport,
        { reportId: args.reportId },
      );
      return;
    }
    await raiseAlert(ctx, {
      kind: "bug_report_pipeline_failed",
      severity: "warning",
      audience: "platform",
      title: args.nonFatal
        ? "Bug report attachment retries exhausted"
        : "Bug report pipeline failed",
      body: `Report ${args.reportId} stopped retrying at ${args.step}: ${args.error}`,
      source: "bugReports.recordFailure",
      dedupKey: `bug-report-pipeline:${args.reportId}:${args.step}`,
    });
  },
});

export const linkBugReportChannel = internalMutation({
  args: {
    callerUserId: v.id("users"),
    slackChannelId: v.string(),
    unlink: v.boolean(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; message: string; waitingCount?: number }> => {
    const caller = await ctx.db.get(args.callerUserId);
    if (!caller || !isPlatformAdminRole(caller.role)) {
      return {
        ok: false,
        message:
          "Forbidden: platform admin role required to link the bug-report channel.",
      };
    }
    const existing = await ctx.db.query("bugReportChannel").collect();
    if (args.unlink) {
      const current = existing.find(
        (row) => row.slackChannelId === args.slackChannelId,
      );
      if (!current) {
        return {
          ok: false,
          message: "This channel isn't the linked bug-report channel.",
        };
      }
      for (const row of existing) await ctx.db.delete(row._id);
      return {
        ok: true,
        message: "Unlinked — new bug reports will wait until a private channel is linked.",
      };
    }

    for (const row of existing) await ctx.db.delete(row._id);
    await ctx.db.insert("bugReportChannel", {
      slackChannelId: args.slackChannelId,
      linkedBy: args.callerUserId,
      linkedAt: Date.now(),
    });
    const waiting = await ctx.db
      .query("bugReports")
      .withIndex("by_status", (q) => q.eq("status", "waiting_for_channel"))
      .collect();
    for (const report of waiting) {
      await ctx.db.patch(report._id, { status: "received" });
      await ctx.scheduler.runAfter(0, internal.bugReports.processReport, {
        reportId: report._id,
      });
    }
    return {
      ok: true,
      message:
        "Linked this PRIVATE staff channel for Rabbithole bug reports. Reports from every institution will post here for platform-operator triage.",
      waitingCount: waiting.length,
    };
  },
});

function reportRootMessage(context: ProcessingContext): string {
  const { report } = context;
  const lines = [
    "🐛 *New Rabbithole bug report*",
    `*Reported by:* ${escapeSlackText(context.actor.name)} (${escapeSlackText(context.actor.role)})`,
    context.viewed
      ? `*Viewing:* ${escapeSlackText(context.viewed.name)} (${escapeSlackText(context.viewed.role)})`
      : null,
    `*Surface:* ${report.surface}`,
    `*Captured:* ${new Date(report._creationTime).toISOString()}`,
    `*Where:* \`${escapeSlackText(report.url.replace(/`/g, "'"))}\``,
    context.session
      ? `*Session:* <${withBase(siteUrl(), sessionPath(context.session.id, context.session.ownerId))}|${escapeSlackText(context.session.title)}>`
      : null,
    "",
    "*What went wrong*",
    ...(report.description
      ? escapeSlackText(report.description)
          .split("\n")
          .map((line) => `> ${line}`)
      : ["> No description was captured."]),
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

function triageUserContent(context: ProcessingContext): string {
  const lines = [
    `Bug report from ${context.actor.role} on ${context.report.surface}.`,
    `URL: ${context.report.url}`,
    context.viewed ? `Viewed role: ${context.viewed.role}` : null,
    context.session ? `Session: ${context.session.title}` : null,
    `Description: ${context.report.description ?? "(none captured)"}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

export const triageBugReport = internalAction({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args): Promise<void> => {
    const context = await ctx.runQuery(
      internal.bugReports.processingContext,
      args,
    );
    if (
      !context?.report.chatId ||
      !context.report.slackChannelId ||
      !context.report.slackThreadTs ||
      !context.operatorId
    ) {
      throw new Error("Bug report is not ready for triage");
    }

    const existing = await ctx.runQuery(
      internal.bugReports.existingTriageExchange,
      { chatId: context.report.chatId },
    );
    let assistantContent = existing?.assistantContent;
    const userContent = existing?.userContent ?? triageUserContent(context);

    if (!assistantContent) {
      const recent = await ctx.runQuery(internal.bugReports.recentOneLiners, {
        reportId: args.reportId,
        limit: 10,
      });
      const recentText =
        recent.length > 0
          ? recent
              .map(
                (item) =>
                  `- ${item.surface} ${item.url}: ${item.summary}`,
              )
              .join("\n")
          : "- No recent reports.";
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const anthropic = new Anthropic({ apiKey: requireAnthropicApiKey() });
      const response = await anthropic.messages.create({
        model: MODELS.SONNET,
        max_tokens: 1_200,
        system:
          "You are Rabbithole's platform-operator bug triage assistant. " +
          "Analyze the report without dispatching work or claiming a fix. " +
          "Respond with a concise triage note: observed symptom, likely area, " +
          "reproduction clues, possible duplicate, and the next question or check. " +
          "Do not use tools. Do not mention or infer anything from raw files; only " +
          "the supplied text context is available.",
        messages: [
          {
            role: "user",
            content: `${userContent}\n\nRecent report one-liners for duplicate hints:\n${recentText}`,
          },
        ],
      });
      assistantContent = response.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!assistantContent) throw new Error("Triage model returned no text");
      await recordAnthropicUsage(ctx, {
        source: "bug-report-triage",
        role: ROLES.PLATFORM_ADMIN,
        institutionId: context.report.institutionId,
        model: MODELS.SONNET,
        usage: response.usage,
        sessionId: context.report.sessionId,
      });
      await ctx.runMutation(internal.slackBot.recordExchange, {
        sessionId: context.report.chatId,
        userContent,
        speakerName: context.actor.name,
        assistantContent,
        model: MODELS.SONNET,
        tokensUsed: response.usage.output_tokens,
      });
    }

    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) throw new Error("Slack bot is not configured");
    const posted = await postMessage(token, {
      channel: context.report.slackChannelId,
      threadTs: context.report.slackThreadTs,
      text: assistantContent,
      markdown: true,
    });
    if (!posted.ok) {
      throw new Error(`Slack triage reply failed (${posted.error ?? "unknown_error"})`);
    }
    await ctx.runMutation(internal.bugReports.commitTriaged, args);
  },
});

async function uploadReportFiles(
  ctx: ActionCtx,
  context: ProcessingContext,
  token: string,
): Promise<string[]> {
  const failures: string[] = [];
  const files = [
    context.report.screenshotStorageId
      ? {
          kind: "screenshot",
          storageId: context.report.screenshotStorageId,
          filename: "bug-report-screenshot.png",
        }
      : null,
    context.report.audioStorageId
      ? {
          kind: "audio",
          storageId: context.report.audioStorageId,
          filename: "bug-report-audio.m4a",
        }
      : null,
  ].filter(
    (
      file,
    ): file is {
      kind: string;
      storageId: Id<"_storage">;
      filename: string;
    } => file !== null,
  );
  for (const file of files) {
    const blob = await ctx.storage.get(file.storageId);
    if (!blob) {
      failures.push(`${file.kind} blob is unavailable`);
      continue;
    }
    const filename =
      file.kind === "audio" && blob.type.includes("webm")
        ? "bug-report-audio.webm"
        : file.filename;
    const uploaded = await uploadImageToSlack(token, {
      channel: context.report.slackChannelId!,
      threadTs: context.report.slackThreadTs!,
      bytes: new Uint8Array(await blob.arrayBuffer()),
      filename,
      title:
        file.kind === "audio"
          ? "Original bug-report audio"
          : "Bug-report screenshot",
    });
    if (!uploaded.ok) failures.push(`${file.kind} upload failed`);
  }
  return failures;
}

export const processReport = internalAction({
  args: { reportId: v.id("bugReports") },
  handler: async (ctx, args): Promise<void> => {
    let context = await ctx.runQuery(
      internal.bugReports.processingContext,
      args,
    );
    if (!context) return;
    if (context.report.status === "resolved" || context.report.status === "failed") {
      return;
    }
    if (context.report.status === "triaged" && context.report.filesAt) return;

    const fail = async (
      step: PipelineStep,
      error: unknown,
      nonFatal = false,
    ) => {
      await ctx.runMutation(internal.bugReports.recordFailure, {
        reportId: args.reportId,
        step,
        error: errorText(error),
        nonFatal,
      });
    };

    if (!context.report.transcribedAt) {
      try {
        const transcript = context.report.audioStorageId
          ? await ctx.runAction(internal.audioActions.transcribeStored, {
              storageId: context.report.audioStorageId,
              sessionId: context.report.sessionId,
            })
          : null;
        await ctx.runMutation(internal.bugReports.markTranscribed, {
          reportId: args.reportId,
          transcript: transcript?.text,
        });
      } catch (error) {
        await fail("transcribe", error);
        return;
      }
      context = await ctx.runQuery(internal.bugReports.processingContext, args);
      if (!context) return;
    }

    if (!context.channelId) {
      await ctx.runMutation(internal.bugReports.markWaitingForChannel, args);
      return;
    }
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      await fail("post", new Error("Slack bot is not configured"));
      return;
    }

    if (!context.report.postedAt) {
      try {
        const posted = await postMessage(token, {
          channel: context.channelId,
          text: reportRootMessage(context),
          markdown: true,
        });
        if (!posted.ok || !posted.ts) {
          throw new Error(
            `Slack root post failed (${posted.error ?? "missing timestamp"})`,
          );
        }
        // The external call and receipt cannot be atomic. Commit coordinates
        // immediately; a crash in this tiny gap may rarely duplicate a root post,
        // which is acceptable here and avoids a costly marker-search protocol.
        await ctx.runMutation(internal.bugReports.commitPosted, {
          reportId: args.reportId,
          channelId: context.channelId,
          threadTs: posted.ts,
        });
      } catch (error) {
        await fail("post", error);
        return;
      }
      context = await ctx.runQuery(internal.bugReports.processingContext, args);
      if (!context) return;
    }

    if (!context.report.filesAt) {
      try {
        const failures = await uploadReportFiles(ctx, context, token);
        if (failures.length === 0) {
          await ctx.runMutation(internal.bugReports.commitFiles, args);
        } else {
          await fail("files", new Error(failures.join("; ")), true);
        }
      } catch (error) {
        await fail("files", error, true);
      }
      context = await ctx.runQuery(internal.bugReports.processingContext, args);
      if (!context) return;
    }

    if (!context.report.bridgedAt) {
      try {
        if (
          !context.report.slackChannelId ||
          !context.report.slackThreadTs ||
          !context.operatorId
        ) {
          throw new Error("Missing Slack coordinates or platform operator");
        }
        const { chatId } = await ctx.runMutation(
          internal.slackBot.ensureThreadSession,
          {
            channelId: context.report.slackChannelId,
            threadTs: context.report.slackThreadTs,
            userId: context.operatorId,
          },
        );
        await ctx.runMutation(internal.bugReports.commitBridge, {
          reportId: args.reportId,
          chatId,
        });
      } catch (error) {
        await fail("bridge", error);
        return;
      }
      context = await ctx.runQuery(internal.bugReports.processingContext, args);
      if (!context) return;
    }

    if (!context.report.triagedAt) {
      try {
        await ctx.runAction(internal.bugReports.triageBugReport, args);
      } catch (error) {
        await fail("triage", error);
      }
    }
  },
});

export const sweepStuckReports = internalMutation({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ redriven: number; failed: number; waiting: number }> => {
    const now = Date.now();
    const channel = await ctx.db.query("bugReportChannel").first();
    const statuses = [
      "received",
      "waiting_for_channel",
      "posted",
    ] as const;
    const reports = (
      await Promise.all(
        statuses.map((status) =>
          ctx.db
            .query("bugReports")
            .withIndex("by_status", (q) => q.eq("status", status))
            .collect(),
        ),
      )
    ).flat();
    let redriven = 0;
    let failed = 0;
    let waiting = 0;
    for (const report of reports) {
      if (report.status === "waiting_for_channel" && !channel) {
        waiting += 1;
        continue;
      }
      const lastProgress = Math.max(
        report._creationTime,
        report.transcribedAt ?? 0,
        report.postedAt ?? 0,
        report.filesAt ?? 0,
        report.bridgedAt ?? 0,
        report.triagedAt ?? 0,
      );
      if (now - lastProgress < STUCK_AFTER_MS) continue;
      if ((report.attempts ?? 0) >= RETRY_DELAYS_MS.length) {
        await ctx.db.patch(report._id, {
          status: "failed",
          lastError: report.lastError ?? "Pipeline stalled with no progress",
        });
        await raiseAlert(ctx, {
          kind: "bug_report_pipeline_stuck",
          severity: "warning",
          audience: "platform",
          title: "Bug report pipeline is stuck",
          body: `Report ${report._id} was marked failed by the safety sweep.`,
          source: "bugReports.sweepStuckReports",
          dedupKey: `bug-report-stuck:${report._id}`,
        });
        failed += 1;
        continue;
      }
      if (report.status === "waiting_for_channel") {
        await ctx.db.patch(report._id, { status: "received" });
      }
      await ctx.scheduler.runAfter(0, internal.bugReports.processReport, {
        reportId: report._id,
      });
      redriven += 1;
    }
    return { redriven, failed, waiting };
  },
});

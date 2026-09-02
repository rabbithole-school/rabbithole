// Slack-surface extra tools — the Slack-ONLY ops (channel↔group linking,
// the alerts channel, the parent-message channel, parent enroll links) layered
// ON TOP of the shared assembleCurriculumTools set (which the Slack bot gets
// unchanged, and which now also carries the scholar-record WRITE tools — observation, report,
// dossier, reading level, profile, password/passkey reset, delete, and
// document/portfolio upload — shared verbatim with the in-app aide + MCP via
// lib/scholarWriteTools.ts). What lives here is only what's intrinsically
// Slack-shaped.
//
// Surface gating: the group-link tools are CHANNEL-only (they bind the
// channel the conversation is in); parent enroll links are DM-only (the link
// is a credential). The assembler takes `surface` and simply doesn't build
// the wrong ones — same defense style as TOOLS_BY_ROLE.
//
// Role gating mirrors the underlying in-app mutations exactly:
//   link_channel_to_group      teacher/admins      (scholarGroups are teacher tooling)
//   set_group_notify_mode      teacher/admins
//   link_alerts_channel         platform_admin
//   link_parent_message_channel platform_admin
//   issue_parent_enroll_link   scholar-admin       (enrollment.issueParentEnrollLink)

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, isScholarAdminRole, isPlatformAdminRole, type Role } from "./roles";
import type { AideEmit } from "./aideStream";
import { setConversationTopic, listItemInfo, listItems, listItemCreate, listItemUpdate, listItemDelete, postMessage } from "./slackApi";
import { parseListId, buildListCell, listSchemaColumns, formatListForModel, WRITABLE_LIST_TYPES, type SlackListColumn } from "./slackLists";

let institutionSlugExamples = '"primary", "guests"';

async function privateChannelCheck(
  token: string,
  channelId: string,
): Promise<{ ok: boolean; isPrivate: boolean; error?: string }> {
  try {
    const form = new URLSearchParams({ channel: channelId });
    const response = await fetch("https://slack.com/api/conversations.info", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Bearer " + token,
      },
      body: form.toString(),
    });
    const result = (await response.json()) as {
      ok?: boolean;
      error?: string;
      channel?: { is_private?: boolean };
    };
    return {
      ok: result.ok === true,
      isPrivate: result.channel?.is_private === true,
      error: result.error,
    };
  } catch (error) {
    return {
      ok: false,
      isPrivate: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Which kind of Slack conversation a turn is happening in.
 *
 * `mpim` — a GROUP direct message (the bot plus two or more people) — is its
 * own surface rather than a flavour of either neighbour, because it sits
 * between them on both axes that matter:
 *
 *   • Like a DM and unlike a channel, everyone in the room is there *because
 *     of* the bot's conversation. There is no "the bot happens to sit in this
 *     channel" case, so the bystander premise that justifies staying silent
 *     does not hold (see `mayStaySilent`).
 *   • Like a channel and unlike a DM, it holds more than one human, so it is
 *     NOT the private 1:1 surface that unlocks the DM-only tools.
 *
 * Collapsing it into either neighbour gets one of those wrong. Everything that
 * asks `surface === "dm"` therefore keeps treating an mpim as non-private (its
 * behaviour before this surface existed); the difference is only where a rule
 * really turns on "is this a shared room the bot merely sits in".
 */
export type SlackSurface = "channel" | "dm" | "mpim";

/**
 * The GLOBAL Slack surface → `WriteSurface` collapse.
 *
 * Only a 1:1 DM is "private" here. A group DM (`mpim`) is deliberately NOT,
 * because this value gates the credential/destructive/sensitive tools —
 * `get_scholar_emergency_info` (healthRecordTools), and
 * `reset_scholar_password` / `reset_scholar_passkeys` / `delete_scholar` /
 * `upload_scholar_document` (scholarWriteTools). Widening `mpim` here would
 * put a child's medical record and account credentials into any multi-person
 * DM; see the reasoning on `SlackSurface` above.
 *
 * A tool that genuinely wants a different boundary takes its OWN explicitly
 * named option instead of changing this — `guardianFormAnswersSurface` is the
 * worked example (guardian-form answers, where a deliberately-composed private
 * group DM does count as private).
 */
export function writeSurfaceFor(surface: SlackSurface): "private" | "channel" {
  return surface === "dm" ? "private" : "channel";
}

// Described only when the Lists tools are actually assembled (scholar-admin).
// Reinforces the two invariants the tool descriptions also carry: read first
// (to get ids), and confirm before any write/delete.
export const SLACK_LISTS_SYSTEM_PROMPT_SECTION =
  "Slack Lists: you can read and edit Slack Lists (Slack's native task/table) with read_slack_list / add_slack_list_item / update_slack_list_item / delete_slack_list_item. There's no search-by-name — ask for the list's link (…/lists/F…) if you don't have it. ALWAYS read_slack_list first so you have each column's id + type and each row's record id, and CONFIRM the exact change with the requester before adding, updating, or (especially) deleting a row.";

// ── Self-documenting channel topics ──────────────────────────────────────
// When a staff member LINKS a channel to a Rabbithole entity, we stamp a short
// topic so the channel documents itself ("what is this wired to?"). Pure so it
// can be unit-tested per link type. The group variant uses the canonical group
// name the teacher named; the alerts/parent channels are singletons.
export type SlackLinkKind = "group" | "alerts" | "parent";

export interface LinkTopicOpts {
  groupName?: string;
  // For "alerts": the channel's effective role decides what actually posts
  // there — platform-ops never receives safety alerts, so its topic must not
  // claim them (and gets a calm 📊, not the safety siren).
  alertsRole?: "scoped" | "catchall" | "platform-ops" | "improvement-loops";
  institutionName?: string;
}

export function linkTopicFor(kind: SlackLinkKind, opts?: LinkTopicOpts): string {
  switch (kind) {
    case "group":
      return `📚 ${(opts?.groupName ?? "").trim() || "Scholar group"} · Rabbithole activity updates`;
    case "alerts": {
      if (opts?.alertsRole === "platform-ops") {
        return "📊 Rabbithole platform ops · cost/usage reports & system alerts";
      }
      if (opts?.alertsRole === "improvement-loops") {
        return "🔄 Rabbithole improvement loops · Rounds, Coherence & proposals";
      }
      const inst = (opts?.institutionName ?? "").trim();
      return inst
        ? `🚨 ${inst} · Rabbithole safety alerts & weekly reports`
        : "🚨 Rabbithole alerts · safety alerts & weekly reports";
    }
    case "parent":
      return "✉️ Rabbithole parent messages · PRIVATE — staff only";
  }
}

/** The soft note appended to a link confirmation ONLY when the topic stamp landed. */
const TOPIC_STAMP_NOTE = " (I also set this channel's topic to label the link.)";

export async function makeSlackTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    surface: SlackSurface;
    /** The Slack channel the conversation lives in (for channel↔group linking). */
    slackChannelId: string;
    /** Bot token — used to stamp a self-documenting topic on link (best-effort). */
    token: string;
    /** Established from an active institution-scoped school:operations grant. */
    hasSchoolOperationsAccess?: boolean;
  },
) {
  const {
    role,
    callerUserId,
    surface,
    slackChannelId,
    token,
    hasSchoolOperationsAccess = false,
  } = opts;
  const canOperateSchool =
    isScholarAdminRole(role) ||
    (role === "staff" && hasSchoolOperationsAccess);
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  // Stamp the channel's topic AFTER a successful LINK (never on unlink, so we
  // never clobber a human's topic on a channel we didn't just link). Best-effort:
  // returns a soft note to append to the confirmation only when Slack accepted it.
  const stampTopicOnLink = async (
    isLink: boolean,
    kind: SlackLinkKind,
    opts?: LinkTopicOpts,
  ): Promise<string> => {
    if (!isLink) return "";
    const res = await setConversationTopic(
      token,
      slackChannelId,
      linkTopicFor(kind, opts),
    );
    return res.ok ? TOPIC_STAMP_NOTE : "";
  };

  const tools = [];

  // ── link_channel_to_group — teacher/admins, CHANNEL surface only ──────
  // (Linking a DM to a group would be meaningless; the tool binds the
  // channel the conversation is happening in, so it's also self-evident
  // to everyone present which channel got linked. A GROUP DM is excluded
  // for the same reason as a 1:1 — it is not a durable, joinable room, so
  // routing a group's notifications into it would strand them.)
  if (isTeacherRole(role) && surface === "channel") {
    tools.push(
      betaTool({
        name: "link_channel_to_group",
        description:
          "Link THIS Slack channel to a scholar group so the group's activity notifications (completions, deliverable submissions) post here. Linking is the opt-in: an unlinked channel never gets notifications. Confirm with the requester before linking. Pass unlink=true to remove this channel's link instead.",
        inputSchema: {
          type: "object" as const,
          properties: {
            groupName: {
              type: "string" as const,
              description: "The scholar group's name (case-insensitive partial match)",
            },
            unlink: {
              type: "boolean" as const,
              description: "true to UNLINK this channel from the group instead",
            },
          },
          required: ["groupName"] as const,
        },
        run: async (input) => {
          const isLink = !(input.unlink ?? false);
          const result = await ctx.runMutation(
            internal.slackNotifications.linkChannelToGroup,
            {
              callerUserId,
              groupName: input.groupName,
              slackChannelId,
              unlink: input.unlink ?? false,
            },
          );
          if (!result.ok) return result.message;
          emit({
            toolComplete: { name: "link_channel_to_group", result: result.message },
          });
          const note = await stampTopicOnLink(isLink, "group", {
            groupName: input.groupName,
          });
          return result.message + note;
        },
      }),
    );
  }

  // ── set_group_notify_mode — teacher/admins, channel surface ───────────
  if (isTeacherRole(role) && surface === "channel") {
    tools.push(
      betaTool({
        name: "set_group_notify_mode",
        description:
          "Change a linked scholar group's notification cadence: 'digest' (default — hourly activity-gated replies in the day's check-in thread) or 'immediate' (each event as it happens). Only works on groups already linked to a channel.",
        inputSchema: {
          type: "object" as const,
          properties: {
            groupName: {
              type: "string" as const,
              description: "The scholar group's name (case-insensitive partial match)",
            },
            mode: {
              type: "string" as const,
              enum: ["digest", "immediate"] as const,
              description: "The delivery cadence",
            },
          },
          required: ["groupName", "mode"] as const,
        },
        run: async (input) => {
          const result = await ctx.runMutation(
            internal.slackNotifications.setNotifyMode,
            {
              callerUserId,
              groupName: input.groupName,
              mode: input.mode as "digest" | "immediate",
            },
          );
          if (result.ok) {
            emit({
              toolComplete: { name: "set_group_notify_mode", result: result.message },
            });
          }
          return result.message;
        },
      }),
    );
  }

  // ── link_alerts_channel — platform admin only, CHANNEL surface only ───
  // Alert channel destination. Four roles:
  //   scoped       — one channel per institution (welfare/safety + Quality Pulse +
  //                  Practice Portrait for that institution's scholars).
  //   catchall     — fallback for institutions without a dedicated channel.
  //   platform-ops — dedicated channel for firm-wide cost/usage reports and
  //                  generic system/error alerts; never receives scholar alerts.
  //   improvement-loops — private channel for generic pointers and redacted proposals.
  // Omitting role with an institution_slug → "scoped" (backward compat).
  // Omitting role without an institution_slug → "catchall" (backward compat).
  if (isPlatformAdminRole(role) && surface === "channel") {
    tools.push(
      betaTool({
        name: "link_alerts_channel",
        description:
          "Link THIS Slack channel as a Rabbithole alert destination. Four roles:\n" +
          "• \"scoped\" (default when institution_slug is given) — receives welfare/safety alerts, Quality Pulse, and Practice Portrait for one institution. Pass institution_slug.\n" +
          "• \"catchall\" (default when no institution_slug) — fallback for institutions without a dedicated scoped channel.\n" +
          "• \"platform-ops\" — receives the firm-wide AI cost/usage report and generic system/error alerts; does NOT receive scholar or institution reports. Only one platform-ops channel at a time.\n" +
          "• \"improvement-loops\" — PRIVATE channel for generic Rounds and Coherence pointers plus human-reviewed proposal threads. Never receives learner records. Only one at a time.\n" +
          "PLATFORM ADMIN ONLY. Pass unlink=true to remove the link. Confirm with the requester before linking.",
        inputSchema: {
          type: "object" as const,
          properties: {
            unlink: {
              type: "boolean" as const,
              description: "true to UNLINK this channel as the alerts destination",
            },
            institution_slug: {
              type: "string" as const,
              description:
                `Institution slug (e.g. ${institutionSlugExamples}) — required for the "scoped" role. Omit for "catchall", "platform-ops", or "improvement-loops".`,
            },
            role: {
              type: "string" as const,
              enum: ["scoped", "catchall", "platform-ops", "improvement-loops"],
              description:
                "Channel role. \"improvement-loops\" is the private platform-wide destination for generic Rounds/Coherence pointers and redacted proposal threads (never learner data). Defaults to \"scoped\" when institution_slug is provided, \"catchall\" otherwise.",
            },
          },
          required: [] as const,
        },
        run: async (input) => {
          const isLink = !(input.unlink ?? false);
          if (isLink && input.role === "improvement-loops") {
            const privacy = await privateChannelCheck(token, slackChannelId);
            if (!privacy.ok) {
              return (
                "I couldn't verify that this Slack channel is private, so I " +
                `didn't link it (${privacy.error ?? "conversations.info failed"}).`
              );
            }
            if (!privacy.isPrivate) {
              return (
                "I can't link a public channel for improvement loops. Create or " +
                "use a PRIVATE channel, then run this link again."
              );
            }
          }
          const result = await ctx.runMutation(
            internal.alerts.linkAlertsChannel,
            {
              callerUserId,
              slackChannelId,
              unlink: input.unlink ?? false,
              institutionSlug: input.institution_slug ?? undefined,
              role: (input.role as "scoped" | "catchall" | "platform-ops" | "improvement-loops" | undefined) ?? undefined,
            },
          );
          if (result.ok) {
            emit({
              toolComplete: { name: "link_alerts_channel", result: result.message },
            });
            const note = await stampTopicOnLink(isLink, "alerts", {
              alertsRole: result.role,
              institutionName: result.institutionName,
            });
            return result.message + note;
          }
          return result.message;
        },
      }),
    );
  }

  // ── link_bug_report_channel — platform admin, PRIVATE channel only ────
  // Reports can contain classroom audio, screenshots, and cross-tenant product
  // context. Unlike the generic channel binders, this one verifies Slack's
  // is_private bit before recording the destination.
  if (isPlatformAdminRole(role) && surface === "channel") {
    tools.push(
      betaTool({
        name: "link_bug_report_channel",
        description:
          "Link THIS PRIVATE Slack channel as Rabbithole's platform-operator bug-report inbox. Reports from every institution can include classroom screenshots/audio, so public channels are refused. There is one bug-report channel at a time; linking here moves it and drains any waiting reports. PLATFORM ADMIN ONLY. Pass unlink=true to remove the binding. Confirm with the requester before linking.",
        inputSchema: {
          type: "object" as const,
          properties: {
            unlink: {
              type: "boolean" as const,
              description:
                "true to UNLINK this channel as the bug-report destination",
            },
          },
          required: [] as const,
        },
        run: async (input) => {
          if (!(input.unlink ?? false)) {
            const privacy = await privateChannelCheck(token, slackChannelId);
            if (!privacy.ok) {
              return (
                "I couldn't verify that this Slack channel is private, so I " +
                `didn't link it (${privacy.error ?? "conversations.info failed"}).`
              );
            }
            if (!privacy.isPrivate) {
              return (
                "I can't link a public channel for bug reports. Create or use " +
                "a PRIVATE staff channel, then run this link again."
              );
            }
          }
          const result = await ctx.runMutation(
            internal.bugReports.linkBugReportChannel,
            {
              callerUserId,
              slackChannelId,
              unlink: input.unlink ?? false,
            },
          );
          if (!result.ok) return result.message;
          let message = result.message;
          if ((result.waitingCount ?? 0) > 0) {
            const posted = await postMessage(token, {
              channel: slackChannelId,
              text: `${result.waitingCount} bug report${result.waitingCount === 1 ? " was" : "s were"} waiting and will be posted here now.`,
            });
            message += posted.ok
              ? ` ${result.waitingCount} waiting report${result.waitingCount === 1 ? " is" : "s are"} now being drained.`
              : " The waiting reports are being drained, but Slack rejected the backlog notice.";
          }
          emit({
            toolComplete: {
              name: "link_bug_report_channel",
              result: message,
            },
          });
          return message;
        },
      }),
    );
  }


  // ── link_parent_message_channel — platform admin only, CHANNEL surface ─
  // The shared private staff inbox for teacher↔parent messages. Parent/child
  // PII is intentionally visible to members, so the tool's success text always
  // reminds the platform admin to use a private staff channel.
  if (isPlatformAdminRole(role) && surface === "channel") {
    tools.push(
      betaTool({
        name: "link_parent_message_channel",
        description:
          "Link THIS Slack channel as Rabbithole's shared staff inbox for teacher-parent messages. There is ONE parent-message channel for the whole school; linking here moves it from any previous channel. PLATFORM ADMIN ONLY. Use a PRIVATE staff channel because parent/child PII will be visible to channel members. Pass unlink=true to stop parent messages posting here. Confirm with the requester before linking.",
        inputSchema: {
          type: "object" as const,
          properties: {
            unlink: {
              type: "boolean" as const,
              description:
                "true to UNLINK this channel as the parent-message destination",
            },
          },
          required: [] as const,
        },
        run: async (input) => {
          const isLink = !(input.unlink ?? false);
          const result = await ctx.runMutation(
            internal.parentMessageSlack.linkParentMessageChannel,
            {
              callerUserId,
              slackChannelId,
              unlink: input.unlink ?? false,
            },
          );
          if (result.ok) {
            emit({
              toolComplete: {
                name: "link_parent_message_channel",
                result: result.message,
              },
            });
            const note = await stampTopicOnLink(isLink, "parent");
            return result.message + note;
          }
          return result.message;
        },
      }),
    );
  }

  // ── issue_parent_enroll_link — scholar-admin, DM only ─────────────────
  if (canOperateSchool && surface === "dm") {
    tools.push(
      betaTool({
        name: "issue_parent_enroll_link",
        description:
          "Issue a one-time sign-in (passkey enrollment) link for a PARENT account, e.g. before a parent meeting. The link is single-use and expires; treat it like a credential — it's only offered here in a DM, never in a channel. Confirm the resolved parent with the requester before issuing.",
        inputSchema: {
          type: "object" as const,
          properties: {
            parentName: {
              type: "string" as const,
              description:
                "The parent's name or email (case-insensitive partial match)",
            },
          },
          required: ["parentName"] as const,
        },
        run: async (input) => {
          const result = await ctx.runMutation(
            internal.slackAdminOps.issueParentEnrollLink,
            { callerUserId, parentName: input.parentName },
          );
          if (!result.ok) return result.message;
          emit({
            toolComplete: {
              name: "issue_parent_enroll_link",
              result: `Issued link for ${result.parentName}`,
            },
          });
          return `One-time enroll link for ${result.parentName}: ${result.url}\n(Single use; expires in 7 days. Anyone with this link can claim the account — share it only with the parent.)`;
        },
      }),
    );
  }


  // ── Rabbithole Lock — school operations, both Slack surfaces ─────────
  // The read-before-write split is load-bearing: the model must resolve opaque
  // paired-device ids and show the exact iPads to the requester before a remote
  // disarm. The internal functions repeat role + institution checks; prompt
  // confirmation is never treated as the authorization boundary.
  if (canOperateSchool) {
    tools.push(
      betaTool({
        name: "list_rabbithole_lock_devices",
        description:
          "List paired school iPads and their Rabbithole Lock state. Use this BEFORE set_rabbithole_lock to resolve the exact paired_device_ids and show the requester which iPads will change. Optionally search by device label, serial, scholar name/username, or id. The inventory is complete; rows for Extended Education (program-guest) scholars are tagged extendedEducation: true.",
        inputSchema: {
          type: "object" as const,
          properties: {
            search: {
              type: "string" as const,
              description:
                "Optional device label, serial, scholar name/username, or id filter.",
            },
          },
          required: [] as const,
        },
        run: async (input) => {
          const result = await ctx.runQuery(internal.deviceLock.listForSlack, {
            callerUserId,
            search: input.search?.trim() || undefined,
          });
          if (!result.ok) return result.message;
          emit({
            toolComplete: {
              name: "list_rabbithole_lock_devices",
              result: `${result.devices.length} iPad${result.devices.length === 1 ? "" : "s"}`,
            },
          });
          return JSON.stringify(result.devices, null, 2);
        },
      }),
    );

    tools.push(
      betaTool({
        name: "set_rabbithole_lock",
        description:
          "Arm or disarm Rabbithole Lock on one or more paired school iPads. You MUST call list_rabbithole_lock_devices first, show the exact resolved devices and action to the requester, and receive confirmation before calling this write tool. Disarm defaults to until_midnight in each iPad's school timezone; alternatives are one_time (re-arms when Rabbithole is entered again), until_further_notice, and timed (re-arms automatically after a fixed number of minutes — pass disarm_minutes, 5-480, whenever disarm_mode is timed).",
        inputSchema: {
          type: "object" as const,
          properties: {
            paired_device_ids: {
              type: "array" as const,
              description:
                "Exact pairedDeviceId values returned by list_rabbithole_lock_devices.",
              items: { type: "string" as const },
            },
            state: {
              type: "string" as const,
              enum: ["armed", "disarmed"] as const,
            },
            disarm_mode: {
              type: "string" as const,
              enum: [
                "one_time",
                "until_midnight",
                "until_further_notice",
                "timed",
              ] as const,
              description:
                "For disarm only. Defaults to until_midnight.",
            },
            disarm_minutes: {
              type: "number" as const,
              description:
                "Required when disarm_mode is timed: how many minutes from now to stay disarmed (integer, 5-480). Ignored for every other disarm_mode.",
            },
          },
          required: ["paired_device_ids", "state"] as const,
        },
        run: async (input) => {
          const result = await ctx.runMutation(
            internal.deviceLock.setFromSlack,
            {
              callerUserId,
              pairedDeviceIds: (input.paired_device_ids ?? []) as Id<"pairedDevices">[],
              state: input.state as "armed" | "disarmed",
              disarmMode: input.disarm_mode as
                | "one_time"
                | "until_midnight"
                | "until_further_notice"
                | "timed"
                | undefined,
              disarmMinutes: input.disarm_minutes as number | undefined,
            },
          );
          if (result.ok) {
            emit({
              toolComplete: {
                name: "set_rabbithole_lock",
                result: result.message,
              },
            });
          }
          return result.message;
        },
      }),
    );
  }

  // ── Class focus — teachers, both Slack surfaces ────────────────────────
  // The headline ad-hoc capability: put an app, a video, or any link in
  // front of a group for a bounded window, without inventing a unit and an
  // assignment to hold it. Read-before-write, same split as Rabbithole Lock:
  // list_focus_options resolves opaque app/group ids so the requester sees
  // exactly what will appear on scholars' screens before it does.
  if (isTeacherRole(role)) {
    tools.push(
      betaTool({
        name: "list_focus_options",
        description:
          "List what you can make the class focus and who you can send it to: the external-app catalog, this school's scholar groups (Geckos, Seals, Robotics, …), and the allowed durations. Call this BEFORE make_class_focus to resolve the exact app_id and group_id, and to show the requester which group and how long. Omitting group_id in the write means every enrolled scholar at the school.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [] as const,
        },
        run: async () => {
          const result = await ctx.runQuery(
            internal.pushes.focusOptionsForSlack,
            { callerUserId },
          );
          if (!result.ok) return result.message;
          emit({
            toolComplete: {
              name: "list_focus_options",
              result: `${result.apps.length} apps, ${result.groups.length} groups`,
            },
          });
          return JSON.stringify(result, null, 2);
        },
      }),
    );

    tools.push(
      betaTool({
        name: "make_class_focus",
        description:
          "Put an app, a video, or any web link in front of scholars right now — it appears at the top of their iPad home as a 'Right now' card until the window closes. Use this for an ad-hoc push like 'show the Geckos this coral reef video for the next 20 minutes'. You MUST call list_focus_options first, then show the requester the resolved app/link, the group, and the duration, and receive confirmation before calling this write tool. Give either app_id OR url (with a title). Duration defaults to 60 minutes. It expires on its own — no cleanup needed.",
        inputSchema: {
          type: "object" as const,
          properties: {
            app_id: {
              type: "string" as const,
              description:
                "Exact appId from list_focus_options. Mutually exclusive with url.",
            },
            url: {
              type: "string" as const,
              description:
                "Full http(s) URL for a video or web page. Mutually exclusive with app_id.",
            },
            title: {
              type: "string" as const,
              description:
                "What scholars see as the card's name. Required with url.",
            },
            media: {
              type: "string" as const,
              enum: ["video", "page"] as const,
              description: "For url only. Picks the glyph and the verb (Watch vs Open).",
            },
            group_id: {
              type: "string" as const,
              description:
                "Exact groupId from list_focus_options. OMIT to push to every enrolled scholar at the school.",
            },
            duration_min: {
              type: "number" as const,
              description: "Minutes the focus stays up. Defaults to 60.",
            },
            note: {
              type: "string" as const,
              description:
                "Optional one-line note shown verbatim under the title (e.g. 'watch the first 10 minutes').",
            },
          },
          required: [] as const,
        },
        run: async (input) => {
          const result = await ctx.runMutation(
            internal.pushes.makeFocusFromSlack,
            {
              callerUserId,
              appId: input.app_id
                ? (input.app_id as Id<"externalApps">)
                : undefined,
              url: input.url?.trim() || undefined,
              title: input.title?.trim() || undefined,
              media: input.media as "video" | "page" | undefined,
              groupId: input.group_id
                ? (input.group_id as Id<"scholarGroups">)
                : undefined,
              durationMin:
                typeof input.duration_min === "number"
                  ? input.duration_min
                  : undefined,
              note: input.note?.trim() || undefined,
            },
          );
          if (result.ok) {
            emit({
              toolComplete: {
                name: "make_class_focus",
                result: result.message,
              },
            });
          }
          return result.message;
        },
      }),
    );

    tools.push(
      betaTool({
        name: "list_class_focus",
        description:
          "Show what is currently on scholars' screens as class focus, with how long each has left and who pushed it. Call this to answer 'what's up right now?' and to resolve a push_id before end_class_focus.",
        inputSchema: {
          type: "object" as const,
          properties: {},
          required: [] as const,
        },
        run: async () => {
          const result = await ctx.runQuery(internal.pushes.liveFocusForSlack, {
            callerUserId,
          });
          if (!result.ok) return result.message;
          if (result.pushes.length === 0) return "Nothing is up right now.";
          emit({
            toolComplete: {
              name: "list_class_focus",
              result: `${result.pushes.length} live`,
            },
          });
          return JSON.stringify(result.pushes, null, 2);
        },
      }),
    );

    tools.push(
      betaTool({
        name: "end_class_focus",
        description:
          "Wrap up a live class focus before its window closes. Call list_class_focus first to resolve the push_id and show the requester which one you are ending.",
        inputSchema: {
          type: "object" as const,
          properties: {
            push_id: {
              type: "string" as const,
              description: "Exact pushId from list_class_focus.",
            },
          },
          required: ["push_id"] as const,
        },
        run: async (input) => {
          const result = await ctx.runMutation(
            internal.pushes.clearFocusFromSlack,
            {
              callerUserId,
              pushId: String(input.push_id) as Id<"pushes">,
            },
          );
          if (result.ok) {
            emit({
              toolComplete: { name: "end_class_focus", result: result.message },
            });
          }
          return result.message;
        },
      }),
    );
  }

  // ── Program capture mode — scholar-admin, both Slack surfaces ───────────
  // The backend owns the scoped program-capability, institution, scholar, and
  // assigned-device checks. Slack only resolves the opaque scholar/station ids
  // before a confirmed change; it must never reveal device credentials.
  if (isScholarAdminRole(role)) {
    tools.push(
      betaTool({
        name: "find_robotics_capture_target",
        description:
          "Find the eligible Robotics/program capture station for a named scholar's assigned iPad. Call this BEFORE set_robotics_capture_mode. It returns the exact scholar_id and capture_station_id required for a change; use those ids exactly. It never exposes a device id, serial, enrollment token, or session token.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholar_query: {
              type: "string" as const,
              description:
                "The scholar's name or username. Ask for clarification if the result is ambiguous.",
            },
          },
          required: ["scholar_query"] as const,
        },
        run: async (input) => {
          const scholarQuery = String(input.scholar_query ?? "").trim();
          if (!scholarQuery) return "Name the scholar whose capture mode you want to manage.";
          const result = await ctx.runQuery(
            internal.captureStations.findAssignedDeviceCaptureTargetsForSlack,
            { callerUserId, scholarQuery },
          );
          const targets = result.flatMap((target) =>
            target.stations.map((station) => ({
              scholarId: target.scholarId,
              scholarName: target.scholarName ?? target.scholarUsername ?? "Scholar",
              captureStationId: station.captureStationId,
              captureStationName: station.label ?? "Program capture station",
            })),
          );
          if (targets.length === 0) {
            return "I couldn't find an eligible assigned capture device for that scholar.";
          }
          emit({
            toolComplete: {
              name: "find_robotics_capture_target",
              result: `${targets.length} eligible capture target${targets.length === 1 ? "" : "s"}`,
            },
          });
          return JSON.stringify({ targets }, null, 2);
        },
      }),
    );

    tools.push(
      betaTool({
        name: "set_robotics_capture_mode",
        description:
          "Start or stop Robotics/program capture-station mode on a named scholar's assigned iPad. You MUST first call find_robotics_capture_target, show the resolved scholar and program station plus whether you will start or stop mode, and receive explicit confirmation in this thread before this tool for BOTH start and stop. Use only the exact scholar_id and capture_station_id returned by that lookup. Starting mode ends automatically at 4:40 PM today; stopping mode leaves existing captures available.",
        inputSchema: {
          type: "object" as const,
          properties: {
            scholar_id: {
              type: "string" as const,
              description:
                "Exact scholarId returned by find_robotics_capture_target.",
            },
            capture_station_id: {
              type: "string" as const,
              description:
                "Exact captureStationId returned by find_robotics_capture_target.",
            },
            enabled: {
              type: "boolean" as const,
              description: "true starts capture mode; false stops it.",
            },
          },
          required: ["scholar_id", "capture_station_id", "enabled"] as const,
        },
        run: async (input) => {
          const enabled = input.enabled === true;
          await ctx.runMutation(
            internal.captureStations.setAssignedDeviceCaptureModeFromSlack,
            {
              callerUserId,
              scholarId: input.scholar_id as Id<"users">,
              captureStationId: input.capture_station_id as Id<"captureStations">,
              enabled,
            },
          );
          const message = enabled
            ? "Capture-station mode started. It ends automatically at 4:40 PM today."
            : "Capture-station mode stopped. Existing captures remain available.";
          emit({ toolComplete: { name: "set_robotics_capture_mode", result: message } });
          return message;
        },
      }),
    );
  }

  // ── Slack Lists (native task/table) — scholar-admin, BOTH surfaces ────
  // Read/write Slack's native Lists so staff can drive a shared task list from
  // the bot ("mark the aquaponics prep row done", "add a row for…"). A List
  // isn't a credential, so unlike enroll links these work in channels AND DMs.
  // The model resolves a List by a pasted link/id (there's no find-by-name),
  // and must read_slack_list first to learn each column's id + type before
  // writing. Writes/deletes are confirm-before-acting (reinforced in the tool
  // descriptions + the system prompt).
  if (isScholarAdminRole(role)) {
    const fieldItemsSchema = {
      type: "array" as const,
      description:
        "Cells to set, one per column. Each is { column_id, type, value }. Get column_id + type from read_slack_list first.",
      items: {
        type: "object" as const,
        properties: {
          column_id: {
            type: "string" as const,
            description: "The column's id (e.g. Col…) from read_slack_list.",
          },
          type: {
            type: "string" as const,
            enum: [...WRITABLE_LIST_TYPES],
            description: "The column's type from read_slack_list.",
          },
          value: {
            description:
              "The cell value. text: a string; checkbox: true/false; date: \"YYYY-MM-DD\"; number: a number; select: option id(s); user: U… id(s); channel: C… id(s); email/phone: string(s). Ids may be a single value or an array.",
          },
        },
        required: ["column_id", "type", "value"] as const,
      },
    };

    tools.push(
      betaTool({
        name: "read_slack_list",
        description:
          "Read a Slack List (Slack's native task/table). Paste the list's link (looks like …/lists/F…) or its F… id. Returns the columns (with each column_id + type — you NEED these to add or edit rows) and every row (with its record id). Use this before any add/update/delete so you have the right ids.",
        inputSchema: {
          type: "object" as const,
          properties: {
            list: {
              type: "string" as const,
              description: "A Slack List link (…/lists/F…) or the raw list id (F…).",
            },
          },
          required: ["list"] as const,
        },
        run: async (input) => {
          const listId = parseListId(String(input.list));
          if (!listId) {
            return "I couldn't find a Slack List id in that. Paste the list's link (it looks like …/lists/F…) or its F… id.";
          }
          const itemsRes = await listItems(token, listId, { limit: 100 });
          if (!itemsRes.ok) {
            return `I couldn't read that list (${itemsRes.error ?? "unknown_error"}). If the list is in a channel, add @Rabbithole to that channel so it can see the list.`;
          }
          const items = Array.isArray(itemsRes.items)
            ? (itemsRes.items as Array<Record<string, unknown>>)
            : [];
          // Schema (column ids + types) comes from slackLists.items.info on a
          // record — there's no schema-only method (slackLists.info doesn't
          // exist; items.list omits the schema). An empty list has no row to
          // ask, so columns fall back to whatever the rows expose.
          let columns: SlackListColumn[] = [];
          const firstId = items.length
            ? String(items[0].id ?? "")
            : "";
          if (firstId) {
            const info = await listItemInfo(token, listId, firstId);
            if (info.ok) columns = listSchemaColumns(info);
          }
          emit({ toolComplete: { name: "read_slack_list", result: `${items.length} rows` } });
          return formatListForModel(listId, columns, items);
        },
      }),
    );

    tools.push(
      betaTool({
        name: "add_slack_list_item",
        description:
          "Add a row to a Slack List. Call read_slack_list FIRST to get each column's id + type, and confirm the values with the requester before adding.",
        inputSchema: {
          type: "object" as const,
          properties: {
            list: {
              type: "string" as const,
              description: "The List link or F… id.",
            },
            fields: fieldItemsSchema,
          },
          required: ["list", "fields"] as const,
        },
        run: async (input) => {
          const listId = parseListId(String(input.list));
          if (!listId) {
            return "I couldn't find a Slack List id in that. Paste the list's link or its F… id.";
          }
          const defs = (input.fields ?? []) as Array<{
            column_id: string;
            type: string;
            value: unknown;
          }>;
          let initialFields: Array<Record<string, unknown>>;
          try {
            initialFields = defs.map((f) => buildListCell(f.column_id, f.type, f.value));
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          const res = await listItemCreate(token, listId, initialFields);
          if (!res.ok) {
            return `I couldn't add the row (${res.error ?? "unknown_error"}).`;
          }
          const newId = (res.item as Record<string, unknown> | undefined)?.id as
            | string
            | undefined;
          emit({
            toolComplete: {
              name: "add_slack_list_item",
              result: `Added row${newId ? ` ${newId}` : ""}`,
            },
          });
          return `Added a row to the list${newId ? ` (id ${newId})` : ""}.`;
        },
      }),
    );

    tools.push(
      betaTool({
        name: "update_slack_list_item",
        description:
          "Update one or more cells on an existing Slack List row — e.g. tick a checkbox to mark a task done, change a status, set a due date. Call read_slack_list FIRST to get the row's record id (Rec…) plus each column's id + type. Confirm the change with the requester before updating.",
        inputSchema: {
          type: "object" as const,
          properties: {
            list: {
              type: "string" as const,
              description: "The List link or F… id.",
            },
            row_id: {
              type: "string" as const,
              description: "The row/record id (Rec…) from read_slack_list.",
            },
            fields: fieldItemsSchema,
          },
          required: ["list", "row_id", "fields"] as const,
        },
        run: async (input) => {
          const listId = parseListId(String(input.list));
          if (!listId) {
            return "I couldn't find a Slack List id in that. Paste the list's link or its F… id.";
          }
          const rowId = String(input.row_id);
          const defs = (input.fields ?? []) as Array<{
            column_id: string;
            type: string;
            value: unknown;
          }>;
          let cells: Array<Record<string, unknown>>;
          try {
            cells = defs.map((f) => ({
              row_id: rowId,
              ...buildListCell(f.column_id, f.type, f.value),
            }));
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
          const res = await listItemUpdate(token, listId, cells);
          if (!res.ok) {
            return `I couldn't update the row (${res.error ?? "unknown_error"}).`;
          }
          emit({
            toolComplete: {
              name: "update_slack_list_item",
              result: `Updated ${cells.length} cell(s)`,
            },
          });
          return "Updated the row.";
        },
      }),
    );

    tools.push(
      betaTool({
        name: "delete_slack_list_item",
        description:
          "Delete a row from a Slack List. Destructive and not undoable — ALWAYS confirm the exact row with the requester first. Pass the row's record id (Rec…) from read_slack_list.",
        inputSchema: {
          type: "object" as const,
          properties: {
            list: {
              type: "string" as const,
              description: "The List link or F… id.",
            },
            row_id: {
              type: "string" as const,
              description: "The row/record id (Rec…) from read_slack_list.",
            },
          },
          required: ["list", "row_id"] as const,
        },
        run: async (input) => {
          const listId = parseListId(String(input.list));
          if (!listId) {
            return "I couldn't find a Slack List id in that. Paste the list's link or its F… id.";
          }
          const res = await listItemDelete(token, listId, String(input.row_id));
          if (!res.ok) {
            return `I couldn't delete the row (${res.error ?? "unknown_error"}).`;
          }
          emit({
            toolComplete: { name: "delete_slack_list_item", result: "Deleted row" },
          });
          return "Deleted the row.";
        },
      }),
    );
  }

  return tools;
}

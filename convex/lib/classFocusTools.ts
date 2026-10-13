// Class focus as AGENT TOOLS — `list_focus_options`, `make_class_focus`,
// `list_class_focus`, `end_class_focus` — for the shared staff aide (in-app ·
// Slack · MCP). The headline ad-hoc capability: put an app, a video, or any
// link in front of a group for a bounded window, without inventing a unit and
// an assignment to hold it.
//
// The web/native UI keeps its own entry point (MakeFocusDialog →
// `pushes.makeFocus`); both write through `createFocus`.
//
// Read-before-write, same split as Rabbithole Lock: list_focus_options
// resolves opaque app/group ids so the requester sees exactly what will appear
// on scholars' screens before it does. That contract is prose, and prose is
// UX — the authorization boundary is the internal functions in
// convex/pushes.ts (`focusOptionsForAide` / `makeFocusFromAide` /
// `liveFocusForAide` / `clearFocusFromAide`), each of which re-checks the
// teacher role and resolves the caller's own institution lens. The caller id
// is the transport's authenticated user, never a model argument.
//
// Gating: teacher roles (isTeacherRole), every surface.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AideEmit } from "./aideStream";
import { isTeacherRole, type Role } from "./roles";

export async function makeClassFocusTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
  },
) {
  if (!isTeacherRole(opts.role)) return [];
  const { callerUserId } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const tools = [];

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
          internal.pushes.focusOptionsForAide,
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
          internal.pushes.makeFocusFromAide,
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
        const result = await ctx.runQuery(internal.pushes.liveFocusForAide, {
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
          internal.pushes.clearFocusFromAide,
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

  return tools;
}

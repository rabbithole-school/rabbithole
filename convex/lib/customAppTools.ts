// Bot tools — "install an app for a student." The teacher-facing aide (in-app
// Curriculum Assistant, the Slack bot, and the OAuth MCP connector) shares this
// one toolset so app installation, coached activities, and activity forks work
// through ANY bot (see the prompt section below):
//
//   install_external_app  — the teacher gave a URL for a REAL website → make it
//                            a launcher tile now (convex/customApps.ts
//                            installExistingUrlApp). No custom-app row.
//   create_custom_app     — the bot vibecoded a self-contained STATIC HTML app
//                            → store it, mint a token, install INSTANTLY at the
//                            /custom-apps?token=… url (createStaticApp). No PR.
//   update_custom_app     — replace a STATIC app's HTML in place, preserving
//                            its token, launcher URL, status, and grants.
//   make_app_a_coached_activity — turn a live STATIC app into a vibecode
//                            starter activity, optionally sending it live now.
//   fork_activity         — copy another teacher's activity into caller-owned
//                           curriculum with its own starter app copy.
//
// Like the other write toolsets, calls use an explicit callerUserId (the bot
// acts on behalf of the mapped user); scholar/group names are resolved locally
// where relevant. The set is gated to teacher roles (teacher / school- or
// platform-admin), not curriculum_designer / operations staff. Callers spread
// the result unconditionally (returns [] for a non-teaching caller).

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, type Role } from "./roles";
import type { AideEmit } from "./aideStream";
import { matchScholarByName } from "./scholarReadTools";
import {
  activityRehearsalPath,
  assignmentPath,
  markdownLink,
  unitPath,
  withBase,
} from "./channels";
import {
  assignAndPushActivityNow,
  makeAssignmentCohortResolver,
} from "./assignmentTools";
import {
  allowSilenceSchemaFragment,
  buildContractSchemaFragment,
  scholarEditSchemaFragment,
  scholarEditToEditAccess,
  tutorModelSchemaFragment,
  VIBECODE_BUILD_BRIEF_DESCRIPTION,
} from "./botTools";
import type { EditAccess } from "../../shared/workshopMode";
import {
  normalizeBuildContract,
  parseBuildContractArg,
  type BuildContract,
} from "./buildContract";
import {
  generateAppToken,
  MAX_STATIC_HTML_BYTES,
} from "../customApps";
import { APP_STATE_RULES } from "../prompts";
import { appBaseUrl } from "./deploymentConfig";
import { isAppActivity } from "../../shared/appSurface";

const scholarNamesProp = {
  type: "array" as const,
  items: { type: "string" as const },
  description:
    "Names of the scholar(s) to install for (case-insensitive partial match). Optional — omit to install for whole groups only, or for neither (create the app now, install later).",
};

const groupNamesProp = {
  type: "array" as const,
  items: { type: "string" as const },
  description:
    "Names of the scholar GROUP(s) to install for (e.g. a pod or class). Optional.",
};

type CoachedAppResolution =
  | { kind: "not_found" }
  | { kind: "ambiguous" }
  | { kind: "wrong_kind"; name: string }
  | {
      kind: "not_live";
      name: string;
      status: "building" | "archived";
    }
  | { kind: "missing_html"; name: string }
  | {
      kind: "resolved";
      customAppId: Id<"customApps">;
      name: string;
      url: string;
    };

type ActivityReference =
  | { kind: "name"; value: string }
  | { kind: "link"; activityId: Id<"activities"> }
  | { kind: "invalid_link" };

function parseActivityReference(reference: string): ActivityReference {
  const value = reference.trim();
  const looksLikeLink =
    /^https?:\/\//i.test(value) ||
    value.startsWith("/") ||
    value.includes("/teacher/curriculum/");
  if (!looksLikeLink) return { kind: "name", value };
  try {
    const url = new URL(value, "https://rabbithole.local");
    const activityId = url.searchParams.get("activity");
    return activityId
      ? { kind: "link", activityId: activityId as Id<"activities"> }
      : { kind: "invalid_link" };
  } catch {
    return { kind: "invalid_link" };
  }
}

/** kebab-case an app name into a URL/dir-safe route slug (bounded length). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "app"
  );
}

/**
 * Resolve human-named install targets to ids. Scholar writes use the strict
 * exact-first/unique-partial matcher and refuse ambiguities rather than choosing
 * the first substring match. Group matching retains its existing
 * exact-else-unique-partial behavior.
 */
async function resolveTargets(
  ctx: ActionCtx,
  scholarNames: string[] | undefined,
  groupNames: string[] | undefined,
  allowedScholarIds?: Set<Id<"users">>,
): Promise<{
  scholarIds: Id<"users">[];
  groupIds: Id<"scholarGroups">[];
  resolved: string[];
  unresolved: string[];
  ambiguous: { name: string; candidates: string[] }[];
  named: boolean;
}> {
  const scholarIds: Id<"users">[] = [];
  const groupIds: Id<"scholarGroups">[] = [];
  const resolved: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: { name: string; candidates: string[] }[] = [];

  if ((scholarNames ?? []).length > 0) {
    const { scholars: allScholars } = await ctx.runQuery(
      internal.curriculumAssistant.listScholarsInternal,
      // Naming a scholar is itself the Extended Education opt-in
      // (lib/scholarParticipationTooling.ts) — resolve program guests too.
      // The lens filters server-side; the local filter below is
      // belt-and-braces so a mis-plumbed call site still can't widen.
      {
        includeProgramGuests: true,
        ...(allowedScholarIds
          ? { allowedScholarIds: [...allowedScholarIds] }
          : {}),
      },
    );
    const scholars = allowedScholarIds
      ? allScholars.filter((s) => allowedScholarIds.has(s.id))
      : allScholars;
    for (const raw of scholarNames ?? []) {
      const name = raw.trim();
      if (!name) continue;
      const match = matchScholarByName(name, scholars);
      if (match.kind === "match") {
        scholarIds.push(match.scholar.id);
        resolved.push(match.scholar.name);
      } else if (match.kind === "ambiguous") {
        ambiguous.push({
          name,
          candidates: match.candidates.map((candidate) => candidate.name),
        });
      } else {
        unresolved.push(name);
      }
    }
  }

  if ((groupNames ?? []).length > 0) {
    const groups: Array<{
      id: Id<"scholarGroups">;
      name: string;
      members: { id: Id<"users">; name: string }[];
      /** True when the lens hid at least one live scholar member. */
      hasHiddenMembers?: boolean;
    }> = await ctx.runQuery(
      internal.curriculumAssistant.listScholarGroupsInternal,
      // An explicitly NAMED group keeps its full membership, Extended
      // Education scholars included (naming is the opt-in). The lens still
      // hides other schools' members — hasHiddenMembers marks the group as
      // partial, and a partial group is refused for installs below.
      {
        includeProgramGuests: true,
        ...(allowedScholarIds
          ? { allowedScholarIds: [...allowedScholarIds] }
          : {}),
      },
    );
    for (const raw of groupNames ?? []) {
      const q = raw.trim().toLowerCase();
      if (!q) continue;
      const exact = groups.filter((g) => g.name.toLowerCase() === q);
      const partial = groups.filter((g) => g.name.toLowerCase().includes(q));
      const match =
        exact.length === 1
          ? exact[0]
          : partial.length === 1
            ? partial[0]
            : null;
      if (match) {
        // A group grant must stay DYNAMIC — a scholar who joins the group
        // later still inherits the app. Expanding the match into a member-id
        // snapshot (which is what the lens-active path used to do) silently
        // withheld the app from every future member while still reporting
        // success to the teacher. So hand over the GROUP.
        //
        // But only when the caller can see the WHOLE group. A lensed caller is
        // shown a partial group (readScholarGroups hides out-of-lens members
        // while keeping the group visible), and granting by id would reach
        // those hidden members too — now and on every future expansion,
        // including the deferred one in finalizeCodedApp, which runs at PR
        // merge with no lens available. Refuse it here with a readable reason
        // instead: the mutation's assertTargetsWithinLens would also reject it,
        // but only as a thrown error the aide can't explain.
        if (match.hasHiddenMembers) {
          unresolved.push(raw.trim());
        } else {
          groupIds.push(match.id);
          resolved.push(match.name);
        }
      } else {
        unresolved.push(raw.trim());
      }
    }
  }

  const named = (scholarNames ?? []).length > 0 || (groupNames ?? []).length > 0;
  return { scholarIds, groupIds, resolved, unresolved, ambiguous, named };
}

function ambiguousTargetRefusal(t: {
  ambiguous: { name: string; candidates: string[] }[];
}): string | null {
  if (t.ambiguous.length === 0) return null;
  return t.ambiguous
    .map(
      ({ name, candidates }) =>
        `Multiple scholars match "${name}": ${candidates.join(", ")}. Use the exact full name so no app is installed for the wrong scholar.`,
    )
    .join(" ");
}

/** A one-line "installed for …" / "couldn't find …" suffix for tool replies. */
function targetSummary(t: {
  resolved: string[];
  unresolved: string[];
}): string {
  const parts: string[] = [];
  if (t.resolved.length) parts.push(`Installed for: ${t.resolved.join(", ")}.`);
  else parts.push("Not installed for anyone yet (no target resolved).");
  if (t.unresolved.length)
    parts.push(`Couldn't find: ${t.unresolved.join(", ")}.`);
  return parts.join(" ");
}

/**
 * Build the shared custom-app tools, closed over the calling stream's action
 * `ctx`, its SSE `emit`, and the caller's role/id/session/surface. Returns an
 * array of betaTools; `[]` when the caller isn't teaching staff (teacher /
 * admin), so callers spread it unconditionally (mirrors makeIntrospectionTools).
 */
export async function makeCustomAppTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    sessionId?: Id<"chats"> | null;
    linkBase?: string;
    allowedScholarIds?: Set<Id<"users">>;
    lensLabel?: string | null;
    /** Whether the caller actually RESOLVED an institution scholar lens.
     * Threaded to the install mutations so their guard can fail closed on a
     * caller that never considered one (vs. a platform admin who resolved an
     * unrestricted lens); see customApps.assertTargetsWithinLens. */
    scholarLensResolved?: boolean;
    via?: "aide" | "slack";
  },
) {
  if (!isTeacherRole(opts.role)) return [];

  const { callerUserId, sessionId, linkBase = "" } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  const resolveCohort = makeAssignmentCohortResolver(
    ctx,
    opts.allowedScholarIds,
  );

  // ── install_external_app — an existing website the teacher gave a URL for ──
  const installExternalAppTool = betaTool({
    name: "install_external_app",
    description:
      "Install an EXISTING website or web app as a launcher tile on a scholar's (or group's) iPad — use this when the teacher gives or clearly references a URL. The tile opens the site in the locked in-app webview. Nothing is BUILT here (the site already exists on the web); this adds its catalog tile if we don't have one yet, reusing the existing tile when we do, and grants it to the scholars/groups you name. This is the DEFAULT path for 'give <site> to <someone>'. (For a brand-new app the teacher describes, use create_custom_app or dispatch_custom_app. To add a catalog entry WITHOUT granting it — or to set an icon, colour, default-for-new-scholars, or credential source — use create_external_app, then the enable_app_for_* tools.)",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "A short display name for the launcher tile.",
        },
        url: {
          type: "string" as const,
          description: "The app's https:// URL.",
        },
        scholarNames: scholarNamesProp,
        groupNames: groupNamesProp,
      },
      required: ["name", "url"] as const,
    },
    run: async (input: {
      name: string;
      url: string;
      scholarNames?: string[];
      groupNames?: string[];
    }) => {
      const url = input.url.trim();
      let host: string;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:")
          return "The app URL must start with https://.";
        host = parsed.hostname;
      } catch {
        return `"${input.url}" isn't a valid URL. Give the app's full https:// address.`;
      }
      const displayName = input.name.trim() || host;
      const targets = await resolveTargets(
        ctx,
        input.scholarNames,
        input.groupNames,
        opts.allowedScholarIds,
      );
      const ambiguity = ambiguousTargetRefusal(targets);
      if (ambiguity) return ambiguity;
      if (targets.named && targets.resolved.length === 0) {
        const scope = opts.allowedScholarIds && opts.lensLabel
          ? ` in the current institution view (${opts.lensLabel})`
          : "";
        return `Couldn't find anyone matching ${targets.unresolved
          .map((n) => `"${n}"`)
          .join(", ")}${scope}. Check the name(s) and try again.`;
      }
      await ctx.runMutation(internal.customApps.installExistingUrlApp, {
        name: displayName,
        webUrl: url,
        callerUserId,
        scholarIds: targets.scholarIds,
        groupIds: targets.groupIds,
        allowedScholarIds: opts.allowedScholarIds
          ? [...opts.allowedScholarIds]
          : undefined,
        scholarLensResolved:
          opts.scholarLensResolved === true ||
          opts.allowedScholarIds !== undefined,
        via: opts.via,
      });
      emit({
        toolComplete: {
          name: "install_external_app",
          result: `Installed ${displayName}`,
        },
      });
      return `Installed **${displayName}** (${url}). ${targetSummary(targets)}`;
    },
  });

  // create_custom_app builds BLIND (no render, no console, no snapshot), so an
  // app scholars will use with the tutor must never be born here: the model
  // has to declare the purpose at call time, and the coached case is refused
  // with the route to the sighted Workshop hand-off. Prose guidance alone did
  // not hold (rocket shop, 2026-09-14). TRA-288.
  const coachedPurposeRefusal = (purpose: unknown): string | null => {
    if (purpose === "standalone_tile") return null;
    if (purpose === "coached_activity") {
      return "Not built: this tool builds blind and is for standalone tiles only. For an app scholars will use with the tutor, call make_app_a_coached_activity with appRequest (the teacher's description of the app) and no appName — that drafts the coached activity and hands the build to the Workshop, where the teacher builds it with the tutor and can see it run.";
    }
    return "Say what the app is for: purpose must be \"standalone_tile\" (a tile with no tutor coaching) or \"coached_activity\" (scholars use it with the tutor — then use make_app_a_coached_activity with appRequest instead).";
  };

  const forkActivityTool = betaTool({
    name: "fork_activity",
    description:
      "Copy an existing activity into curriculum owned by the requesting teacher. Pass the activity's name or its Rabbithole curriculum link. The source stays untouched. If it has a vibecode starter app, the fork gets its own teacher-owned copy; resources and process links remain shared references. The result opens the new activity in manual Preflight rehearsal.",
    inputSchema: {
      type: "object" as const,
      properties: {
        activity: {
          type: "string" as const,
          description:
            "The activity title or a Rabbithole curriculum link containing ?activity=<id>.",
        },
      },
      required: ["activity"] as const,
    },
    run: async (input: { activity: string }) => {
      const activityRef = input.activity.trim();
      if (!activityRef) return "Name the activity or paste its curriculum link.";
      const reference = parseActivityReference(activityRef);
      if (reference.kind === "invalid_link") {
        return "That curriculum link does not identify an activity. Copy the activity's full Rabbithole link and try again.";
      }
      let activityId: Id<"activities">;
      if (reference.kind === "link") {
        activityId = reference.activityId;
      } else {
        let hits: Array<{
          kind: "lesson" | "activity";
          activityId?: Id<"activities">;
          activityTitle?: string;
        }>;
        try {
          hits = await ctx.runQuery(
            internal.units.searchCurriculumForAide,
            {
              callerUserId,
              query: reference.value,
              limit: 30,
            },
          );
        } catch (error) {
          return `Could not find the activity: ${error instanceof Error ? error.message : String(error)}`;
        }
        const activities = hits.filter(
          (
            hit,
          ): hit is {
            kind: "activity";
            activityId: Id<"activities">;
            activityTitle: string;
          } =>
            hit.kind === "activity" &&
            hit.activityId !== undefined &&
            hit.activityTitle !== undefined,
        );
        if (activities.length === 0) {
          return `No activity matching "${reference.value}" was found. Paste its curriculum link if the title is different.`;
        }
        const needle = reference.value.trim().toLowerCase();
        const rank = (title: string) => {
          const normalized = title.trim().toLowerCase();
          if (normalized === needle) return 0;
          if (normalized.startsWith(needle)) return 1;
          return 2;
        };
        const bestRank = rank(activities[0]!.activityTitle);
        const best = activities.filter(
          (candidate) => rank(candidate.activityTitle) === bestRank,
        );
        if (best.length > 1) {
          return `More than one activity matches "${reference.value}". Paste the activity's curriculum link so I fork the right one.`;
        }
        activityId = activities[0]!.activityId;
      }
      let result: {
        unitId: Id<"units">;
        unitTitle: string;
        lessonId: Id<"lessons">;
        activityId: Id<"activities">;
        activityTitle: string;
      };
      try {
        result = await ctx.runMutation(
          internal.activities.forkToMyUnitForAide,
          {
            callerUserId,
            activityId,
          },
        );
      } catch (error) {
        return `Could not fork the activity: ${error instanceof Error ? error.message : String(error)}`;
      }
      const rehearsalLink = markdownLink(
        result.activityTitle,
        withBase(
          linkBase,
          activityRehearsalPath(
            result.unitId,
            result.lessonId,
            result.activityId,
          ),
        ),
      );
      emit({
        toolComplete: {
          name: "fork_activity",
          result: `Forked ${result.activityTitle}`,
        },
      });
      return `Forked ${rehearsalLink} into **${result.unitTitle}**. If it has a starter app, the fork gets its own copy; resources and process links remain shared references. Open the link to rehearse it manually.`;
    },
  });

  // ── create_custom_app — a self-contained STATIC HTML app, installed now ────
  const customAppOrigin = appBaseUrl().replace(/\/+$/, "");
  const createCustomAppTool = betaTool({
    name: "create_custom_app",
    description: `STANDALONE TILES ONLY. Do NOT use this for an app scholars will use with the tutor (a coached activity, an assignment, "for my class", "report to the tutor"): you build blind here and cannot see the result — for those, call make_app_a_coached_activity with appRequest instead, which hands the build to the sighted Workshop. This tool creates and INSTANTLY installs a brand-new, self-contained STATIC app as a launcher tile — a tool, reference, or widget that needs NO saved data, NO login, NO coaching, and NO sharing between students (any state can live in memory for the session). Provide the ENTIRE app as a single self-contained HTML string (inline CSS + JS; no external build). It installs immediately at a private ${customAppOrigin}/custom-apps?token=… url — no PR, no waiting. IMPORTANT: it runs sandboxed, so it CANNOT persist data across reloads or connect students to each other — if the teacher needs saved progress, accounts, a database, or a shared/collaborative space, use dispatch_custom_app instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        purpose: {
          type: "string" as const,
          enum: ["standalone_tile", "coached_activity"] as const,
          description:
            "Why this app exists. standalone_tile = a launcher tile a teacher uses on its own, no tutor coaching. coached_activity = scholars will use it with the tutor coaching (an activity/assignment, 'report to the tutor') — this tool REFUSES that case; use make_app_a_coached_activity with appRequest instead.",
        },
        name: {
          type: "string" as const,
          description: "A short display name for the launcher tile.",
        },
        html: {
          type: "string" as const,
          description: `The complete self-contained HTML document for the app (one file: inline <style> and <script>, no external assets or network calls). This is the whole app. Apps built here can later become coached activities the tutor watches, so instrument them:${APP_STATE_RULES}`,
        },
        scholarNames: scholarNamesProp,
        groupNames: groupNamesProp,
      },
      required: ["purpose", "name", "html"] as const,
    },
    run: async (input: {
      purpose?: string;
      name: string;
      html: string;
      scholarNames?: string[];
      groupNames?: string[];
    }) => {
      const refusal = coachedPurposeRefusal(input.purpose);
      if (refusal) return refusal;
      const name = input.name.trim();
      if (!name) return "Give the app a short display name.";
      const html = input.html;
      if (!html || !html.trim())
        return "The app's HTML is empty — generate the full self-contained HTML first, then install it.";
      const bytes = new TextEncoder().encode(html).length;
      if (bytes > MAX_STATIC_HTML_BYTES) {
        return `That HTML is too large (${bytes} bytes; max ${MAX_STATIC_HTML_BYTES}). A static app must be one small self-contained file — trim it, or build it as a coded app with dispatch_custom_app.`;
      }
      const targets = await resolveTargets(
        ctx,
        input.scholarNames,
        input.groupNames,
        opts.allowedScholarIds,
      );
      const ambiguity = ambiguousTargetRefusal(targets);
      if (ambiguity) return ambiguity;
      if (targets.named && targets.resolved.length === 0) {
        const scope = opts.allowedScholarIds && opts.lensLabel
          ? ` in the current institution view (${opts.lensLabel})`
          : "";
        return `Couldn't find anyone matching ${targets.unresolved
          .map((n) => `"${n}"`)
          .join(", ")}${scope}. Check the name(s) and try again.`;
      }
      const token = generateAppToken();
      const result = await ctx.runMutation(internal.customApps.createStaticApp, {
        name,
        html,
        token,
        callerUserId,
        scholarIds: targets.scholarIds,
        groupIds: targets.groupIds,
        allowedScholarIds: opts.allowedScholarIds
          ? [...opts.allowedScholarIds]
          : undefined,
        scholarLensResolved:
          opts.scholarLensResolved === true ||
          opts.allowedScholarIds !== undefined,
        via: opts.via,
      });
      emit({
        toolComplete: {
          name: "create_custom_app",
          result: `Created ${name}`,
        },
      });
      return `Created and installed **${name}** — it's live now at ${result.url}. ${targetSummary(targets)}`;
    },
  });

  // ── update_custom_app — replace a STATIC app's HTML without reinstalling ──
  const updateCustomAppTool = betaTool({
    name: "update_custom_app",
    description:
      "Replace the complete HTML of an existing STATIC custom app while keeping its private URL, launcher tile, status, and scholar/group grants unchanged. Resolve the app by its case-insensitive display name. Use this to revise an app created with create_custom_app instead of creating a duplicate. Coded apps cannot be updated this way.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description:
            "The existing static custom app's display name (case-insensitive exact match).",
        },
        html: {
          type: "string" as const,
          description:
            "The complete replacement self-contained HTML document (one file: inline <style> and <script>, no external assets or network calls).",
        },
      },
      required: ["name", "html"] as const,
    },
    run: async (input: { name: string; html: string }) => {
      const name = input.name.trim();
      if (!name) return "Name the existing static custom app to update.";
      const html = input.html;
      if (!html || !html.trim())
        return "The replacement HTML is empty — generate the full self-contained HTML first.";
      const bytes = new TextEncoder().encode(html).length;
      if (bytes > MAX_STATIC_HTML_BYTES) {
        return `That HTML is too large (${bytes} bytes; max ${MAX_STATIC_HTML_BYTES}). A static app must remain one small self-contained file.`;
      }
      const result = await ctx.runMutation(internal.customApps.updateStaticApp, {
        name,
        html,
        callerUserId,
        allowedScholarIds: opts.allowedScholarIds
          ? [...opts.allowedScholarIds]
          : undefined,
        scholarLensResolved:
          opts.scholarLensResolved === true ||
          opts.allowedScholarIds !== undefined,
      });
      if (result.kind === "not_found") {
        return `No custom app named "${name}" was found. Check the exact app name and try again.`;
      }
      if (result.kind === "ambiguous") {
        return `More than one custom app is named "${name}" (case-insensitive), so nothing was changed. Rename or archive the duplicate before retrying.`;
      }
      if (result.kind === "wrong_kind") {
        return `"${result.name}" is a coded app, not a static app. update_custom_app can only revise apps created with create_custom_app.`;
      }
      emit({
        toolComplete: {
          name: "update_custom_app",
          result: `Updated ${result.name}`,
        },
      });
      return `Updated **${result.name}** in place — its URL and existing installs are unchanged: ${result.url}`;
    },
  });

  const makeAppACoachedActivityTool = betaTool({
    name: "make_app_a_coached_activity",
    description:
      "Set up a coached vibecode activity — the tutor coaches a learning arc around a self-contained app. TWO shapes, pick one: (1) an EXISTING live static app the teacher already made → pass appName; the app is resolved by case-insensitive exact name inside the caller's institution lens, and with a roster it goes live now. (2) a NEW app the teacher wants BUILT FOR scholars to use → pass appRequest (the teacher's description of the app) and NO appName; this drafts the activity and hands off — the teacher builds the first version WITH the tutor in the Workshop, then promotes it with 'Use as activity starter'. Provide exactly ONE of appName / appRequest. During the activity the tutor reads the app's published state from window.rabbithole.setState, so an uninstrumented app gives the tutor nothing to coach on. This creates or reuses a unit, lesson, and activity; with appName + a roster it also creates or reuses an exact-roster assignment and pushes it live now. A roster is NOT allowed with appRequest (nothing is built yet — draft only). Do NOT call create_custom_app to build an app for scholars to USE with the tutor; use appRequest here instead. Reserve create_custom_app for a standalone app the teacher wants installed as a tile with no coaching, and create_scholar_activity with kind 'vibecode' for when scholars build the app themselves. ALWAYS settle scholarEdit (play vs build) before calling — from the request when it says so, otherwise by asking the teacher one short question first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: {
          type: "string" as const,
          description:
            "The existing live static custom app's display name (case-insensitive exact match). Provide this OR appRequest, not both.",
        },
        appRequest: {
          type: "string" as const,
          description:
            "The teacher's description of the app to build, verbatim or lightly cleaned. Used when no existing app is named: the teacher builds it with the tutor in the Workshop.",
        },
        title: {
          type: "string" as const,
          description:
            "Optional scholar-facing activity title. Defaults to the app name.",
        },
        unitTitle: {
          type: "string" as const,
          description:
            "Optional unit title. Defaults to '<app name> Lab' (or the app name itself when it already ends in Lab). Reuses a same-title unit already authored by this teacher.",
        },
        lessonTitle: {
          type: "string" as const,
          description:
            "Optional lesson title. Defaults to 'Explore <app name>'. Reuses a same-title lesson in the unit.",
        },
        buildBrief: {
          type: "string" as const,
          description: VIBECODE_BUILD_BRIEF_DESCRIPTION,
        },
        groupName: {
          type: "string" as const,
          description:
            "Name of one scholar group (case-insensitive exact or unique partial match). Mutually exclusive with scholarNames.",
        },
        scholarNames: {
          type: "array" as const,
          items: { type: "string" as const },
          description:
            "Individual scholar names to receive the activity. Mutually exclusive with groupName.",
        },
        mode: {
          type: "string" as const,
          enum: ["classFocus", "homework"] as const,
          description:
            "classFocus = live in-the-room focus; homework = live on their plate. Defaults to classFocus.",
        },
        tutorModel: tutorModelSchemaFragment(),
        buildContract: buildContractSchemaFragment(),
        allowSilence: allowSilenceSchemaFragment(),
        scholarEdit: scholarEditSchemaFragment(
          "Here the teacher made (or is making) the app, so when the teacher doesn't say and doesn't answer, it defaults to `play` on a new activity; a reused activity keeps its setting unless you pass one.",
        ),
      },
      required: ["buildBrief"] as const,
    },
    run: async (input: {
      appName?: string;
      appRequest?: string;
      title?: string;
      unitTitle?: string;
      lessonTitle?: string;
      buildBrief: string;
      groupName?: string;
      scholarNames?: string[];
      mode?: "classFocus" | "homework";
      tutorModel?: "sonnet" | "fable";
      buildContract?: unknown;
      allowSilence?: boolean;
      scholarEdit?: string;
    }) => {
      // Validate the model contract and the edit policy BEFORE any
      // unit/lesson is created, so a malformed arg can't leave a half-built
      // activity behind.
      let buildContract: BuildContract | undefined;
      let requestedEditAccess: EditAccess | undefined;
      try {
        const raw = parseBuildContractArg(input.buildContract);
        buildContract = raw ? normalizeBuildContract(raw) : undefined;
        requestedEditAccess = scholarEditToEditAccess(input.scholarEdit);
      } catch (error) {
        return `Not created: ${error instanceof Error ? error.message : String(error)}`;
      }
      const appName = input.appName?.trim() || "";
      const appRequest = input.appRequest?.trim() || "";
      const buildBrief = input.buildBrief.trim();
      if (!buildBrief) {
        return "Provide the learning-arc buildBrief for the tutor to coach.";
      }
      if (!appName && !appRequest) {
        return "Name an existing app (appName) to coach on, OR describe the app to build (appRequest) for a Workshop hand-off. Exactly one is required.";
      }
      // appName XOR appRequest — enforced before any cohort/app resolution so a
      // both-present call can never send a named app live while also requesting
      // a build.
      if (appName && appRequest) {
        return "Give either appName or appRequest, not both.";
      }
      // No appName → hand off: draft the activity carrying the request; the
      // teacher builds the first version with the tutor in the Workshop.
      const isBuildHandoff = !appName;

      const hasRoster =
        (input.groupName != null && input.groupName.trim() !== "") ||
        (Array.isArray(input.scholarNames) && input.scholarNames.length > 0);
      if (isBuildHandoff && hasRoster) {
        return "There's nothing to send yet — this drafts an app for you to build with the tutor in the Workshop first. Leave the group/scholar names off; once you've built it and used 'Use as activity starter', tell me a group and I'll send it.";
      }
      const cohort = hasRoster ? await resolveCohort(input) : null;
      if (cohort && !cohort.ok) return cohort.message;

      let app: Extract<CoachedAppResolution, { kind: "resolved" }> | null =
        null;
      if (!isBuildHandoff) {
        let resolved: CoachedAppResolution;
        try {
          resolved = await ctx.runQuery(
            internal.customApps.resolveStaticAppForCoachedActivity,
            {
              name: appName,
              callerUserId,
              allowedScholarIds: opts.allowedScholarIds
                ? [...opts.allowedScholarIds]
                : undefined,
              scholarLensResolved:
                opts.scholarLensResolved === true ||
                opts.allowedScholarIds !== undefined,
            },
          );
        } catch (error) {
          return `Could not resolve the custom app: ${error instanceof Error ? error.message : String(error)}`;
        }
        if (resolved.kind === "not_found") {
          return `No custom app named "${appName}" was found in the current institution view. Check the exact app name and try again.`;
        }
        if (resolved.kind === "ambiguous") {
          return `More than one custom app is named "${appName}" (case-insensitive), so no activity was created. Rename or archive the duplicate before retrying.`;
        }
        if (resolved.kind === "wrong_kind") {
          return `"${resolved.name}" is a coded app, not a static app. Only a live static app can become a coached starter activity.`;
        }
        if (resolved.kind === "not_live") {
          return `"${resolved.name}" is ${resolved.status}, not live. Restore or rebuild it before creating a coached activity.`;
        }
        if (resolved.kind === "missing_html") {
          return `"${resolved.name}" has no usable HTML, so it cannot become a coached starter activity.`;
        }
        app = resolved;
      }

      // The naming base: an existing app's name, else the activity/build title.
      const activityTitle =
        input.title?.trim() || (app ? app.name : "New app");
      const baseName = app ? app.name : activityTitle;
      // Avoid "F = ma Lab Lab": only suffix when the base does not already end in Lab.
      const unitTitle =
        input.unitTitle?.trim() ||
        (/\blab$/i.test(baseName.trim()) ? baseName.trim() : `${baseName} Lab`);
      const lessonTitle =
        input.lessonTitle?.trim() ||
        (app ? `Explore ${baseName}` : `Build ${baseName}`);
      const mode = input.mode ?? "classFocus";
      const tutorModel = input.tutorModel;
      const appLink = app ? markdownLink(app.name, app.url) : "";
      const appSuffix = app ? ` ${appLink} is unchanged.` : "";

      let unit: {
        unitId: Id<"units">;
        existed: boolean;
      };
      try {
        unit = await ctx.runMutation(
          internal.teacherAide.createCurriculumUnit,
          {
            authorId: callerUserId,
            title: unitTitle,
          },
        );
      } catch (error) {
        return `Could not create or reuse the unit for ${appLink || "the coached activity"}: ${error instanceof Error ? error.message : String(error)}. No lesson, activity, or assignment was created.`;
      }
      const unitLink = markdownLink(
        unitTitle,
        withBase(linkBase, unitPath(unit.unitId)),
      );

      let lesson: {
        lessonId: Id<"lessons">;
        existed: boolean;
      };
      try {
        lesson = await ctx.runMutation(
          internal.teacherAide.createScholarLesson,
          {
            unitId: unit.unitId,
            title: lessonTitle,
          },
        );
      } catch (error) {
        return `PARTIAL: ${unitLink} exists (${unit.existed ? "reused" : "new"}), but the lesson could not be created or reused: ${error instanceof Error ? error.message : String(error)}. No activity or assignment was created;${appSuffix}`;
      }
      const lessonLink = markdownLink(
        lessonTitle,
        withBase(
          linkBase,
          unitPath(unit.unitId, { lessonId: lesson.lessonId }),
        ),
      );

      const existingActivities = await ctx.runQuery(
        internal.activities.listByLessonInternal,
        { lessonId: lesson.lessonId },
      );
      const existingActivity = existingActivities.find(
        (candidate) =>
          candidate.title.trim().toLowerCase() ===
          activityTitle.trim().toLowerCase(),
      );
      if (existingActivity && !isAppActivity(existingActivity)) {
        const existingActivityLink = markdownLink(
          existingActivity.title,
          withBase(
            linkBase,
            unitPath(unit.unitId, {
              lessonId: lesson.lessonId,
              activityId: existingActivity._id,
            }),
          ),
        );
        return `PARTIAL: ${unitLink} and ${lessonLink} exist, but ${existingActivityLink} already exists and is not an app activity, so it was left unchanged and no assignment was created. Choose a different activity title;${appSuffix}`;
      }

      // Build hand-off reuse safety: a same-title app activity may only be
      // reused when it is a PLAIN DRAFT — no starter, no scholarsStartFrom, and
      // not referenced by any assignment. Otherwise it is already built and/or
      // live to scholars; rewriting its brief/appRequest under a repeated or
      // default title would silently mutate live work, so refuse and write
      // nothing.
      if (isBuildHandoff && existingActivity) {
        const referencedByAssignment = await ctx.runQuery(
          internal.assignments.anyAssignmentReferencesActivityInternal,
          { activityId: existingActivity._id },
        );
        const isPlainDraft =
          existingActivity.starterAppId == null &&
          existingActivity.scholarsStartFrom == null &&
          !referencedByAssignment;
        if (!isPlainDraft) {
          const existingActivityLink = markdownLink(
            existingActivity.title,
            withBase(
              linkBase,
              unitPath(unit.unitId, {
                lessonId: lesson.lessonId,
                activityId: existingActivity._id,
              }),
            ),
          );
          return `PARTIAL: ${unitLink} and ${lessonLink} exist, but ${existingActivityLink} already has a starter or is live to scholars, so I left it untouched and drafted nothing. Give this build a different activity title.`;
        }
      }

      let activity: {
        activityId: Id<"activities">;
        existed: boolean;
        kind: string;
      };
      // Existing app → seed scholars from it. Build hand-off → no starter yet;
      // carry the teacher's request in the dedicated (never-scholar-facing)
      // appRequest field so the Workshop build session can build the first
      // version from it without the request ever leaking into a scholar prompt.
      const starterOrRequest = app
        ? {
            starterAppId: app.customAppId,
            scholarsStartFrom: "starter" as const,
          }
        : { appRequest };
      // A teacher-made app handed to scholars is a game to PLAY unless the
      // teacher said otherwise (TRA-477): the row's absent default ("always")
      // would let every scholar remix it. Only a NEW activity takes the
      // default — a reused one keeps whatever the teacher set since.
      const editAccess =
        requestedEditAccess ??
        (existingActivity ? undefined : ("never" as const));
      try {
        activity = await ctx.runMutation(
          internal.teacherAide.createScholarActivity,
          {
            lessonId: lesson.lessonId,
            title: activityTitle,
            kind: "vibecode",
            systemPrompt: buildBrief,
            ...starterOrRequest,
            tutorModel,
            buildContract,
            allowSilence: input.allowSilence === true ? true : undefined,
            editAccess,
          },
        );
      } catch (error) {
        return `PARTIAL: ${unitLink} and ${lessonLink} exist, but the coached activity could not be created or reused: ${error instanceof Error ? error.message : String(error)}. No assignment was created;${appSuffix}`;
      }
      const activityLink = markdownLink(
        activityTitle,
        withBase(
          linkBase,
          unitPath(unit.unitId, {
            lessonId: lesson.lessonId,
            activityId: activity.activityId,
          }),
        ),
      );
      // `kind` comes back effective ("vibecode" for either app shape).
      if (!isAppActivity({ kind: activity.kind })) {
        return `PARTIAL: ${activityLink} is not an app activity, so no assignment was created.${appSuffix} Choose a different activity title.`;
      }

      if (isBuildHandoff) {
        const rehearsalLink = markdownLink(
          activityTitle,
          withBase(
            linkBase,
            activityRehearsalPath(
              unit.unitId,
              lesson.lessonId,
              activity.activityId,
            ),
          ),
        );
        emit({
          toolComplete: {
            name: "make_app_a_coached_activity",
            result: `${activityTitle} drafted for building`,
          },
        });
        return `${activity.existed ? "Reused" : "Created"} ${rehearsalLink}. Open it and the tutor builds the first version with you in the Workshop; when it looks right, use 'Use as activity starter', then tell me a group and I'll send it.`;
      }

      if (!cohort) {
        const rehearsalLink = markdownLink(
          activityTitle,
          withBase(
            linkBase,
            activityRehearsalPath(
              unit.unitId,
              lesson.lessonId,
              activity.activityId,
            ),
          ),
        );
        emit({
          toolComplete: {
            name: "make_app_a_coached_activity",
            result: `${activityTitle} created, not sent`,
          },
        });
        return `${activity.existed ? "Reused" : "Created"} coached activity ${rehearsalLink} from ${appLink}. Nothing was sent to scholars. Open that link and you land in the Workshop with the tutor; when ready, tell me a group or scholar names and I'll send it.`;
      }

      const assignment = await assignAndPushActivityNow(ctx, {
        callerUserId,
        unitId: unit.unitId,
        activityId: activity.activityId,
        scholarIds: cohort.ids,
        mode,
      });
      if (assignment.status === "assign_failed") {
        return `PARTIAL: ${unitLink}, ${lessonLink}, and ${activityLink} exist (${activity.existed ? "reused" : "new"} activity) from ${appLink}, but no assignment was created: ${assignment.error}`;
      }
      const assignmentLink = markdownLink(
        "assignment",
        withBase(linkBase, assignmentPath(assignment.assignmentId)),
      );
      if (assignment.status === "push_failed") {
        return `PARTIAL: ${activityLink} exists and the ${assignmentLink} exists (${assignment.created ? "new" : "reused"}) with the activity PLANNED, but the live push failed: ${assignment.error}. Scholars do NOT see it yet — retry with push_activity_now on that assignment, and tell the teacher exactly this state. ${appLink} is unchanged.`;
      }

      emit({
        toolComplete: {
          name: "make_app_a_coached_activity",
          result: `${activityTitle} live (${mode}) for ${cohort.ids.length} scholar${cohort.ids.length === 1 ? "" : "s"}`,
        },
      });
      return `${activity.existed ? "Reused" : "Created"} coached activity ${activityLink} from ${appLink} and sent it live as the ${assignmentLink} to ${cohort.audienceLabel} (${mode}).`;
    },
  });

  return [
    installExternalAppTool,
    createCustomAppTool,
    updateCustomAppTool,
    forkActivityTool,
    makeAppACoachedActivityTool,
  ];
}


/** The system-prompt section that teaches the model the custom-app paths and
 * how to choose between them. Injected wherever the tools are (see
 * convex/http.ts and convex/slackBot.ts), gated by the same staff-role check
 * makeCustomAppTools uses. */
export const CUSTOM_APPS_SYSTEM_PROMPT_SECTION = `
## Installing an app for a student

When a teacher asks you to "install an app" (or "add an app", "put an app on their iPad / home screen", "give them a tool for X") for a scholar or group, first work out which of two things they mean, then act:

1. **An existing website or app** — they give, paste, or clearly reference a URL. Call \`install_external_app\` with that URL. It becomes a launcher tile that opens the site in the locked in-app webview.

2. **A new self-contained app the teacher will use on their own** (a tool, reference, or widget as a tile — no tutor coaching, no scholars using it in an activity) with no saved data, login, or shared state. Create it as one self-contained HTML file with inline CSS and JavaScript, then call \`create_custom_app\` with purpose "standalone_tile". If scholars will use the app with the tutor, this is NOT the path — see "Building an app FOR scholars" below.

**Choosing:** a URL → case 1. Otherwise use case 2 only when the app can be fully self-contained.

**Naming the students:** for all three, pass \`scholarNames\` and/or \`groupNames\` so the app actually lands on the right iPads. You can create an app with no targets to preview it, but say so — nobody receives it until it's installed for someone.

**Editing an existing static app:** when the teacher asks to revise an app previously made with \`create_custom_app\`, generate the complete replacement HTML and call \`update_custom_app\` with its existing name. Update it in place rather than creating a duplicate; its private URL and installs stay unchanged.

**Coaching with an existing app:** when the teacher wants kids to USE a live static app with the tutor coaching the learning arc, call \`make_app_a_coached_activity\` with \`appName\`; omit the roster to create a draft for manual rehearsal without sending it, or include a group/scholar roster to send it live.

**Building an app FOR scholars to use (hand off to the Workshop):** when the teacher asks you to BUILD an app for their scholars to use with the tutor, do NOT call \`create_custom_app\` — YOU are a blind builder and can't see what you make. Instead call \`make_app_a_coached_activity\` with \`appRequest\` (the teacher's description of the app) and NO \`appName\`. That drafts the coached activity, carries the request into a teacher build session, and hands back one link: the teacher builds the first version WITH the tutor in the sighted Workshop, then promotes it with 'Use as activity starter'. Do NOT pass a roster — nothing is built yet. Once the teacher has built and promoted it, they'll ask you to send it to a group. Reserve \`create_custom_app\` for a standalone app the teacher explicitly wants installed as a tile with NO coaching, and \`create_scholar_activity\` with kind \`vibecode\` for when kids BUILD the app themselves.

**Play or build — settle it before you create.** Every coached app activity has a scholar edit policy (\`scholarEdit\`): \`play\` (scholars only use the app — no Edit control), \`build\` (scholars remix it / make their own), or \`afterCompletion\` (play first; Edit unlocks when they finish). When you hand an EXISTING app to scholars (\`appName\`) or set up an app FOR scholars to use (\`appRequest\`), decide it from the request: homework, practice, "just play", "a game for them to play", "the game is the main activity" → \`play\`; "they build / remix / vibecode / make their own" → \`build\` — set it without asking. When it is genuinely unclear, ASK the teacher one short question before creating ("Should scholars just play it, or be able to change it?") rather than defaulting silently. If the teacher doesn't answer, a teacher-built app is \`play\`; scholars building their own (\`create_scholar_activity\` with kind \`vibecode\` and no starter) is \`build\`. This is a real fork in what the activity IS, so it is a fair question — unlike translate-vs-park below, which you never ask.

**Every vibecode activity gets a model contract.** Whenever you call \`make_app_a_coached_activity\` or \`create_scholar_activity\` with kind \`vibecode\`, write a \`buildContract\` in addition to the build brief, and set \`allowSilence: true\` with it: 2–3 \`invariants\` (what the app must be TRUE about, as testable mechanics — a cause and the effect you could check by running it — never topics), \`freedoms\` (what the scholar owns: setting, characters, genre, visuals, side quests — anything that doesn't break an invariant), and ONE \`gate\` (what must exist and have been run once before cosmetics; usually the core model, run once without the intervention). Derive it from the teacher's goal yourself. Do NOT ask the teacher whether off-topic scholar ideas should be translated, parked, or allowed — the designer translates them into the subject by default and parks the rest for free play.

`;

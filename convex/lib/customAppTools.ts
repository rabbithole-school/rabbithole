// Bot tools — "install an app for a student." The teacher-facing aide (in-app
// Curriculum Assistant, the Slack bot, and the OAuth MCP connector) shares this
// one toolset so "install X for the Seals" works through ANY bot. Four tools,
// covering each shape a teacher can mean plus editing a static app (see the
// prompt section below):
//
//   install_external_app  — the teacher gave a URL for a REAL website → make it
//                            a launcher tile now (convex/customApps.ts
//                            installExistingUrlApp). No custom-app row.
//   create_custom_app     — the bot vibecoded a self-contained STATIC HTML app
//                            → store it, mint a token, install INSTANTLY at the
//                            /custom-apps?token=… url (createStaticApp). No PR.
//   update_custom_app     — replace a STATIC app's HTML in place, preserving
//                            its token, launcher URL, status, and grants.
//
// Like the other write toolsets, every tool resolves scholar/group NAMES to ids
// locally and calls internal mutations with an explicit callerUserId (the bot
// acts on behalf of the mapped user). Installing an app FOR a scholar is a
// teaching action, so it's gated by teacher role (teacher / school- or
// platform-admin) — not the curriculum_designer / operations staff, who have no
// scholar-facing writes. Callers spread the result unconditionally (returns []
// for a non-teaching caller).

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isTeacherRole, type Role } from "./roles";
import type { AideEmit } from "./aideStream";
import { matchScholarByName } from "./scholarReadTools";
import { markdownLink } from "./channels";
import {
  generateAppToken,
  MAX_STATIC_HTML_BYTES,
} from "../customApps";
import { appBaseUrl } from "./deploymentConfig";

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
    allowedScholarIds?: Set<Id<"users">>;
    lensLabel?: string | null;
    /** Whether the caller actually RESOLVED an institution scholar lens.
     * Threaded to the install mutations so their guard can fail closed on a
     * caller that never considered one (vs. a platform admin who resolved an
     * unrestricted lens); see customApps.assertTargetsWithinLens. */
    scholarLensResolved?: boolean;
  },
) {
  if (!isTeacherRole(opts.role)) return [];

  const { callerUserId, sessionId } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
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

  // ── create_custom_app — a self-contained STATIC HTML app, installed now ────
  const customAppOrigin = appBaseUrl().replace(/\/+$/, "");
  const createCustomAppTool = betaTool({
    name: "create_custom_app",
    description: `Create and INSTANTLY install a brand-new, self-contained STATIC app you vibecode yourself — a tool, game, visualizer, reference, or widget that needs NO saved data, NO login, and NO sharing between students (any state can live in memory for the session). Provide the ENTIRE app as a single self-contained HTML string (inline CSS + JS; no external build). It installs immediately at a private ${customAppOrigin}/custom-apps?token=… url — no PR, no waiting. IMPORTANT: it runs sandboxed, so it CANNOT persist data across reloads or connect students to each other — if the teacher needs saved progress, accounts, a database, or a shared/collaborative space, use dispatch_custom_app instead.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "A short display name for the launcher tile.",
        },
        html: {
          type: "string" as const,
          description:
            "The complete self-contained HTML document for the app (one file: inline <style> and <script>, no external assets or network calls). This is the whole app.",
        },
        scholarNames: scholarNamesProp,
        groupNames: groupNamesProp,
      },
      required: ["name", "html"] as const,
    },
    run: async (input: {
      name: string;
      html: string;
      scholarNames?: string[];
      groupNames?: string[];
    }) => {
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

  return [installExternalAppTool, createCustomAppTool, updateCustomAppTool];
}


/** The system-prompt section that teaches the model the custom-app paths and
 * how to choose between them. Injected wherever the tools are (see
 * convex/http.ts and convex/slackBot.ts), gated by the same staff-role check
 * makeCustomAppTools uses. */
export const CUSTOM_APPS_SYSTEM_PROMPT_SECTION = `
## Installing an app for a student

When a teacher asks you to "install an app" (or "add an app", "put an app on their iPad / home screen", "give them a tool for X") for a scholar or group, first work out which of two things they mean, then act:

1. **An existing website or app** — they give, paste, or clearly reference a URL. Call \`install_external_app\` with that URL. It becomes a launcher tile that opens the site in the locked in-app webview.

2. **A new self-contained app** — a tool, game, visualizer, reference, or widget with no saved data, login, or shared state. Create it as one self-contained HTML file with inline CSS and JavaScript, then call \`create_custom_app\`.

**Choosing:** a URL → case 1. Otherwise use case 2 only when the app can be fully self-contained.

**Naming the students:** for all three, pass \`scholarNames\` and/or \`groupNames\` so the app actually lands on the right iPads. You can create an app with no targets to preview it, but say so — nobody receives it until it's installed for someone.

**Editing an existing static app:** when the teacher asks to revise an app previously made with \`create_custom_app\`, generate the complete replacement HTML and call \`update_custom_app\` with its existing name. Update it in place rather than creating a duplicate; its private URL and installs stay unchanged.

`;

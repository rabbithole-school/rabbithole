// External-Apps aide tools — the chat/voice transport over the same
// externalApps / appAudiences / scholarApps core that backs the web Apps tab
// and Manage-access drawer. Lets staff ADD + CONFIGURE launchable web apps and
// GRANT/REVOKE who can use them (whole scholarGroups, whole institutions, or a
// single scholar) entirely by chatting — on the in-app aide AND Slack (both
// resolve through assembleCurriculumTools, so this one file covers both).
//
// The bot works by NAME: apps, groups, institutions, and scholars are named in
// chat and resolved to ids SERVER-SIDE inside verified internal.* aide* fns
// (which re-check the caller is a scholar-admin — teacher/admin/operations staff —
// since these run in an ActionCtx with no ctx.user). A missing/ambiguous name
// returns a helpful error listing candidates so the model can disambiguate.
//
// Gated to scholar-admin here (returns [] otherwise) so callers spread the
// result unconditionally; the internal wrappers enforce the same gate.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isScholarAdminRole, type Role } from "./roles";
import {
  INCLUDE_EXTENDED_EDUCATION_PROP,
  applyParticipationDefault,
  extendedEducationOmittedNote,
} from "./scholarParticipationTooling";
import type { AideEmit } from "./aideStream";
// Type-only (erased at compile — no runtime @anthropic-ai/sdk static import, same
// as aideTools.ts): the widened element type every betaTool() collapses to, so
// spreading these 12 tools into the big aideTools return array contributes ONE
// element type instead of 12 (otherwise the inferred union overflows TS2590).
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

/**
 * Strip every submitted secret out of a message before it goes back to the
 * model (and from there into the transcript). Exact-substring replacement:
 * a short secret may over-redact unrelated text, which is the right failure.
 */
export function redactSecrets(
  message: string,
  secrets: readonly (string | undefined)[],
): string {
  let out = message;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

/**
 * Who gets the External-Apps tools: the same audience as the underlying
 * scholarAdminMutation gate on these mutations — teacher / school_admin /
 * platform_admin, or a staffer holding school-operations access. Shared with
 * the audit-log reader (lib/auditLogTools.ts), which is exposed exactly where
 * `get_external_app_access` is.
 */
export function canUseExternalAppsTools(opts: {
  role: Role | null | undefined;
  hasSchoolOperationsAccess?: boolean;
}): boolean {
  return (
    isScholarAdminRole(opts.role) ||
    (opts.role === "staff" && !!opts.hasSchoolOperationsAccess)
  );
}

export async function makeExternalAppsTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    hasSchoolOperationsAccess?: boolean;
    surface?: "private" | "channel";
    via?: "aide" | "slack";
  },
): Promise<BetaRunnableTool[]> {
  if (!canUseExternalAppsTools(opts)) return [];
  const { callerUserId } = opts;
  const via = opts.via ?? "aide";
  // Fail CLOSED, like the password/passkey resets in scholarWriteTools: a
  // caller that never says which surface it is on (the MCP connector, whose
  // service accounts can be one identity shared by a whole Claude-in-Slack
  // channel) gets no credential-bearing tool. `!== "channel"` shipped first
  // and handed exactly that caller the tool.
  const isPrivate = opts.surface === "private";

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const listAppsTool = betaTool({
    name: "list_external_apps",
    description:
      "List the org's External Apps (the launchable web-app tiles scholars open from their home screen) with a WHO-CAN-USE-IT summary for each: name, URL, appKind (web website / custom Rabbithole app / native iPad app), whether it's a default for new scholars, its credential source, whether it's archived, and how many audiences (groups/schools) + individual scholars it's granted to. Group/school memberCount and directScholarCount are complete counts (they include Extended Education scholars). Call this first to see what exists before creating/updating or granting. Includes archived apps (flagged) so you can un-archive one.",
    inputSchema: { type: "object" as const, properties: {}, required: [] as const },
    run: async () => {
      let rows;
      try {
        rows = await ctx.runQuery(internal.appAudiences.aideListApps, {
          callerUserId,
        });
      } catch (e) {
        return `Could not list external apps: ${errMsg(e)}`;
      }
      const apps = rows.map((r) => ({
        name: r.name,
        webUrl: r.webUrl,
        // web website / Rabbithole custom app / native iPad app — the one
        // canonical KIND signal (shared/appKind.ts), so the aide can answer
        // "which apps are native iPad apps" instead of re-parsing the URL.
        appKind: r.appKind,
        defaultForNewScholars: r.defaultForNewScholars,
        credentialSource: r.credentialSource,
        archived: r.archived,
        audiences: r.audiences.map((a) => ({
          kind: a.audienceKind,
          name: a.label,
          memberCount: a.memberCount,
          enabled: a.enabled,
        })),
        directScholarCount: r.directScholarCount,
      }));
      emit({
        toolComplete: {
          name: "list_external_apps",
          result: `${apps.length} external app(s)`,
        },
      });
      return JSON.stringify({ apps });
    },
  });

  const getAccessTool = betaTool({
    name: "get_external_app_access",
    description:
      "For ONE External App (named), show who can use it. An app reaches a scholar by THREE independent routes and this returns all three, so read all three before drawing any conclusion:\n" +
      "1. STANDING grants, which have NO clock and apply around the clock: `groups` (scholar groups), `institutions` (whole schools, each with a live member count + whether the grant is enabled), and `scholars` (individuals granted it directly).\n" +
      "2. `blockScoped` — schedule placements that grant the app only during a class block, with the day, the block, and the exact window including the lead-in before the bell and the grace after it. This is the PREFERRED way to grant a class app (see place_class).\n" +
      "3. `pushes` — the pushes themselves: a block placement's window (`source: \"schedule\"`) or a teacher pushing the app to a class (`source: \"teacher\"`), each with who it covers (`group`), its window in school-local time, and `live` saying whether it is putting the app on scholars' tiles at this instant (the tiles' own rule, so an archived app is never live). A live push has `liveUntilLocal`, normally the end of its window, when a scheduled clear retires it. `overrun: true` means that window has already ended but nothing has cleared the push yet, so it is still on scholars' tiles: a clear normally lands within minutes, and `liveUntilLocal` is then midnight, the latest it can last. Every live push is listed; one that is not live is listed only when its window is within ±2 hours of now (e.g. about to open). For a push to a list of scholars or to an assignment's roster, `group` is only a COUNT (e.g. \"3 scholars\"): it does not say who, so it cannot tell you whether a particular scholar is covered.\n" +
      "CRITICAL: empty `groups`/`institutions`/`scholars` does NOT mean nobody can use the app. A block-scoped app has zero standing grants BY DESIGN. Never report an app as ungranted, broken, or accidentally revoked on the strength of those three being empty — check `blockScoped` and `pushes` first, and check `recentGrantChanges` (recent grant edits for this app, with who and via which surface) before suggesting a grant was lost.\n" +
      "ONE SCHOLAR: to answer \"can this scholar open it?\", pass `scholar` instead of working it out from the lists above. The result then also has `forScholar`, with `summary`, a sentence to relay:\n" +
      "- `canOpen`: right now, by the same rule as that scholar's own tile and launch checks.\n" +
      "- `via`: every route that lets them, each with a `name` to say and its `route` kind: `direct` (their own app row: added for them, or one of the default apps every new scholar gets), `group grant`, `school grant`, `schedule push` or `teacher push`.\n" +
      "- `untilLocal`: null when nothing ends the access on a clock (a direct row or a grant lasts until someone removes it). For a push it is the EXPECTED end, the close of its window, when a scheduled clear retires it. That is not guaranteed: if the clear is late, the push stays on the scholar's tile past its window, and a later call shows `overrun: true` with midnight, the latest it can last.\n" +
      "- When `canOpen` is false: `whyNot` (`no-route`: nothing opens it for them at this moment; or `archived`), and `when`, which states rows that already exist and never forecasts:\n" +
      "  - `when.opens`: pushes already planned for them, soonest first, each with `atLocal`. These are the scheduler's (or a teacher's) own rows, so they are the ONLY authority on when the app opens. The scheduler plans only about a week ahead, so the soonest is the soonest ALREADY PLANNED; do not call it the next opening.\n" +
      "  - `when.wrappedToday`: today's sessions covering them that a teacher wrapped up (`opened: true`) or called off before they opened (`opened: false`). A deleted class, or a class whose app was removed, is not listed here, and a session a newer push covers again is not either.\n" +
      "  - `when.scheduled`: CONFIGURATION, not a promise. These are the class placements for a group they are in, each with its window, its term (`termStatus` current, ended or upcoming, with dates) and, for a one-week placement, `weekOver`. Whether and when a placement opens the app is the scheduler's decision: it opens nothing outside the placement's term, after a teacher's wrap-up or on a no-school day. Never say a placement \"will open\" the app; say it is scheduled, and take the time from `when.opens`.\n" +
      "  - All three empty means no class they are in is on their school's schedule for the app and nothing is planned; say so plainly. `scheduled` covers only their own school's terms. It does not mean anything is broken, and a block-scoped app is not missing a grant.\n" +
      "A group you cannot see (another school's, or a legacy group whose roster reaches beyond your scholars) still counts toward `canOpen` but is never named (\"a group not visible to you\"). A scholar outside your school is an error, exactly as if no scholar had that name.\n" +
      "The individual-scholar list defaults to enrolled scholars only; group/school member counts are complete (they include Extended Education scholars). The app name is resolved server-side; an unknown or ambiguous name returns a helpful error listing candidates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: {
          type: "string" as const,
          description: "The External App's name (e.g. 'Acme Practice').",
        },
        scholar: {
          type: "string" as const,
          description:
            "Optional: ONE scholar's name or (preferably) exact username, to ask whether THEY can open the app right now, through what, and until when (adds `forScholar`).",
        },
        ...INCLUDE_EXTENDED_EDUCATION_PROP,
      },
      required: ["appName"] as const,
    },
    run: async (input: {
      appName: string;
      scholar?: string;
      includeExtendedEducation?: boolean;
    }) => {
      const scholar = input.scholar?.trim() || undefined;
      // The SERVER's clock (this runs in an action), exact: the one instant
      // the query judges every push at, and the named scholar's answer too, so
      // the two halves of the answer cannot disagree about a push that ended
      // seconds ago. A one-shot call from an action has no subscription, so
      // no minute bucket is needed to keep it fresh.
      const now = Date.now();
      let access;
      try {
        access = await ctx.runQuery(internal.appAudiences.aideGetAppAccess, {
          callerUserId,
          appName: input.appName,
          now,
          ...(scholar ? { scholar } : {}),
        });
      } catch (e) {
        return `Could not read access: ${errMsg(e)}`;
      }
      // Direct-scholar rows arrive tagged (coreGetAppAccess); the enumeration
      // defaults to enrolled scholars only, with the explicit model opt-in
      // (scholarParticipationTooling.ts). Group/school member COUNTS are
      // factual group sizes and are never filtered.
      const { rows: scholars, extendedEducationOmitted } =
        applyParticipationDefault(
          access.scholars,
          input.includeExtendedEducation === true,
        );
      const note = extendedEducationOmittedNote(extendedEducationOmitted);
      // This one line is what a human reads in Slack. Its previous form —
      // "Scratch: 0 group(s), 0 school(s), 0 scholar(s)" — is literally the
      // sentence that convinced two people a working app was broken, so it
      // carries the block-scoped half and every live push too (a teacher's
      // push has no block to hang off), and says "standing" out loud so the
      // zeros cannot be read as "no access".
      const blockText = access.blockScoped.length
        ? `${access.blockScoped.length} block-scoped (${access.blockScoped
            .map((b) => `${b.group} ${b.block} ${b.day} ${b.windowLocal}`)
            .join(", ")})`
        : "";
      const live = access.pushes.filter((p) => p.live);
      const liveText = live.length
        ? `LIVE now for ${live
            .map((p) =>
              !p.liveUntilLocal
                ? p.group
                : p.overrun
                  ? `${p.group} until ${p.liveUntilLocal} at the latest (window over, not cleared yet)`
                  : `${p.group} until ${p.liveUntilLocal}`,
            )
            .join(", ")}`
        : "";
      const appWideLine = `${access.app.name}: standing — ${access.groups.length} group(s), ${access.institutions.length} school(s), ${scholars.length} scholar(s)${
        blockText ? `; ${blockText}` : ""
      }${liveText ? `; ${liveText}` : ""}`;
      // Asked about one scholar, the line leads with their answer and keeps
      // the app-wide clocked parts, including pushes about to open, so a
      // "can't open right now" never stands alone the way the 2026-09-21
      // zeros did. (An archived app opens for no one, so nothing is pending.)
      const pending = access.app.archived
        ? []
        : access.pushes.filter((p) => !p.live && p.startsAt > now);
      const pendingText = pending.length
        ? `not open yet for ${pending.map((p) => `${p.group} ${p.windowLocal}`).join(", ")}`
        : "";
      const appWide = [blockText, liveText, pendingText].filter(Boolean);
      emit({
        toolComplete: {
          name: "get_external_app_access",
          result: access.forScholar
            ? `${access.forScholar.summary}${
                appWide.length ? ` App-wide: ${appWide.join("; ")}.` : ""
              }`
            : appWideLine,
        },
      });
      return JSON.stringify({
        ...access,
        scholars,
        ...(note ? { note } : {}),
      });
    },
  });

  const createAppTool = betaTool({
    name: "create_external_app",
    description:
      "Add an External App to the CATALOG without giving it to anyone — a launchable web-app tile. PREFER `install_external_app` when the teacher wants an app for specific scholars or groups: it creates the tile AND grants it in one step. Reach for THIS tool when the catalog entry is the point: adding an app to have on the shelf, or setting configuration `install_external_app` can't — an icon URL, a tile color (hex), default-for-new-scholars, the credential source ('scholarApp' = each scholar's own per-app login [default]; 'libraryCard' = the scholar's shared library card), or a native iOS app URL scheme (managed iPads open the installed app instead of the web view). `name` and `webUrl` (the https:// start URL) are required; the allowed-host list is derived from the URL's host. Re-creating an app that already has this webUrl returns the existing one rather than a duplicate tile. Grant it afterwards with the enable_app_for_* tools.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string" as const, description: "Display name, e.g. 'Acme Practice'." },
        webUrl: {
          type: "string" as const,
          description: "The https:// URL the app opens to (usually a login page).",
        },
        iconUrl: { type: "string" as const, description: "Optional tile icon URL." },
        iconEmoji: {
          type: "string" as const,
          description:
            "Optional single emoji for the tile, e.g. '\u{1F9EE}'. Shown when there is no icon URL, on the tile's color. Prefer this over iconUrl unless the app has a real logo image: it needs no upload and renders offline on the iPads.",
        },
        color: { type: "string" as const, description: "Optional tile color, hex like '#1f7fd0'. Unset picks a stable hue from the name." },
        defaultForNewScholars: {
          type: "boolean" as const,
          description: "Optional: auto-add this app to every newly created scholar.",
        },
        credentialSource: {
          type: "string" as const,
          enum: ["scholarApp", "libraryCard"] as const,
          description:
            "Where autofill pulls the login from: 'scholarApp' (per-scholar site account, default) or 'libraryCard' (the scholar's shared library credential).",
        },
        nativeUrlScheme: {
          type: "string" as const,
          description:
            "Optional native iOS app URL scheme, e.g. 'googlesheets://'. When set, managed iPads open the INSTALLED native app instead of the web view; must be a scheme-URL prefix like 'name://'.",
        },
        nativeBundleId: {
          type: "string" as const,
          description:
            "Optional native iOS app BUNDLE ID, e.g. 'com.mentava.learn2read'. Use this instead of nativeUrlScheme for a managed iPad app that registers NO custom URL scheme: nothing can open such an app programmatically, so its tile does the readiness and lock work and then points the scholar at the Home Screen. Never invent a scheme for one — a made-up scheme produces a tile that fails when tapped.",
        },
      },
      required: ["name", "webUrl"] as const,
    },
    run: async (input: {
      name: string;
      webUrl: string;
      iconUrl?: string;
      iconEmoji?: string;
      color?: string;
      defaultForNewScholars?: boolean;
      credentialSource?: "scholarApp" | "libraryCard";
      nativeUrlScheme?: string;
      nativeBundleId?: string;
    }) => {
      let res;
      try {
        res = await ctx.runMutation(internal.externalApps.aideCreateApp, {
          callerUserId,
          name: input.name,
          webUrl: input.webUrl,
          iconUrl: input.iconUrl,
          iconEmoji: input.iconEmoji,
          color: input.color,
          defaultForNewScholars: input.defaultForNewScholars,
          credentialSource: input.credentialSource,
          nativeUrlScheme: input.nativeUrlScheme,
          nativeBundleId: input.nativeBundleId,
        });
      } catch (e) {
        return `Could not create the app: ${errMsg(e)}`;
      }
      emit({
        toolComplete: { name: "create_external_app", result: `Created "${res.name}"` },
      });
      return JSON.stringify(res);
    },
  });

  const updateAppTool = betaTool({
    name: "update_external_app",
    description:
      "Reconfigure an EXISTING External App (named). Patches only the fields you provide — rename it, change the webUrl (the allowed-host list is re-derived from the new URL unless you pass webAllowedHosts), change the icon/color, toggle the default-for-new-scholars flag, change the credential source, set the login-helper selectors (loginUrlPattern / usernameSelector / passwordSelector / loginFlow), or set the native iOS app URL scheme (nativeUrlScheme). Pass an empty string to clear an optional text field (including nativeUrlScheme). The app name is resolved server-side.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: { type: "string" as const, description: "The app to update, by name." },
        name: { type: "string" as const, description: "New display name." },
        webUrl: { type: "string" as const, description: "New https:// start URL." },
        webAllowedHosts: {
          type: "array" as const,
          items: { type: "string" as const },
          description: "Optional explicit allowed-host list (else derived from webUrl).",
        },
        iconUrl: { type: "string" as const, description: "New icon URL (empty string clears)." },
        iconEmoji: {
          type: "string" as const,
          description:
            "New single emoji for the tile, shown when there is no icon URL (empty string clears).",
        },
        color: { type: "string" as const, description: "New tile color hex (empty string clears; unset falls back to a stable hue from the name)." },
        defaultForNewScholars: {
          type: "boolean" as const,
          description: "Whether to auto-add to new scholars.",
        },
        credentialSource: {
          type: "string" as const,
          enum: ["scholarApp", "libraryCard"] as const,
          description: "Where autofill pulls the login from.",
        },
        loginUrlPattern: { type: "string" as const, description: "Login-page URL pattern (empty clears)." },
        usernameSelector: { type: "string" as const, description: "CSS selector for the username field (empty clears)." },
        passwordSelector: { type: "string" as const, description: "CSS selector for the password field (empty clears)." },
        loginFlow: { type: "string" as const, description: "Named auto-login flow id (empty clears)." },
        nativeUrlScheme: {
          type: "string" as const,
          description:
            "Native iOS app URL scheme, e.g. 'googlesheets://' (managed iPads open the installed app instead of the web view). Must be a scheme-URL prefix like 'name://'; empty string clears.",
        },
      },
      required: ["appName"] as const,
    },
    run: async (input: {
      appName: string;
      name?: string;
      webUrl?: string;
      webAllowedHosts?: string[];
      iconUrl?: string;
      iconEmoji?: string;
      color?: string;
      defaultForNewScholars?: boolean;
      credentialSource?: "scholarApp" | "libraryCard";
      loginUrlPattern?: string;
      usernameSelector?: string;
      passwordSelector?: string;
      loginFlow?: string;
      nativeUrlScheme?: string;
    }) => {
      const { appName, ...patch } = input;
      let res;
      try {
        res = await ctx.runMutation(internal.externalApps.aideUpdateApp, {
          callerUserId,
          appName,
          ...patch,
        });
      } catch (e) {
        return `Could not update the app: ${errMsg(e)}`;
      }
      emit({
        toolComplete: { name: "update_external_app", result: `Updated "${res.name}"` },
      });
      return JSON.stringify(res);
    },
  });

  const archiveAppTool = betaTool({
    name: "archive_external_app",
    description:
      "Archive an External App (named): hide it from the catalog + launcher. This never deletes grants or per-scholar links — un-archiving restores everything. Use unarchive_external_app to bring it back.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: { type: "string" as const, description: "The app to archive, by name." },
      },
      required: ["appName"] as const,
    },
    run: async (input: { appName: string }) => {
      let res;
      try {
        res = await ctx.runMutation(internal.externalApps.aideSetAppArchived, {
          callerUserId,
          appName: input.appName,
          archived: true,
        });
      } catch (e) {
        return `Could not archive the app: ${errMsg(e)}`;
      }
      emit({
        toolComplete: { name: "archive_external_app", result: `Archived "${res.name}"` },
      });
      return JSON.stringify(res);
    },
  });

  const unarchiveAppTool = betaTool({
    name: "unarchive_external_app",
    description:
      "Un-archive an External App (named): restore a previously archived app to the catalog + launcher, with its grants and per-scholar links intact.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: { type: "string" as const, description: "The archived app to restore, by name." },
      },
      required: ["appName"] as const,
    },
    run: async (input: { appName: string }) => {
      let res;
      try {
        res = await ctx.runMutation(internal.externalApps.aideSetAppArchived, {
          callerUserId,
          appName: input.appName,
          archived: false,
        });
      } catch (e) {
        return `Could not un-archive the app: ${errMsg(e)}`;
      }
      emit({
        toolComplete: { name: "unarchive_external_app", result: `Restored "${res.name}"` },
      });
      return JSON.stringify(res);
    },
  });

  const setGroupAccess = (enabled: boolean) =>
    betaTool({
      name: enabled ? "enable_app_for_group" : "disable_app_for_group",
      description: enabled
        ? "Grant an External App to a whole scholar GROUP (named) — every scholar in the group gets the tile, and it stays true as membership changes (join the group → get the app). App + group names are resolved server-side."
        : "Revoke an External App from a scholar GROUP (named) — removes the group grant so the tile disappears for everyone it covered (per-scholar credentials are retained for a later re-grant). App + group names are resolved server-side.",
      inputSchema: {
        type: "object" as const,
        properties: {
          appName: { type: "string" as const, description: "The External App, by name." },
          groupName: { type: "string" as const, description: "The scholar group, by name (e.g. 'Geckos')." },
        },
        required: ["appName", "groupName"] as const,
      },
      run: async (input: { appName: string; groupName: string }) => {
        let res;
        try {
          res = await ctx.runMutation(internal.appAudiences.aideSetGroupAccess, {
            callerUserId,
            appName: input.appName,
            groupName: input.groupName,
            enabled,
            via,
          });
        } catch (e) {
          return `Could not ${enabled ? "enable" : "disable"} the app for that group: ${errMsg(e)}`;
        }
        const result = enabled
          ? `Enabled ${res.app} for ${res.group} (${res.memberCount} scholar${res.memberCount === 1 ? "" : "s"})`
          : `Disabled ${res.app} for ${res.group}`;
        emit({
          toolComplete: {
            name: enabled ? "enable_app_for_group" : "disable_app_for_group",
            result,
          },
        });
        return JSON.stringify(res);
      },
    });

  const setInstitutionAccess = (enabled: boolean) =>
    betaTool({
      name: enabled ? "enable_app_for_institution" : "disable_app_for_institution",
      description: enabled
        ? "Grant an External App to a whole INSTITUTION (school, named) — every scholar at that school gets the tile, staying true as enrollment changes. App + school names are resolved server-side."
        : "Revoke an External App from an INSTITUTION (school, named) — removes the school-wide grant (per-scholar credentials are retained). App + school names are resolved server-side.",
      inputSchema: {
        type: "object" as const,
        properties: {
          appName: { type: "string" as const, description: "The External App, by name." },
          institutionName: {
            type: "string" as const,
            description: "The school/institution, by name (e.g. 'Moli School').",
          },
        },
        required: ["appName", "institutionName"] as const,
      },
      run: async (input: { appName: string; institutionName: string }) => {
        let res;
        try {
          res = await ctx.runMutation(
            internal.appAudiences.aideSetInstitutionAccess,
            {
              callerUserId,
              appName: input.appName,
              institutionName: input.institutionName,
              enabled,
              via,
            },
          );
        } catch (e) {
          return `Could not ${enabled ? "enable" : "disable"} the app for that school: ${errMsg(e)}`;
        }
        const result = enabled
          ? `Enabled ${res.app} for ${res.institution} (${res.memberCount} scholar${res.memberCount === 1 ? "" : "s"})`
          : `Disabled ${res.app} for ${res.institution}`;
        emit({
          toolComplete: {
            name: enabled
              ? "enable_app_for_institution"
              : "disable_app_for_institution",
            result,
          },
        });
        return JSON.stringify(res);
      },
    });

  const setScholarAccess = (enabled: boolean) =>
    betaTool({
      name: enabled ? "enable_app_for_scholar" : "disable_app_for_scholar",
      description: enabled
        ? "Give an External App to ONE scholar (by name or username) — adds the tile directly to just that scholar's launcher. App + scholar are resolved server-side; prefer the exact username when a name is ambiguous."
        : "Remove an External App from ONE scholar's launcher (by name or username) — removes their direct link (does not touch group/school grants). App + scholar are resolved server-side; prefer the exact username when a name is ambiguous.",
      inputSchema: {
        type: "object" as const,
        properties: {
          appName: { type: "string" as const, description: "The External App, by name." },
          scholar: {
            type: "string" as const,
            description: "The scholar's name or (preferably) exact username.",
          },
        },
        required: ["appName", "scholar"] as const,
      },
      run: async (input: { appName: string; scholar: string }) => {
        let res;
        try {
          res = await ctx.runMutation(internal.scholarApps.aideSetScholarAccess, {
            callerUserId,
            appName: input.appName,
            scholarQuery: input.scholar,
            enabled,
            via,
          });
        } catch (e) {
          return `Could not ${enabled ? "enable" : "disable"} the app for that scholar: ${errMsg(e)}`;
        }
        const result = enabled
          ? `Enabled ${res.app} for ${res.scholar}`
          : `Disabled ${res.app} for ${res.scholar}`;
        emit({
          toolComplete: {
            name: enabled ? "enable_app_for_scholar" : "disable_app_for_scholar",
            result,
          },
        });
        return JSON.stringify(res);
      },
    });

  const setCredentialsTool = betaTool({
    name: "set_external_app_login",
    description:
      "Set or update ONE scholar's saved login for an External App. This is credential-bearing and is available only in a private chat. ALWAYS confirm the resolved scholar and app with the staff member before calling it; never repeat a username or password in your confirmation or response. Pass at least one of username or password. An empty string clears that field; omitting it leaves the saved value unchanged. App + scholar are resolved server-side; prefer the scholar's exact username when their name is ambiguous.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: { type: "string" as const, description: "The External App, by name." },
        scholar: {
          type: "string" as const,
          description: "The scholar's name or (preferably) exact username.",
        },
        username: {
          type: "string" as const,
          description: "The site's username. Empty clears it; omit to leave unchanged.",
        },
        password: {
          type: "string" as const,
          description: "The site's password. Empty clears it; omit to leave unchanged. Never return it.",
        },
      },
      required: ["appName", "scholar"] as const,
    },
    run: async (input: {
      appName: string;
      scholar: string;
      username?: string | number;
      password?: string | number;
    }) => {
      // A model will happily pass an all-digit PIN as a JSON number despite
      // the string schema. Coerce rather than let the mutation's argument
      // validator reject it — that error message quotes the rejected value,
      // which would put the secret into the tool result and the transcript.
      const username =
        input.username === undefined ? undefined : String(input.username);
      const password =
        input.password === undefined ? undefined : String(input.password);
      if (username === undefined && password === undefined) {
        return "Provide a username, password, or both to update the saved login.";
      }
      let res;
      try {
        res = await ctx.runMutation(internal.scholarApps.aideSetCredentials, {
          callerUserId,
          appName: input.appName,
          scholarQuery: input.scholar,
          username,
          password,
        });
      } catch (e) {
        // Belt and braces: no failure path may echo the secret back.
        return `Could not save that External App login: ${redactSecrets(errMsg(e), [username, password])}`;
      }
      const result = res.cleared
        ? `Cleared login for ${res.scholar} in ${res.app}`
        : `Saved login for ${res.scholar} in ${res.app}`;
      emit({ toolComplete: { name: "set_external_app_login", result } });
      return JSON.stringify(res);
    },
  });

  return [
    listAppsTool,
    getAccessTool,
    createAppTool,
    updateAppTool,
    archiveAppTool,
    unarchiveAppTool,
    setGroupAccess(true),
    setGroupAccess(false),
    setInstitutionAccess(true),
    setInstitutionAccess(false),
    setScholarAccess(true),
    setScholarAccess(false),
    ...(isPrivate ? [setCredentialsTool] : []),
  ];
}

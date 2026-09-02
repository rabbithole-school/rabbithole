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

export async function makeExternalAppsTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    hasSchoolOperationsAccess?: boolean;
  },
): Promise<BetaRunnableTool[]> {
  // Same audience as the underlying scholarAdminMutation gate on these
  // mutations: teacher / school_admin / platform_admin / operations staff.
  if (
    !isScholarAdminRole(opts.role) &&
    !(opts.role === "staff" && opts.hasSchoolOperationsAccess)
  ) {
    return [];
  }
  const { callerUserId } = opts;

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

  const listAppsTool = betaTool({
    name: "list_external_apps",
    description:
      "List the org's External Apps (the launchable web-app tiles scholars open from their home screen) with a WHO-CAN-USE-IT summary for each: name, URL, whether it's a default for new scholars, its credential source, whether it's archived, and how many audiences (groups/schools) + individual scholars it's granted to. Group/school memberCount and directScholarCount are complete counts (they include Extended Education scholars). Call this first to see what exists before creating/updating or granting. Includes archived apps (flagged) so you can un-archive one.",
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
      "For ONE External App (named), show the complete list of who can use it: every scholar GROUP it's granted to, every INSTITUTION (school) it's granted to (each with a live member count + whether the grant is enabled), and every INDIVIDUAL scholar who has it directly. The individual-scholar list defaults to enrolled scholars only; group/school member counts are complete (they include Extended Education scholars). The app name is resolved server-side; an unknown or ambiguous name returns a helpful error listing candidates.",
    inputSchema: {
      type: "object" as const,
      properties: {
        appName: {
          type: "string" as const,
          description: "The External App's name (e.g. 'Acme Practice').",
        },
        ...INCLUDE_EXTENDED_EDUCATION_PROP,
      },
      required: ["appName"] as const,
    },
    run: async (input: {
      appName: string;
      includeExtendedEducation?: boolean;
    }) => {
      let access;
      try {
        access = await ctx.runQuery(internal.appAudiences.aideGetAppAccess, {
          callerUserId,
          appName: input.appName,
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
      emit({
        toolComplete: {
          name: "get_external_app_access",
          result: `${access.app.name}: ${access.groups.length} group(s), ${access.institutions.length} school(s), ${scholars.length} scholar(s)`,
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
  ];
}

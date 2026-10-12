// `get_audit_log` — the agent reader over `auditLog` (TRA-362). Answers "who
// changed this, and when" from the record instead of an inference: the
// 2026-09-21 Scratch incident had a bot call a deliberate grant removal an
// accident while the five audit rows that said otherwise sat unread.
//
// Offered to exactly the audience of `get_external_app_access` (same gate —
// `canUseExternalAppsTools` — spread beside it in assembleCurriculumTools,
// which the in-app aide, Slack, and the MCP connector all go through), but it
// ANSWERS only on a private surface. Tenancy, the health-access wall, and the
// impersonation-detail omission are enforced server-side in
// `internal.auditLog.aideListAuditLog`.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { Role } from "./roles";
import type { AideEmit } from "./aideStream";
import { canUseExternalAppsTools } from "./externalAppsTools";
import { AUDIT_LOG_PRIVATE_ONLY } from "./auditLog";
import type { WriteSurface } from "./scholarWriteTools";
// Type-only, as in externalAppsTools.ts: the widened element type every
// betaTool() collapses to.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

export async function makeAuditLogTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    hasSchoolOperationsAccess?: boolean;
    institutionScope?: string;
    surface?: WriteSurface;
  },
): Promise<BetaRunnableTool[]> {
  if (!canUseExternalAppsTools(opts)) return [];
  const { callerUserId, institutionScope } = opts;
  // PRIVATE surfaces only — a 1:1 bot DM, the in-app aide, a person's own MCP
  // connection. Fails closed like externalAppsTools' credential tool: a caller
  // that never names its surface is treated as shared. Slack channels and
  // group DMs, service-account MCP, and Google Doc comment replies all arrive
  // as "channel" and get a legible refusal (the query separately refuses a
  // service account, so this is not the only wall).
  const isPrivate = opts.surface === "private";
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const getAuditLogTool = betaTool({
    name: "get_audit_log",
    description:
      "Read your school's audit trail: who changed what, and when — app grants (`app-grant.*`), managed iPads and pairing (`managed-claim.*`, `device.*`), health documents (`health_document.*`, `medical_clearance.*`), view-as sessions (`impersonation.*`), and school suspension (`institution.*`). Newest first, times in school-local time. Use it BEFORE saying something was dropped, lost, or changed by accident: a deliberate change leaves a row naming who made it. Filter by an action prefix, the person acted on (`targetName`), or who did it (`actorName`); names match on a substring of name or username. Only your own school's rows are ever returned; health-document rows appear only for staff with health access there, and view-as rows show who, whom and when but no detail. Available only in a private chat — in a channel, group DM, or shared connection it returns a notice instead. `more: true` means the list was cut off — narrow the filters or widen `sinceDays`/`limit` rather than concluding nothing else happened.",
    inputSchema: {
      type: "object" as const,
      properties: {
        actionPrefix: {
          type: "string" as const,
          description:
            "Only actions starting with this, e.g. 'app-grant.' or 'impersonation.'.",
        },
        targetName: {
          type: "string" as const,
          description: "Only rows about this person (scholar or staff), by name.",
        },
        actorName: {
          type: "string" as const,
          description: "Only rows done by this person, by name.",
        },
        sinceDays: {
          type: "number" as const,
          description: "How many days back to look (default 7, max 90).",
        },
        limit: {
          type: "number" as const,
          description: "Max rows to return (default 25, max 100).",
        },
      },
      required: [] as const,
    },
    run: async (input: {
      actionPrefix?: string;
      targetName?: string;
      actorName?: string;
      sinceDays?: number;
      limit?: number;
    }) => {
      if (!isPrivate) return AUDIT_LOG_PRIVATE_ONLY;
      let res;
      try {
        res = await ctx.runQuery(internal.auditLog.aideListAuditLog, {
          callerUserId,
          institutionScope,
          actionPrefix: input.actionPrefix,
          targetName: input.targetName,
          actorName: input.actorName,
          sinceDays: input.sinceDays,
          limit: input.limit,
          now: Math.floor(Date.now() / 60_000) * 60_000,
        });
      } catch (e) {
        return `Could not read the audit log: ${e instanceof Error ? e.message : String(e)}`;
      }
      emit({
        toolComplete: {
          name: "get_audit_log",
          result: `${res.entries.length} audit entr${res.entries.length === 1 ? "y" : "ies"} (last ${res.sinceDays} day(s))${res.more ? ", more available" : ""}`,
        },
      });
      return JSON.stringify(res);
    },
  });

  return [getAuditLogTool];
}

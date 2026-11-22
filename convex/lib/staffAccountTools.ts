// `find_staff_account` — the agent reader over staff accounts and their
// capability grants. Answers "does X have an account yet, and can they do Y"
// from the record: before it, the aide had no way to see a staff account and
// sent a school admin to /admin to check on a colleague who already existed.
//
// Offered to exactly the audience of `get_audit_log` (the same
// `canUseExternalAppsTools` gate, spread beside it in assembleCurriculumTools,
// which the in-app aide, Slack, and the MCP connector all go through).
// Tenancy and the no-contact-details shape are enforced server-side in
// `internal.staffCapabilities.aideFindStaffAccounts`. Unlike the audit log it
// answers on shared surfaces too: it carries the same facts the staff
// directory shows every scholar-admin, plus which grants a colleague holds.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { Role } from "./roles";
import type { AideEmit } from "./aideStream";
import { canUseExternalAppsTools } from "./externalAppsTools";
// Type-only, as in externalAppsTools.ts: the widened element type every
// betaTool() collapses to.
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";

export async function makeStaffAccountTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    hasSchoolOperationsAccess?: boolean;
    institutionScope?: string;
  },
): Promise<BetaRunnableTool[]> {
  if (!canUseExternalAppsTools(opts)) return [];
  const { callerUserId, institutionScope } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const findStaffAccountTool = betaTool({
    name: "find_staff_account",
    description:
      "Look up a STAFF account at your school by name or username (substring match): whether the person has an account, their username, their roles at each school (teacher, staff, school_admin, curriculum_designer — someone can hold more than one), whether it is linked to Slack, and the capability grants that are in effect for them — `scholars:mentor` (message enrolled scholars; `group: null` means the whole school, otherwise only that group), `curriculum:edit`, `curriculum:run`, `school:operations`, `health:manage`, `program:publish` / `captures:review` (per group), `admissions:full` / `admissions:scheduling`. Use it BEFORE telling anyone you can't tell whether a colleague has an account or what access they have. An empty `staff` list means no staff account matches at the schools in `schoolsSearched` (the schools where you manage scholars) — try a shorter part of the name before concluding they have none. Teachers and school admins reach curriculum and mentor threads by role, so a missing grant for them is not missing access. Returns no email, phone, or scholar data.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string" as const,
          description: "Part of the person's name or username, e.g. 'Hobbs'.",
        },
      },
      required: ["name"] as const,
    },
    run: async (input: { name: string }) => {
      let res;
      try {
        res = await ctx.runQuery(internal.staffCapabilities.aideFindStaffAccounts, {
          callerUserId,
          institutionScope,
          name: input.name,
        });
      } catch (e) {
        return `Could not look up staff accounts: ${e instanceof Error ? e.message : String(e)}`;
      }
      emit({
        toolComplete: {
          name: "find_staff_account",
          result: `${res.staff.length} staff account(s) match "${input.name}"${res.more ? ", more available" : ""}`,
        },
      });
      return JSON.stringify(res);
    },
  });

  return [findStaffAccountTool];
}

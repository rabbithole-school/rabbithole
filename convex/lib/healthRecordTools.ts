import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { AideEmit } from "./aideStream";
import { isScholarAdminRole, type Role } from "./roles";
import type { WriteSurface } from "./scholarWriteTools";

export const EMERGENCY_INFO_TOOL_NAME = "get_scholar_emergency_info";

export const EMERGENCY_INFO_CHANNEL_NOTICE =
  "Health and emergency records contain sensitive information. Ask me in a one-to-one Slack DM to retrieve the record; I will not post those details in a channel or group conversation.";

export function emergencyInfoToolForRequest(
  message: string,
): typeof EMERGENCY_INFO_TOOL_NAME | null {
  const asksForEmergencyRecord =
    /\b(?:emergency (?:info(?:rmation)?|contacts?|medical|health)|health (?:record|info(?:rmation)?|details)|medical (?:record|info(?:rmation)?|details|conditions?)|allerg(?:y|ies)|current medications?)\b/i;
  return asksForEmergencyRecord.test(message)
    ? EMERGENCY_INFO_TOOL_NAME
    : null;
}

export async function makeHealthRecordTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    surface: WriteSurface;
    institutionScope?: string;
    hasHealthManagementAccess?: boolean;
  },
) {
  if (
    !isScholarAdminRole(opts.role) &&
    !opts.hasHealthManagementAccess
  ) {
    return [];
  }

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );
  return [
    betaTool({
      name: EMERGENCY_INFO_TOOL_NAME,
      description:
        "Get the latest SUBMITTED canonical emergency and medical record for one scholar. Call this for requests such as \"what is Kai's emergency info?\", emergency contacts, allergies, medications, chronic conditions, healthcare action plans, physician/insurance details, or emergency-care authorization. It never returns guardian-private drafts. Name matching is strict: an ambiguous partial name is rejected instead of guessed. In a Slack channel or group conversation, the tool returns only a privacy instruction; record details are available in a one-to-one DM or another private staff-aide transport.",
      inputSchema: {
        type: "object" as const,
        properties: {
          scholarName: {
            type: "string" as const,
            description:
              "The scholar's full or uniquely identifying name. Ambiguous partial names are rejected.",
          },
        },
        required: ["scholarName"] as const,
      },
      run: async (input) => {
        if (opts.surface === "channel") {
          return EMERGENCY_INFO_CHANNEL_NOTICE;
        }
        const result = await ctx.runQuery(
          internal.scholarHealthRecords.getEmergencyInfoForAide,
          {
            callerUserId: opts.callerUserId,
            scholarName: input.scholarName,
            institutionScope: opts.institutionScope,
          },
        );
        emit({
          toolComplete: {
            name: EMERGENCY_INFO_TOOL_NAME,
            result: "Emergency information lookup completed",
          },
        });
        if (result.status === "not_found") {
          return `No scholar found matching "${input.scholarName}" in the staff member's current institution context.`;
        }
        if (result.status === "ambiguous") {
          return `The scholar name "${input.scholarName}" is ambiguous. Ask the staff member to choose one of: ${result.candidates.join(", ")}.`;
        }
        if (result.status === "no_record") {
          return `No submitted canonical health or emergency record is on file for ${result.scholar}.`;
        }
        return JSON.stringify(result);
      },
    }),
  ];
}

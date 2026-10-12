// Managed-iPad operations as AGENT TOOLS — the one definition shared by every
// transport that hands them to a model: the Slack bot (lib/slackTools.ts) and
// the OAuth MCP connector (convex/mcp.ts).
//
// Why shared rather than copied: these tools carry a SAFETY CONTRACT in their
// prose — "list first, show the requester the exact resolved iPads, get
// confirmation, then write". A second copy of that sentence is a second copy
// that can drift, and the surface it drifts on is a remote command to a child's
// device. `.claude/rules/rabbithole-mdm-asm.md` states the contract once; this
// module is its single executable expression.
//
// The contract is prose, and prose is UX — the authorization boundary is the
// internal functions these call (`deviceLock.listForAgent` /
// `deviceLock.setFromAgent` / `managedDeviceClaims.listForAgent`), each of
// which re-resolves the caller and refuses the whole batch if any id falls
// outside their school:operations institutions. A model that skips the
// confirmation step still cannot reach another school's iPad.
//
// DELIBERATELY ABSENT: `deviceAppUnlock:configureDedicatedProfile`. Rebinding
// a device's allowlist baseline resets the live SimpleMDM profile to a
// baseline-only template (assertTemplateBaseline demands exact equality) and
// narrows the scholar's allowlist for the window before the rebind lands.
// That is an operator action with a reviewed dry run, not a chat tool.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isScholarAdminRole, ROLES, type Role } from "./roles";
import type { AideEmit } from "./aideStream";

/** Which agent transport is calling — recorded verbatim in the lock audit
 *  line, so an ops question ("who disarmed this, from where?") has an answer.
 *  Required rather than defaulted: a new transport must name itself. */
export type DeviceOpsSource = "slack" | "mcp";

/**
 * The school-operations gate for TOOL VISIBILITY. Same predicate the Slack
 * assembler has always used: teacher / school_admin / platform_admin by role,
 * base staff only with an established institution-scoped `school:operations`
 * grant. Every underlying internal function repeats it against the database.
 */
export function canOperateSchoolDevices(
  role: Role | null | undefined,
  hasSchoolOperationsAccess: boolean,
): boolean {
  return (
    isScholarAdminRole(role) ||
    (role === ROLES.STAFF && hasSchoolOperationsAccess)
  );
}

export async function makeDeviceOpsTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    /** Established from an active institution-scoped school:operations grant. */
    hasSchoolOperationsAccess?: boolean;
    source: DeviceOpsSource;
  },
) {
  const {
    role,
    callerUserId,
    hasSchoolOperationsAccess = false,
    source,
  } = opts;
  if (!canOperateSchoolDevices(role, hasSchoolOperationsAccess)) return [];

  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  return [
    betaTool({
      name: "list_managed_devices",
      description:
        "Inventory of the school's managed (MDM-enrolled) iPads: which scholar each serial is assigned to, its claim state, whether sign-in is currently held, whether a session is live, and — per managed app — whether the scholar can actually open it. Use this to answer 'which iPad is scholar X on?' and 'can X open <app>, and if not what is stopping it?'. Each appAccess row gives granted (the scholar holds the app), allowed (the device's MDM allowlist admits it), installed (SimpleMDM last saw it on the device), tiled (it has a home-screen tile), onDevice (the one-line answer), and blocker — the FIRST fact standing in the way: scholar, binding, grant, allowlist, inventory, install, or tile. Read blocker before proposing a fix; 'grant' means the scholar needs the app added, while 'install' means the app is granted but has not landed on the device yet. appAccessError is the last error updating the iPad's app-access profile (null if none); it retries on its own. A row with scholarDeleted true is the iPad of a scholar who has since been deleted: it has no scholar, and staff need to reassign it on the devices page. The SimpleMDM figures are the last hourly snapshot, not a live device read. Optionally search by scholar name/username, serial, device label, or id.",
      inputSchema: {
        type: "object" as const,
        properties: {
          search: {
            type: "string" as const,
            description:
              "Optional scholar name/username, serial, device label, or id filter.",
          },
        },
        required: [] as const,
      },
      run: async (input) => {
        const result = await ctx.runQuery(
          internal.managedDeviceClaims.listForAgent,
          { callerUserId, search: input.search?.trim() || undefined },
        );
        if (!result.ok) return result.message;
        emit({
          toolComplete: {
            name: "list_managed_devices",
            result: `${result.devices.length} iPad${result.devices.length === 1 ? "" : "s"}`,
          },
        });
        return JSON.stringify(result.devices, null, 2);
      },
    }),

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
        const result = await ctx.runQuery(internal.deviceLock.listForAgent, {
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

    betaTool({
      name: "set_rabbithole_lock",
      description:
        "Arm or disarm Rabbithole Lock on one or more paired school iPads. You MUST call list_rabbithole_lock_devices first, show the exact resolved devices and action to the requester, and receive confirmation before calling this write tool. Never pass an id you inferred from a name without having listed it. Disarm defaults to until_midnight in each iPad's school timezone; alternatives are one_time (re-arms when Rabbithole is entered again), until_further_notice, and timed (re-arms automatically after a fixed number of minutes — pass disarm_minutes, 5-480, whenever disarm_mode is timed).",
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
            description: "For disarm only. Defaults to until_midnight.",
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
          internal.deviceLock.setFromAgent,
          {
            callerUserId,
            source,
            pairedDeviceIds: (input.paired_device_ids ??
              []) as Id<"pairedDevices">[],
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
            toolComplete: { name: "set_rabbithole_lock", result: result.message },
          });
        }
        return result.message;
      },
    }),
  ];
}

// Managed-iPad operations as AGENT TOOLS — the one definition shared by every
// transport that hands them to a model. Wired in ONE place, the shared staff
// aide registry (`assembleCurriculumTools`, lib/aideTools.ts), so the in-app
// aide, the Slack bot, and the OAuth MCP connector all get the same set.
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
// `deviceLock.setFromAgent` / `deviceLock.freezeFromAgent` /
// `managedDeviceClaims.listForAgent` /
// `simplemdm.restartDeviceFromAgent`), each of which re-resolves the caller
// and refuses the whole batch if any id falls outside their school:operations
// institutions. A model that skips the confirmation step still cannot reach
// another school's iPad. The restart runs the SAME guard sequence as the
// devices console's Restart button (`simplemdm.runDeviceRestart`).
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

/** Which agent transport is calling — recorded verbatim in the device audit
 *  line, so an ops question ("who disarmed this, from where?") has an answer.
 *  Required rather than defaulted: a new transport must name itself. Same
 *  vocabulary as the admissions agent's `surface` ("app" = the in-app staff
 *  aide). */
export type AgentTransport = "app" | "slack" | "mcp";

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
    source: AgentTransport;
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
        "List paired school iPads with their Rabbithole Lock and Freeze Mode state (frozenUntil is the epoch-ms instant a frozen iPad thaws, null when not frozen). Use this BEFORE set_rabbithole_lock or set_freeze_mode to resolve the exact paired_device_ids and show the requester which iPads will change. Optionally search by device label, serial, scholar name/username, or id. The inventory is complete; rows for Extended Education (program-guest) scholars are tagged extendedEducation: true.",
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
        "Arm or disarm Rabbithole Lock on one or more paired school iPads. You MUST call list_rabbithole_lock_devices first, show the exact resolved devices and action to the requester, and receive confirmation before calling this write tool. Never pass an id you inferred from a name without having listed it. Disarm defaults to until_midnight in each iPad's school timezone; alternatives are one_time (re-arms when Rabbithole is entered again), until_further_notice, and timed (re-arms automatically after a fixed number of minutes — pass disarm_minutes, 5-480, whenever disarm_mode is timed). A frozen iPad (Freeze Mode) cannot be disarmed until it is unfrozen.",
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

    betaTool({
      name: "set_freeze_mode",
      description:
        "Freeze or unfreeze one or more paired school iPads. Freeze Mode is a staff-set pause: it arms Rabbithole Lock so the scholar can't leave the app and covers Rabbithole with a screen reading that the iPad is frozen until a stated time and to ask a teacher to unfreeze it. It thaws on its own after `minutes`, or when staff unfreeze it. You MUST call list_rabbithole_lock_devices first, show the requester the exact scholars and iPads you resolved plus the action (and for a freeze, how long), and get confirmation before calling this. Never pass an id you inferred from a name without having listed it. Freeze Mode is not a fix for an unresponsive or crashed iPad — that is restart_managed_device. Unfreezing leaves Rabbithole Lock armed.",
      inputSchema: {
        type: "object" as const,
        properties: {
          paired_device_ids: {
            type: "array" as const,
            description:
              "Exact pairedDeviceId values returned by list_rabbithole_lock_devices.",
            items: { type: "string" as const },
          },
          frozen: {
            type: "boolean" as const,
            description: "true to freeze, false to unfreeze.",
          },
          minutes: {
            type: "number" as const,
            description:
              "Required when freezing: how many minutes from now the iPad stays frozen (integer, 5-480). Re-freezing a frozen iPad replaces its end time. Ignored when unfreezing.",
          },
        },
        required: ["paired_device_ids", "frozen"] as const,
      },
      run: async (input) => {
        const result = await ctx.runMutation(
          internal.deviceLock.freezeFromAgent,
          {
            callerUserId,
            source,
            pairedDeviceIds: (input.paired_device_ids ??
              []) as Id<"pairedDevices">[],
            frozen: input.frozen === true,
            minutes: input.minutes as number | undefined,
          },
        );
        if (result.ok) {
          emit({
            toolComplete: { name: "set_freeze_mode", result: result.message },
          });
        }
        return result.message;
      },
    }),

    // One device per call, deliberately: a restart drops whatever the scholar
    // has not sent, so a batch would multiply the cost of one wrong match.
    // The console's Restart button is one-device too.
    betaTool({
      name: "restart_managed_device",
      description:
        "Restart ONE managed school iPad over MDM — the fix for a hung or wedged app (not Freeze Mode, which staff set on purpose; see set_freeze_mode). You MUST call list_managed_devices first, tell the requester the exact scholar and iPad (label and serial) you resolved, and get an explicit yes in this conversation before calling this. Never pass an id you inferred from a name without having listed it. One iPad per call; there is no bulk restart. What staff should know: the iPad must be online to receive the restart (it waits in the queue until the iPad next checks in); anything the scholar hasn't sent or saved is lost; the iPad comes back signed in as the same scholar. Never use force sign-out as a substitute for a restart: on a managed iPad that invalidates its enrollment key and needs a staff follow-up before it can sign in again. Requires a supervised, SimpleMDM-enrolled iPad; a refusal says why.",
      inputSchema: {
        type: "object" as const,
        properties: {
          paired_device_id: {
            type: "string" as const,
            description:
              "The exact pairedDeviceId of ONE iPad, as list_managed_devices returned it.",
          },
        },
        required: ["paired_device_id"] as const,
      },
      run: async (input) => {
        const pairedDeviceId = input.paired_device_id?.trim();
        if (!pairedDeviceId) {
          return "Failed: pass the pairedDeviceId of one iPad exactly as list_managed_devices returned it.";
        }
        let result;
        try {
          result = await ctx.runAction(
            internal.simplemdm.restartDeviceFromAgent,
            {
              callerUserId,
              source,
              pairedDeviceId: pairedDeviceId as Id<"pairedDevices">,
            },
          );
        } catch (error) {
          // Every refusal comes back as { ok: false }, so a throw here is
          // almost always argument validation — a malformed or invented id.
          const reason = error instanceof Error ? error.message : String(error);
          return `Failed: the restart did not run (${reason}). Pass one pairedDeviceId exactly as list_managed_devices returned it.`;
        }
        if (!result.ok) return `Failed: ${result.message}`;
        emit({
          toolComplete: {
            name: "restart_managed_device",
            result: result.message,
          },
        });
        return result.message;
      },
    }),
  ];
}

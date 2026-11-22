// What the MCP consent screen (./page.tsx) tells the person a connection will
// be able to do. Pure, so the copy that decides "read-only" vs "can change"
// is testable without a browser.
//
// Deliberately takes NO `resource`. The RFC 8707 `resource` parameter is
// client-controlled, and nothing server-side binds the authorization code or
// the token to it: a token approved for /api/mcp/read works on the full
// /api/mcp connector too. Describing access from `resource` let any
// registered client show a "read-only" screen and then use every write tool
// (TRA-635). Until the grant itself is bound to the resource, the screen
// describes everything the person's token can actually do. Overstating access
// is the safe direction.

import { isReadOnlyToolName } from "@/convex/lib/scholarReadPolicy";
import { isStaffRole, type Role } from "@/convex/lib/roles";

export type ConsentAccess = {
  /** Every tool the token can call, reads first. */
  callerToolNames: string[];
  /** The tools that can change something, sorted. */
  changeToolNames: string[];
  /** The tool list failed to load for a role that does hold change tools. */
  changesUnknown: boolean;
  /** The sentence that heads the access list. */
  summary: string;
};

export function describeConsentAccess(input: {
  role: Role | null;
  readTools: readonly string[];
  /** The names `/api/mcp` serves from each `api.mcp.list*Tools` action, fetched
   *  by the page with the signed-in person's session. null while loading or
   *  after a failed load. */
  curriculumToolNames: readonly string[] | null;
  unitDesignerToolNames: readonly string[] | null;
  admissionsToolNames: readonly string[] | null;
  toolListError: boolean;
  scopeNote: string | undefined;
}): ConsentAccess {
  const callerToolNames = [
    ...input.readTools,
    ...(input.curriculumToolNames ?? []),
    ...(input.unitDesignerToolNames ?? []),
    ...(input.admissionsToolNames ?? []),
  ];
  // Which tools can CHANGE something: the same rule the read-only connector
  // uses to decide what it offers (isReadOnlyToolName).
  const changeToolNames = callerToolNames
    .filter((name) => !isReadOnlyToolName(name))
    .sort();
  // If the tool list could not load we cannot enumerate, but staff genuinely
  // do hold change tools, so say so rather than implying read-only.
  const changesUnknown = input.toolListError && isStaffRole(input.role);
  const hasMutatingTool = changeToolNames.length > 0 || changesUnknown;
  const summary =
    callerToolNames.length > 0 || changesUnknown
      ? hasMutatingTool
        ? "This connection can read your Rabbithole data and change it. Some of what it can do is permanent, and some of it affects other people."
        : `It will get read-only access${input.scopeNote ? ` ${input.scopeNote}` : ""}:`
      : "Your role has no MCP tools available, so this connection won't be able to read anything.";
  return { callerToolNames, changeToolNames, changesUnknown, summary };
}

// The single role → scholar-read-tools policy, shared by every agent
// surface that exposes scholar data to an AI or external client:
//
//   - the in-app aide streams (lib/scholarReadTools.ts builds Anthropic
//     tools from this table), and
//   - the remote MCP connector (app/api/mcp/route.ts assembles its MCP
//     tool list from it, and convex/mcp.ts re-checks it server-side on
//     every query — the route's filtering is UX; the query gate is the
//     security boundary).
//
// Pure module on purpose: no Convex imports, so the Next.js route can
// import it without dragging server code along, and it unit-tests as a
// plain function. If you add a tool or a role, change THIS table — not
// the surfaces.

import { ROLES, type Role } from "./roles";

/** Every scholar-read tool any surface may expose, in display order. */
export const SCHOLAR_READ_TOOLS = [
  "list_scholars",
  "get_scholar_dossier",
  "get_scholar_interests",
  "get_scholar_mastery",
  "get_scholar_signals",
  "get_scholar_seeds",
  "get_scholar_observations",
  "get_scholar_sessions",
  "get_session_transcript",
  "get_scholar_web_activity",
  "get_scholar_practice",
  "get_scholar_math_checkin",
  "get_scholar_documents",
  "get_scholar_work_samples",
  "get_school_calendar",
] as const;

export type ScholarReadToolName = (typeof SCHOLAR_READ_TOOLS)[number];

/**
 * Tier-1 = the non-sensitive learning measurements (mastery / signals /
 * seeds / first-party practice state). Parents get exactly these for their
 * own children; scholars get exactly these for themselves. Tier-2 (dossier,
 * documents, work samples, observations, sessions metadata, the raw session
 * TRANSCRIPT, web-activity practice, cross-scholar roster) stays teacher/admin.
 * The transcript especially — the most granular scholar data there is — is
 * teacher/admin ONLY; never widen it to parents or scholars.
 *
 * `get_scholar_math_checkin` is Tier-2 for the same reason: it returns the
 * per-probe check-in transcript (each question, the answer given, right or
 * wrong). That is diagnostic detail for a teacher reading a placement search,
 * not a portrait — handing a scholar or a parent a list of the child's misses
 * turns a map into a report card. The `get_scholar_practice` glance (Tier-1)
 * is the trend-altitude view they get instead.
 *
 * `get_scholar_practice` is Tier-1: it surfaces procedural-practice state
 * (placement, frontier, due skills) for parents/scholars. NOTE: the
 * `observerFlaggedMisconceptions` sub-field is redacted for TIER_1 callers
 * (parents/scholars see {label, domain} only; full observation text/IDs are
 * teacher/admin only). The redaction is enforced in the tool layer
 * (scholarReadTools.ts / mcp.ts), not the policy gate.
 */
const TIER_1: readonly ScholarReadToolName[] = [
  "get_scholar_interests",
  "get_scholar_mastery",
  "get_scholar_signals",
  "get_scholar_seeds",
  "get_scholar_practice",
  // Not a scholar measurement at all — the school's public no-school days,
  // scoped to the named scholar's institution. It rides the scholar-read
  // table because the scholar name is how every surface here scopes a
  // request, and that scoping is exactly what keeps a parent from reading
  // another school's calendar. Nothing in it is private.
  "get_school_calendar",
];

/**
 * Role → allowed tool names. "all" = the full set.
 *
 * - `curriculum_designer` gets NONE: designers work on curriculum-design
 *   surfaces, not scholar records — surfacing the roster, mastery, or
 *   (worst of all) `get_scholar_documents` (which retains cognitive-
 *   assessment scores / IEP findings) to a designer is a privacy break.
 * - `operations staff` gets only the non-sensitive roster lookup (and the data
 *   layer additionally redacts readingLevel/observationCount for them).
 * - base `staff` gets nothing by default. A caller must prove an active,
 *   institution-scoped `school:operations` grant before it receives the same
 *   redacted roster tool. This pure module takes that proof as an explicit
 *   option; database-backed transports establish it before calling here.
 * - `parent` and `scholar` get tier-1 only. The TOOL table picks what;
 *   the id scope (guardianship for parents, self for scholars — enforced
 *   via `allowedScholarIds` in the aide and in convex/mcp.ts) picks whose.
 *
 * Unknown/missing roles get NOTHING — default-deny, because the MCP
 * surface serves whatever role authenticates.
 */
const TOOLS_BY_ROLE: Record<
  Role,
  readonly ScholarReadToolName[] | "all"
> = {
  [ROLES.TEACHER]: "all",
  [ROLES.PLATFORM_ADMIN]: "all",
  [ROLES.SCHOOL_ADMIN]: "all",
  [ROLES.CURRICULUM_DESIGNER]: [],
  [ROLES.STAFF]: [],
  [ROLES.PARENT]: TIER_1,
  [ROLES.SCHOLAR]: TIER_1,
  [ROLES.LIFELONG_LEARNER]: TIER_1,
};

/** The tool names a given role may use. Unknown role → empty. */
export type ScholarReadPolicyOptions = {
  /** A database boundary has established at least one active school-operations grant. */
  hasSchoolOperationsAccess?: boolean;
};

export function allowedScholarReadTools(
  role: Role | undefined | null,
  options: ScholarReadPolicyOptions = {},
): readonly ScholarReadToolName[] {
  if (!role || !(role in TOOLS_BY_ROLE)) return [];
  if (role === ROLES.STAFF) {
    return options.hasSchoolOperationsAccess ? ["list_scholars"] : [];
  }
  const entry = TOOLS_BY_ROLE[role];
  return entry === "all" ? SCHOLAR_READ_TOOLS : entry;
}

const SCHOLAR_READ_TOOL_SET: ReadonlySet<string> = new Set(SCHOLAR_READ_TOOLS);

/**
 * Named like a read but writes. `get_mentava_progress` saves the level it
 * fetches to `mentavaLinks` on every call (convex/mentava.ts recordLevels), so
 * the read-only connector leaves it out. Every other `get_`/`list_` tool the
 * aide assembles makes only queries (audited 2026-11-07). The pinned list in
 * convex/__tests__/mcp.test.ts fails when a new one reaches a teacher, a
 * platform admin or operations staff; tools gated to other roles are not
 * pinned.
 */
const WRITES_DESPITE_NAME: ReadonlySet<string> = new Set(["get_mentava_progress"]);

/**
 * Reads whose names don't say so (audited 2026-11-09):
 * - `find_candidate_or_family`: `get_candidate_status` needs the ids it
 *   returns, and the lookup only queries (convex/admissionsSlack.ts
 *   findCandidates).
 * - `find_staff_account` (audited 2026-11-12): one internalQuery
 *   (convex/staffCapabilities.ts aideFindStaffAccounts), which scopes to the
 *   caller's schools and returns no email, phone or scholar data. Kept under
 *   the aide's name rather than renamed `get_…` so the in-app aide, Slack and
 *   both MCP endpoints share one tool.
 * - `search_code`, `read_repo_file`, `read_system_doc`, `recent_changes`:
 *   GET the GitHub REST API as the App installation (convex/github.ts
 *   searchCode / readFile / recentChanges); nothing is stored.
 *
 * `read_drive_link` and `search_drive` stay out: reaching Drive goes through
 * getValidAccessToken (lib/googleTokens.ts), which saves a refreshed Google
 * token to `googleAccounts`, or marks the link for reconnect, when it has to.
 */
const READS_DESPITE_NAME: ReadonlySet<string> = new Set([
  "find_candidate_or_family",
  "find_staff_account",
  "search_code",
  "read_repo_file",
  "read_system_doc",
  "recent_changes",
]);

/**
 * Whether a connector tool only reads, judged by its name: the scholar-read
 * tools above, plus any tool named `get_…` or `list_…`, the settled naming
 * convention for reads across the aide tool layer. Two surfaces depend on it:
 * the OAuth consent page, which tells a person what a connection can change,
 * and the read-only connector (/api/mcp/read), which offers nothing else.
 *
 * Judging by name means a new tool counts as a change until it is named like
 * a read, which is wrong in the cautious direction. The other direction is
 * the one to guard: name a tool that writes `get_`/`list_` only if you also
 * add it to WRITES_DESPITE_NAME.
 */
export function isReadOnlyToolName(name: string): boolean {
  if (SCHOLAR_READ_TOOL_SET.has(name) || READS_DESPITE_NAME.has(name)) return true;
  if (WRITES_DESPITE_NAME.has(name)) return false;
  return name.startsWith("get_") || name.startsWith("list_");
}

export function isScholarReadToolAllowed(
  role: Role | undefined | null,
  tool: ScholarReadToolName,
  options?: ScholarReadPolicyOptions,
): boolean {
  return (
    allowedScholarReadTools(role, options) as readonly ScholarReadToolName[]
  ).includes(tool);
}

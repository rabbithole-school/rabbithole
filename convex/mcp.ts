/**
 * The data surface for the remote MCP connector (app/api/mcp/route.ts).
 *
 * The Next.js route authenticates each request with the OAuth access
 * token — a REAL Convex Auth JWT — via ConvexHttpClient.setAuth(), so
 * these queries run as the actual signed-in user. THIS file is the
 * security boundary: every query re-checks the shared role→tool policy
 * (lib/scholarReadPolicy.ts) and scopes name resolution to the caller's
 * allowed scholar set (platform admin → all, institution staff → their
 * membership institutions, parent → linked children via guardianships,
 * scholar → self). The route's per-role tool filtering is just UX; even a
 * client that calls an off-role query gets "Forbidden".
 *
 * Data comes from lib/scholarReads.ts — the same implementations the
 * in-app aide and the parent portal read. One policy, one data layer,
 * N transports.
 */
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { authedQuery } from "./lib/customFunctions";
import {
  ROLES,
  isPlatformAdminRole,
  isStaffRole,
  isCurriculumRole,
  isTeacherRole,
  type Role,
} from "./lib/roles";
import { accessibleScholarIds } from "./lib/access";
import type { ScholarSchoolCalendar } from "./academicCalendar";
import {
  isScholarReadToolAllowed,
  SCHOLAR_READ_TOOLS,
  type ScholarReadToolName,
} from "./lib/scholarReadPolicy";
import { extendedEducationOmittedNote } from "./lib/scholarParticipationTooling";
import {
  readScholarRoster,
  readScholarMastery,
  readScholarSignals,
  readScholarSeeds,
  readScholarObservations,
  readScholarDossier,
  readScholarSessions,
  readSessionTranscript,
  readScholarWebActivity,
  readScholarDocuments,
  readScholarWorkSamples,
  readScholarPractice,
  readScholarMathCheckIn,
  redactScholarPractice,
} from "./lib/scholarReads";
import { assembleCurriculumTools } from "./lib/aideTools";
import { assembleUnitDesignerTools } from "./lib/unitDesignerTools";
import { siteUrl, withBase } from "./lib/channels";
import type { AideEmit } from "./lib/aideStream";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx, ActionCtx } from "./_generated/server";
import { requireUnitEditAccessForUser } from "./lib/auth";
import { schoolOperationsInstitutionIds } from "./lib/staffCapabilities";

/** Server-side mirror of the route's tool filtering. Throws on off-role calls. */
async function requireTool(
  ctx: QueryCtx,
  user: Doc<"users">,
  tool: ScholarReadToolName,
): Promise<void> {
  const schoolOperationsInstitutions =
    user.role === ROLES.STAFF
      ? await schoolOperationsInstitutionIds(ctx, user)
      : new Set<Id<"institutions">>();
  const hasSchoolOperationsAccess =
    schoolOperationsInstitutions !== "all" &&
    schoolOperationsInstitutions.size > 0;
  if (
    !isScholarReadToolAllowed(user.role as Role | undefined, tool, {
      hasSchoolOperationsAccess,
    })
  ) {
    throw new Error(`Forbidden: your role may not use ${tool}`);
  }
}

/**
 * The scholars this caller may read about. `null` = unrestricted platform
 * admin. Teachers and school admins get the union of scholars
 * from their institution-scoped staff memberships. Base `staff` get every
 * scholar at institutions where they hold a school:operations grant. Parents
 * get their linked children (guardianships); scholars get themselves; everyone
 * else gets nothing.
 */
async function allowedScholarIdSet(
  ctx: QueryCtx,
  user: Doc<"users">,
): Promise<Set<Id<"users">> | null> {
  if (isPlatformAdminRole(user.role)) return null;
  if (user.role === ROLES.STAFF) {
    const resolvedInstitutionIds = await schoolOperationsInstitutionIds(ctx, user);
    const institutionIds =
      resolvedInstitutionIds === "all"
        ? new Set<Id<"institutions">>()
        : resolvedInstitutionIds;
    const allowed = new Set<Id<"users">>();
    for (const institutionId of institutionIds) {
      const scholars = await ctx.db
        .query("users")
        .withIndex("by_institution", (q) => q.eq("institutionId", institutionId))
        .collect();
      for (const scholar of scholars) {
        if (scholar.role === ROLES.SCHOLAR) allowed.add(scholar._id);
      }
    }
    return allowed;
  }
  if (isTeacherRole(user.role)) {
    const memberships = await ctx.db
      .query("memberships")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const scopedMemberships = memberships.filter((membership) => {
      // Role changes retain old membership rows. Never let a lower-privilege
      // membership inherit the caller's broader MCP tool permissions.
      return (
        membership.role === ROLES.TEACHER ||
        membership.role === ROLES.SCHOOL_ADMIN
      );
    });
    const membershipScholarIdSets = await Promise.all(
      scopedMemberships.map((membership) =>
        accessibleScholarIds(ctx, membership),
      ),
    );
    const allowed = new Set<Id<"users">>();
    for (const membershipScholarIds of membershipScholarIdSets) {
      for (const scholarId of membershipScholarIds) {
        allowed.add(scholarId);
      }
    }
    return allowed;
  }
  if (user.role === ROLES.PARENT) {
    const links = await ctx.db
      .query("guardianships")
      .withIndex("by_parent", (q) => q.eq("parentUserId", user._id))
      .collect();
    return new Set(links.map((l) => l.scholarUserId));
  }
  if (user.role === ROLES.SCHOLAR) return new Set([user._id]);
  return new Set();
}

/**
 * Resolve a scholar by case-insensitive partial name match WITHIN the
 * caller's allowed set — same semantics as the aide's
 * resolveScholarByName (lib/scholarReadTools.ts), including the
 * empty-query refusal: this is the chokepoint that makes it impossible
 * for a scoped caller to turn another scholar's name into data.
 *
 * Deliberately resolves Extended Education (program-guest) scholars too:
 * naming a scholar IS the opt-in — only enumerations default to enrolled
 * (lib/scholarParticipationTooling.ts).
 */
async function resolveScholarForUser(
  ctx: QueryCtx,
  user: Doc<"users">,
  scholarName: string,
): Promise<Doc<"users"> | null> {
  const lower = scholarName.trim().toLowerCase();
  if (!lower) return null;
  const allowed = await allowedScholarIdSet(ctx, user);
  const scholars = await ctx.db
    .query("users")
    .withIndex("by_role", (q) => q.eq("role", ROLES.SCHOLAR))
    .collect();
  const candidates = allowed
    ? scholars.filter((s) => allowed.has(s._id))
    : scholars;
  return (
    candidates.find((s) => (s.name ?? "").toLowerCase().includes(lower)) ??
    null
  );
}

// ── Identity ───────────────────────────────────────────────────────────

/**
 * Who is this access token? The route calls this on every MCP request —
 * both as the 401 probe (an invalid/expired JWT throws "Not
 * authenticated") and to pick which tools to expose. `scholarNames` is
 * populated for scoped callers (parent/scholar) so the connector can say
 * which children/self it covers without a roster tool.
 */
export const whoami = authedQuery({
  args: {},
  handler: async (ctx) => {
    const role = (ctx.user.role ?? ROLES.SCHOLAR) as Role;
    let scholarNames: string[] | null = null;
    if (role === ROLES.PARENT || role === ROLES.SCHOLAR) {
      const allowed = await allowedScholarIdSet(ctx, ctx.user);
      const names: string[] = [];
      for (const id of allowed ?? []) {
        const scholar = await ctx.db.get(id);
        if (scholar?.role === ROLES.SCHOLAR) names.push(scholar.name ?? "Scholar");
      }
      scholarNames = names;
    }
    const operationInstitutions =
      role === ROLES.STAFF
        ? await schoolOperationsInstitutionIds(ctx, ctx.user)
        : new Set<Id<"institutions">>();
    const schoolOperations =
      operationInstitutions !== "all" && operationInstitutions.size > 0;
    return {
      name: ctx.user.name ?? ctx.user.username ?? "User",
      role,
      scholarNames,
      schoolOperations,
    };
  },
});

// ── Roster ─────────────────────────────────────────────────────────────

export const listScholars = authedQuery({
  args: { includeExtendedEducation: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "list_scholars");
    const allowed = await allowedScholarIdSet(ctx, ctx.user);
    // The enrolled-only default applies unconditionally: identity-scoped
    // roles (parent/scholar) are exempt STRUCTURALLY — requireTool above
    // already refuses them this enumeration (lib/scholarReadPolicy.ts).
    const { scholars: rows, extendedEducationOmitted } =
      await readScholarRoster(ctx, allowed, {
        includeProgramGuests: args.includeExtendedEducation === true,
      });
    // Operations-only staff are walled off from learning measurements — same
    // redaction as their aide tool and users.listScholars.
    const roster =
      ctx.user.role === ROLES.STAFF
        ? rows.map((s) => ({
            id: s.id,
            name: s.name,
            sessionCount: s.sessionCount,
            ...(s.extendedEducation === true
              ? { extendedEducation: true as const }
              : {}),
          }))
        : rows;
    const note = extendedEducationOmittedNote(extendedEducationOmitted);
    // Always the same shape — a data-dependent bare-array union would break
    // typed clients the day the first guest enrolls; the note rides along
    // only when guests were omitted, so the model learns the opt-in exists.
    return { scholars: roster, ...(note ? { note } : {}) };
  },
});

// ── Per-scholar reads (name-keyed, scope-resolved) ─────────────────────
// Each returns null when no scholar in the caller's allowed set matches —
// deliberately indistinguishable from "doesn't exist" so a scoped caller
// can't probe the roster by name.

export const getScholarDossier = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_dossier");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    const [dossier, sourceDocuments] = await Promise.all([
      readScholarDossier(ctx, scholar._id),
      readScholarDocuments(ctx, scholar._id),
    ]);
    return {
      scholar: scholar.name ?? "Scholar",
      dossier,
      sourceDocuments,
    };
  },
});

export const getScholarMastery = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_mastery");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      mastery: await readScholarMastery(
        ctx,
        scholar._id,
        ctx.user.role as Role | undefined,
      ),
    };
  },
});

export const getScholarSignals = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_signals");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      signals: await readScholarSignals(ctx, scholar._id),
    };
  },
});

export const getScholarSeeds = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_seeds");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      seeds: await readScholarSeeds(ctx, scholar._id),
    };
  },
});

export const getScholarObservations = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_observations");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      observations: await readScholarObservations(ctx, scholar._id),
    };
  },
});

export const getScholarSessions = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_sessions");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      scholarId: scholar._id,
      sessions: await readScholarSessions(ctx, scholar._id),
    };
  },
});

export const getSessionTranscript = authedQuery({
  args: {
    scholarName: v.string(),
    sessionId: v.optional(v.id("sessions")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_session_transcript");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    const transcript = await readSessionTranscript(ctx, scholar._id, {
      sessionId: args.sessionId,
      limit: args.limit,
    });
    if (!transcript) return null;
    return { scholar: scholar.name ?? "Scholar", ...transcript };
  },
});

export const getScholarWebActivity = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_web_activity");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      webActivity: await readScholarWebActivity(ctx, scholar._id),
    };
  },
});

export const getScholarPractice = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_practice");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    const practice = await readScholarPractice(ctx, scholar._id);
    // REDACTION (centralized, role-tiered): parents get trend altitude (no due
    // backlog, no misconceptions); scholars keep due-for-review but not
    // misconceptions; teacher/admin get everything.
    return {
      scholar: scholar.name ?? "Scholar",
      ...redactScholarPractice(practice, ctx.user.role as Role | undefined),
    };
  },
});

export const getScholarMathCheckIn = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    // Teacher/admin only via the policy table — not Tier-1, so this never
    // reaches a parent or a scholar.
    await requireTool(ctx, ctx.user, "get_scholar_math_checkin");
    // resolveScholarForUser matches ONLY within allowedScholarIdSet, so an
    // out-of-lens name resolves to null and returns before any read.
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      ...(await readScholarMathCheckIn(ctx, scholar._id)),
    };
  },
});

export const getSchoolCalendar = authedQuery({
  args: { scholarName: v.string() },
  // Explicit return type: without it the runQuery hop below becomes a circular
  // inference and degrades `api`/`internal` typing across the whole codebase.
  handler: async (
    ctx,
    args,
  ): Promise<{
    scholar: string;
    calendar: ScholarSchoolCalendar | null;
    subscriptionUrl?: string;
  } | null> => {
    await requireTool(ctx, ctx.user, "get_school_calendar");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    // The scholar name is how this surface scopes a request, and resolution is
    // already confined to the caller's allowed set — so the institution we
    // read from here is one the caller may already see.
    const calendar = await ctx.runQuery(
      internal.academicCalendar.getScholarCalendar,
      { scholarId: scholar._id },
    );
    // The tool description promises a subscription address, so return one —
    // per-school, never the bare /calendar.ics (which resolves to the primary
    // institution and would be the wrong year for another school's family).
    const siteBase = process.env.CONVEX_SITE_URL ?? "";
    return {
      scholar: scholar.name ?? "Scholar",
      calendar,
      subscriptionUrl:
        calendar && siteBase
          ? withBase(
              siteBase,
              `/calendar.ics?school=${encodeURIComponent(calendar.schoolSlug)}`,
            )
          : undefined,
    };
  },
});

export const getScholarDocuments = authedQuery({
  args: { scholarName: v.string() },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_documents");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      documents: await readScholarDocuments(ctx, scholar._id),
    };
  },
});

export const getScholarWorkSamples = authedQuery({
  args: {
    scholarName: v.string(),
    query: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTool(ctx, ctx.user, "get_scholar_work_samples");
    const scholar = await resolveScholarForUser(ctx, ctx.user, args.scholarName);
    if (!scholar) return null;
    return {
      scholar: scholar.name ?? "Scholar",
      workSamples: await readScholarWorkSamples(ctx, scholar._id, {
        query: args.query,
        limit: args.limit,
      }),
    };
  },
});

// ── Curriculum/design surface (proxied through the shared assemble layer) ─
// The classroom-bot + curriculum tools, mirrored for the OAuth MCP
// connector so the SAME ops work from Claude desktop. Rather than
// hand-maintaining a parallel copy of each tool (the old per-wrapper
// query/mutation surface), these two actions proxy straight to
// `assembleCurriculumTools` — the single role-gated source the aide stream
// and Slack bot already use. A new tool or a gating change there reaches
// MCP for free.
//
// The role gate IS the assemble layer: it returns only the tools the
// caller's role may use (teacher/admin get the unit reads + scholar-scoped
// writes + assignment ops; designers get the scholar-agnostic reads;
// operations staff/parent/scholar get nothing here). The WRITE tools are
// additionally owner-checked inside the shared internal fns
// (a.teacherId === callerUserId). The route's tool filtering is UX; this
// gate is the boundary.
//
// Scholar-DETAIL reads (list_scholars, dossier, mastery, …) are excluded
// here — the route keeps its own redaction-aware, prettily formatted path
// for those (the `getScholar*` queries above), so we'd otherwise register
// them twice.

/** Structural view of a runnable assembled tool. The assembled array is a
 *  union that also includes Anthropic-hosted and predefined tools that MCP
 *  cannot proxy; `isMcpRunnableTool` narrows to JSON-schema custom tools. */
interface RunnableTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  run: (input: unknown) => Promise<string>;
}

function isMcpRunnableTool(tool: {
  name?: unknown;
  input_schema?: unknown;
  run?: unknown;
}): tool is RunnableTool {
  return (
    typeof tool.name === "string" &&
    typeof tool.run === "function" &&
    typeof tool.input_schema === "object" &&
    tool.input_schema !== null &&
    !Array.isArray(tool.input_schema)
  );
}

// The unit-scoped designer has a larger assembled set (scholar reads,
// assignment scheduling, and web tools) than the MCP editing surface needs.
// Keep this list in the MCP boundary so its tools retain the designer's
// implementation while callers receive only in-place unit CRUD.
const UNIT_DESIGNER_CRUD_TOOL_NAMES = new Set([
  "read_unit_structure",
  "update_unit",
  "create_lesson",
  "update_lesson",
  "delete_lesson",
  "generate_lesson_prompt",
  "generate_all_prompts",
  "create_activity",
  "list_activity_kind_catalog",
  "create_game_activity",
  "create_web_activity",
  "create_share_back_activity",
  "create_simulator_activity",
  "update_simulator_spec",
  "create_simulator_activity",
  "update_simulator",
  "list_simulator_templates",
  "update_activity",
  "delete_activity",
  "reorder_activities",
  "generate_activity_prompt",
  "create_slides_deck",
  "read_deck",
  "apply_deck_edits",
]);
const unitDesignerMcpName = (name: string) => `unit_${name}`;

const unitIdProperty = {
  type: "string",
  description: "The Rabbithole unit ID to read or edit.",
};

function withUnitId(
  inputSchema: Record<string, unknown>,
): Record<string, unknown> {
  const properties = (inputSchema.properties ?? {}) as Record<string, unknown>;
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required.filter((value): value is string => typeof value === "string")
    : [];
  return {
    ...inputSchema,
    properties: { ...properties, unitId: unitIdProperty },
    required: [...new Set(["unitId", ...required])],
  };
}

/** Resolve the access token → caller identity, the same way the route's
 *  whoami probe does. Throws "Not authenticated" on a missing/expired JWT. */
async function resolveMcpCaller(
  ctx: ActionCtx,
): Promise<{ userId: Id<"users">; role: Role }> {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Not authenticated");
  const user = await ctx.runQuery(internal.users.getByIdInternal, { id: userId });
  if (!user) throw new Error("Not authenticated");
  return { userId, role: (user.role ?? ROLES.SCHOLAR) as Role };
}

/**
 * The action context cannot access the database directly. This internal query
 * is the per-call authorization boundary for the MCP unit-designer proxy:
 * role, active institution, and unit institution are checked by the same
 * helper used by the web editor before any assembled internal CRUD runs.
 */
export const authorizeUnitDesignerTool = internalQuery({
  args: { callerUserId: v.id("users"), unitId: v.id("units") },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.callerUserId);
    if (!user) throw new Error("Not authenticated");
    const { unit } = await requireUnitEditAccessForUser(ctx, user, {
      unitId: args.unitId,
    });
    // The owning institution travels with the title so the designer toolset
    // can scope its scholar lens to the unit's school rather than silently
    // falling back to the caller's home institution (see mcpUnitDesignerTools).
    return {
      unitTitle: unit.title,
      institutionScope: unit.institutionId ? String(unit.institutionId) : "",
    };
  },
});

/** The MCP-exposed curriculum toolset for a caller: the role-gated assemble
 *  output minus the scholar-detail reads (kept on the route's own path) and
 *  the tools MCP cannot proxy. Anthropic predefined tool types intentionally
 *  carry no JSON `input_schema` and require ToolRunner context (including the
 *  tool_use id), so they must stay out of both MCP listing and dispatch.
 *  `listCurriculumTools` and `callCurriculumTool` share this so what's listed
 *  is exactly what's callable. */
async function mcpCurriculumTools(
  ctx: ActionCtx,
  role: Role,
  callerUserId: Id<"users">,
): Promise<RunnableTool[]> {
  // The curriculum/design surface is STAFF territory. assembleCurriculumTools
  // is built for the staff aide and only walls operations staff OFF the unit reads —
  // it implicitly trusts the caller to be staff, so a parent/scholar would
  // otherwise be handed the unit reads + the sim kickoffs. Over MCP a
  // parent/scholar IS a possible caller, so gate the whole surface here; they
  // keep only their scholar-read tools (the route's own path).
  if (!isStaffRole(role)) return [];
  const schoolOperations =
    role === ROLES.STAFF
      ? await ctx.runQuery(
          internal.curriculumAssistant.schoolOperationsScopeForUser,
          { callerUserId },
        )
      : null;
  const healthInstitutions =
    role === ROLES.STAFF
      ? await ctx.runQuery(internal.users.healthInstitutionIdsInternal, {
          id: callerUserId,
        })
      : [];
  // The institution scholar lens is MANDATORY for every staff-class caller,
  // not just ROLES.STAFF. `isStaffRole` also admits teacher / school_admin /
  // curriculum_designer / operations staff, and those callers used to reach the aide
  // WRITE toolset with NO lens at all — which additionally made customApps'
  // assertTargetsWithinLens a no-op, so a teacher could land a launcher tile
  // on another school's scholar. A school-operations caller keeps its NARROWER
  // grant-scoped set; everyone else resolves the same institution lens every
  // other aide transport (http /aide-stream, Slack, the unit designer) uses.
  let allowedScholarIds: Set<Id<"users">> | undefined;
  let lensLabel: string | null = null;
  if (schoolOperations) {
    allowedScholarIds = new Set<Id<"users">>(schoolOperations.scholarIds);
    lensLabel = "your granted school operations institutions";
  } else {
    const lens = await ctx.runQuery(
      internal.curriculumAssistant.resolveAideScholarLens,
      { callerUserId, scope: "" },
    );
    // `unrestricted` is the ONLY legitimate no-lens case (a platform admin who
    // may see every institution). Everyone else gets an explicit id set.
    if (!lens.unrestricted) {
      allowedScholarIds = new Set<Id<"users">>(lens.scholarIds ?? []);
      lensLabel = lens.lensLabel;
    }
  }

  const noopEmit: AideEmit = () => {};
  const tools = await assembleCurriculumTools(ctx, noopEmit, {
    role,
    callerUserId,
    // No chat thread in the MCP context, so tag_session is naturally out.
    sessionId: null,
    guardianFormAnswersSurface: "private",
    // Absolute deep links (like Slack) — the connector is an external client.
    linkBase: siteUrl(),
    allowedScholarIds,
    // Always true — the lens above is resolved server-side for EVERY caller,
    // so downstream fail-closed guards can trust it was actually considered.
    scholarLensResolved: true,
    lensLabel,
    hasSchoolOperationsAccess: schoolOperations
      ? schoolOperations.institutionIds.length > 0
      : false,
    hasHealthManagementAccess:
      healthInstitutions === "all" || healthInstitutions.length > 0,
  });
  const scholarReadNames = SCHOLAR_READ_TOOLS as readonly string[];
  return (
    tools as {
      name?: unknown;
      input_schema?: unknown;
      run?: unknown;
    }[]
  )
    .filter(isMcpRunnableTool)
    .filter((t) => !scholarReadNames.includes(t.name));
}

async function mcpUnitDesignerTools(
  ctx: ActionCtx,
  role: Role,
  callerUserId: Id<"users">,
  unitId?: Id<"units">,
): Promise<RunnableTool[]> {
  // MCP exposes editing of shared curriculum units only to curriculum roles.
  // The per-call internal check below additionally enforces active
  // institution, unit access, and ownership rules before tool execution.
  if (!isCurriculumRole(role)) return [];

  let unitTitle: string | undefined;
  // Scope the designer's scholar lens to the institution that OWNS the open
  // unit, exactly as unitDesignerStream does. Without this an admin editing
  // another school's unit was lensed to their own home institution — school B
  // served school A's scholars while believing they were B's own. Empty string
  // (no unit yet) keeps the documented caller's-home-institution fallback.
  let institutionScope = "";
  if (unitId) {
    const access = await ctx.runQuery(internal.mcp.authorizeUnitDesignerTool, {
      callerUserId,
      unitId,
    });
    unitTitle = access.unitTitle;
    institutionScope = access.institutionScope;
  }

  const tools = await assembleUnitDesignerTools(ctx, () => {}, {
    teacherId: callerUserId,
    unitId: unitId ?? ("unit_placeholder" as Id<"units">),
    role,
    unitTitle,
    institutionScope,
  });
  return (
    tools as {
      name?: unknown;
      input_schema?: unknown;
      run?: unknown;
    }[]
  )
    .filter(isMcpRunnableTool)
    .filter((tool) => UNIT_DESIGNER_CRUD_TOOL_NAMES.has(tool.name));
}

/**
 * tools/list for the curriculum surface — the role-gated set of tool
 * descriptors (name + description + JSON-Schema input) the route registers
 * generically. The JSON Schema passes through verbatim (the route uses a
 * low-level MCP Server whose `Tool.inputSchema` is raw JSON Schema), so no
 * lossy JSON-Schema→Zod conversion of the deeply-nested deliverable fragment.
 */
export const listCurriculumTools = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    { name: string; description: string; inputSchema: Record<string, unknown> }[]
  > => {
    const { userId, role } = await resolveMcpCaller(ctx);
    const tools = await mcpCurriculumTools(ctx, role, userId);
    return tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.input_schema,
    }));
  },
});

/**
 * tools/call for the curriculum surface — runs ONE assembled tool by name
 * with the client's input and returns the tool's text result. Re-resolves
 * the caller + re-asserts the role gate on every call: a name outside the
 * caller's allowed set throws "Forbidden: <name>" (indistinguishable from a
 * tool that doesn't exist for this role), so a scoped client can't reach a
 * write tool by guessing its name.
 */
export const callCurriculumTool = action({
  args: { name: v.string(), input: v.optional(v.any()) },
  handler: async (ctx, { name, input }): Promise<string> => {
    const { userId, role } = await resolveMcpCaller(ctx);
    const tools = await mcpCurriculumTools(ctx, role, userId);
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Forbidden: ${name}`);
    return await tool.run(input ?? {});
  },
});

/** Descriptors for unit-designer CRUD tools. Every tool takes `unitId`, so an
 * MCP client can edit any authorized shared unit in place rather than holding
 * a unit-specific server session. */
export const listUnitDesignerTools = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<
    { name: string; description: string; inputSchema: Record<string, unknown> }[]
  > => {
    const { userId, role } = await resolveMcpCaller(ctx);
    const tools = await mcpUnitDesignerTools(ctx, role, userId);
    return tools.map((tool) => ({
      // Some designer primitives (for example list_simulator_templates) also
      // appear in the global curriculum set. MCP requires globally unique
      // names, so namespace this per-unit transport without duplicating its
      // implementation.
      name: unitDesignerMcpName(tool.name),
      description: tool.description ?? "",
      inputSchema: withUnitId(tool.input_schema),
    }));
  },
});

/** Executes one unit-designer CRUD tool after authorizing the submitted unit
 * ID. The ID is removed before dispatch because the shared tools already close
 * over the authorized unit. */
export const callUnitDesignerTool = action({
  args: {
    name: v.string(),
    unitId: v.id("units"),
    input: v.optional(v.any()),
  },
  handler: async (ctx, { name, unitId, input }): Promise<string> => {
    const { userId, role } = await resolveMcpCaller(ctx);
    const tools = await mcpUnitDesignerTools(ctx, role, userId, unitId);
    if (!name.startsWith("unit_")) throw new Error(`Forbidden: ${name}`);
    const toolName = name.slice("unit_".length);
    const tool = tools.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`Forbidden: ${name}`);
    const { unitId: _unitId, ...toolInput } =
      (input ?? {}) as Record<string, unknown>;
    return await tool.run(toolInput);
  },
});

// Staff-aide transport for the existing teacher-facing Math plan surface.
// The tools resolve a named scholar, then delegate policy and validation to
// the gated internal twins of mathPlans.planEditor/saveForScholar.

import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { AideEmit } from "./aideStream";
import { PRACTICE_DOMAINS } from "./practice/domains";
import type { PracticeScope } from "./practice/mathPlan";
import { isTeacherRole, type Role } from "./roles";
import {
  matchScholarByName,
  resolveScholarByName,
} from "./scholarReadTools";
import { humanizeStrand } from "../../shared/practiceDomainLabels";

type CheckpointTarget = {
  domain: string;
  strand?: string;
  grade: string;
};

type PlanEditorResult = {
  practiceScope: PracticeScope;
  scopeSource: "math_plan" | "legacy_standing" | "open_default";
  checkpoint: CheckpointTarget | null;
  groupCheckpoint: CheckpointTarget | null;
  conflict: boolean;
  domains: Array<{
    domain: string;
    label: string;
    strands: Array<{ strand: string; label: string }>;
  }>;
};

type DomainProgress = {
  domain: string;
  started: boolean;
};

type CheckInDomain = {
  domain: string;
  status:
    | "converged"
    | "in_flight"
    | "shadow_placed"
    | "queued"
    | "available"
    | "ineligible"
    | null;
  probesAnswered: number;
};

type PlacementSummary = {
  domain: string;
  placedThroughGrade: string | null;
};

type DomainMap = {
  domain: string;
  status: Exclude<CheckInDomain["status"], null>;
};

type ActiveStanding = {
  domains: string[];
} | null;

const DOMAIN_SLUGS = PRACTICE_DOMAINS.map(({ domain }) => domain);
const DOMAIN_LABELS = new Map(
  PRACTICE_DOMAINS.map(({ domain, label }) => [domain, label]),
);

export async function makeMathPlanTools(
  ctx: ActionCtx,
  emit: AideEmit,
  opts: {
    role: Role | null | undefined;
    callerUserId: Id<"users">;
    allowedScholarIds?: Set<Id<"users">>;
  },
) {
  if (!isTeacherRole(opts.role)) return [];
  const { callerUserId, allowedScholarIds } = opts;
  const { betaTool } = await import(
    "@anthropic-ai/sdk/helpers/beta/json-schema"
  );

  const domainDescription = `One of: ${DOMAIN_SLUGS.join(", ")}`;

  async function readPlan(scholarId: Id<"users">, scholarName: string) {
    const editor = (await ctx.runQuery(internal.mathPlans.aidePlanEditor, {
      callerUserId,
      scholarId,
    })) as PlanEditorResult;
    const [progress, checkIn, placementSummaries, domainMap, activeStanding] = await Promise.all([
      ctx.runQuery(internal.practiceSkills.domainsForScholarInternal, {
        scholarId,
      }) as Promise<DomainProgress[]>,
      ctx.runQuery(internal.curriculumAssistant.getScholarMathCheckIn, {
        scholarId,
      }) as Promise<{ domains: CheckInDomain[] }>,
      ctx.runQuery(
        internal.practiceSkills.placementSummariesForScholarInternal,
        { scholarId },
      ) as Promise<PlacementSummary[]>,
      ctx.runQuery(
        internal.practiceSkills.domainMapForScholarInternal,
        { scholarId },
      ) as Promise<DomainMap[]>,
      ctx.runQuery(
        internal.standingPractice.activeStandingForScholarInternal,
        { scholarId },
      ) as Promise<ActiveStanding>,
    ]);

    const editorDomain = new Map(editor.domains.map((domain) => [domain.domain, domain]));
    const scopeEntry =
      editor.practiceScope.kind === "limited"
        ? new Map(editor.practiceScope.domains.map((entry) => [entry.domain, entry]))
        : null;
    const started = new Set(
      progress.filter((domain) => domain.started).map((domain) => domain.domain),
    );
    const checkInByDomain = new Map(
      checkIn.domains.map((domain) => [domain.domain, domain]),
    );
    const mapStatusByDomain = new Map(
      domainMap.map((entry) => [entry.domain, entry.status]),
    );
    const placementSummaryByDomain = new Map(
      placementSummaries.map((summary) => [summary.domain, summary]),
    );
    const legacyStandingDomains = new Set(activeStanding?.domains ?? []);
    const presentCheckpoint = <T extends CheckpointTarget>(target: T) => ({
      ...target,
      domainLabel: DOMAIN_LABELS.get(target.domain) ?? target.domain,
      ...(target.strand
        ? { strandLabel: humanizeStrand(target.strand) }
        : {}),
    });

    const practiceScope =
      editor.practiceScope.kind === "open"
        ? { kind: "open" as const }
        : {
            kind: "limited" as const,
            domains: editor.practiceScope.domains.map((entry) => ({
              domain: entry.domain,
              label: DOMAIN_LABELS.get(entry.domain) ?? entry.domain,
              ...(entry.strands
                ? {
                    strands: entry.strands.map((strand) => ({
                      strand,
                      label: humanizeStrand(strand),
                    })),
                  }
                : {}),
            })),
          };

    const domains = PRACTICE_DOMAINS.map(({ domain, label }) => {
      const definition = editorDomain.get(domain);
      const entry = scopeEntry?.get(domain);
      const inPlan =
        editor.practiceScope.kind === "open" || entry !== undefined;
      const strandsInPlan = !inPlan
        ? []
        : entry?.strands
          ? entry.strands.map((strand) => ({
              strand,
              label: humanizeStrand(strand),
            }))
          : (definition?.strands ?? []).map(({ strand, label: strandLabel }) => ({
              strand,
              label: strandLabel,
            }));
      const placement = checkInByDomain.get(domain);
      const mapStatus = mapStatusByDomain.get(domain);
      const placedThroughGrade =
        placementSummaryByDomain.get(domain)?.placedThroughGrade ?? null;
      const state =
        mapStatus === "converged"
          ? "complete"
          : mapStatus === "in_flight"
            ? "in_progress"
            : mapStatus === "shadow_placed"
              ? "placed_without_checkin"
            : "not_started";

      return {
        domain,
        label,
        inPlan,
        strandsInPlan,
        checkIn: {
          state,
          probesAnswered: placement?.probesAnswered ?? 0,
          ...(placedThroughGrade ? { placedThroughGrade } : {}),
        },
        // Mirrors components/practice/PlaylistCard.tsx and
        // native/src/components/practice/PracticePlaylistCard.tsx. An explicit
        // limited plan shows its domains; an explicit open plan shows domains
        // already started. Without an explicit plan, legacy standing governs.
        shownInDomainSwitcher:
          editor.scopeSource === "math_plan"
            ? editor.practiceScope.kind === "limited"
              ? inPlan
              : started.has(domain)
            : editor.scopeSource === "legacy_standing"
              ? legacyStandingDomains.has(domain)
              : false,
      };
    });

    return {
      scholar: scholarName,
      practiceScope,
      scopeSource: editor.scopeSource,
      checkpoint: editor.checkpoint
        ? presentCheckpoint(editor.checkpoint)
        : null,
      groupCheckpoint: editor.groupCheckpoint
        ? presentCheckpoint(editor.groupCheckpoint)
        : null,
      checkpointSuppressed:
        editor.checkpoint === null && editor.groupCheckpoint !== null,
      conflict: editor.conflict,
      domains,
    };
  }

  async function resolveScholarStrict(scholarName: string) {
    const { scholars } = (await ctx.runQuery(
      internal.curriculumAssistant.listScholarsInternal,
      {
        includeProgramGuests: true,
        ...(allowedScholarIds
          ? { allowedScholarIds: [...allowedScholarIds] }
          : {}),
      },
    )) as { scholars: Array<{ id: string; name: string }> };
    const visible = allowedScholarIds
      ? scholars.filter((scholar) =>
          allowedScholarIds.has(scholar.id as Id<"users">),
        )
      : scholars;
    return matchScholarByName(scholarName, visible);
  }

  const getPlanTool = betaTool({
    name: "get_scholar_math_plan",
    description:
      "Read a scholar's current teacher-authored Math plan: Practice scope, optional Checkpoint, per-domain check-in state, and whether each domain is shown in the scholar's domain switcher. `placed_without_checkin` means mastery rows exist from placement/accelerated credit but no check-in run converged. `conflict: true` means the Checkpoint is outside the Practice scope; widen the scope, move the Checkpoint, or clear it before treating the plan as coherent. Use this before diagnosing a missing Math domain or before any set_scholar_math_plan change. Read-only.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's name (case-insensitive partial match).",
        },
      },
      required: ["scholarName"] as const,
    },
    run: async (input: { scholarName: string }) => {
      const scholar = await resolveScholarByName(
        ctx,
        input.scholarName,
        allowedScholarIds,
      );
      if (!scholar) {
        const result = `No scholar matched "${input.scholarName}"`;
        emit({
          toolComplete: { name: "get_scholar_math_plan", result },
        });
        return `${result}.`;
      }
      const plan = await readPlan(
        scholar.id as Id<"users">,
        scholar.name,
      );
      emit({
        toolComplete: {
          name: "get_scholar_math_plan",
          result: `Read ${scholar.name}'s Math plan`,
        },
      });
      return JSON.stringify(plan);
    },
  });

  const setPlanTool = betaTool({
    name: "set_scholar_math_plan",
    description:
      "Replace one scholar's complete Math plan. FIRST call get_scholar_math_plan, state the exact before → after diff to the teacher, and get explicit confirmation. Refuse an ambiguous scholar name. practiceScope is the FULL desired scope and REPLACES the current scope; it does not merge, so preserve every domain the teacher did not explicitly ask to remove. Pass checkpoint as the complete effective target, or null to remove the scholar's effective Checkpoint; null also suppresses an inherited group Checkpoint. The only geometry domain is `geometry-measurement`, an elementary grades 1–6 domain; Rabbithole has no high-school Geometry domain, so say that plainly when a teacher asks for \"geometry\" rather than implying otherwise. Dispatching or pushing an activity does not change this plan. Returns a read-back of the saved plan.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scholarName: {
          type: "string" as const,
          description: "The scholar's exact, unambiguous name.",
        },
        practiceScope: {
          anyOf: [
            {
              type: "object" as const,
              properties: {
                kind: { type: "string" as const, const: "open" },
              },
              required: ["kind"] as const,
              additionalProperties: false,
            },
            {
              type: "object" as const,
              properties: {
                kind: { type: "string" as const, const: "limited" },
                domains: {
                  type: "array" as const,
                  minItems: 1,
                  items: {
                    type: "object" as const,
                    properties: {
                      domain: {
                        type: "string" as const,
                        enum: DOMAIN_SLUGS,
                        description: domainDescription,
                      },
                      strands: {
                        type: "array" as const,
                        minItems: 1,
                        items: { type: "string" as const },
                        description:
                          "Optional selected strand slugs. Omit to include the whole domain.",
                      },
                    },
                    required: ["domain"] as const,
                    additionalProperties: false,
                  },
                },
              },
              required: ["kind", "domains"] as const,
              additionalProperties: false,
            },
          ],
        },
        checkpoint: {
          anyOf: [
            {
              type: "object" as const,
              properties: {
                domain: {
                  type: "string" as const,
                  enum: DOMAIN_SLUGS,
                  description: domainDescription,
                },
                strand: { type: "string" as const },
                grade: { type: "string" as const },
              },
              required: ["domain", "grade"] as const,
              additionalProperties: false,
            },
            { type: "null" as const },
          ],
          description:
            "The complete effective Checkpoint target, or null to remove it and suppress any inherited group Checkpoint.",
        },
      },
      required: ["scholarName", "practiceScope", "checkpoint"] as const,
    },
    run: async (input: {
      scholarName: string;
      practiceScope: PracticeScope;
      checkpoint: CheckpointTarget | null;
    }) => {
      const match = await resolveScholarStrict(input.scholarName);
      if (match.kind === "ambiguous") {
        const result = `Ambiguous scholar "${input.scholarName}" matches ${match.candidates.map((candidate) => candidate.name).join(", ")}. Use the exact name; no change was made.`;
        emit({
          toolComplete: { name: "set_scholar_math_plan", result },
        });
        return result;
      }
      if (match.kind === "none") {
        const result = `No scholar matched "${input.scholarName}". No change was made.`;
        emit({
          toolComplete: { name: "set_scholar_math_plan", result },
        });
        return result;
      }
      const scholar = {
        id: match.scholar.id as Id<"users">,
        name: match.scholar.name,
      };
      await ctx.runMutation(internal.mathPlans.aideSaveForScholar, {
        callerUserId,
        scholarId: scholar.id,
        practiceScope: input.practiceScope,
        checkpoint: input.checkpoint,
      });
      const readBack = await readPlan(scholar.id, scholar.name);
      emit({
        toolComplete: {
          name: "set_scholar_math_plan",
          result: `Updated ${scholar.name}'s Math plan`,
        },
      });
      return JSON.stringify(readBack);
    },
  });

  return [getPlanTool, setPlanTool];
}

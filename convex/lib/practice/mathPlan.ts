import type { Id } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";

export type PracticeScope =
  | { kind: "open" }
  | { kind: "limited"; domains: Array<{ domain: string; strands?: string[] }> };

export type PracticeScopeSource =
  | "math_plan"
  | "legacy_standing"
  | "open_default";

type DbCtx = Pick<QueryCtx | MutationCtx, "db">;

export function normalizePracticeScope(scope: PracticeScope): PracticeScope {
  if (scope.kind === "open") return { kind: "open" };
  const byDomain = new Map<string, Set<string> | null>();
  for (const entry of scope.domains) {
    const existing = byDomain.get(entry.domain);
    if (entry.strands === undefined) {
      byDomain.set(entry.domain, null);
    } else if (existing !== null) {
      byDomain.set(
        entry.domain,
        new Set([...(existing ?? []), ...entry.strands]),
      );
    }
  }
  return {
    kind: "limited",
    domains: [...byDomain.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, strands]) =>
        strands === null
          ? { domain }
          : { domain, strands: [...strands].sort((a, b) => a.localeCompare(b)) },
      ),
  };
}

export function practiceScopeAllowsDomain(scope: PracticeScope, domain: string) {
  return scope.kind === "open" || scope.domains.some((entry) => entry.domain === domain);
}

export function practiceScopeAllowsNode(
  scope: PracticeScope,
  domain: string,
  strand?: string,
) {
  if (scope.kind === "open") return true;
  const entry = scope.domains.find((item) => item.domain === domain);
  return !!entry && (entry.strands === undefined || (strand !== undefined && entry.strands.includes(strand)));
}

export function practiceScopeAllowsCheckpoint(
  scope: PracticeScope,
  target: { domain: string; strand?: string },
) {
  if (scope.kind === "open") return true;
  const entry = scope.domains.find((item) => item.domain === target.domain);
  if (!entry) return false;
  return target.strand === undefined
    ? entry.strands === undefined
    : entry.strands === undefined || entry.strands.includes(target.strand);
}

export async function validatePracticeScope(ctx: DbCtx, scope: PracticeScope) {
  const normalized = normalizePracticeScope(scope);
  if (normalized.kind === "limited" && normalized.domains.length === 0) {
    throw new Error("A limited Practice scope needs at least one domain.");
  }
  if (normalized.kind === "open") return normalized;
  for (const entry of normalized.domains) {
    if (entry.strands?.length === 0) {
      throw new Error(
        `Practice scope domain "${entry.domain}" needs at least one strand or the whole domain.`,
      );
    }
    const nodes = await ctx.db
      .query("knowledgeNodes")
      .withIndex("by_domain", (q) => q.eq("domain", entry.domain))
      .collect();
    if (nodes.length === 0) throw new Error(`Unknown practice domain "${entry.domain}".`);
    if (entry.strands) {
      const known = new Set(nodes.map((node) => node.strand).filter(Boolean));
      for (const strand of entry.strands) {
        if (!known.has(strand)) {
          throw new Error(`Unknown practice strand "${strand}" in domain "${entry.domain}".`);
        }
      }
    }
  }
  return normalized;
}

/**
 * A deterministic fingerprint of a Practice scope, used to decide whether a
 * persisted practice-run resume snapshot is still honorable. A resumed run is
 * only restored while the scholar's resolved allowed scope is UNCHANGED since
 * it was served — a Math-plan edit or a standing-assignment change must
 * invalidate an in-flight snapshot rather than let the scholar resume into
 * content they are no longer scoped to. `normalizePracticeScope` already sorts
 * domains and strands, so stringifying the normalized shape is deterministic;
 * this names that as a stable contract rather than an incidental property.
 */
export function practiceScopeKey(scope: PracticeScope): string {
  return JSON.stringify(normalizePracticeScope(scope));
}

export async function resolvePracticeScope(
  ctx: DbCtx,
  scholarId: Id<"users">,
): Promise<{ practiceScope: PracticeScope; source: PracticeScopeSource }> {
  const planRows = await ctx.db
    .query("scholarMathPlans")
    .withIndex("by_scholar", (q) => q.eq("scholarId", scholarId))
    .collect();
  if (planRows.length) {
    const newest = [...planRows].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    return { practiceScope: normalizePracticeScope(newest.practiceScope), source: "math_plan" };
  }
  const standing = (await ctx.db
    .query("assignments")
    .withIndex("by_practice_mode", (q) => q.eq("practiceMode", "standing"))
    .collect()).filter(
    (row) => !row.archivedAt && row.practiceMode === "standing" && row.scholarIds.includes(scholarId),
  );
  if (standing.length === 1) {
    const config = standing[0]!.practiceConfig;
    const domains = config?.domains?.length
      ? config.domains
      : [config?.domain ?? "whole-number-arithmetic"];
    const scopeDomains = domains.map((domain) => ({ domain }));
    if (domains.length === 1 && config?.excludedStrands?.length) {
      const nodes = await ctx.db
        .query("knowledgeNodes")
        .withIndex("by_domain", (q) => q.eq("domain", domains[0]!))
        .collect();
      const excluded = new Set(config.excludedStrands);
      const strands = [
        ...new Set(
          nodes
            .map((node) => node.strand)
            .filter(
              (strand): strand is string =>
                strand !== undefined && !excluded.has(strand),
            ),
        ),
      ];
      if (strands.length === 0) {
        return {
          practiceScope: { kind: "open" },
          source: "legacy_standing",
        };
      }
      const knownDomains = await Promise.all(
        domains.map((domain) =>
          ctx.db
            .query("knowledgeNodes")
            .withIndex("by_domain", (q) => q.eq("domain", domain))
            .first(),
        ),
      );
      if (knownDomains.some((node) => node === null)) {
        return { practiceScope: { kind: "open" }, source: "legacy_standing" };
      }
      return {
        practiceScope: normalizePracticeScope({
          kind: "limited",
          domains: [{ domain: domains[0]!, strands }],
        }),
        source: "legacy_standing",
      };
    }
    return {
      practiceScope: normalizePracticeScope({
        kind: "limited",
        domains: scopeDomains,
      }),
      source: "legacy_standing",
    };
  }
  if (standing.length > 1) {
    const hasComplexStrandConfig = standing.some(
      (assignment) =>
        assignment.practiceConfig?.pinnedStrands?.length ||
        assignment.practiceConfig?.excludedStrands?.length,
    );
    if (hasComplexStrandConfig) {
      return {
        practiceScope: { kind: "open" },
        source: "legacy_standing",
      };
    }
    const domains = [
      ...new Set(
        standing.flatMap((assignment) => {
          const config = assignment.practiceConfig;
          return config?.domains?.length
            ? config.domains
            : [config?.domain ?? "whole-number-arithmetic"];
        }),
      ),
    ];
    const knownDomains = await Promise.all(
      domains.map((domain) =>
        ctx.db
          .query("knowledgeNodes")
          .withIndex("by_domain", (q) => q.eq("domain", domain))
          .first(),
      ),
    );
    if (knownDomains.some((node) => node === null)) {
      return {
        practiceScope: { kind: "open" },
        source: "legacy_standing",
      };
    }
    return {
      practiceScope: normalizePracticeScope({
        kind: "limited",
        domains: domains.map((domain) => ({ domain })),
      }),
      source: "legacy_standing",
    };
  }
  return { practiceScope: { kind: "open" }, source: "open_default" };
}

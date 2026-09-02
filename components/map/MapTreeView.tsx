"use client";

/**
 * MapTreeView — the DATA + REDACTION layer behind the Map's tech-tree skin.
 *
 * Owns everything audience-specific so the canvas stays a dumb renderer:
 *   1. fetches the per-scholar tree (`practiceSkills.treeForScholar`) + depth
 *      readings (`nodeDepth.nodeReadingsForScholar`) — both already server-gated;
 *   2. lays the DAG out left→right with `computeDepths` (treeX's own definition —
 *      longest-prerequisite-path — so we don't need the stored treeX facet or a
 *      new backend query);
 *   3. derives the three dial readings (mastery / automaticity / depth) and
 *      applies the ONE redaction overlay by `audience`;
 *   4. renders <MapTreeCanvas/> and, on node tap, a right-side Chakra Drawer
 *      hosting the <NodeDrawer/> neighbourhood pivot (floats over the map —
 *      no layout reflow).
 *
 * Redaction (the single knob — roadmap §6, "audience = overlay, not a different
 * IA"): scholar → full dial + own readings, NO flags; teacher → + misconception
 * flags + drawer instruments; parent → TIER_1 (mastery/frontier only, arcs
 * zeroed, no flags, no drawer).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { useRouter } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Drawer, Flex, IconButton, Portal, Spinner, Text } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";
import { buildFrontierLines, buildTreeVMs, computeGradeRuler } from "@/shared/treeMapLayout";
import { domainFogState, type DomainFogState } from "@/shared/domainFog";
import type { ScholarMathPlan } from "@/shared/mathPlanScope";
import { NodeDrawer } from "@/components/NodeDrawer";
import { MapTreeCanvas, type TreeEdgeVM } from "@/components/map/MapTreeCanvas";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useNow } from "@/hooks/useNow";

export { buildFrontierLines, buildTreeVMs, computeGradeRuler } from "@/shared/treeMapLayout";

export type MapAudience = "scholar" | "teacher" | "parent";

// ── component ─────────────────────────────────────────────────────────────────

export type MapTreeViewProps = {
  scholarId: Id<"users">;
  audience: MapAudience;
  domain?: string;
  height?: number | string;
  dialSize?: number;
  /** Full-bleed: fill the parent instead of a fixed-height card. */
  fill?: boolean;
  /** Multiply the tree's label text font size (default 1 = web tree unchanged). */
  labelScale?: number;
  /** Full-screen surfaces fit the whole tree to the viewport + re-fit on resize. */
  fitToViewport?: boolean;
};

export function MapTreeView({ scholarId, audience, domain, height = 560, dialSize = 34, fill = false, labelScale = 1, fitToViewport = false }: MapTreeViewProps) {
  const router = useRouter();
  const { user } = useCurrentUser();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [selectedLabelOverride, setSelectedLabelOverride] = useState<string | null>(null);
  const canLaunchPractice = audience === "scholar" && user?._id === scholarId;

  // Parent CANNOT call the teacher-or-self gated queries (treeForScholar THROWS,
  // which would hit the error boundary). Skip them and show the TIER_1 notice —
  // wiring parent data needs a guardian-gated read (deliberately deferred).
  const canQuery = audience !== "parent";
  // Default (no explicit `domain` pin) = the UNIFIED all-domains map — one big
  // tree, scholar- and teacher-facing (no domain switcher). An explicit `domain`
  // still pins a single domain for any embed that wants it.
  const treeArgs = domain
    ? { scholarId, domain }
    : { scholarId, allDomains: true as const };
  // Readings are domain-agnostic (no `domain` = every domain's readings), which
  // is what both the unified and single-domain views want.
  const tree = useQuery(api.practiceSkills.treeForScholar, canQuery ? treeArgs : "skip");
  const readingsRes = useQuery(api.nodeDepth.nodeReadingsForScholar, canQuery ? { scholarId } : "skip");
  // Fog-of-war (Surface 3): per-domain map status, so the tree can fog the
  // exact domains that aren't mapped yet. Same teacher-or-self gate as
  // `treeForScholar`/`nodeReadingsForScholar` above — skip it for parent, which
  // has no placement concept on this surface.
  const domainStatus = useQuery(api.practiceSkills.domainMapForScholar, canQuery ? { scholarId } : "skip");
  const mathPlan = useQuery(
    api.mathPlans.myPlan,
    audience === "scholar" && user?._id === scholarId ? {} : "skip",
  ) as ScholarMathPlan | undefined;
  const domainFog = useMemo(() => {
    if (!domainStatus) return undefined;
    const map: Record<string, DomainFogState> = {};
    for (const d of domainStatus) {
      const fog = domainFogState(d.status);
      if (fog) map[d.domain] = fog;
    }
    return map;
  }, [domainStatus]);

  const vms = useMemo(() => {
    if (!tree) return null;
    return buildTreeVMs(
      { nodes: tree.nodes, edges: tree.edges },
      readingsRes?.readings ?? [],
      audience,
      tree.domains,
      tree.domainLabels,
    );
  }, [tree, readingsRes, audience]);

  // The frontier poly-lines (current + moved-since ghosts). The "Yesterday" and
  // "1 week ago" ghosts are rolling day-grain cutoffs, so memoizing on `tree`
  // alone anchored them to the last tree update — after a day of an open tab
  // the ghost labelled "Yesterday" was drawing a boundary two days old. A
  // minute-grain clock is far finer than needed and costs one re-render a
  // minute, but keeps the labels honest across a day boundary.
  const nowMs = useNow(60_000);
  const frontierLines = useMemo(() => {
    if (!tree) return [];
    return buildFrontierLines({ nodes: tree.nodes, edges: tree.edges }, nowMs, tree.domains);
  }, [tree, nowMs]);

  // The top grade ruler (K · 1 · 2 · … ) — one tick per grade band present,
  // anchored to the SAME columns buildTreeVMs laid the nodes out on.
  const gradeRuler = useMemo(() => {
    if (!tree) return [];
    return computeGradeRuler({ nodes: tree.nodes, edges: tree.edges }, tree.domains);
  }, [tree]);

  // Deep-link: keep the open node in the URL (?node=<nodeKey>) so a specific
  // node drawer can be linked directly. replaceState (not the Next router) keeps
  // this self-contained in the shared map component — no Suspense boundary needed.
  const selectNode = useCallback((key: string | null, label?: string) => {
    setSelectedKey(key);
    setSelectedLabelOverride(key ? (label ?? null) : null);
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (key) url.searchParams.set("node", key);
    else url.searchParams.delete("node");
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);
  const launchPractice = useCallback(
    (nodeKey: string) => {
      router.push(`/scholar/practice?skill=${encodeURIComponent(nodeKey)}`);
    },
    [router],
  );

  // On load, open the drawer for ?node=<nodeKey> once the tree is ready (so we
  // can validate the key exists on this scholar's map).
  const didInitFromUrl = useRef(false);
  useEffect(() => {
    if (didInitFromUrl.current || !vms) return;
    didInitFromUrl.current = true;
    const p = new URLSearchParams(window.location.search).get("node");
    if (p && vms.some((v) => v.nodeKey === p)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- consumes the URL node selection once the resolved tree validates it.
      setSelectedKey(p);
    }
  }, [vms]);

  if (audience === "parent") {
    return (
      <Box position="relative" h={fill ? "100%" : height}
        borderRadius={fill ? undefined : "xl"} overflow="hidden"
        borderWidth={fill ? undefined : "1px"} borderColor={fill ? undefined : "gray.200"}
        css={{ background: "radial-gradient(130% 130% at 50% 30%, #ffffff, #f2f4f1 82%)" }}>
        <Flex position="absolute" inset={0} align="center" justify="center" px={8}>
          <Text fontSize="sm" color="charcoal.400" textAlign="center" maxW="34ch">
            Your child&apos;s map shows how far they&apos;ve come and where they&apos;re pulled next —
            mastery and their active frontier, without the teaching detail. This view is coming soon.
          </Text>
        </Flex>
      </Box>
    );
  }

  if (!vms) {
    return (
      <Flex h={fill ? "100%" : height} align="center" justify="center"
        borderRadius={fill ? undefined : "xl"} borderWidth={fill ? undefined : "1px"} borderColor={fill ? undefined : "gray.200"}>
        <Spinner color="violet.400" />
      </Flex>
    );
  }

  if (vms.length === 0) {
    return (
      <Flex h={fill ? "100%" : height} align="center" justify="center" px={8}
        borderRadius={fill ? undefined : "xl"} borderWidth={fill ? undefined : "1px"} borderColor={fill ? undefined : "gray.200"}>
        <Text fontSize="sm" color="charcoal.400" textAlign="center">
          No skills placed yet — this map fills in as the scholar practices.
        </Text>
      </Flex>
    );
  }

  const edges: TreeEdgeVM[] = tree!.edges;
  const drawerOpen = selectedKey !== null;
  const selectedLabel =
    selectedLabelOverride ??
    vms.find((v) => v.nodeKey === selectedKey)?.label ??
    "Skill detail";

  return (
    <Box h={fill ? "100%" : undefined}>
      <MapTreeCanvas
        nodes={vms}
        edges={edges}
        frontierLines={frontierLines}
        gradeRuler={gradeRuler}
        height={height}
        fill={fill}
        selectedKey={selectedKey}
        onSelect={selectNode}
        showFlags={audience === "teacher"}
        dialSize={dialSize}
        labelScale={labelScale}
        fitToViewport={fitToViewport}
        domainFog={domainFog}
        practiceScope={mathPlan?.practiceScope}
      />

      {/* Right-side slide-over: floats over the map (no layout reflow) and
          gives us focus-trap / escape-to-close / backdrop for free. */}
      <Drawer.Root
        open={drawerOpen}
        onOpenChange={(d) => {
          if (!d.open) selectNode(null);
        }}
        placement="end"
        size="md"
      >
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content>
              <Drawer.Header borderBottom="1px solid" borderColor="gray.100">
                <Drawer.Title>{selectedLabel}</Drawer.Title>
                <Drawer.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close skill detail"
                    size="sm"
                    variant="ghost"
                    position="absolute"
                    top={3}
                    right={3}
                    minW="44px"
                    minH="44px"
                  >
                    <X size={18} />
                  </IconButton>
                </Drawer.CloseTrigger>
              </Drawer.Header>
              <Drawer.Body>
                <NodeDrawer
                  key={selectedKey}
                  nodeKey={selectedKey ?? undefined}
                  scholarId={scholarId}
                  audience={audience}
                  onPractice={canLaunchPractice ? launchPractice : undefined}
                  onNavigate={(key, label) => selectNode(key, label)}
                />
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>
    </Box>
  );
}

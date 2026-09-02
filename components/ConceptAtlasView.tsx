"use client";

/**
 * ConceptAtlasView — the shared Concept Atlas, rendered as a living night-sky.
 * The renderer itself lives in `lib/atlasEngine.ts` (a framework-agnostic engine,
 * the converged decluttering-spike: de-clump, LOD-by-zoom, parallax-tracking
 * screen-space labels + bridges, natural framing, zoom-to-cursor, culling, and a
 * smooth camera GLIDE between lenses — they share ONE coordinate space).
 *
 * Three lenses on ONE atlas:
 *   • Full atlas  — every concept placed by meaning; edges = cross-domain bridges.
 *   • Scholar Sky — a scholar's lit subset: demonstrated mastery + standards reached
 *                   + pulled-next seeds (hollow), with their threads, on dim territory.
 *   • Class Galaxy— the cohort's heat: ≥2-scholar concepts glow gold (a convergence).
 * Reads convex/concepts.ts (getAtlas / atlasForScholar / classGalaxy / …).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Flex, HStack, IconButton, Text, Spinner, Button } from "@chakra-ui/react";
import { ArrowsOut, ArrowsIn, Sparkle } from "@phosphor-icons/react";
import { ConceptDrawer } from "@/components/ConceptDrawer";
import { StarDrawer, type StarDrawerContent } from "@/components/sky/StarDrawer";
import { createAtlasEngine } from "@/lib/atlasEngine";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { MASTERY_STAR_COLOR } from "@/shared/skyTiers";
import { tapOpensSomething } from "@/components/conceptAtlasTapHint";

type Mode = "atlas" | "scholar" | "galaxy";

type SeedMetaWire = {
  // "seed" = a real teacher/AI-suggested invitation (launches "Begin Quest").
  // "mastery"/"starter" are the night-museum's display-only layers (see
  // convex/lib/skyMuseum.ts) — no seedId, no CTA.
  kind: "seed" | "mastery" | "starter";
  seedId?: string; blurb: string; pinned: boolean; structured: boolean;
  visited: boolean; visitCount: number; completed: boolean; suggestionType: string;
  strand: string | null;
};

export function ConceptAtlasView({ lockedScholarId, canCurate = true, height = "560px", fill = false, lockMode, initialMode, onExploreSeed, exploringSeedId, allowFullscreen = false, groupId, selfChartable = false }: { lockedScholarId?: Id<"users">; canCurate?: boolean; height?: string; fill?: boolean; lockMode?: Mode; initialMode?: Mode; onExploreSeed?: (seedId: Id<"seeds">) => void; exploringSeedId?: string | null; allowFullscreen?: boolean; groupId?: string; selfChartable?: boolean } = {}) {
  const locked = !!lockedScholarId;
  const [mode, setMode] = useState<Mode>(lockMode ?? initialMode ?? (locked ? "scholar" : "atlas"));
  const [pickedScholarId, setScholarId] = useState<Id<"users"> | null>(null);
  const [drawerConcept, setDrawerConcept] = useState<string | null>(null);
  const [seedSheetId, setSeedSheetId] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  // Fill-mode (e.g. the full-screen scholar map) has no room below the canvas
  // for the non-fill instruction line, and hides it entirely today (FTUE M7 —
  // a debut Sky gives no "stars are tappable" cue). Track whether the scholar
  // has already tapped a star so the quiet touch hint dismisses itself on
  // ordinary interaction instead of lingering forever.
  const [hasTappedStar, setHasTappedStar] = useState(false);
  // Cold-start: a scholar viewing their OWN blank sky can chart a first one.
  const requestMySky = useMutation(api.interpretiveHelpers.requestMySky);
  const [charting, setCharting] = useState(false);
  const { scopeParam } = useActiveInstitution(!locked);

  const scholars = useQuery(api.concepts.litScholars, locked ? "skip" : {});
  // effective scholar: locked → explicit pick → default to the first lit scholar once the list loads
  const scholarId = lockedScholarId ?? pickedScholarId ?? (mode === "scholar" ? scholars?.[0]?.id ?? null : null);

  const atlas = useQuery(api.concepts.getAtlas, mode === "atlas" ? {} : "skip");
  const edges = useQuery(api.concepts.getAtlasEdges, mode === "atlas" ? { maxBridges: 40 } : "skip");
  const scholarAtlas = useQuery(api.concepts.skyFieldForScholar, mode === "scholar" && scholarId ? { scholarId } : "skip");
  const galaxy = useQuery(
    api.concepts.classGalaxy,
    mode === "galaxy" ? { scope: scopeParam, ...(groupId ? { groupId: groupId as Id<"scholarGroups"> } : {}) } : "skip",
  );

  const vpRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<ReturnType<typeof createAtlasEngine> | null>(null);
  const canCurateRef = useRef(canCurate);
  useEffect(() => { canCurateRef.current = canCurate; }, [canCurate]);
  // scholar seed-tap wiring (read from the stable onNodeClick via refs)
  const seedMetaRef = useRef<Record<string, SeedMetaWire> | undefined>(undefined);
  const onExploreSeedRef = useRef(onExploreSeed);
  useEffect(() => { onExploreSeedRef.current = onExploreSeed; }, [onExploreSeed]);

  // Fullscreen: lock body scroll, Esc to exit, and nudge the engine to re-measure
  // (its container resizes without a window resize, so the engine can't hear it).
  useEffect(() => {
    const nudge = () => window.dispatchEvent(new Event("resize"));
    if (!fullscreen) { const t = setTimeout(nudge, 60); return () => clearTimeout(t); }
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const t = setTimeout(nudge, 60);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      clearTimeout(t);
    };
  }, [fullscreen]);

  // ── instantiate the engine once ──
  const onNodeClick = useCallback((id: string) => {
    const isInteractiveSeed = !!(onExploreSeedRef.current && seedMetaRef.current?.[id]);
    // The debut-Sky tap hint (FTUE M7) must dismiss ONLY on a tap that
    // actually opens something — see `tapOpensSomething`'s doc comment for
    // why (a no-op tap on a demonstrated-mastery/standard star must never
    // permanently kill the "tap a star" instruction).
    if (tapOpensSomething(id, { isInteractiveSeed, canCurate: canCurateRef.current })) {
      setHasTappedStar(true);
    }
    // A scholar tapping a seed star opens the invitation sheet (Begin Quest).
    if (isInteractiveSeed) { setSeedSheetId(id); return; }
    // Galaxy free-float seeds carry a synthetic (`seed:<scholar>:<seed>`) id, not a
    // real knowledgeNodes id — hover-only, so don't open the concept drawer on them.
    if (canCurateRef.current && !id.startsWith("seed:")) setDrawerConcept(id);
  }, []);
  useEffect(() => {
    const vp = vpRef.current;
    if (!vp) return;
    const eng = createAtlasEngine(vp, { onNodeClick });
    engineRef.current = eng;
    return () => { eng.destroy(); engineRef.current = null; };
  }, [onNodeClick]);

  // ── feed the engine the active lens's data whenever it arrives / changes ──
  useEffect(() => {
    const eng = engineRef.current;
    if (!eng) return;
    if (mode === "atlas") {
      if (!atlas) return;
      const e = [
        ...(edges?.bridges ?? []).map((b) => ({ s: b.source, t: b.target, k: "bridge" as const, w: b.w })),
        ...(edges?.explicit ?? []).map((x) => ({ s: x.source, t: x.target, k: "explicit" as const })),
      ];
      eng.setData("atlas", { nodes: atlas.nodes, edges: e });
    } else if (mode === "scholar") {
      if (!scholarAtlas) return;
      seedMetaRef.current = scholarAtlas.seedMeta;
      eng.setData("sky", {
        nodes: scholarAtlas.nodes,
        lit: scholarAtlas.lit,
        standardLit: scholarAtlas.standardLit,
        seeds: scholarAtlas.seeds,
        starter: scholarAtlas.starter,
        interactiveSeeds: Object.keys(scholarAtlas.seedMeta),
        threads: scholarAtlas.threads,
        prereqEdges: scholarAtlas.prereqEdges,
      });
    } else {
      if (!galaxy) return;
      eng.setData("galaxy", { nodes: galaxy.nodes, heat: galaxy.heat, reached: galaxy.reached, seeds: galaxy.seeds, threads: galaxy.threads });
    }
  }, [mode, scholarId, atlas, edges, scholarAtlas, galaxy]);

  const summary = mode === "atlas" ? (atlas ? `${atlas.shown < atlas.total ? `showing ${atlas.shown} of ${atlas.total}` : `${atlas.total} concepts placed`} · ${atlas.embedded} embedded` : "")
    : mode === "scholar" ? (scholarAtlas ? `${scholarAtlas.litCount} concepts lit · ${scholarAtlas.standardLit.length} standards · ${scholarAtlas.seeds.length} pulled-next${scholarAtlas.starter.length > 0 ? ` · ${scholarAtlas.starter.length} to grow into` : ""}` : "")
    : (galaxy ? `${galaxy.convergences} convergences (≥2 scholars) · ${galaxy.litTotal} concepts lit · ${galaxy.seedTotal} invitations · ${galaxy.scholarCount} scholars` : "");
  const loading = (mode === "atlas" && !atlas) || (mode === "scholar" && !!scholarId && !scholarAtlas) || (mode === "galaxy" && !galaxy);
  const notBuilt = mode === "atlas" && atlas && !atlas.ready;
  // A scholar looking at their OWN sky with nothing of theirs on it yet (no lit
  // concepts, no pulled-next seeds, AND no cold-start starter stars either —
  // see convex/lib/skyMuseum.ts) — the true empty-void moment. Keyed on
  // lit/seed/starter counts, NOT nodes.length, because the dimmed atlas
  // backbone still renders behind a brand-new scholar (so nodes.length is
  // rarely 0). Self-view only.
  const skyBlank =
    !loading &&
    mode === "scholar" &&
    selfChartable &&
    !!scholarAtlas &&
    scholarAtlas.litCount === 0 &&
    scholarAtlas.seeds.length === 0 &&
    scholarAtlas.starter.length === 0;
  const emptyLens = !loading && !skyBlank && ((mode === "scholar" && !!scholarAtlas && scholarAtlas.nodes.length === 0) || (mode === "galaxy" && !!galaxy && galaxy.nodes.length === 0));
  const emptyMessage = mode === "scholar" ? "Your sky fills in as you explore and practice — nothing’s placed here yet." : "No constellations yet — this fills in as scholars explore.";

  // The "Tap a star to open it" cue only makes sense when a tappable star
  // actually exists. On a scholar's own Sky the ONLY tappable stars are
  // pulled-next SEED stars (`scholarAtlas.seedMeta`), and only when
  // `onExploreSeed` is wired — mastery / standards / starter stars are
  // deliberate no-op taps. Without a seed star the hint was permanent and
  // pointed at nothing tappable (#911).
  const hasTappableStar =
    !!onExploreSeed && Object.keys(scholarAtlas?.seedMeta ?? {}).length > 0;

  const chartMySky = useCallback(async () => {
    setCharting(true);
    try {
      await requestMySky({});
    } catch {
      setCharting(false);
      return;
    }
    // Charting is a several-second LLM call; the reactive sky query repopulates
    // and unmounts this panel when the stars land. Clear the local flag after a
    // generous window so a thin/failed gen re-enables the button rather than
    // spinning forever.
    setTimeout(() => setCharting(false), 25000);
  }, [requestMySky]);

  // The scholar seed sheet — a tap on a seed/mastery/starter star opens it.
  // Only a real "seed" carries a CTA (Begin/Resume Quest); mastery/starter are
  // display-only (see convex/lib/skyMuseum.ts) — the shared StarDrawer already
  // renders footer-less when `actions` is empty.
  const seedNode = seedSheetId && scholarAtlas ? scholarAtlas.nodes.find((n) => n.id === seedSheetId) : null;
  const seedSel: SeedMetaWire | undefined = seedSheetId ? scholarAtlas?.seedMeta?.[seedSheetId] : undefined;
  const seedContent: StarDrawerContent | null = !seedNode || !seedSel ? null
    : seedSel.kind === "mastery" ? {
        eyebrow: seedSel.strand ? `${seedSel.strand} · you built this` : "you built this",
        title: seedNode.label,
        body: seedSel.blurb,
        color: MASTERY_STAR_COLOR,
        meta: [],
        actions: [],
      }
    : seedSel.kind === "starter" ? {
        eyebrow: "a star to grow into",
        title: seedNode.label,
        body: seedSel.blurb,
        color: "#8b9cff",
        meta: [],
        actions: [],
      }
    : {
    eyebrow: seedSel.structured ? "Guided path" : "An invitation",
    title: seedNode.label,
    body: seedSel.blurb,
    color: "#e7c25c",
    meta: seedSel.visited ? [{ label: "Visited", value: seedSel.visitCount > 1 ? `${seedSel.visitCount}×` : "once" }] : [],
    actions: [{
      label: exploringSeedId === seedSel.seedId ? "Charting…"
        : seedSel.completed ? "Explore again 🚀"
        : seedSel.visited ? "Resume quest 🚀"
        : "Begin quest 🚀",
      onClick: () => { setSeedSheetId(null); setFullscreen(false); onExploreSeed?.(seedSel.seedId as Id<"seeds">); },
      primary: true,
      loading: exploringSeedId === seedSel.seedId,
    }],
  };

  return (
    <Box h={fill ? "100%" : undefined}>
      {((!locked && !lockMode) || (mode === "scholar" && !locked && !!scholars)) && (
        <Flex gap={2} mb={2} wrap="wrap" align="center">
          {!locked && !lockMode && (
            <HStack gap={1} bg="gray.100" borderRadius="lg" p={1}>
              {(["atlas", "scholar", "galaxy"] as Mode[]).map((m) => (
                <Button key={m} size="xs" variant={mode === m ? "solid" : "ghost"} colorPalette="violet" onClick={() => setMode(m)}>
                  {m === "atlas" ? "Full atlas" : m === "scholar" ? "Scholar Sky" : "Class Galaxy"}
                </Button>
              ))}
            </HStack>
          )}
          {mode === "scholar" && !locked && scholars && (
            <select value={scholarId ?? ""} onChange={(e) => setScholarId(e.target.value as Id<"users">)} style={{ fontSize: 13, padding: "4px 8px", borderRadius: 8, border: "1px solid #ddd" }}>
              {scholars.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.litCount})</option>)}
            </select>
          )}
        </Flex>
      )}

      <Box position={fullscreen ? "fixed" : "relative"} inset={fullscreen ? 0 : undefined}
        zIndex={fullscreen ? 1000 : undefined}
        h={fullscreen ? "100dvh" : fill ? "100%" : height}
        borderRadius={fullscreen || fill ? undefined : "xl"} overflow="hidden"
        borderWidth={fullscreen || fill ? undefined : "1px"} borderColor={fullscreen || fill ? undefined : "#2a2350"}>
        <Box ref={vpRef} position="absolute" inset={0}
          css={{ background: "radial-gradient(130% 130% at 50% 38%,#1d1444,#0a0718 76%)", cursor: "grab" }} />
        {loading && <Flex position="absolute" inset={0} align="center" justify="center" zIndex={30} pointerEvents="none"><Spinner color="violet.300" /></Flex>}
        {notBuilt && (
          <Flex position="absolute" inset={0} align="center" justify="center" px={8} zIndex={30}>
            <Text color="#cdbef2" fontSize="sm" textAlign="center">The atlas isn&apos;t built yet. Run <code>conceptAtlas:rebuildAll</code>.</Text>
          </Flex>
        )}
        {emptyLens && (
          <Flex position="absolute" inset={0} align="center" justify="center" px={8} zIndex={30}>
            <Text color="#cdbef2" fontSize="sm" textAlign="center">{emptyMessage}</Text>
          </Flex>
        )}
        {skyBlank && (
          <Flex position="absolute" inset={0} align="center" justify="center" px={6} zIndex={30}>
            <Flex direction="column" align="center" gap={4} maxW="380px" textAlign="center">
              <Text fontSize="2xl" aria-hidden>✨</Text>
              <Text color="white" fontSize="lg" fontWeight="600">Your sky is waiting</Text>
              <Text color="#cdbef2" fontSize="sm" lineHeight="1.5">
                This map fills with places your curiosity could travel — surprising,
                true, and yours. Chart a first sky and see where your interests reach.
              </Text>
              <Button
                colorPalette="violet"
                size="md"
                borderRadius="full"
                onClick={chartMySky}
                loading={charting}
                loadingText="Charting your sky…"
              >
                Chart my sky
              </Button>
              <Text color="#8b7fb8" fontSize="xs">
                The more you explore and practice, the richer it grows.
              </Text>
            </Flex>
          </Flex>
        )}
        {/* Fill mode (the full-screen scholar map) hides the non-fill instruction
            line below the canvas entirely — a debut Sky then shows only star
            names with no "stars are tappable" cue (FTUE M7). Reuse that same
            instruction slot's copy/spirit here, touch-first, quiet, and
            dismissed for good once the scholar has tapped a star. */}
        {fill && mode === "scholar" && !loading && !skyBlank && !emptyLens && !hasTappedStar && hasTappableStar && (
          <Text
            position="absolute" left={0} right={0} bottom={4} zIndex={20}
            textAlign="center" fontSize="xs" color="#cdbef2" px={4} pointerEvents="none"
          >
            Tap a star to open it. Pinch to zoom; drag to move.
          </Text>
        )}
        {allowFullscreen && (
          <IconButton aria-label={fullscreen ? "Exit full screen" : "Open full screen"}
            onClick={() => setFullscreen((v) => !v)}
            size="sm" variant="ghost" position="absolute" top={3} right={3} zIndex={40}
            color="#cdbef2" bg="blackAlpha.400" borderRadius="full"
            _hover={{ bg: "blackAlpha.600", color: "white" }}>
            {fullscreen ? <ArrowsIn size={18} /> : <ArrowsOut size={18} />}
          </IconButton>
        )}
        {/* A persistent (not just cold-start-gated) entry to the AI Interpretive
            generator — the night-museum's starter layer means `skyBlank` above
            rarely fires anymore, so this keeps "Chart my sky" reachable. */}
        {selfChartable && !loading && !skyBlank && (
          <Button
            position="absolute"
            bottom={3}
            right={3}
            zIndex={40}
            size="xs"
            variant="ghost"
            colorPalette="violet"
            borderRadius="full"
            color="#cdbef2"
            bg="blackAlpha.400"
            _hover={{ bg: "blackAlpha.600", color: "white" }}
            loading={charting}
            loadingText="Charting…"
            onClick={chartMySky}
          >
            <Sparkle size={14} weight="fill" /> Chart a new sky
          </Button>
        )}
      </Box>

      {!fill && summary && (
        <Text fontSize="xs" color="charcoal.500" mt={2} fontWeight="500">{summary}</Text>
      )}

      {!fill && (
        <Text fontSize="xs" color="charcoal.400" mt={2}>
          {mode === "atlas" && "Every concept the school touches, placed by meaning in one shared space — grounded standards, demonstrated mastery, and seeds. Faint lines are the strongest cross-domain bridges."}
          {mode === "scholar" && "A scholar's Sky: their demonstrated mastery (bright) + standards reached + pulled-next seeds (hollow) + practiced skills grown fluent, with their threads, against the dimmed territory they haven't reached yet — invitation, never deficit. Same coordinates as every other scholar."}
          {mode === "galaxy" && "Every scholar's Sky, overlaid on one atlas: bright gold stars are convergences — concepts two or more scholars are independently circling (the cue to assign shared work) — gold rings are live invitations somewhere in the cohort, and faint lines are the union of their constellation threads. Hover a star to light its own threads."}
          {" "}<Text as="span" color="violet.500" fontWeight="600">Hover a star to inspect it; click to open its panel. Scroll/pinch to zoom (to the cursor), drag to pan.</Text>
        </Text>
      )}
      <ConceptDrawer key={drawerConcept ?? "none"} conceptId={canCurate ? drawerConcept : null} forScholarId={mode === "scholar" ? scholarId : undefined} onClose={() => setDrawerConcept(null)} onNavigate={setDrawerConcept} />
      <StarDrawer content={seedContent} onClose={() => setSeedSheetId(null)} />
    </Box>
  );
}

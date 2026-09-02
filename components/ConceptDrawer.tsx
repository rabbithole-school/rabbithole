"use client";

/**
 * ConceptDrawer — click a star in the Concept Atlas to open this right panel:
 * what the concept is, the standard it grounds (if any), who's demonstrated it,
 * its CONNECTED concepts (drawn edges) vs merely NEARBY (proximity) ones, a
 * FACEPILE of who it's already seeded / set-as-a-destination for, and an action
 * to seed it (a curiosity thread) or set it as a destination (a deliberate
 * target) for a scholar. When opened from one scholar's Sky (`forScholarId`),
 * the picker defaults to them and shows the "already seeded for them" state.
 * See review/seeds-destinations-design.html for the seed-vs-destination model.
 */

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Box, Flex, Text, Button, Badge, Textarea, Spinner } from "@chakra-ui/react";
import { X, Sparkle, Check, ShootingStar, MapTrifold, UsersThree } from "@phosphor-icons/react";
import { ConceptStarMap } from "@/components/ConceptStarMap";
import { StartAssignmentDialog } from "@/components/StartAssignmentDialog";

const SOURCE = { standard: { c: "#5f7fb6", label: "standard" }, mastery: { c: "#9f7ae0", label: "demonstrated" }, seed: { c: "#e0b46f", label: "seed" } } as Record<string, { c: string; label: string }>;

type Intent = "seed" | "destination";

function Avatar({ name, image, size = 22 }: { name: string; image: string | null; size?: number }) {
  if (image) return (
    // eslint-disable-next-line @next/next/no-img-element -- tiny avatar, arbitrary URL; next/image needs domain config
    <img src={image} alt={name} width={size} height={size} style={{ borderRadius: "9999px", objectFit: "cover", flexShrink: 0 }} />
  );
  const initials = name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
  return <Flex w={`${size}px`} h={`${size}px`} borderRadius="full" bg="violet.100" color="violet.700" fontSize="10px" fontWeight="700" align="center" justify="center" flexShrink={0}>{initials}</Flex>;
}

export function ConceptDrawer({ conceptId, forScholarId, onClose, onNavigate }: { conceptId: string | null; forScholarId?: Id<"users"> | null; onClose: () => void; onNavigate: (id: string) => void }) {
  const detail = useQuery(api.concepts.conceptDetail, conceptId ? { conceptId: conceptId as Id<"knowledgeNodes">, ...(forScholarId ? { scholarId: forScholarId } : {}) } : "skip");
  const scholars = useQuery(api.concepts.allScholars, conceptId ? {} : "skip");
  const createSeed = useMutation(api.seeds.create);
  const [scholarId, setScholarId] = useState("");
  const [note, setNote] = useState("");
  const [intent, setIntent] = useState<Intent>("seed");
  const [planting, setPlanting] = useState(false);
  const [planted, setPlanted] = useState<{ name: string; intent: Intent } | null>(null);
  const [showMap, setShowMap] = useState(false);
  // Snapshot of the group-assignment roster + cue, captured at click time. conceptDetail
  // is a reactive query, so reading litBy live while the dialog is open could
  // change the array identity mid-edit and re-seed the dialog's selection; the
  // snapshot freezes "the scholars the teacher saw" and stays referentially stable.
  const [groupAssign, setGroupAssign] = useState<{
    ids: Id<"users">[];
    cue: string;
  } | null>(null);

  if (!conceptId) return null;
  const src = detail ? SOURCE[detail.source] ?? { c: "#888", label: detail.source } : null;
  const selected = scholarId || (forScholarId as string | undefined) || "";

  const plant = async () => {
    if (!detail || !selected) return;
    setPlanting(true);
    try {
      await createSeed({
        scholarId: selected as Id<"users">,
        topic: detail.label,
        domain: detail.domain,
        intent,
        rationale: note.trim() || (intent === "destination"
          ? `Set as a destination from the concept atlas — a target worth heading toward: "${detail.label}".`
          : `Seeded from the concept atlas — a thread worth pulling from "${detail.label}".`),
      });
      const name = scholars?.find((s) => s.id === selected)?.name ?? "the scholar";
      setPlanted({ name, intent });
      setNote("");
    } catch (e) {
      console.error("plant seed failed", e);
    } finally {
      setPlanting(false);
    }
  };

  return (
    <>
      <Box position="fixed" inset={0} bg="blackAlpha.400" zIndex={1500} onClick={onClose} />
      <Box position="fixed" top={0} right={0} h="100dvh" w={{ base: "100%", md: "380px" }} bg="white" zIndex={1501} boxShadow="-8px 0 30px rgba(0,0,0,.18)" overflowY="auto">
        <Flex align="center" justify="space-between" px={5} py={4} borderBottom="1px solid" borderColor="gray.100" position="sticky" top={0} bg="white" zIndex={1}>
          <Text fontSize="2xs" fontWeight="800" letterSpacing="0.06em" textTransform="uppercase" color="charcoal.400">Concept</Text>
          <Box as="button" onClick={onClose} color="charcoal.400" _hover={{ color: "charcoal.700" }} aria-label="Close"><X size={18} /></Box>
        </Flex>

        {detail === undefined ? (
          <Flex h="200px" align="center" justify="center"><Spinner color="violet.400" /></Flex>
        ) : detail === null ? (
          <Text p={5} fontSize="sm" color="charcoal.400">Concept not found.</Text>
        ) : (
          <Box px={5} py={4}>
            <Text fontFamily="heading" fontWeight="700" fontSize="lg" color="navy.600" lineHeight="1.25">{detail.label}</Text>
            <Flex gap={2} mt={2} wrap="wrap">
              {src && <Badge bg={src.c} color="white" fontSize="2xs" px={2}>{src.label}</Badge>}
              <Badge bg="gray.100" color="charcoal.600" fontSize="2xs" px={2}>{detail.domain}</Badge>
            </Flex>

            {detail.standard && (
              <Box mt={4} bg="#eef3e3" borderWidth="1px" borderColor="#d3e0bd" borderRadius="md" px={3} py={2}>
                <Text fontSize="2xs" fontWeight="800" color="#5a6a3f">{detail.standard.notation}</Text>
                <Text fontSize="xs" color="#3f4a2c" mt={0.5}>{detail.standard.description}</Text>
              </Box>
            )}

            {detail.seededFor.length > 0 && (
              <Box mt={5}>
                <Text fontSize="2xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="charcoal.400" mb={2}>Seeded for</Text>
                <Flex wrap="wrap" gap={1.5}>
                  {detail.seededFor.map((s) => (
                    <Flex key={s.id} align="center" gap={1.5} bg={s.intent === "destination" ? "#fff6e0" : "gray.50"} borderWidth="1px" borderColor={s.intent === "destination" ? "#f0d58a" : "gray.100"} borderRadius="full" pl={1} pr={2.5} py={0.5} title={s.intent === "destination" ? (s.structured ? "Destination · guided path" : "Destination") : "Seed"}>
                      <Avatar name={s.name} image={s.image} size={20} />
                      <Text fontSize="xs" color="charcoal.700" lineClamp={1}>{s.name}</Text>
                      {s.intent === "destination" && <ShootingStar size={13} weight="fill" color="#caa23a" />}
                    </Flex>
                  ))}
                </Flex>
              </Box>
            )}

            {detail.litBy.length > 0 && (
              <Box mt={5}>
                <Text fontSize="2xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="charcoal.400" mb={2}>Demonstrated by</Text>
                <Flex direction="column" gap={1.5}>
                  {detail.litBy.map((l) => (
                    <Flex key={l.id} align="center" gap={2} fontSize="sm">
                      <Avatar name={l.name} image={l.image} size={20} />
                      <Text color="charcoal.700" flex={1}>{l.name}</Text>
                      <Text fontSize="xs" color="charcoal.400">mastery {l.level.toFixed(1)}</Text>
                    </Flex>
                  ))}
                </Flex>
                {detail.litBy.length >= 2 && (
                  <Button
                    mt={3}
                    size="sm"
                    variant="outline"
                    colorPalette="violet"
                    onClick={() =>
                      setGroupAssign({
                        ids: detail.litBy.map((l) => l.id as Id<"users">),
                        cue: `Group assignment cue: "${detail.label}" — ${detail.litBy.length} scholars are independently circling this concept. Pick a unit, lesson, or activity that fits.`,
                      })
                    }
                    title="Two or more scholars are independently circling this concept — assign it to them as a group."
                  >
                    <UsersThree weight="duotone" /> Assign to this group
                  </Button>
                )}
              </Box>
            )}

            {detail.connected.length > 0 && (
              <Box mt={5}>
                <Text fontSize="2xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="charcoal.400" mb={2}>Connected</Text>
                <Flex direction="column" gap={1}>
                  {detail.connected.map((cn) => (
                    <Flex key={cn.id} as="button" onClick={() => { setPlanted(null); onNavigate(cn.id); }} align="center" gap={2} fontSize="sm" py={1.5} px={2} mx={-2} borderRadius="md" _hover={{ bg: "violet.50" }} textAlign="left" cursor="pointer">
                      <Box w="7px" h="7px" borderRadius="full" bg={SOURCE[cn.source]?.c ?? "#888"} flexShrink={0} boxShadow={`0 0 6px ${SOURCE[cn.source]?.c ?? "#888"}`} />
                      <Text color="charcoal.700" flex={1} lineClamp={1}>{cn.label}</Text>
                      <Badge bg={cn.kind === "explicit" ? "#e7eef9" : "#fbf1dd"} color={cn.kind === "explicit" ? "#3a5b94" : "#9a6e1f"} fontSize="2xs" px={1.5} flexShrink={0} title={cn.kind === "explicit" ? "An explicit curriculum connection" : "A cross-domain bridge (embedding similarity)"}>
                        {cn.kind === "explicit" ? "link" : `↔ ${cn.weight.toFixed(2)}`}
                      </Badge>
                    </Flex>
                  ))}
                </Flex>
                <Text fontSize="2xs" color="charcoal.300" mt={1.5}>The drawn lines on the map — bridges (similarity) and curriculum links, not just proximity.</Text>
              </Box>
            )}

            {detail.neighbors.length > 0 && (
              <Box mt={5}>
                <Text fontSize="2xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="charcoal.400" mb={2}>{detail.connected.length > 0 ? "Also nearby" : "Nearby in the atlas"}</Text>
                <Flex direction="column" gap={1}>
                  {detail.neighbors.map((nb) => (
                    <Flex key={nb.id} as="button" onClick={() => { setPlanted(null); onNavigate(nb.id); }} align="center" gap={2} fontSize="sm" py={1} px={2} mx={-2} borderRadius="md" _hover={{ bg: "gray.50" }} textAlign="left" cursor="pointer">
                      <Box w="6px" h="6px" borderRadius="full" bg={SOURCE[nb.source]?.c ?? "#888"} flexShrink={0} opacity={0.7} />
                      <Text color="charcoal.600" flex={1} lineClamp={1}>{nb.label}</Text>
                    </Flex>
                  ))}
                </Flex>
              </Box>
            )}

            <Box mt={6} pt={4} borderTop="1px solid" borderColor="gray.100">
              {/* Open map — ConceptStarMap pivot, folded in as an affordance
                  rather than a separate surface. Toggles inline below. */}
              <Flex align="center" justify="space-between" mb={showMap ? 0 : 3}>
                <Text fontSize="2xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="violet.600">
                  Explore further
                </Text>
                <Button
                  size="xs"
                  colorPalette={showMap ? "violet" : "gray"}
                  variant={showMap ? "solid" : "subtle"}
                  onClick={() => setShowMap((v) => !v)}
                  data-testid="concept-drawer-open-map"
                  title="Open the associative star map anchored on this concept"
                  minH="32px"
                >
                  <MapTrifold weight={showMap ? "fill" : "duotone"} />
                  Open map
                </Button>
              </Flex>
              {showMap && (
                <Box mb={4}>
                  <ConceptStarMap
                    concept={detail.label}
                    grounding={detail.standard?.notation}
                    onClose={() => setShowMap(false)}
                  />
                </Box>
              )}
              {detail.forScholar && (
                <Flex align="center" gap={2} bg={detail.forScholar.intent === "destination" ? "#fff6e0" : "gray.50"} borderRadius="md" px={3} py={2} mb={3}>
                  {detail.forScholar.intent === "destination" ? <ShootingStar size={15} weight="fill" color="#caa23a" /> : <Sparkle size={14} weight="fill" color="#caa23a" />}
                  <Text fontSize="xs" color="charcoal.600">Already {detail.forScholar.intent === "destination" ? "a destination" : "seeded"} for <b>{detail.forScholar.name}</b>.</Text>
                </Flex>
              )}
              <Text fontSize="2xs" fontWeight="800" letterSpacing="0.05em" textTransform="uppercase" color="violet.600" mb={2}>Suggest to a scholar</Text>

              {planted ? (
                <Flex align="center" gap={2} bg="#e7f5ee" borderRadius="md" px={3} py={2.5}>
                  <Check size={16} weight="bold" color="#1f7a52" />
                  <Text fontSize="sm" color="#1f7a52" fontWeight="600">{planted.intent === "destination" ? "Destination set" : "Seeded"} for {planted.name}.</Text>
                  <Box as="button" ml="auto" fontSize="xs" color="#1f7a52" textDecoration="underline" onClick={() => setPlanted(null)}>suggest another</Box>
                </Flex>
              ) : (
                <Flex direction="column" gap={2}>
                  <Flex gap={0} borderWidth="1px" borderColor="gray.200" borderRadius="md" overflow="hidden">
                    <Button flex={1} size="xs" borderRadius={0} variant={intent === "seed" ? "solid" : "ghost"} colorPalette={intent === "seed" ? "violet" : "gray"} onClick={() => setIntent("seed")} title="A curiosity thread to pull — open, optional">
                      <Sparkle weight={intent === "seed" ? "fill" : "regular"} /> Seed
                    </Button>
                    <Button flex={1} size="xs" borderRadius={0} variant={intent === "destination" ? "solid" : "ghost"} colorPalette={intent === "destination" ? "yellow" : "gray"} onClick={() => setIntent("destination")} title="A deliberate target to head toward">
                      <ShootingStar weight={intent === "destination" ? "fill" : "regular"} /> Destination
                    </Button>
                  </Flex>
                  <Text fontSize="2xs" color="charcoal.400">{intent === "destination" ? "🌠 A deliberate target you’re elevating — “head here.”" : "🌱 A curiosity thread for them to pull — open and optional."}</Text>
                  <select value={selected} onChange={(e) => setScholarId(e.target.value)} style={{ fontSize: 13, padding: "7px 9px", borderRadius: 8, border: "1px solid #ddd", width: "100%" }}>
                    <option value="">Choose a scholar…</option>
                    {scholars?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                  <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this, for them? (optional)" size="sm" rows={2} fontSize="sm" />
                  <Button colorPalette={intent === "destination" ? "yellow" : "violet"} size="sm" disabled={!selected || planting} onClick={plant} loading={planting}>
                    {intent === "destination" ? <><ShootingStar weight="fill" /> Set destination</> : <><Sparkle weight="fill" /> Plant seed</>}
                  </Button>
                </Flex>
              )}
            </Box>
          </Box>
        )}
      </Box>
      <StartAssignmentDialog
        open={groupAssign !== null}
        onClose={() => setGroupAssign(null)}
        initialScholarIds={groupAssign?.ids}
        contextText={groupAssign?.cue}
      />
    </>
  );
}

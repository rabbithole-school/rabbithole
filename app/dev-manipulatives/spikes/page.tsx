"use client";

/**
 * Manipulative spikes (unlinked; visit /dev-manipulatives/spikes).
 *
 * Two sections, two different maths:
 *
 *  1. Number bonds within 10 — prototypes of the job the old additive
 *     `dotBlaster` did badly (a row of dots cut by a draggable divider). The
 *     rekenrek won and was promoted to a real kind; the slider it replaces has
 *     been deleted, so there is no longer a control card to compare against. The
 *     ten-frame and bond-bowls prototypes were also evaluated against it and
 *     lost — the rekenrek already carries the five/ten structure and the
 *     `groupOf` number-bond goal on the exact same skill nodes — so they were
 *     deleted rather than promoted.
 *  2. Multiplication by equal groups — the dot blaster under its CORRECT
 *     meaning. Load a group size, fire repeatedly, and the product accumulates
 *     one group at a time, with a skip-count ladder beside it.
 *
 * These are spikes, wired to nothing — not the kind union, not the practice
 * item path, not native. Whichever survives gets rebuilt properly on both
 * frontends.
 */
import { useCallback, useEffect, useState } from "react";
import { Box, Container, Flex, Heading, Text } from "@chakra-ui/react";
import { C, wash } from "@/components/manipulative/colors";

import { RekenrekSpike, SPIKE_META as REKENREK } from "@/components/manipulative/spikes/RekenrekSpike";
import { RodTrainSpike, SPIKE_META as ROD_TRAIN } from "@/components/manipulative/spikes/RodTrainSpike";
import { RealBlasterSpike, SPIKE_META as REAL_BLASTER } from "@/components/manipulative/spikes/RealBlasterSpike";
import { DotBlasterSpike, SPIKE_META as DOT_BLASTER } from "@/components/manipulative/spikes/DotBlasterSpike";

type SpikeMeta = { id: string; title: string; metaphor: string; blurb: string; why: string };
type Stage = (p: {
  total: number;
  target: number;
  onChange?: (s: { left: number; right: number; solved: boolean }) => void;
}) => React.ReactNode;

const BOND_TOTAL = 10;
const BOND_TARGETS = [3, 4, 6, 7, 8];
const BOND_SPIKES: { meta: SpikeMeta; Stage: Stage }[] = [
  { meta: REKENREK, Stage: RekenrekSpike },
  { meta: ROD_TRAIN, Stage: RodTrainSpike },
  { meta: REAL_BLASTER, Stage: RealBlasterSpike },
];

/** The blaster's `target` is a PRODUCT to build, not one part of a bond. */
const PRODUCT_TARGETS = [12, 15, 18, 20, 24];

function Card({
  title,
  metaphor,
  blurb,
  why,
  badge,
  children,
}: {
  title: string;
  metaphor: string;
  blurb: string;
  why: string;
  badge?: string;
  children: React.ReactNode;
}) {
  return (
    <Box bg="white" borderWidth="1px" borderColor="border" borderRadius="16px" p={{ base: 5, md: 6 }}>
      <Flex align="baseline" gap={3} wrap="wrap">
        <Heading size="md" color="brand.primary">
          {title}
        </Heading>
        <Text fontSize="13px" color="fg.muted">
          {metaphor}
        </Text>
        {badge && (
          <Box
            fontSize="11px"
            fontWeight="700"
            px="10px"
            py="3px"
            borderRadius="999px"
            color={C.teal}
            style={{ backgroundColor: wash(C.green, 0.22) }}
          >
            {badge}
          </Box>
        )}
      </Flex>
      <Text mt={2} fontSize="14px" color="fg.default" maxW="640px">
        {blurb}
      </Text>
      <Text mt={1} fontSize="13px" color="fg.muted" maxW="640px">
        {why}
      </Text>
      {/* The stages were briefed to render inside ~480×360; hold them to it so
          the page compares like with like instead of letting a wide card
          stretch one spike's geometry. */}
      <Box mt={5} maxW="560px">
        {children}
      </Box>
    </Box>
  );
}

function SpikeCard({
  meta,
  Stage,
  total,
  target,
  badge,
  readout,
}: {
  meta: SpikeMeta;
  Stage: Stage;
  total: number;
  target: number;
  badge?: string;
  readout: (s: { left: number; right: number; solved: boolean }) => string;
}) {
  const [state, setState] = useState({ left: 0, right: total, solved: false });
  const onChange = useCallback((s: { left: number; right: number; solved: boolean }) => setState(s), []);

  // Several spikes scatter their objects with Math.random() during the first
  // render, which SSR and the client disagree about. These are dev-only toys —
  // mount them client-side rather than making every spike author seed a PRNG.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- defer random spike rendering until after hydration.
    setMounted(true);
  }, []);

  return (
    <Card title={meta.title} metaphor={meta.metaphor} blurb={meta.blurb} why={meta.why} badge={badge}>
      {/* Remount the stage when the puzzle changes so each spike starts clean. */}
      {mounted ? (
        <Stage key={`${meta.id}-${total}-${target}`} total={total} target={target} onChange={onChange} />
      ) : (
        <Box h="360px" />
      )}
      <Flex mt={4} align="center" gap={3} minH="28px">
        <Text fontSize="14px" fontWeight="600" color="brand.primary">
          {readout(state)}
        </Text>
        {state.solved && (
          <Box
            fontSize="12px"
            fontWeight="700"
            px="10px"
            py="3px"
            borderRadius="999px"
            color={C.teal}
            style={{ backgroundColor: wash(C.green, 0.22) }}
          >
            Solved
          </Box>
        )}
      </Flex>
    </Card>
  );
}

function TargetPicker({
  label,
  targets,
  value,
  onChange,
  render,
}: {
  label: string;
  targets: number[];
  value: number;
  onChange: (t: number) => void;
  render: (t: number) => string;
}) {
  return (
    <Flex mt={5} align="center" gap={3} wrap="wrap">
      <Text fontSize="14px" fontFamily="heading" color="fg.muted">
        {label}
      </Text>
      {targets.map((t) => (
        <Box
          key={t}
          as="button"
          onClick={() => onChange(t)}
          px="14px"
          py="7px"
          borderRadius="999px"
          borderWidth="1px"
          borderColor={t === value ? "transparent" : "border"}
          bg={t === value ? "brand.primary" : "white"}
          color={t === value ? "white" : "fg.default"}
          fontFamily="heading"
          fontSize="sm"
          fontWeight="600"
        >
          {render(t)}
        </Box>
      ))}
    </Flex>
  );
}

export default function ManipulativeSpikes() {
  const [bondTarget, setBondTarget] = useState(6);
  const [product, setProduct] = useState(15);

  return (
    <Box h="100dvh" overflowY="auto" bg="bg.subtle" py={{ base: 6, md: 10 }}>
      <Container maxW="1100px">
        <Text fontSize="12px" fontWeight="700" letterSpacing="0.1em" textTransform="uppercase" color="brand.secondary">
          Spikes
        </Text>
        <Heading size={{ base: "xl", md: "2xl" }} color="brand.primary" mt={1} lineHeight="1.1">
          Manipulative spikes
        </Heading>
        <Text mt={3} maxW="740px" color="fg.muted" fontSize={{ base: "15px", md: "16px" }}>
          Prototypes only — nothing here is wired to the kind union, the practice item path, or native.
          Two sections, because the old dot blaster was really doing two different jobs and doing
          neither one well.
        </Text>

        <Box mt={{ base: 8, md: 12 }}>
          <Heading size="lg" color="brand.primary">
            Number bonds within 10
          </Heading>
          <Text mt={2} maxW="740px" color="fg.muted" fontSize="14px">
            Split a whole of {BOND_TOTAL} into two parts, one of which must equal the target. A few things
            to do with your hands. The slider these replace has been deleted, so there is no control card
            any more.
          </Text>
          <TargetPicker
            label="Target"
            targets={BOND_TARGETS}
            value={bondTarget}
            onChange={setBondTarget}
            render={(t) => `${t} + ${BOND_TOTAL - t}`}
          />
          <Flex direction="column" gap={6} mt={6}>
            {BOND_SPIKES.map(({ meta, Stage }, i) => (
              <SpikeCard
                key={meta.id}
                meta={meta}
                Stage={Stage}
                total={BOND_TOTAL}
                target={bondTarget}
                badge={i === 0 ? "Promoting" : undefined}
                readout={(s) => `${s.left} and ${s.right} make ${s.left + s.right}`}
              />
            ))}
          </Flex>
        </Box>

        <Box mt={{ base: 10, md: 14 }} pb={16}>
          <Heading size="lg" color="brand.primary">
            Multiplication by equal groups
          </Heading>
          <Text mt={2} maxW="740px" color="fg.muted" fontSize="14px">
            The dot blaster under its real meaning: load a group size, fire, and each shot flings out
            that many dots as its own group. The repo already models multiplication as <b>area</b> (drag
            a corner, the rectangle resizes) — this is the <b>equal-groups</b> model, where the product
            is built one act at a time and the skip-count sequence is the thing on screen. With the mode
            locked it also reads as quotative division: how many blasts of 3 make 15?
          </Text>
          <TargetPicker
            label="Make"
            targets={PRODUCT_TARGETS}
            value={product}
            onChange={setProduct}
            render={(t) => `${t} dots`}
          />
          <Flex direction="column" gap={6} mt={6}>
            <SpikeCard
              meta={DOT_BLASTER}
              Stage={DotBlasterSpike}
              total={product}
              target={product}
              readout={(s) => (s.left === 0 ? "Field is empty" : `${s.left} dots on the field`)}
            />
          </Flex>
        </Box>
      </Container>
    </Box>
  );
}

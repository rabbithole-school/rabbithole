"use client";

/**
 * Signal 2 · Sessions — the violet FIELD RECORD (PR #1072 §7/§8). Where
 * Readiness is a preflight gate that fills, this is a record that measures: it
 * only appears once an activity is assigned and real scholars have run it, and
 * it's honestly allowed to dip. It is a plain COUNT of real sessions — never a
 * synthetic "Proven" tier — plus a mean judged fitness and a sim-vs-real
 * distribution. Data comes from `activitySessions.getForUnit`; the pure roll-up
 * lives in convex/lib/activitySessions.ts.
 *
 * Three densities: plain text ("Not assigned" gray / "N sessions" violet) where
 * a chart won't fit; an inline measurement strip (dots + mean + sim tick) in
 * list rows; and the full distribution + Active/Complete/Debrief rows in the
 * hub. A weak mean tints the readout amber. Web-only teacher surface.
 */
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import {
  type SessionsSignal,
  sessionsMeanIsWeak,
  totalSessions,
} from "@/convex/lib/activitySessions";
import { CircleCheck, HollowDot, InProgressDot } from "./MaturityGlyphs";

const VIOLET = "#8f519f";
const VIOLET_600 = "#734180";
const VIOLET_500 = "#a960bc";
export const AMBER = "#8a561c";
export const AMBER_MARK = "#e69533";


/** Map a 1–5 fitness onto a 0–100% track position. */
function pct(fitness: number): number {
  return Math.max(0, Math.min(100, ((fitness - 1) / 4) * 100));
}

export function isAssigned(s: SessionsSignal): boolean {
  return totalSessions(s) > 0;
}

/** The bare plain-text readout — gray "Not assigned" or violet "N sessions". */
export function SessionsText({ sessions }: { sessions: SessionsSignal }) {
  const n = totalSessions(sessions);
  if (n === 0) {
    return (
      <Text
        fontFamily="heading"
        fontWeight="600"
        fontSize="xs"
        color="#8a93a3"
        whiteSpace="nowrap"
      >
        Not assigned
      </Text>
    );
  }
  return (
    <Text fontFamily="heading" fontWeight="700" fontSize="sm" color={VIOLET_600} whiteSpace="nowrap">
      <Box as="span" fontWeight="900">
        {n}
      </Box>{" "}
      {n === 1 ? "session" : "sessions"}
    </Text>
  );
}

/** The compact inline measurement strip — a violet dot per real judged score,
 *  a solid mean band, and the dashed amber prediction tick (no inline label —
 *  the predicted value is surfaced by the Scholar-bot rehearsal step). Amber
 *  when weak. The ONE strip renderer: `w`/`h`/`dot` scale it from the header
 *  pill up to the hub's full distribution, so every density shares this shape. */
export function SessionsMeasureStrip({
  sessions,
  w = "118px",
  h = "18px",
  dot = "5px",
}: {
  sessions: SessionsSignal;
  w?: string;
  h?: string;
  dot?: string;
}) {
  const weak = sessionsMeanIsWeak(sessions);
  const dotColor = weak ? AMBER_MARK : VIOLET_500;
  const meanColor = weak ? AMBER : VIOLET_600;
  return (
    <Box
      position="relative"
      display="inline-block"
      w={w}
      h={h}
      borderRadius="5px"
      bg="#f5f1f8"
      boxShadow="inset 0 0 0 1px #e8e0ef"
      flexShrink={0}
    >
      {sessions.fitnesses.map((f, i) => (
        <Box
          key={i}
          position="absolute"
          top="50%"
          left={`${pct(f)}%`}
          w={dot}
          h={dot}
          borderRadius="full"
          bg={dotColor}
          opacity={0.72}
          transform="translate(-50%,-50%)"
        />
      ))}
      {sessions.simMean !== null && sessions.meanFitness !== null && (
        <Box
          position="absolute"
          top="1px"
          bottom="1px"
          left={`${pct(sessions.simMean)}%`}
          borderLeftWidth="2px"
          borderLeftStyle="dashed"
          borderLeftColor={AMBER_MARK}
        />
      )}
      {sessions.meanFitness !== null && (
        <Box
          position="absolute"
          top="2px"
          bottom="2px"
          left={`${pct(sessions.meanFitness)}%`}
          w="2.5px"
          borderRadius="2px"
          bg={meanColor}
          transform="translateX(-50%)"
        />
      )}
    </Box>
  );
}

/**
 * The list-row / summary Sessions readout: "Not assigned" when empty; the count
 * + a static in-progress mark + "in flight · no mean yet" when running but
 * unjudged; the count + measurement strip + mean once completions are judged.
 */
export function SessionsInline({ sessions }: { sessions: SessionsSignal }) {
  const n = totalSessions(sessions);
  if (n === 0) return <SessionsText sessions={sessions} />;

  const weak = sessionsMeanIsWeak(sessions);
  return (
    <Flex align="center" gap={2} minW={0}>
      <SessionsText sessions={sessions} />
      {sessions.meanFitness === null ? (
        <>
          <InProgressDot color={VIOLET_500} size={10} />
          <Text fontSize="xs" color="charcoal.400" whiteSpace="nowrap">
            in flight · no mean yet
          </Text>
        </>
      ) : (
        <>
          <SessionsMeasureStrip sessions={sessions} />
          <Text
            fontFamily="heading"
            fontWeight="800"
            fontSize="xs"
            color={weak ? AMBER : VIOLET_600}
            whiteSpace="nowrap"
          >
            {weak ? "! " : ""}
            {sessions.meanFitness.toFixed(1)}
          </Text>
        </>
      )}
    </Flex>
  );
}

/**
 * The Sessions read for the composed header pill (`NodeMaturityCta`) — the
 * violet count paired with the inline measurement strip + mean, so the record
 * reads as *data* (number + performance), never a bare badge on a colored tier.
 * In-flight sessions with no completions show a static in-progress mark instead
 * of a fabricated score; a weak mean tints the mean amber.
 */
export function SessionsPillMark({ sessions }: { sessions: SessionsSignal }) {
  const n = totalSessions(sessions);
  const weak = sessionsMeanIsWeak(sessions);
  return (
    <Flex align="center" gap={1.5} flexShrink={0}>
      <Text
        fontFamily="heading"
        fontWeight="800"
        fontSize="xs"
        color={VIOLET_600}
        whiteSpace="nowrap"
      >
        <Box as="span" fontWeight="900">
          {n}
        </Box>{" "}
        {n === 1 ? "session" : "sessions"}
      </Text>
      {sessions.meanFitness === null ? (
        <InProgressDot color={VIOLET_500} size={10} />
      ) : (
        <>
          <SessionsMeasureStrip sessions={sessions} w="60px" />
          <Text
            fontFamily="heading"
            fontWeight="800"
            fontSize="xs"
            color={weak ? AMBER : VIOLET_600}
            whiteSpace="nowrap"
          >
            {weak ? "! " : ""}
            {sessions.meanFitness.toFixed(1)}
          </Text>
        </>
      )}
    </Flex>
  );
}

// ── Hub panel · "Track its record" ─────────────────────────────────────

/** The hub's full distribution — the SAME violet measurement strip as the pill,
 *  scaled up, with a 1–5 axis underneath. Dots = one real judged session; the
 *  solid band = the mean; the dashed amber tick = the sims' prediction (its
 *  value is labelled up on the Scholar-bot rehearsal step, not in the chart). */
export function SessionsDistribution({ sessions }: { sessions: SessionsSignal }) {
  return (
    <Box maxW="300px" mt={2} mb={5}>
      <SessionsMeasureStrip sessions={sessions} w="100%" h="30px" dot="8px" />
      <Box position="relative" h="12px" mt="4px">
        {[1, 2, 3, 4, 5].map((n) => (
          <Text
            key={n}
            position="absolute"
            left={`${pct(n)}%`}
            fontSize="9px"
            color="#9aa2ad"
            transform="translateX(-50%)"
          >
            {n}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function RecordRow({
  pip,
  label,
  detail,
  action,
}: {
  pip: React.ReactNode;
  label: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Flex align="center" gap={2.5} py={2} borderBottomWidth="1px" borderBottomColor="gray.100" borderStyle="dashed">
      {pip}
      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="#3a4658">
        {label}
      </Text>
      <Flex ml="auto" align="center" gap={1.5}>
        {action ?? (
          <Text fontSize="xs" color="charcoal.400">
            {detail}
          </Text>
        )}
      </Flex>
    </Flex>
  );
}

/**
 * The hub's right panel — "Track its record". Leads with the distribution
 * (calibration made visible), then plain Active / Complete / Debrief rows. When
 * nothing's assigned yet the panel says so — the readiness gate stands alone.
 */
export function SessionsPanel({
  sessions,
  onRunDebrief,
}: {
  sessions: SessionsSignal;
  onRunDebrief?: () => void;
}) {
  const n = totalSessions(sessions);
  const weak = sessionsMeanIsWeak(sessions);
  return (
    <Box p={5} h="full" overflowY="auto">
      <Text fontFamily="heading" fontWeight="800" fontSize="md" color="navy.500">
        Track its record
      </Text>
      <Text fontSize="xs" color="charcoal.400" mb={3}>
        Sessions — real runthroughs, accrue after it ships
      </Text>

      {n === 0 ? (
        <Flex
          direction="column"
          align="flex-start"
          gap={1}
          mt={4}
          p={4}
          borderWidth="1px"
          borderColor="gray.100"
          borderRadius="lg"
          bg="gray.50"
        >
          <SessionsText sessions={sessions} />
          <Text fontSize="xs" color="charcoal.400">
            No record yet — assign it to real scholars and their sessions accrue here.
          </Text>
        </Flex>
      ) : (
        <>
          {sessions.meanFitness !== null && <SessionsDistribution sessions={sessions} />}
          <RecordRow
            pip={
              sessions.activeCount > 0 ? (
                <InProgressDot color={VIOLET_500} />
              ) : (
                <HollowDot color={VIOLET_500} />
              )
            }
            label="Active"
            detail={`${sessions.activeCount} session${sessions.activeCount === 1 ? "" : "s"} in flight`}
          />
          <RecordRow
            pip={
              sessions.completeCount > 0 ? (
                <CircleCheck color={weak ? AMBER_MARK : VIOLET} />
              ) : (
                <HollowDot color={VIOLET_500} />
              )
            }
            label="Complete"
            detail={
              sessions.meanFitness !== null ? (
                // as="span": RecordRow already wraps detail in a <Text> (a <p>),
                // so this must not render a nested <p> (hydration error).
                <Text as="span" fontSize="xs" color="charcoal.400">
                  {sessions.completeCount} session{sessions.completeCount === 1 ? "" : "s"} ·{" "}
                  <Box as="b" color={weak ? AMBER : VIOLET_600}>
                    mean {sessions.meanFitness.toFixed(1)}
                  </Box>
                </Text>
              ) : (
                `${sessions.completeCount} complete · no mean yet`
              )
            }
          />
          <RecordRow
            pip={<HollowDot color="#c3c9d2" />}
            label="Debrief"
            action={
              <Button
                size="xs"
                h="26px"
                variant="outline"
                borderColor="gray.300"
                color="charcoal.500"
                fontFamily="heading"
                fontWeight="700"
                fontSize="xs"
                onClick={onRunDebrief}
              >
                Run debrief
              </Button>
            }
          />
        </>
      )}
    </Box>
  );
}

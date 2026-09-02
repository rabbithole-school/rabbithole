"use client";

/**
 * MomentActions — the triage layer on a class-digest key moment. Turns a
 * surfaced moment into a durable record with one click: log a private
 * observation or plant an exploration seed for that scholar. Both write
 * to existing backends (observations.add / seeds.create).
 *
 * Uses INLINE expanding forms (not a Dialog) on purpose — avoids the
 * Chakra/Ark body-lock leak (see engineering-principles.md).
 */

import { useState } from "react";
import {
  Box,
  Button,
  HStack,
  Input,
  Stack,
  Textarea,
} from "@chakra-ui/react";
import Link from "next/link";
import {
  NotePencil,
  Sparkle,
  Check,
  X,
  ArrowSquareOut,
} from "@phosphor-icons/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { toaster } from "@/lib/toaster";
import type { MomentKind } from "@/components/ClassDigestView";
import type { ObservationType } from "@/components/ObservationCard";

const OBS_TYPES: ObservationType[] = [
  "praise",
  "concern",
  "suggestion",
  "intervention",
  "note",
];

// Sensible default observation type per moment kind.
const DEFAULT_OBS: Record<MomentKind, ObservationType> = {
  breakthrough: "praise",
  insight: "praise",
  misconception: "suggestion",
  needsHelp: "concern",
  offTask: "concern",
};

export function MomentActions({
  scholarId,
  scholarName,
  sessionId,
  momentHeadline,
  momentDetail,
  kind,
}: {
  scholarId: Id<"users">;
  scholarName: string;
  sessionId?: Id<"sessions">;
  momentHeadline: string;
  momentDetail: string;
  kind: MomentKind;
}) {
  const [open, setOpen] = useState<null | "observation" | "seed">(null);
  const [done, setDone] = useState<null | "observation" | "seed">(null);
  const [busy, setBusy] = useState(false);

  const addObservation = useMutation(api.observations.add);
  const createSeed = useMutation(api.seeds.create);

  // Observation form state
  const [obsNote, setObsNote] = useState(
    `${momentHeadline}${momentDetail ? ` — ${momentDetail}` : ""}`,
  );
  const [obsType, setObsType] = useState<ObservationType>(DEFAULT_OBS[kind]);

  // Seed form state
  const [seedTopic, setSeedTopic] = useState(momentHeadline.slice(0, 80));
  const [seedRationale, setSeedRationale] = useState(momentDetail);

  const saveObservation = async () => {
    if (!obsNote.trim()) return;
    setBusy(true);
    try {
      await addObservation({
        scholarId,
        sessionId,
        note: obsNote,
        type: obsType,
      });
      toaster.success({ title: `Observation logged for ${scholarName}` });
      setOpen(null);
      setDone("observation");
    } finally {
      setBusy(false);
    }
  };

  const saveSeed = async () => {
    if (!seedTopic.trim()) return;
    setBusy(true);
    try {
      await createSeed({
        scholarId,
        topic: seedTopic,
        rationale: seedRationale || momentHeadline,
      });
      toaster.success({ title: `Seed planted for ${scholarName}` });
      setOpen(null);
      setDone("seed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <HStack gap={2}>
        <Button
          size="2xs"
          variant="ghost"
          color={done === "observation" ? "green.600" : "charcoal.500"}
          _hover={{ color: "violet.500", bg: "violet.50" }}
          fontFamily="heading"
          onClick={() => setOpen(open === "observation" ? null : "observation")}
        >
          {done === "observation" ? (
            <Check size={12} style={{ marginRight: 4 }} />
          ) : (
            <NotePencil size={12} style={{ marginRight: 4 }} />
          )}
          {done === "observation" ? "Logged" : "Log observation"}
        </Button>
        <Button
          size="2xs"
          variant="ghost"
          color={done === "seed" ? "green.600" : "charcoal.500"}
          _hover={{ color: "violet.500", bg: "violet.50" }}
          fontFamily="heading"
          onClick={() => setOpen(open === "seed" ? null : "seed")}
        >
          {done === "seed" ? (
            <Check size={12} style={{ marginRight: 4 }} />
          ) : (
            <Sparkle size={12} weight="fill" style={{ marginRight: 4 }} />
          )}
          {done === "seed" ? "Planted" : "Plant seed"}
        </Button>
        {sessionId && (
          <Button
            size="2xs"
            variant="ghost"
            color="charcoal.500"
            _hover={{ color: "violet.500", bg: "violet.50" }}
            fontFamily="heading"
            asChild
          >
            <Link href={`/scholar/${sessionId}`}>
              <ArrowSquareOut size={12} style={{ marginRight: 4 }} />
              Open session
            </Link>
          </Button>
        )}
      </HStack>

      {open === "observation" && (
        <Box mt={2} maxW="md">
          <Stack gap={2}>
            <HStack gap={1.5} flexWrap="wrap">
              {OBS_TYPES.map((tp) => (
                <Button
                  key={tp}
                  size="2xs"
                  variant={obsType === tp ? "solid" : "outline"}
                  colorPalette={obsType === tp ? "violet" : "gray"}
                  fontFamily="heading"
                  textTransform="capitalize"
                  onClick={() => setObsType(tp)}
                >
                  {tp}
                </Button>
              ))}
            </HStack>
            <Textarea
              size="sm"
              value={obsNote}
              onChange={(e) => setObsNote(e.target.value)}
              rows={2}
              autoresize
            />
            <HStack gap={2}>
              <Button
                size="xs"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={saveObservation}
                loading={busy}
              >
                Save observation
              </Button>
              <Button
                size="xs"
                variant="ghost"
                color="charcoal.400"
                onClick={() => setOpen(null)}
              >
                <X size={12} />
              </Button>
            </HStack>
          </Stack>
        </Box>
      )}

      {open === "seed" && (
        <Box mt={2} maxW="md">
          <Stack gap={2}>
            <Input
              size="sm"
              value={seedTopic}
              onChange={(e) => setSeedTopic(e.target.value)}
              placeholder="Topic to explore"
            />
            <Textarea
              size="sm"
              value={seedRationale}
              onChange={(e) => setSeedRationale(e.target.value)}
              rows={2}
              autoresize
              placeholder="Why this seed (the scholar won't see this)"
            />
            <HStack gap={2}>
              <Button
                size="xs"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={saveSeed}
                loading={busy}
              >
                <Sparkle size={12} weight="fill" style={{ marginRight: 4 }} />
                Plant seed
              </Button>
              <Button
                size="xs"
                variant="ghost"
                color="charcoal.400"
                onClick={() => setOpen(null)}
              >
                <X size={12} />
              </Button>
            </HStack>
          </Stack>
        </Box>
      )}
    </Box>
  );
}

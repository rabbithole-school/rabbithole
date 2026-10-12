"use client";

/**
 * The kind="vibecode" MODEL CONTRACT group of the activity editor — the
 * steering note the App designer reads alongside the build brief
 * (schema.ts activities.buildContract + allowSilence). Each list is edited
 * one entry per line and saved on blur; limits are enforced server-side by
 * convex/lib/buildContract.ts, and a refusal surfaces as a toast.
 */

import { useEffect, useState } from "react";
import { Box, Stack, Switch, Text, Textarea, Input } from "@chakra-ui/react";
import type { Id } from "@/convex/_generated/dataModel";
import { Field, SectionHeader } from "./shared";
import { toaster } from "@/lib/toaster";

export type BuildContract = {
  invariants: string[];
  freedoms: string[];
  gate?: string;
};

/** Split a one-entry-per-line textarea into trimmed, non-empty entries. */
export const contractLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * The value to save after editing one part of the contract: `null` clears an
 * all-empty contract; `"needsInvariant"` means the teacher typed freedoms or
 * a gate without any "must be true" line, which the server would refuse.
 * Shared by this editor and the curriculum document view.
 */
export function nextBuildContract(
  current: BuildContract | undefined,
  patch: Partial<BuildContract>,
): BuildContract | null | "needsInvariant" {
  const invariants = patch.invariants ?? current?.invariants ?? [];
  const freedoms = patch.freedoms ?? current?.freedoms ?? [];
  const gate = ("gate" in patch ? patch.gate : current?.gate)?.trim() ?? "";
  if (invariants.length === 0 && freedoms.length === 0 && !gate) return null;
  if (invariants.length === 0) return "needsInvariant";
  return { invariants, freedoms, ...(gate ? { gate } : {}) };
}

export function VibecodeContractFields({
  activityId,
  buildContract,
  allowSilence,
  update,
}: {
  activityId: Id<"activities">;
  buildContract: BuildContract | undefined;
  allowSilence: boolean | undefined;
  update: (args: {
    id: Id<"activities">;
    buildContract?: BuildContract | null;
    allowSilence?: boolean;
  }) => Promise<unknown>;
}) {
  const remoteInvariants = (buildContract?.invariants ?? []).join("\n");
  const remoteFreedoms = (buildContract?.freedoms ?? []).join("\n");
  const remoteGate = buildContract?.gate ?? "";
  const [invariants, setInvariants] = useState(remoteInvariants);
  const [freedoms, setFreedoms] = useState(remoteFreedoms);
  const [gate, setGate] = useState(remoteGate);

  // Reset local drafts when the stored contract changes (switching
  // activities, or the aide rewriting it).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInvariants(remoteInvariants);
  }, [remoteInvariants]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFreedoms(remoteFreedoms);
  }, [remoteFreedoms]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGate(remoteGate);
  }, [remoteGate]);

  // A contract needs at least one "must be true" line; anything else typed
  // without one is held locally until it has one.
  const next = nextBuildContract(undefined, {
    invariants: contractLines(invariants),
    freedoms: contractLines(freedoms),
    gate,
  });
  const needsInvariant = next === "needsInvariant";

  const save = async () => {
    if (next === "needsInvariant") return;
    const unchanged =
      (next === null && buildContract === undefined) ||
      (next !== null &&
        next.invariants.join("\n") === remoteInvariants &&
        next.freedoms.join("\n") === remoteFreedoms &&
        (next.gate ?? "") === remoteGate);
    if (unchanged) return;
    try {
      await update({ id: activityId, buildContract: next });
    } catch (err) {
      console.error(err);
      toaster.error({
        title: "Couldn't save the model contract",
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const textareaProps = {
    fontSize: "sm",
    fontFamily: "body",
    borderColor: "gray.200",
    _focus: { borderColor: "violet.400", boxShadow: "none" },
  } as const;

  return (
    <Stack gap={3}>
      <SectionHeader title="Model contract" />
      <Field
        label="Must be true"
        hint="One per line, up to 5. What the scholar's app must get right, as a mechanic you could check by running it."
      >
        <Textarea
          value={invariants}
          onChange={(e) => setInvariants(e.target.value)}
          onBlur={() => void save()}
          rows={3}
          placeholder="e.g. Winged seeds drift with the wind; heavy seeds land near the parent"
          aria-label="Must be true"
          {...textareaProps}
          borderColor={needsInvariant ? "red.400" : "gray.200"}
        />
        {needsInvariant && (
          <Text fontSize="xs" color="red.600" mt={1}>
            Add at least one line here to save the contract.
          </Text>
        )}
      </Field>
      <Field
        label="Scholar owns"
        hint="One per line, up to 8. What the scholar decides outright: setting, characters, genre, visuals, side quests."
      >
        <Textarea
          value={freedoms}
          onChange={(e) => setFreedoms(e.target.value)}
          onBlur={() => void save()}
          rows={3}
          placeholder="e.g. The setting — any island, planet, or backyard"
          aria-label="Scholar owns"
          {...textareaProps}
        />
      </Field>
      <Field
        label="Gate"
        hint="What must exist and have run once before the designer builds cosmetic requests."
      >
        <Input
          size="sm"
          value={gate}
          onChange={(e) => setGate(e.target.value)}
          onBlur={() => void save()}
          placeholder="e.g. One generation of seeds dropped and sprouted, before any redesign"
          aria-label="Gate"
          {...textareaProps}
        />
      </Field>
      <Box>
        <Switch.Root
          // Silence only applies under a model contract (the server drops
          // allowSilence without one), so the switch waits for it.
          disabled={!buildContract}
          checked={!!allowSilence && !!buildContract}
          onCheckedChange={(d) =>
            void update({ id: activityId, allowSilence: !!d.checked }).catch(
              (err: unknown) => {
                console.error(err);
                toaster.error({ title: "Couldn't change the setting" });
              },
            )
          }
          colorPalette="violet"
          size="sm"
        >
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontFamily="heading" fontSize="sm" color="charcoal.600">
            Designer may stay silent until a question is answered
          </Switch.Label>
        </Switch.Root>
        <Text fontSize="2xs" color="charcoal.400" pl={6} mt={0.5}>
          {buildContract
            ? "When the designer asks a learning question, it waits for a real answer instead of building past it."
            : "Needs a model contract"}
        </Text>
      </Box>
    </Stack>
  );
}

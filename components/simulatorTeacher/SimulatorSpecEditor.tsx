"use client";

/**
 * The EDIT tab for a World activity (plan §8). This is the TEMPLATE-AGNOSTIC
 * shell: loading/draft states, the Physics card (template/interpreter/
 * micro-world), the error banner, and the save bar. Every template-specific
 * field (criterion, config, species slots, budgets) lives in that template's
 * Form component in `./forms/` — see `./forms/registry.ts`. Adding a new
 * template is one registry entry + one Form; this file never grows a
 * template-specific branch.
 *
 * Every save round-trips through simulator.saveSimulatorSpec → template.validateSpec,
 * so an illegal combination is rejected server-side with a human-readable
 * reason rather than silently stored. A world with no spec renders the Draft
 * state with one "start from a template" button per registered template.
 *
 * A template the SERVER knows about but that has no registered Form yet
 * (e.g. it landed in `lib/simulator/templates/registry.ts` before its author UI
 * was built) falls back to a read-only notice — the only case that notice is
 * shown, per plan §8's editing-boundary intent.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { WarningCircle } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { SimulatorSpec } from "@/lib/simulator/contract";
import { toaster } from "@/lib/toaster";
import { getSimulatorForm } from "./forms/registry";
import { InterpreterField, Label, MicroWorldSwitch, SectionCard, selectStyle } from "./forms/shared";
import type { DeepWritable } from "./forms/types";

export function SimulatorSpecEditor({ activityId }: { activityId: Id<"activities"> }) {
  const design = useQuery(api.simulator.simulatorDesign, { activityId });
  const save = useMutation(api.simulator.saveSimulatorSpec);
  const [draft, setDraft] = useState<SimulatorSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    // Load the remote spec into the local draft when it changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(design?.simulatorSpec ?? null);
  }, [design?.simulatorSpec]);

  if (design === undefined) {
    return (
      <Flex py={16} align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Loading…
        </Text>
      </Flex>
    );
  }
  if (design === null) {
    return (
      <Flex py={16} align="center" justify="center">
        <Text fontSize="sm" color="charcoal.400">
          Activity not found.
        </Text>
      </Flex>
    );
  }

  const patch = (mut: (next: DeepWritable<SimulatorSpec>) => void) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const next = structuredClone(prev) as DeepWritable<SimulatorSpec>;
      mut(next);
      return next as SimulatorSpec;
    });
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await save({ activityId, spec: draft });
      toaster.success({ title: "Simulator saved" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // ── Draft state: no spec yet — offer every template with a registered form ──
  if (!draft) {
    const startable = design.templates.filter((t) => getSimulatorForm(t.id) !== null);
    return (
      <Box p={8}>
        <Box
          maxW="520px"
          mx="auto"
          mt={8}
          borderWidth="1px"
          borderColor="gray.200"
          borderRadius="lg"
          bg="white"
          p={6}
          textAlign="center"
        >
          <Text fontSize="3xl" mb={2}>
            🌍
          </Text>
          <Text fontFamily="heading" fontWeight="800" fontSize="md" color="navy.500" mb={1}>
            Draft — no Simulator configured
          </Text>
          <Text fontSize="sm" color="charcoal.500" mb={4}>
            A simulator is config over a code-owned physics template. Start from a template, then
            tune the criterion, species and budgets. Scholars author prompt decks over it.
          </Text>
          <Stack gap={2} align="center">
            {startable.map((templateMeta) => {
              const entry = getSimulatorForm(templateMeta.id)!;
              return (
                <Button
                  key={templateMeta.id}
                  bg="violet.500"
                  color="white"
                  fontFamily="heading"
                  fontWeight="700"
                  _hover={{ bg: "violet.600" }}
                  onClick={() =>
                    setDraft(entry.defaultSpec(templateMeta, activityId))
                  }
                >
                  {entry.startLabel}
                </Button>
              );
            })}
          </Stack>
        </Box>
      </Box>
    );
  }

  const templateMeta = design.templates.find((t) => t.id === draft.templateId) ?? design.templates[0];
  const formEntry = getSimulatorForm(draft.templateId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(design.simulatorSpec);

  // A template the server knows about but with no author-facing form yet —
  // the only case that gets the read-only notice.
  if (!formEntry) {
    return (
      <Box p={8}>
        <Box maxW="520px" mx="auto" mt={8} borderWidth="1px" borderColor="gray.200" borderRadius="lg" bg="white" p={6}>
          <Text fontFamily="heading" fontWeight="800" fontSize="md" color="navy.500" mb={1}>
            {draft.templateId} Simulator
          </Text>
          <Text fontSize="sm" color="charcoal.500">
            This Simulator runs on the <strong>{draft.templateId}</strong> template, which doesn&apos;t have
            an editor form yet. Its interpreter can still be changed here.
          </Text>
          <Box mt={4}>
            <InterpreterField
              interpreter={draft.interpreter}
              onChange={(interpreter) =>
                patch((next) => {
                  next.interpreter = interpreter;
                })
              }
            />
          </Box>
          {dirty ? (
            <Button
              mt={4}
              colorPalette="violet"
              loading={saving}
              onClick={handleSave}
            >
              Save interpreter
            </Button>
          ) : null}
        </Box>
      </Box>
    );
  }

  const editableTemplates = design.templates.filter((t) => t.id === draft.templateId);
  const Form = formEntry.Form;

  return (
    <Box p={5}>
      <Stack gap={4} maxW="900px" mx="auto" pb={20}>
        {(error || design.specError) && (
          <Box borderWidth="1px" borderColor="red.300" bg="red.50" borderRadius="md" px={3} py={2}>
            <HStack gap={1.5} align="flex-start" color="red.600">
              <Box mt="2px" flexShrink={0}>
                <WarningCircle size={14} />
              </Box>
              <Text fontSize="xs" fontFamily="heading" lineHeight="1.5">
                {error ?? design.specError}
              </Text>
            </HStack>
          </Box>
        )}

        {/* Template + interpreter + micro-world — shared across every template */}
        <SectionCard title="Physics">
          <Stack gap={3}>
            <Box>
              <Label>Template</Label>
              <select
                aria-label="Physics template"
                style={selectStyle}
                value={draft.templateId}
                onChange={(e) => patch((n) => (n.templateId = e.target.value as SimulatorSpec["templateId"]))}
              >
                {editableTemplates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.id} v{t.version}
                  </option>
                ))}
              </select>
              <Text fontSize="2xs" color="charcoal.400" mt={1}>
                Templates are code. The editor parameterizes them; it can&apos;t invent physics.
              </Text>
            </Box>
            <HStack gap={6} align="center">
              <InterpreterField
                interpreter={draft.interpreter}
                onChange={(interpreter) =>
                  patch((next) => {
                    next.interpreter = interpreter;
                  })
                }
              />
              <MicroWorldSwitch
                checked={draft.microWorld}
                onCheckedChange={(checked) => patch((n) => (n.microWorld = checked))}
              />
            </HStack>
          </Stack>
        </SectionCard>

        <Form
          activityId={activityId}
          draft={draft}
          templateMeta={templateMeta}
          limits={design.limits}
          patch={patch}
        />
      </Stack>

      {/* Save bar */}
      <Flex
        position="sticky"
        bottom={0}
        bg="white"
        borderTopWidth="1px"
        borderColor="gray.200"
        px={5}
        py={3}
        justify="flex-end"
        align="center"
        gap={3}
        mt={-16}
      >
        {dirty && (
          <Text fontSize="xs" color="amber.600" fontFamily="heading">
            Unsaved changes
          </Text>
        )}
        <Button
          bg="violet.500"
          color="white"
          fontFamily="heading"
          fontWeight="700"
          _hover={{ bg: "violet.600" }}
          loading={saving}
          disabled={!dirty}
          onClick={handleSave}
        >
          Save Simulator
        </Button>
      </Flex>
    </Box>
  );
}

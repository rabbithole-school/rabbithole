"use client";

// The staff-aide "vote with your feet" model picker — a per-person choice
// of which Claude model powers the aide (Chat tab, Curriculum Bot, Slack),
// persisted on users.aideModel and resolved server-side in
// convex/lib/aideModel.ts. Small enough to live in every aide header.
//
// Deliberately staff-honest about the trade-off — one clean speed↔smarts axis:
// Sonnet is the fastest, Opus 5.5 is smart and quicker and is the default,
// Fable is the smartest.
//
// Two things this control must make true, both learned from a real incident
// (2026-09-03) where staff sat pinned to an older model through a fleet
// upgrade without anyone — themselves included — being able to tell:
//
//  1. "Default" is a choice you can make. Picking it CLEARS the pin, so the
//     person follows the fleet default and inherits every future upgrade.
//     Un-pinning was always supported by the mutation and reachable from
//     nowhere; the picker only ever offered three permanent pins.
//  2. A pin is VISIBLE. This used to render `aideModel ?? "fable"`, so being
//     unpinned looked exactly like being pinned to Fable — which is precisely
//     how the stale pins survived a model change unnoticed. Pinned state now
//     carries a pin glyph on the trigger.
//
// Every model name is derived from MODEL_DISPLAY so a model bump can't leave
// stale copy behind (the old aide tool advertised "Claude Fable 5" for the
// entire Fable 5 → 5.1 rollout).

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Menu, Portal, Button, Text, Box } from "@chakra-ui/react";
import { CaretDown, Check, PushPin } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";
import { MODELS, modelLabel } from "@/convex/lib/models";
import { resolveAideModel } from "@/convex/lib/aideModel";

type Choice = "sonnet" | "opus" | "fable";

/** "Claude Fable 5.1" → "Fable 5.1" — the header has no room to repeat the
 *  vendor on every entry, and the full name still shows in the menu. */
const short = (id: string) => modelLabel(id).replace(/^Claude /, "");

const DEFAULT_MODEL = resolveAideModel(undefined);

const OPTIONS: Array<{ value: Choice; model: string; hint: string }> = [
  { value: "fable", model: MODELS.FABLE, hint: "Smartest" },
  { value: "opus", model: MODELS.OPUS_5_5, hint: "Smart and quicker" },
  { value: "sonnet", model: MODELS.SONNET, hint: "Fastest" },
];

export default function AideModelPicker({
  size = "sm",
}: {
  /** Trigger scale. Header surfaces default to `sm`; pass `xs` in tight
   *  icon-cluster headers (e.g. the scholar/unit aide panes) so it doesn't
   *  outgrow the neighbouring size-xs icon buttons. */
  size?: "xs" | "sm";
}) {
  const { user } = useCurrentUser();
  const setAideModel = useMutation(api.users.setAideModel);

  if (!user) return null;
  // Absent means unpinned — the state this control previously could neither
  // show nor set.
  const pinned = (user.aideModel as Choice | undefined) ?? null;
  const activeModel = resolveAideModel(pinned ?? undefined);
  const compact = size === "xs";

  const pick = async (value: Choice | null) => {
    if (value === pinned) return;
    try {
      await setAideModel(value ? { model: value } : {});
      toaster.success({
        title: value
          ? `Chat model: ${modelLabel(resolveAideModel(value))}`
          : `Chat model: the default (${modelLabel(DEFAULT_MODEL)})`,
        description: value
          ? "Pinned for you everywhere, from your next message."
          : "You'll follow the default from your next message, upgrades included.",
      });
    } catch {
      toaster.error({ title: "Couldn't switch model" });
    }
  };

  return (
    <Menu.Root positioning={{ placement: "bottom-end" }}>
      <Menu.Trigger asChild>
        <Button
          size={size}
          variant="ghost"
          fontFamily="heading"
          fontWeight="600"
          fontSize={compact ? "2xs" : "sm"}
          color="charcoal.400"
          _hover={{ color: "charcoal.600" }}
          aria-label="Choose chat model"
          title={
            pinned
              ? `Pinned to ${modelLabel(activeModel)} — you won't follow future default changes. Choose "Default" to follow them again.`
              : `Following the default (${modelLabel(activeModel)}) — which Claude model powers your chat, on every surface`
          }
        >
          {short(activeModel)}
          {pinned && (
            <PushPin
              size={compact ? 9 : 11}
              weight="fill"
              style={{ marginLeft: "3px" }}
              aria-label="pinned"
            />
          )}
          <CaretDown size={compact ? 10 : 14} style={{ marginLeft: "3px" }} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content
            minW="240px"
            shadow="md"
            borderRadius="lg"
            border="1px solid"
            borderColor="gray.200"
          >
            <Menu.Item value="default" onClick={() => void pick(null)} py={2}>
              <Box flex={1}>
                <Text fontFamily="heading" fontSize="xs" fontWeight="600" color="navy.500">
                  Default
                </Text>
                <Text fontSize="2xs" color="charcoal.400">
                  {modelLabel(DEFAULT_MODEL)} today — follows future upgrades
                </Text>
              </Box>
              {!pinned && <Check size={12} weight="bold" />}
            </Menu.Item>
            {OPTIONS.map((o) => (
              <Menu.Item
                key={o.value}
                value={o.value}
                onClick={() => void pick(o.value)}
                py={2}
              >
                <Box flex={1}>
                  <Text fontFamily="heading" fontSize="xs" fontWeight="600" color="navy.500">
                    {modelLabel(o.model)}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400">
                    {o.hint} — pinned until you change it
                  </Text>
                </Box>
                {o.value === pinned && <Check size={12} weight="bold" />}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

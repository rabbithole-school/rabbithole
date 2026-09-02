"use client";

// The staff-aide "vote with your feet" model picker — a per-person choice
// of which Claude model powers the aide (Chat tab, Curriculum Bot, Slack),
// persisted on users.aideModel and resolved server-side in
// convex/lib/aideModel.ts. Small enough to live in every aide header.
//
// Deliberately staff-honest about the trade-off — one clean speed↔smarts axis:
// Sonnet is the fastest, Opus is smart and quick, Fable is the smartest (it
// takes its time) and is the default (teacher reasoning is upstream of
// everything).

import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Menu, Portal, Button, Text, Box } from "@chakra-ui/react";
import { CaretDown, Check } from "@phosphor-icons/react";
import { toaster } from "@/lib/toaster";

type Choice = "sonnet" | "opus" | "fable";

const OPTIONS: Array<{
  value: Choice;
  label: string;
  hint: string;
}> = [
  {
    value: "fable",
    label: "Fable",
    hint: "Smartest — takes its time (the default)",
  },
  {
    value: "opus",
    label: "Opus",
    hint: "Smart and quick",
  },
  {
    value: "sonnet",
    label: "Sonnet",
    hint: "Fastest",
  },
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
  const current: Choice = (user.aideModel as Choice | undefined) ?? "fable";
  const currentOption = OPTIONS.find((o) => o.value === current) ?? OPTIONS[0];
  const compact = size === "xs";

  const pick = async (value: Choice) => {
    if (value === current) return;
    try {
      await setAideModel({ model: value });
      toaster.success({
        title: `Chat model: Claude ${OPTIONS.find((o) => o.value === value)?.label}`,
        description: "Takes effect from your next message.",
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
          title="Which Claude model powers your chat (your personal preference, all surfaces)"
        >
          {currentOption.label}
          <CaretDown size={compact ? 10 : 14} style={{ marginLeft: "3px" }} />
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content
            minW="220px"
            shadow="md"
            borderRadius="lg"
            border="1px solid"
            borderColor="gray.200"
          >
            {OPTIONS.map((o) => (
              <Menu.Item
                key={o.value}
                value={o.value}
                onClick={() => void pick(o.value)}
                py={2}
              >
                <Box flex={1}>
                  <Text fontFamily="heading" fontSize="xs" fontWeight="600" color="navy.500">
                    Claude {o.label}
                  </Text>
                  <Text fontSize="2xs" color="charcoal.400">
                    {o.hint}
                  </Text>
                </Box>
                {o.value === current && <Check size={12} weight="bold" />}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

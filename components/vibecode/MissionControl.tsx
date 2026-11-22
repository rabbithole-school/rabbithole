"use client";

import { Button, Popover, Portal, Stack, Text } from "@chakra-ui/react";

import { missionLines, YOUR_MISSION_LABEL } from "@/shared/missionFlair";

export function MissionControl({
  criteria,
}: {
  criteria: readonly { id: string; label: string }[];
}) {
  const lines = missionLines(criteria);
  if (lines.length === 0) return null;

  return (
    <Popover.Root positioning={{ placement: "top", gutter: 6 }}>
      <Popover.Trigger asChild>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          color="fg.muted"
          fontFamily="heading"
          fontSize="sm"
          flexShrink={0}
        >
          {YOUR_MISSION_LABEL}
        </Button>
      </Popover.Trigger>
      <Portal>
        <Popover.Positioner>
          <Popover.Content
            w={{ base: "calc(100vw - 32px)", md: "360px" }}
            maxW="360px"
            maxH="min(60vh, 400px)"
            overflowY="auto"
            borderColor="border"
            shadow="md"
          >
            <Popover.Body>
              <Popover.Title fontFamily="heading" fontWeight="600" mb={3}>
                {YOUR_MISSION_LABEL}
              </Popover.Title>
              <Stack as="ul" gap={3} listStyleType="none" m={0} p={0}>
                {lines.map((line, index) => (
                  <Text as="li" key={index} fontSize="sm" lineHeight="tall">
                    {line}
                  </Text>
                ))}
              </Stack>
            </Popover.Body>
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}

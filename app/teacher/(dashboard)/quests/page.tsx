"use client";

import dynamic from "next/dynamic";
import { Flex, Box } from "@chakra-ui/react";

// Quests — per-scholar, self-authored units.
const QuestsTab = dynamic(
  () => import("@/components/QuestsTab").then((m) => m.QuestsTab),
  { ssr: false },
);

export default function QuestsPage() {
  return (
    <Flex h="full" direction="column" overflow="auto" bg="gray.50">
      <Box px={6} py={4} flex={1}>
        <QuestsTab />
      </Box>
    </Flex>
  );
}

"use client";

import { Box } from "@chakra-ui/react";
import { TeacherMessages } from "@/components/TeacherMessages";

// Teacher/operations staff Messages tab — the staff side of teacher↔parent messaging.
// The shared dashboard layout provides the gate + top nav; this route owns the
// inbox + compose. See components/TeacherMessages.tsx.
export default function TeacherMessagesPage() {
  return (
    <Box flex={1} h="full" overflow="hidden" bg="gray.50">
      <TeacherMessages />
    </Box>
  );
}

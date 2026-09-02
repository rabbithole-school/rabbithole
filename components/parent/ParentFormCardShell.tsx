import type { ReactNode } from "react";
import { Box } from "@chakra-ui/react";

export function ParentFormCardShell({
  children,
  labelledBy,
}: {
  children: ReactNode;
  labelledBy?: string;
}) {
  return (
    <Box
      as="section"
      bg="white"
      borderWidth="1px"
      borderColor="border.default"
      borderRadius="xl"
      p={{ base: 4, md: 5 }}
      aria-labelledby={labelledBy}
    >
      {children}
    </Box>
  );
}

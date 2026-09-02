import type { ReactNode } from "react";
import { Flex, Heading, HStack, type FlexProps } from "@chakra-ui/react";

interface ScholarHomeSectionHeaderProps {
  children: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  color?: FlexProps["color"];
}

export function ScholarHomeSectionHeader({
  children,
  icon,
  actions,
  color = "charcoal.400",
}: ScholarHomeSectionHeaderProps) {
  return (
    <Flex justify="space-between" align="center" gap={3} userSelect="none">
      <HStack gap={2} minW={0} color={color}>
        {icon}
        <Heading
          as="h2"
          fontFamily="heading"
          fontSize="xs"
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.06em"
          color="inherit"
        >
          {children}
        </Heading>
      </HStack>
      {actions}
    </Flex>
  );
}

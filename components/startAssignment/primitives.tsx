// Small form/column primitives shared by StartAssignmentDialog's modes.

import { chakra, Flex, Spinner, Text } from "@chakra-ui/react";

export function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="2xs"
      fontFamily="heading"
      fontWeight="700"
      letterSpacing="0.04em"
      textTransform="uppercase"
      color="charcoal.400"
      mb={1.5}
    >
      {children}
    </Text>
  );
}

export function DateTimeInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <chakra.input
      type="datetime-local"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      w="full"
      px={3}
      py={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      fontFamily="heading"
      fontSize="sm"
      bg="white"
    />
  );
}

export function PlainSelect({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
}) {
  return (
    <chakra.select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      w="full"
      px={3}
      py={2}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="md"
      fontFamily="heading"
      fontSize="sm"
      bg="white"
      cursor="pointer"
    >
      {children}
    </chakra.select>
  );
}

export function ColumnSpinner() {
  return (
    <Flex justify="center" py={6}>
      <Spinner size="sm" color="violet.500" />
    </Flex>
  );
}

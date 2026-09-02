import { Flex, Spinner } from "@chakra-ui/react";

export function AuthorizationPending() {
  return (
    <Flex minH="50vh" align="center" justify="center">
      <Spinner
        size="xl"
        color="violet.500"
        aria-label="Checking access"
      />
    </Flex>
  );
}

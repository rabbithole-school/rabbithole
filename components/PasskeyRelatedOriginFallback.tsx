import { Button } from "@chakra-ui/react";

export function PasskeyRelatedOriginFallback({ href }: { href: string }) {
  return (
    <Button
      asChild
      size="sm"
      w="full"
      variant="outline"
      borderColor="violet.300"
      color="violet.600"
      _hover={{ bg: "violet.50" }}
      fontFamily="heading"
      fontWeight="500"
      mt={1}
    >
      <a href={href}>Continue at the credential domain</a>
    </Button>
  );
}

import { Check } from "@phosphor-icons/react";
import { Circle, Float } from "@chakra-ui/react";

export function FormCompletionBadge() {
  return (
    <Float placement="bottom-end">
      <Circle
        size="4"
        bg="green.500"
        color="white"
        borderWidth="2px"
        borderColor="white"
      >
        <Check size={10} weight="bold" />
      </Circle>
    </Float>
  );
}

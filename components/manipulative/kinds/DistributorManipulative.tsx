"use client";

/**
 * Distributor — deal a pile of items one round at a time into equal plates and
 * watch the leftover pile shrink to the true remainder. Isolates division as
 * equal sharing (a ÷ b = "how many each", with a remainder). Each "+" deals one
 * item to EVERY plate at once — a full round — so the plates are always equal;
 * the win is dealing every round you can, leaving only the real remainder.
 *
 * The math is the shared logic layer (`distributorSolved`, `initialDistributor`,
 * `distributorPerGroupMax`, `distributorRemainder`); this owns only pixels.
 */
import { useEffect, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import type { KindProps } from "../Manipulative";
import type { DistributorSpec } from "@/lib/manipulative/types";
import { C } from "../colors";
import {
  distributorPerGroupMax,
  distributorRemainder,
  initialDistributor,
} from "@/lib/manipulative/logic";
import { Stepper } from "../Stepper";

function Pip({ color }: { color: string }) {
  return <Box w="14px" h="14px" borderRadius="full" bg={color} flexShrink={0} />;
}

function DotBox({
  count,
  color,
  border,
  label,
}: {
  count: number;
  color: string;
  border: string;
  label: string;
}) {
  return (
    <Flex direction="column" align="center" gap={1} minW="72px">
      <Flex
        wrap="wrap"
        gap="6px"
        justify="center"
        align="center"
        w="72px"
        minH="72px"
        p="8px"
        borderWidth="1px"
        borderColor={border}
        borderRadius="14px"
        bg="white"
      >
        {Array.from({ length: count }, (_, i) => (
          <Pip key={i} color={color} />
        ))}
      </Flex>
      <Text fontSize="12px" fontWeight="700" color="fg.muted">
        {label}
      </Text>
    </Flex>
  );
}

export function DistributorManipulative({ spec, onSolvedChange, onStateChange }: KindProps<DistributorSpec>) {
  const max = distributorPerGroupMax(spec);
  const [perGroup, setPerGroup] = useState(() => initialDistributor(spec).perGroup);
  const remainder = distributorRemainder(spec, { perGroup });

  useEffect(() => {
    onSolvedChange(perGroup === max && !!spec.goal);
    onStateChange?.({ perGroup });
  }, [spec, perGroup, max, onSolvedChange, onStateChange]);

  return (
    <Box>
      <Flex wrap="wrap" gap={4} justify="center" align="flex-start" mt={2} mb={4}>
        {Array.from({ length: spec.groups }, (_, i) => (
          <DotBox
            key={i}
            count={perGroup}
            color={C.cyan}
            border={C.line}
            label={`Plate ${i + 1}`}
          />
        ))}
        <DotBox count={remainder} color={C.orange} border={C.line} label="Left over" />
      </Flex>

      <Flex justify="center" mb={3}>
        <Stepper
          value={perGroup}
          min={0}
          max={max}
          onChange={setPerGroup}
          label="each plate"
        />
      </Flex>

      <Text textAlign="center" fontSize="15px" fontWeight="700" color="brand.primary">
        {spec.total} ÷ {spec.groups} = {perGroup}
        {remainder > 0 ? ` remainder ${remainder}` : ""}
      </Text>
    </Box>
  );
}

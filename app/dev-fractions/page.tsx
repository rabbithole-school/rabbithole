"use client";

/**
 * Fraction-rendering gallery (unlinked; visit /dev-fractions). Renders the same
 * ASCII edge cases as the native `/dev-fractions` screen through the web
 * `FractionText` renderer, so web ↔ iPad parity is eyeball-checkable. Each case
 * is a plain string exactly as a generated stem or the tutor's prose would
 * produce it — the renderer parses it directly (no LaTeX). See the writeup:
 * review/fraction-rendering-plan.html.
 */

import { Box, Code, Container, Heading, Stack, Text } from "@chakra-ui/react";
import { FractionText } from "@/components/FractionText";

const CASES: { label: string; value: string }[] = [
  { label: "Simple fraction", value: "3/4" },
  { label: "Mixed number", value: "9 4/9" },
  { label: "Long / multi-digit", value: "123/456" },
  { label: "Very long denominator", value: "7/100000" },
  { label: "Blank in numerator", value: "?/9" },
  { label: "Blank in denominator", value: "9/?" },
  { label: "Blank in both", value: "?/?" },
  { label: "Mixed + blank (the screenshot)", value: "Write 9 4/9 as ?/9" },
  { label: "Addition", value: "2/8 + 1/8 = ?" },
  { label: "Multiplication", value: "1/2 × 3/4" },
  { label: "Division", value: "1/2 ÷ 3 = ?" },
  { label: "Comparison", value: "2/3 > 1/2" },
  { label: "Mixed × whole", value: "12 3/8" },
  { label: "Fraction in a sentence", value: "How does 2/8 compare to 1/2?" },
  {
    label: "Wrapping stem (punctuation after a fraction must not orphan)",
    value: "Decompose 5/8 as 3/8 + 2/8: shade the first disc to 3/8 and the second disc to 2/8.",
  },
];

export default function DevFractions() {
  return (
    <Box h="100dvh" overflowY="auto" bg="bg.subtle" py={10}>
      <Container maxW="900px">
        <Heading size="xl" color="charcoal.500">
          Stacked-fraction renderer
        </Heading>
        <Text mt={2} color="charcoal.400">
          Direct ASCII parser → FractionText (flexbox vinculum). No LaTeX, no SVG,
          no MathJax. The same renderer paints stems, MC choices, and tutor prose.
        </Text>

        <Stack mt={6} gap={3}>
          {CASES.map((c) => (
            <Box key={c.label} bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="14px" p={4}>
              <Text fontSize="13px" fontWeight="600" color="charcoal.400">
                {c.label}
              </Text>
              <Code fontSize="12px" mt={1} color="charcoal.300">
                {c.value}
              </Code>
              <Box mt={3} minH="56px" display="flex" alignItems="center">
                <FractionText value={c.value} fontSize={34} align="left" />
              </Box>
            </Box>
          ))}
        </Stack>
      </Container>
    </Box>
  );
}

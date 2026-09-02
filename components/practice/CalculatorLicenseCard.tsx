"use client";

/**
 * CalculatorLicenseCard — the teacher's record of ONE scholar's Calculator
 * License, sitting directly beneath that scholar's Quick-facts heatmap in
 * their domain report.
 *
 * It lives HERE, at the clicked-scholar detail seam, rather than in a standing
 * dashboard panel or its own tab: the license is a per-scholar act taken while
 * looking at that scholar's fact picture. The grid above remains useful
 * diagnostic context, but the grant itself is entirely a TEACHER DISCRETION
 * call — there is no score input, no numeric threshold, and no server-side
 * validation. The exam itself is paper and proctored in the room; this
 * records an outcome, it does not administer or grade one.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";
import {
  FAST_MATH_NAME,
  fastMathAutomaticFraction,
} from "@/shared/fastMathName";
import { toaster } from "@/lib/toaster";

export function CalculatorLicenseCard({
  scholarId,
  scholarName,
}: {
  scholarId: Id<"users">;
  scholarName: string;
}) {
  // The SAME bounded cohort query the matrix row reads, called with one id —
  // readiness can never be derived two ways.
  const data = useQuery(api.cohortPractice.fastMathForScholars, {
    scholarIds: [scholarId],
  });
  const grant = useMutation(api.calculatorLicenses.grantCalculatorLicense);
  const revoke = useMutation(api.calculatorLicenses.revokeCalculatorLicense);

  const [busy, setBusy] = useState(false);

  if (data === undefined) return null;
  const reading = data.scholars[0];
  if (!reading) return null;

  const license = reading.license;
  const firstName = scholarName.split(" ")[0];

  const submit = async () => {
    setBusy(true);
    try {
      const result = await grant({ scholarId });
      toaster.create({
        description: result.corrected
          ? `Updated ${firstName}'s calculator license`
          : `${firstName} is licensed`,
        type: "success",
      });
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error ? error.message : "Could not grant the license.",
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await revoke({ scholarId });
      toaster.create({
        description: `Removed ${firstName}'s calculator license`,
        type: "success",
      });
    } catch (error) {
      toaster.create({
        description:
          error instanceof Error
            ? error.message
            : "Could not remove the license.",
        type: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box mb={4}>
      <Flex align="center" gap={2} mb={1.5}>
        <Box as="span" fontSize="15px" aria-hidden>
          🧮
        </Box>
        <Text fontSize="sm" fontWeight="700" color="charcoal.700">
          Calculator license
        </Text>
      </Flex>
      <Box
        bg="white"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        p={4}
      >
        <Flex align="center" justify="space-between" gap={4} wrap="wrap">
          <Box minW={0}>
            <Text fontSize="sm" color="charcoal.700" data-testid="license-readiness">
              {license ? (
                <>
                  Licensed on {new Date(license.issuedAt).toLocaleDateString()}
                  {license.issuedByName ? ` by ${license.issuedByName}` : ""}.
                </>
              ) : reading.ready ? (
                <Box as="span" color={MASTERY_DOT_COLOR.fluent} fontWeight="700">
                  Every fact is automatic — ready to sit the test.
                </Box>
              ) : (
                <>
                  {FAST_MATH_NAME} {reading.percent}% (
                  {fastMathAutomaticFraction(
                    reading.automaticCount,
                    reading.denominator,
                  )}
                  ).
                </>
              )}
            </Text>
            <Text fontSize="xs" color="charcoal.400" mt={1}>
              The exam is proctored on paper; grant or update the license here
              at your discretion — Fast Math readiness is context, not a gate.
            </Text>
          </Box>
          <Flex align="center" gap={2}>
            <Button
              size="sm"
              colorPalette="green"
              onClick={submit}
              disabled={busy}
              data-testid="license-grant"
            >
              {license ? "Re-record license" : "Grant license"}
            </Button>
            {license && (
              <Button
                size="sm"
                variant="ghost"
                color="charcoal.400"
                onClick={remove}
                disabled={busy}
                data-testid="license-revoke"
              >
                Remove
              </Button>
            )}
          </Flex>
        </Flex>
      </Box>
    </Box>
  );
}

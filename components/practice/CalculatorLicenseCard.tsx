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
 *
 * The one required input is the expiration date: every license carries one,
 * and the teacher chooses it (the server refuses a grant without a future
 * date).
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, Input, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { MASTERY_DOT_COLOR } from "@/shared/masteryDialPalette";
import {
  FAST_MATH_NAME,
  fastMathAutomaticFraction,
} from "@/shared/fastMathName";
import { toaster } from "@/lib/toaster";
import { useNow } from "@/hooks/useNow";

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
  // null = untouched, so a re-record starts from the license's current date.
  const [expiresDraft, setExpiresDraft] = useState<string | null>(null);
  const now = useNow(60_000);

  if (data === undefined) return null;
  const reading = data.scholars[0];
  if (!reading) return null;

  const license = reading.license;
  const firstName = scholarName.split(" ")[0];
  const expiresOn = expiresDraft ?? license?.expiresOn ?? "";
  const tomorrow = localDateKey(new Date(now + 24 * 60 * 60 * 1000));
  const expiryValid = expiresOn >= tomorrow;

  const submit = async () => {
    if (!expiryValid) return;
    setBusy(true);
    try {
      const result = await grant({ scholarId, expiresOn });
      setExpiresDraft(null);
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
                  {license.issuedByName ? ` by ${license.issuedByName}` : ""}
                  {license.expiresOn
                    ? ` · expires ${formatExpiry(license.expiresOn)}`
                    : " · no expiration date on record"}
                  .
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
            <Box as="label" display="flex" alignItems="center" gap={2}>
              <Text as="span" fontSize="xs" color="charcoal.500" whiteSpace="nowrap">
                Expires
              </Text>
              <Input
                type="date"
                size="sm"
                w="auto"
                min={tomorrow}
                value={expiresOn}
                onChange={(event) => setExpiresDraft(event.target.value)}
                disabled={busy}
                data-testid="license-expires"
              />
            </Box>
            <Button
              size="sm"
              colorPalette="green"
              onClick={submit}
              disabled={busy || !expiryValid}
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

/** The viewer's calendar day as "YYYY-MM-DD" (the date input's format). */
function localDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Jan 15, 2027" for a stored "YYYY-MM-DD" — a date, so no zone shift. */
function formatExpiry(expiresOn: string): string {
  const [y, m, d] = expiresOn.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

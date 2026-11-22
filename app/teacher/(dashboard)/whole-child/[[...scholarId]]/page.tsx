"use client";

/**
 * Retired route. Whole Child reports were replaced by the SEL report in
 * Reports (one prose report per subject plus SEL, 2026-11), and the meeting
 * surface lives on as Rounds on the Scholars tab. Old links land on the
 * matching place instead of a dead page: `?mode=rounds` goes to Rounds, any
 * other link to that scholar's Reports page.
 */
import { useEffect } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Flex, Spinner } from "@chakra-ui/react";

export default function WholeChildRedirect() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const segments = params?.scholarId as string[] | undefined;
  const scholarId = segments && segments.length > 0 ? segments[0] : null;

  useEffect(() => {
    const inst = searchParams.get("inst");
    const instQuery = inst ? `inst=${encodeURIComponent(inst)}` : "";
    if (searchParams.get("mode") === "rounds") {
      router.replace(`/teacher/scholars${scholarId ? `/${scholarId}` : ""}?rounds=1${instQuery ? `&${instQuery}` : ""}`);
    } else {
      router.replace(`/teacher/report${scholarId ? `/${scholarId}` : ""}${instQuery ? `?${instQuery}` : ""}`);
    }
  }, [router, searchParams, scholarId]);

  return (
    <Flex h="full" align="center" justify="center" bg="gray.50">
      <Spinner size="lg" color="violet.500" />
    </Flex>
  );
}

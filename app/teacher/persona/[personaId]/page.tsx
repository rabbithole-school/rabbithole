"use client";

/**
 * DEPRECATED (anti-parasocial, 2026-06): the persona editor route is retired —
 * personas are no longer an active building block (the tutor must not "become"
 * a character). The `personas` table + data are preserved, but this route now
 * just redirects to the Curriculum tab. See TODO.html ("Reimagine personas").
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Flex, Spinner } from "@chakra-ui/react";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

export default function PersonaDetailPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/teacher/curriculum");
  }, [router]);

  return (
    <Flex h={VIEWPORT_SHELL_HEIGHT} align="center" justify="center">
      <Spinner size="xl" color="violet.500" />
    </Flex>
  );
}

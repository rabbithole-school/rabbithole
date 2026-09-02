"use client";

/**
 * Full-screen Share Back facilitation surface. Reads the AI digest and
 * presents it as projector-friendly slides the teacher steps through
 * in class with the arrow keys (or on-screen controls):
 *
 *   title → summary → themes (1/slide) → highlights (1/slide, with a
 *   drill-in to the scholar's full project) → discussion prompts.
 *
 * See review/shareback-offline-activity.md.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Spinner,
  Stack,
  Text,
} from "@chakra-ui/react";
import { ArrowLeft, ArrowRight, X, ArrowSquareOut } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useDarkShellChrome } from "@/lib/native";

type Slide =
  | { kind: "title"; title: string; sources: string[] }
  | { kind: "summary"; summary: string }
  | { kind: "theme"; index: number; total: number; title: string; body: string }
  | {
      kind: "highlight";
      index: number;
      total: number;
      scholarName: string;
      sourceActivityTitle: string;
      angleTitle?: string;
      reason: string;
      excerpt: string;
      sessionId?: Id<"sessions">;
    }
  | { kind: "prompts"; prompts: string[] };

export function ShareBackFacilitation({
  activityId,
  assignmentId,
}: {
  activityId: Id<"activities">;
  /** When provided, scopes the digest to a specific cohort. Without
   *  it, falls back to the lifetime / legacy digest. */
  assignmentId?: Id<"assignments">;
}) {
  // Full-bleed navy presentation screen: light status-bar icons + navy inset
  // strips on the iPad (no-op on web).
  useDarkShellChrome();
  const router = useRouter();
  const digest = useQuery(api.shareBack.getDigest, {
    activityId,
    assignmentId,
  });
  const sources = useQuery(api.shareBack.getSources, { activityId });
  const [idx, setIdx] = useState(0);

  const slides = useMemo<Slide[]>(() => {
    if (!digest || digest.status !== "ready") return [];
    const out: Slide[] = [];
    out.push({
      kind: "title",
      title: "Share Back",
      sources: (sources ?? []).map((s) => s.title),
    });
    if (digest.summary) out.push({ kind: "summary", summary: digest.summary });
    (digest.themes ?? []).forEach((t, i, arr) =>
      out.push({
        kind: "theme",
        index: i + 1,
        total: arr.length,
        title: t.title,
        body: t.body,
      }),
    );
    (digest.highlights ?? []).forEach((h, i, arr) =>
      out.push({
        kind: "highlight",
        index: i + 1,
        total: arr.length,
        scholarName: h.scholarName,
        sourceActivityTitle: h.sourceActivityTitle,
        angleTitle: h.angleTitle,
        reason: h.reason,
        excerpt: h.excerpt,
        sessionId: h.sessionId as Id<"sessions">,
      }),
    );
    if ((digest.discussionPrompts ?? []).length > 0)
      out.push({ kind: "prompts", prompts: digest.discussionPrompts! });
    return out;
  }, [digest, sources]);

  const total = slides.length;
  const clampedIdx = Math.min(idx, Math.max(0, total - 1));

  const go = useCallback(
    (delta: number) => {
      setIdx((i) => {
        const next = i + delta;
        if (next < 0 || next >= total) return i;
        return next;
      });
    },
    [total],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "Escape") {
        router.back();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, router]);

  // Loading / not-ready states.
  if (digest === undefined) {
    return (
      <Flex h="100dvh" bg="navy.500" align="center" justify="center">
        <Spinner size="xl" color="white" />
      </Flex>
    );
  }
  if (!digest || digest.status !== "ready" || total === 0) {
    return (
      <Flex
        h="100dvh"
        bg="navy.500"
        align="center"
        justify="center"
        flexDir="column"
        gap={4}
        px={6}
      >
        <Text fontSize="xl" fontFamily="heading" color="whiteAlpha.800" textAlign="center">
          {digest?.status === "pending"
            ? "The digest is still generating…"
            : digest?.status === "error"
              ? "The digest failed to generate."
              : "No digest to facilitate yet."}
        </Text>
        <Button
          variant="outline"
          color="white"
          borderColor="whiteAlpha.400"
          _hover={{ bg: "whiteAlpha.200" }}
          onClick={() => router.back()}
        >
          ← Back
        </Button>
      </Flex>
    );
  }

  const slide = slides[clampedIdx];

  return (
    <Flex h="100dvh" bg="navy.500" flexDir="column" color="white">
      {/* Top bar — exit + progress */}
      <Flex px={6} py={4} align="center" justify="space-between" flexShrink={0}>
        <IconButton
          aria-label="Exit facilitation"
          variant="ghost"
          color="whiteAlpha.700"
          _hover={{ bg: "whiteAlpha.200", color: "white" }}
          onClick={() => router.back()}
        >
          <X size={20} />
        </IconButton>
        <Text fontSize="sm" fontFamily="heading" color="whiteAlpha.600">
          {clampedIdx + 1} / {total}
        </Text>
      </Flex>

      {/* Slide body */}
      <Flex flex={1} align="center" justify="center" px={{ base: 8, md: 20 }} py={6} overflow="auto">
        <Box maxW="900px" w="full">
          <SlideBody slide={slide} onDrillIn={(pid) => router.push(`/scholar/${pid}`)} />
        </Box>
      </Flex>

      {/* Bottom nav */}
      <Flex
        px={6}
        py={5}
        align="center"
        justify="center"
        gap={4}
        flexShrink={0}
      >
        <IconButton
          aria-label="Previous"
          variant="outline"
          color="white"
          borderColor="whiteAlpha.300"
          _hover={{ bg: "whiteAlpha.200" }}
          _disabled={{ opacity: 0.3, cursor: "not-allowed" }}
          disabled={clampedIdx === 0}
          onClick={() => go(-1)}
        >
          <ArrowLeft />
        </IconButton>
        <Text fontSize="xs" fontFamily="heading" color="whiteAlpha.500" minW="120px" textAlign="center">
          ← / → to navigate
        </Text>
        <IconButton
          aria-label="Next"
          variant="outline"
          color="white"
          borderColor="whiteAlpha.300"
          _hover={{ bg: "whiteAlpha.200" }}
          _disabled={{ opacity: 0.3, cursor: "not-allowed" }}
          disabled={clampedIdx >= total - 1}
          onClick={() => go(1)}
        >
          <ArrowRight />
        </IconButton>
      </Flex>
    </Flex>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="sm"
      fontFamily="heading"
      fontWeight="700"
      color="violet.300"
      textTransform="uppercase"
      letterSpacing="0.08em"
      mb={3}
    >
      {children}
    </Text>
  );
}

function SlideBody({
  slide,
  onDrillIn,
}: {
  slide: Slide;
  onDrillIn: (sessionId: Id<"sessions">) => void;
}) {
  switch (slide.kind) {
    case "title":
      return (
        <Stack gap={5} textAlign="center" align="center">
          <Text fontSize="6xl" lineHeight="1">
            👥
          </Text>
          <Text fontFamily="heading" fontWeight="800" fontSize="5xl" lineHeight="1.1">
            {slide.title}
          </Text>
          {slide.sources.length > 0 && (
            <Text fontSize="lg" color="whiteAlpha.700" fontFamily="heading">
              {slide.sources.join(" · ")}
            </Text>
          )}
          <Text fontSize="sm" color="whiteAlpha.500" mt={4}>
            Press → to begin
          </Text>
        </Stack>
      );
    case "summary":
      return (
        <Stack gap={2}>
          <Eyebrow>The class produced</Eyebrow>
          <Text fontFamily="body" fontSize="3xl" lineHeight="1.4">
            {slide.summary}
          </Text>
        </Stack>
      );
    case "theme":
      return (
        <Stack gap={3}>
          <Eyebrow>
            Theme {slide.index} of {slide.total}
          </Eyebrow>
          <Text fontFamily="heading" fontWeight="700" fontSize="4xl" lineHeight="1.15">
            {slide.title}
          </Text>
          <Text fontFamily="body" fontSize="2xl" color="whiteAlpha.800" lineHeight="1.4">
            {slide.body}
          </Text>
        </Stack>
      );
    case "highlight":
      return (
        <Stack gap={4}>
          <HStack justify="space-between" align="baseline">
            <Eyebrow>
              Highlight {slide.index} of {slide.total}
            </Eyebrow>
            {slide.sessionId && (
              <Button
                size="sm"
                variant="outline"
                color="white"
                borderColor="whiteAlpha.300"
                _hover={{ bg: "whiteAlpha.200" }}
                onClick={() => onDrillIn(slide.sessionId!)}
              >
                <ArrowSquareOut style={{ marginRight: 6 }} /> Open full session
              </Button>
            )}
          </HStack>
          <HStack gap={3} align="baseline" flexWrap="wrap">
            <Text fontFamily="heading" fontWeight="800" fontSize="3xl">
              {slide.scholarName}
            </Text>
            <Text fontSize="md" color="whiteAlpha.600" fontFamily="heading">
              {slide.sourceActivityTitle}
              {slide.angleTitle ? ` · ${slide.angleTitle}` : ""}
            </Text>
          </HStack>
          <Box
            bg="whiteAlpha.100"
            borderLeft="4px solid"
            borderColor="violet.300"
            borderRadius="md"
            px={6}
            py={5}
          >
            <Text fontFamily="body" fontSize="2xl" lineHeight="1.4" fontStyle="italic">
              “{slide.excerpt}”
            </Text>
          </Box>
          {slide.reason && (
            <Text fontFamily="body" fontSize="lg" color="violet.200">
              Why this one: {slide.reason}
            </Text>
          )}
        </Stack>
      );
    case "prompts":
      return (
        <Stack gap={5}>
          <Eyebrow>Discuss</Eyebrow>
          <Stack gap={4}>
            {slide.prompts.map((p, i) => (
              <HStack key={i} gap={4} align="flex-start">
                <Text fontFamily="heading" fontWeight="800" fontSize="3xl" color="violet.300">
                  {i + 1}
                </Text>
                <Text fontFamily="body" fontSize="2xl" lineHeight="1.35">
                  {p}
                </Text>
              </HStack>
            ))}
          </Stack>
        </Stack>
      );
  }
}

"use client";

/**
 * ManipulativeArtifactView — the bridge between a stored `type: "manipulative"`
 * artifact and the pure {@link ./Manipulative} renderer. It mirrors
 * {@link ../geomap/MapArtifactView} / {@link ../slides/SlidesArtifactView}: a
 * tolerant parse of the artifact `content` (bad JSON → a small error card),
 * then the manipulative itself.
 *
 * Standalone (exploration) mode: NO `onCommit`, so the `Manipulative` component
 * runs its own local self-check when the spec carries a goal/answer. Interaction
 * state is ephemeral and local — a manipulative is poked in place, never
 * co-authored, so there is nothing to persist and no owner/read-only split.
 */
import { Box, Center, Flex, Text } from "@chakra-ui/react";
import { Component, type ReactNode } from "react";
import { parseStoredManipulativeArtifact } from "@/lib/manipulative/validate";
import { Manipulative } from "./Manipulative";

interface ManipulativeArtifactViewProps {
  content: string;
}

/** The tolerant fallback card, shared by the parse-null and render-throw paths. */
function ManipulativeFallback() {
  return (
    <Center h="100%" w="100%" bg="white" p={6}>
      <Text fontFamily="body" fontSize="sm" color="charcoal.400" textAlign="center">
        This hands-on model couldn&apos;t be opened.
      </Text>
    </Center>
  );
}

/**
 * Catches a throw from the pure `Manipulative` renderer and shows the same
 * "couldn't be opened" fallback the parse-null path uses, so one malformed
 * material can't take down the whole artifact panel. Mirrors the
 * `ManipulativeRendererBoundary` in native ManipulativeCard.
 */
class ManipulativeRendererBoundary extends Component<
  { children: ReactNode },
  { crashed: boolean }
> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn("[manipulative] web renderer threw — showing fallback card", error);
  }

  render() {
    return this.state.crashed ? <ManipulativeFallback /> : this.props.children;
  }
}

export function ManipulativeArtifactView({ content }: ManipulativeArtifactViewProps) {
  const stored = parseStoredManipulativeArtifact(content);

  if (!stored) {
    return <ManipulativeFallback />;
  }

  return (
    <ManipulativeRendererBoundary>
      <Box h="100%" w="100%" overflowY="auto" bg="white" p={{ base: 3, md: 4 }}>
        <Flex justify="center">
          <Manipulative spec={stored.spec} />
        </Flex>
      </Box>
    </ManipulativeRendererBoundary>
  );
}

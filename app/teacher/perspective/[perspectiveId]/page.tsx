"use client";

import { use, useState } from "react";
import { useConvexAuth, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useRouter } from "next/navigation";
import { Box, Flex, Spinner } from "@chakra-ui/react";
import { DimensionEditModal } from "@/components/DimensionEditModal";
import { TeacherTopNav } from "@/components/TeacherTopNav";
import { VIEWPORT_SHELL_HEIGHT } from "@/lib/viewportShell";

export default function PerspectiveDetailPage({ params }: { params: Promise<{ perspectiveId: string }> }) {
  const { perspectiveId } = use(params);
  const router = useRouter();
  const [open, setOpen] = useState(true);
  // `perspectives.get` is an authedQuery; skip it until auth settles so a cold
  // hard-load (bookmark/refresh/deep link) doesn't fire it during the brief
  // unauthenticated window and throw "Not authenticated" into the ErrorBoundary.
  const { isAuthenticated } = useConvexAuth();
  const entity = useQuery(
    api.perspectives.get,
    isAuthenticated ? { id: perspectiveId as Id<"perspectives"> } : "skip",
  );

  if (entity === undefined) {
    return (
      <Flex h={VIEWPORT_SHELL_HEIGHT} align="center" justify="center">
        <Spinner size="xl" color="violet.500" />
      </Flex>
    );
  }

  const handleClose = () => {
    setOpen(false);
    router.push("/teacher/curriculum");
  };

  return (
    <>
      <Flex direction="column" h={VIEWPORT_SHELL_HEIGHT} overflow="hidden">
        <TeacherTopNav activeKey="curriculum" />
        <Box flex={1} bg="gray.50" />
      </Flex>
      <DimensionEditModal
        open={open}
        onClose={handleClose}
        dimensionType="perspective"
        data={
          entity
            ? {
                _id: entity._id,
                title: entity.title,
                description: entity.description,
                systemPrompt: entity.systemPrompt,
                icon: entity.icon,
              }
            : null
        }
      />
    </>
  );
}

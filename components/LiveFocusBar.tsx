"use client";

/**
 * LiveFocusBar — the teacher's "what's live right now" list for pushes (see
 * convex/pushes.ts `livePushesForScope`), with a "Wrap up" button per row so
 * a push is always reversible — the counterpart to MakeFocusDialog. Renders
 * nothing when nothing is live, same no-layout-shift convention as
 * FocusStrip / AppLauncher.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { Box, Button, Flex, HStack, Text } from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Surface } from "@/components/ui/Surface";
import { toaster } from "@/lib/toaster";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import { pushGlyph, pushTimeLeftLabel } from "@/shared/pushCopy";

const TICK_MS = 15_000;

export function LiveFocusBar({
  institutionScope,
}: {
  institutionScope?: string;
}) {
  const pushes = useQuery(
    api.pushes.livePushesForScope,
    institutionScope === undefined ? {} : { scope: institutionScope },
  );
  const clearPush = useMutation(api.pushes.clearPush);
  const [now, setNow] = useState(() => Date.now());
  const [clearingId, setClearingId] = useState<Id<"pushes"> | null>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  if (!pushes || pushes.length === 0) return null;

  const handleClear = async (pushId: Id<"pushes">) => {
    if (clearingId) return;
    setClearingId(pushId);
    try {
      await clearPush({ pushId });
    } catch (err) {
      toaster.error({
        title: serverErrorMessage(err, "Couldn't wrap that up"),
      });
    } finally {
      setClearingId(null);
    }
  };

  return (
    <Surface p={0} overflow="hidden" mb={4}>
      <Box px={4} py={3} borderBottomWidth="1px" borderColor="gray.100">
        <Text
          fontSize="xs"
          color="charcoal.500"
          fontFamily="heading"
          fontWeight="700"
          textTransform="uppercase"
          letterSpacing="0.04em"
        >
          Right now
        </Text>
      </Box>
      {pushes.map((push) => (
        <Flex
          key={push._id}
          px={4}
          py={3}
          borderBottomWidth="1px"
          borderColor="gray.100"
          _last={{ borderBottomWidth: 0 }}
          align="center"
          gap={3}
        >
          <Box fontSize="md" color="violet.500" flexShrink={0} aria-hidden>
            {pushGlyph(push)}
          </Box>
          <Box flex={1} minW={0}>
            <Text
              fontSize="sm"
              fontFamily="heading"
              fontWeight="700"
              color="charcoal.500"
              lineClamp={1}
            >
              {push.title}
            </Text>
            {push.note && (
              <Text fontSize="2xs" color="charcoal.400" fontFamily="body" lineClamp={1}>
                {push.note}
              </Text>
            )}
          </Box>
          <HStack gap={3} flexShrink={0}>
            {pushTimeLeftLabel(push.endsAt, now) && (
              <Text fontSize="2xs" color="charcoal.400" fontFamily="heading" fontWeight="600">
                {pushTimeLeftLabel(push.endsAt, now)}
              </Text>
            )}
            <Button
              size="xs"
              variant="outline"
              fontFamily="heading"
              disabled={clearingId === push._id}
              onClick={() => void handleClear(push._id)}
            >
              Wrap up
            </Button>
          </HStack>
        </Flex>
      ))}
    </Surface>
  );
}

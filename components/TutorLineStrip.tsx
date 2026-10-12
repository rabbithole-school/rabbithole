"use client";

import { Box, Text } from "@chakra-ui/react";

/**
 * The tutor's newest line, shown while the chat beside a coached app is
 * closed — otherwise a coach line from an app-update turn lands somewhere the
 * scholar cannot see. It sits in a slim slot under the app that is ALWAYS
 * reserved in Play (empty when there is no line): the app never moves when a
 * line arrives or is read, so a tap aimed at the app lands where it was aimed
 * (TRA-477), and the strip covers none of the app's own controls (an overlay
 * sat on Teach the Robot's composer and Send button). Clicking the line opens
 * the chat. The host decides when there is an unread line (useUnreadTutorLine).
 */
export function TutorLineSlot({
  line,
  onOpen,
}: {
  line: { id: string; preview: string } | null;
  onOpen: () => void;
}) {
  return (
    <Box
      h="40px"
      flexShrink={0}
      bg="white"
      borderTop="1px solid"
      borderColor="gray.200"
      overflow="hidden"
    >
      {line && (
        <TutorLineStrip key={line.id} preview={line.preview} onOpen={onOpen} />
      )}
    </Box>
  );
}

function TutorLineStrip({
  preview,
  onOpen,
}: {
  preview: string;
  onOpen: () => void;
}) {
  return (
    <Box
      as="button"
      onClick={onOpen}
      aria-label={`Tutor: ${preview}. Open chat`}
      aria-live="polite"
      display="flex"
      alignItems="center"
      gap={2}
      w="100%"
      h="100%"
      textAlign="left"
      px={4}
      cursor="pointer"
      _hover={{ bg: "gray.50" }}
      css={{
        animation: "tutor-line-fade 200ms ease-out",
        "@keyframes tutor-line-fade": { from: { opacity: 0 }, to: { opacity: 1 } },
      }}
    >
      <Text
        as="span"
        fontSize="sm"
        fontFamily="heading"
        fontWeight="600"
        color="navy.500"
        flexShrink={0}
      >
        Tutor
      </Text>
      <Text as="span" fontSize="sm" fontFamily="body" color="charcoal.600" lineClamp={1}>
        {preview}
      </Text>
    </Box>
  );
}

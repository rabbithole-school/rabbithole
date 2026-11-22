"use client";

/**
 * ListRow — the one row for wonders, starters and a kid's proposed and
 * approved Quests (review/quests-rebuilt-proposal.html, "One row for
 * everything", figure 12). Its words come from shared/wonderRows.ts and
 * shared/questRows.ts (`ListRowModel`), which the BunnyPad twin draws from
 * too.
 *
 * Anatomy, fixed: the thing's emoji in a round tile · a bold title · one
 * optional content line · the muted meta line, always last · exactly one verb
 * button on the right, centred on the row. No chevron, nothing under the
 * text. The button's weight says what kind of tap it is: solid keeps making
 * ("Continue"), outline begins or reopens ("Ask", "Open"), quiet looks
 * ("View").
 *
 * Why not ActivityCard: that card is a whole-card tap target on its own
 * Surface with a caret hint; this row is one real button, and its lists hold
 * their rows on one Surface with hairlines between them.
 *
 * A Quest's mark carries a rocket badge (`row.rocket`, shared/questRows.ts):
 * on the ground, dashed and pointing up, while a proposal waits on a
 * teacher; solid violet once the Quest has launched. Phosphor's
 * RocketLaunch, never the emoji. Once the Quest has been shown the rocket
 * is a gold star (TRA-684).
 *
 * `onDismiss` adds a quiet × after the verb (Scholar's Prep's wonder rows,
 * and every row of a kid's Quests list), which takes the row off the list;
 * the verb stays the row's one action.
 *
 * The row draws no Surface of its own: a list puts its rows on one white
 * Surface (visual-design.md) and passes `divided` to every row but the first.
 */

import { Box, Button, Flex, Stack, Text } from "@chakra-ui/react";
import { RocketLaunch, Star } from "@phosphor-icons/react";
import type { ListRowModel, RowVerbWeight } from "@/shared/wonderRows";
import { DismissButton } from "@/components/ui/DismissButton";

const VERB_STYLE: Record<
  RowVerbWeight,
  { variant: "solid" | "outline" | "ghost"; colorPalette: "violet" | "gray" }
> = {
  solid: { variant: "solid", colorPalette: "violet" },
  outline: { variant: "outline", colorPalette: "violet" },
  quiet: { variant: "ghost", colorPalette: "gray" },
};

export function ListRow({
  row,
  onPress,
  busy = false,
  disabled = false,
  divided = false,
  onReplyPress,
  onDismiss,
}: {
  row: ListRowModel;
  onPress: () => void;
  /** A trailing × that takes the row off its list (wonders, Quests). */
  onDismiss?: () => void;
  /** Opens the conversation behind `row.replyLink` (the end of the meta line). */
  onReplyPress?: (threadId: string) => void;
  /** The verb's work is in flight (a spinner on the button). */
  busy?: boolean;
  disabled?: boolean;
  /** Hairline above the row: every row but a list's first. */
  divided?: boolean;
}) {
  const verb = VERB_STYLE[row.verb.weight];
  return (
    <Flex
      align="center"
      gap={3}
      px={4}
      py={3}
      borderTopWidth={divided ? "1px" : 0}
      borderColor="gray.100"
    >
      <Flex
        aria-hidden
        flexShrink={0}
        w="40px"
        h="40px"
        borderRadius="full"
        bg="gray.50"
        borderWidth="1px"
        borderColor="gray.100"
        align="center"
        justify="center"
        fontSize="xl"
        lineHeight="1"
        position="relative"
      >
        {row.mark}
        {row.rocket && <RocketBadge state={row.rocket} />}
      </Flex>
      <Stack gap={0.5} flex={1} minW={0}>
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="sm"
          color="navy.500"
          lineHeight="1.35"
          lineClamp={3}
        >
          {row.title}
        </Text>
        {row.content && (
          <Text
            fontFamily="body"
            fontSize="sm"
            color="charcoal.500"
            lineHeight="1.45"
            lineClamp={2}
          >
            {row.content}
          </Text>
        )}
        {(row.meta || row.replyLink) && (
          <Text fontFamily="heading" fontSize="xs" color="charcoal.400">
            {row.meta}
            {row.meta && row.replyLink ? " · " : null}
            {row.replyLink && (
              <Box
                as="button"
                display="inline"
                p={0}
                bg="transparent"
                borderWidth={0}
                cursor="pointer"
                font="inherit"
                fontWeight="600"
                color="violet.600"
                textDecoration="underline"
                onClick={() => onReplyPress?.(row.replyLink!.threadId)}
              >
                {row.replyLink.label}
              </Box>
            )}
          </Text>
        )}
      </Stack>
      <Box flexShrink={0}>
        <Button
          size="sm"
          minH="40px"
          variant={verb.variant}
          colorPalette={verb.colorPalette}
          fontFamily="heading"
          fontWeight="600"
          loading={busy}
          disabled={disabled}
          aria-label={`${row.verb.label}: ${row.title}`}
          onClick={onPress}
        >
          {row.verb.label}
        </Button>
      </Box>
      {onDismiss && (
        <Box flexShrink={0} ml={-1}>
          <DismissButton label={row.title} disabled={busy} onPress={onDismiss} />
        </Box>
      )}
    </Flex>
  );
}

/** The small rocket on a Quest's mark: grounded (dashed, pointing up) while
 *  a teacher still has to say yes, launched (solid violet) after. */
function RocketBadge({ state }: { state: "ground" | "launched" | "star" }) {
  if (state === "star") {
    // Shown to an advisor: the rocket becomes a gold star.
    return (
      <Flex
        position="absolute"
        right="-4px"
        bottom="-4px"
        w="20px"
        h="20px"
        borderRadius="full"
        align="center"
        justify="center"
        bg="#E3A600"
        color="white"
        boxShadow="0 0 0 2px white"
        aria-label="Shown"
      >
        <Star size={11} weight="fill" />
      </Flex>
    );
  }
  const launched = state === "launched";
  return (
    <Flex
      position="absolute"
      right="-4px"
      bottom="-4px"
      w="20px"
      h="20px"
      borderRadius="full"
      align="center"
      justify="center"
      bg={launched ? "violet.500" : "white"}
      color={launched ? "white" : "charcoal.400"}
      borderWidth={launched ? 0 : "1.5px"}
      borderStyle="dashed"
      borderColor="charcoal.300"
      boxShadow="0 0 0 2px white"
    >
      <RocketLaunch
        size={11}
        weight="fill"
        style={launched ? undefined : { transform: "rotate(-45deg)" }}
      />
    </Flex>
  );
}

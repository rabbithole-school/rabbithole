"use client";

/**
 * TrophyCase — the classroom "entrance screen".
 *
 * ONE unified grid (badges + curiosity merged): every card celebrates a
 * different scholar's earned **mission badge**, framed as a peer-discussion
 * prompt — "Ask <Scholar> about <their Quest>" — and carries a ✨ hook drawn
 * from THAT scholar's own boldest star. Meant for the big screen by the door
 * (Quests Q4). Reads `trophyCase.forRoster` (teacher-only).
 */

import { useState } from "react";
import {
  Box,
  Button,
  Flex,
  Grid,
  HStack,
  Image,
  Menu,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Footprints } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { formatTimeAgo } from "@/lib/relativeTime";
import { toaster } from "@/lib/toaster";
import { BadgeArt } from "./BadgeArt";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";

function initial(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

type FollowTarget = { _id: string; name: string };

/**
 * "Follow this trail" — the viral-spread affordance. Lets the teacher plant
 * this badge's quest as a NEW star on another scholar's map (the fork lives on
 * the follower, never on the original card). Hover-revealed so the passive
 * kiosk stays clean. No ranking, no progress bar — just footsteps.
 */
function FollowTrailMenu({
  ownerId,
  topic,
  inspiredByName,
  scholars,
}: {
  ownerId: string;
  topic: string;
  inspiredByName: string;
  scholars: FollowTarget[];
}) {
  const follow = useMutation(api.seeds.followBadge);
  const [busyId, setBusyId] = useState<string | null>(null);
  const others = scholars.filter((s) => s._id !== ownerId);

  const onPick = async (s: FollowTarget) => {
    setBusyId(s._id);
    try {
      const res = await follow({
        followerScholarId: s._id as Id<"users">,
        topic,
        inspiredByName,
      });
      const first = s.name.split(/\s+/)[0];
      if (res?.alreadyFollowing) {
        toaster.success({ title: `${first} is already on this trail` });
      } else {
        toaster.success({
          title: `Planted on ${first}'s map`,
          description: `“${topic}” is now a star ${first} can chase.`,
        });
      }
    } catch {
      toaster.error({ title: "Couldn't plant that star" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Menu.Root positioning={{ placement: "bottom-start" }}>
      <Menu.Trigger asChild>
        <Button
          size="xs"
          variant="ghost"
          color="#f4c44c"
          _hover={{ bg: "whiteAlpha.200", color: "#f8d177" }}
          opacity={0}
          _groupHover={{ opacity: 1 }}
          _focusVisible={{ opacity: 1 }}
          css={{ "@media (pointer: coarse)": { opacity: 1 } }}
          transition="opacity .15s"
        >
          <HStack gap={1.5}>
            <Footprints size={13} weight="bold" />
            <Text fontFamily="heading" fontSize="xs" fontWeight="700">
              Follow this trail
            </Text>
          </HStack>
        </Button>
      </Menu.Trigger>
      <Portal>
        <Menu.Positioner>
          <Menu.Content minW="220px" maxH="320px" overflowY="auto">
            <Menu.ItemGroup>
              <Menu.ItemGroupLabel>Who should chase this?</Menu.ItemGroupLabel>
              {others.length === 0 ? (
                <Box px={3} py={2} fontSize="sm" color="charcoal.400">
                  No other scholars to follow.
                </Box>
              ) : (
                others.map((s) => (
                  <Menu.Item
                    key={s._id}
                    value={s._id}
                    cursor="pointer"
                    disabled={busyId === s._id}
                    onClick={() => onPick(s)}
                  >
                    {s.name}
                  </Menu.Item>
                ))
              )}
            </Menu.ItemGroup>
          </Menu.Content>
        </Menu.Positioner>
      </Portal>
    </Menu.Root>
  );
}

export function TrophyCase({ groupId }: { groupId?: string }) {
  const { scopeParam } = useActiveInstitution();
  const data = useQuery(api.trophyCase.forRoster, {
    groupId: groupId ? (groupId as Id<"scholarGroups">) : undefined,
    scope: scopeParam,
  });
  const scholars = useQuery(api.users.listScholars, {
    institutionScope: scopeParam,
  });
  const followTargets: FollowTarget[] = (scholars ?? []).map((s) => ({
    _id: String(s._id),
    name: s.name ?? "A scholar",
  }));

  if (data === undefined) {
    return (
      <Flex h="60vh" align="center" justify="center">
        <Spinner color="#f4c44c" />
      </Flex>
    );
  }

  const { cards } = data;
  const group = data.group;

  return (
    <Box
      minH="full"
      bg="#0b1026"
      css={{
        background:
          "linear-gradient(to bottom, #0b1026 0%, #131a3a 55%, #0b1026 100%)",
      }}
      color="white"
      px={{ base: 5, md: 10 }}
      py={{ base: 6, md: 10 }}
    >
      <VStack align="stretch" gap={2} mb={8}>
        <Text fontSize={{ base: "2xl", md: "4xl" }} fontFamily="heading" fontWeight="800">
          🏆 Trophy Case
          {group && (
            <Text as="span" color="whiteAlpha.600" fontWeight="600">
              {"  ·  "}
              {group.emoji ? `${group.emoji} ` : ""}
              {group.name}
            </Text>
          )}
        </Text>
        <Text color="whiteAlpha.700" fontSize={{ base: "sm", md: "md" }}>
          Ask me about… — every badge here was earned by the scholar shown. Go
          ask them how they did it.
        </Text>
      </VStack>

      {cards.length === 0 ? (
        <Box
          border="1px dashed"
          borderColor="whiteAlpha.300"
          rounded="xl"
          p={6}
          color="whiteAlpha.600"
        >
          No badges earned yet — finish a unit or a Quest to light up the case.
        </Box>
      ) : (
        <Grid
          templateColumns={{
            base: "1fr",
            md: "repeat(2, 1fr)",
            xl: "repeat(3, 1fr)",
          }}
          gap={4}
        >
          {cards.map((c) => (
            <VStack
              key={c._id}
              role="group"
              align="stretch"
              gap={3}
              bg="whiteAlpha.100"
              border="1px solid"
              borderColor="whiteAlpha.200"
              rounded="2xl"
              p={5}
              _hover={{ borderColor: "#f4c44c", bg: "whiteAlpha.200" }}
              transition="all .15s"
            >
              <HStack gap={3} align="center">
                <BadgeArt
                  imageUrl={c.imageUrl}
                  emoji={c.badgeIcon}
                  size="64px"
                  alt={`${c.unitTitle} badge`}
                />
                <Text
                  flex={1}
                  minW={0}
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="md"
                  lineClamp={2}
                >
                  {c.unitTitle}
                </Text>
              </HStack>

              <HStack gap={2} mt="auto" pt={1}>
                {c.scholarImage ? (
                  <Image
                    src={c.scholarImage}
                    alt={c.scholarName}
                    boxSize="22px"
                    rounded="full"
                    objectFit="cover"
                  />
                ) : (
                  <Flex
                    boxSize="22px"
                    rounded="full"
                    bg="whiteAlpha.300"
                    align="center"
                    justify="center"
                    fontSize="11px"
                    fontWeight="700"
                  >
                    {initial(c.scholarName)}
                  </Flex>
                )}
                <Text fontSize="xs" color="whiteAlpha.800" fontWeight="600">
                  {c.scholarName}
                </Text>
                <Text fontSize="xs" color="whiteAlpha.500">
                  · earned {formatTimeAgo(c.earnedAt)}
                </Text>
              </HStack>

              <Box borderTop="1px solid" borderColor="whiteAlpha.150" pt={1} mt={-1}>
                <FollowTrailMenu
                  ownerId={c.scholarId}
                  topic={c.unitTitle}
                  inspiredByName={c.scholarFirstName}
                  scholars={followTargets}
                />
              </Box>
            </VStack>
          ))}
        </Grid>
      )}
    </Box>
  );
}

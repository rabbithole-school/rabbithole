"use client";

/**
 * Teacher-facing dialog: manually award a unit-completion badge to a scholar.
 *
 * The make-good for when the auto-mint (`maybeAwardUnitBadge`) didn't fire —
 * a glitch, or a curriculum edit mid-quest. Picks a unit, optional art style +
 * colorway, and an optional custom title, then calls `badges.awardUnitBadge`,
 * which mints the row and schedules the same generative art as the auto path.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Medal, X } from "@phosphor-icons/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  BADGE_STYLES,
  BADGE_COLORWAYS,
  type BadgeStyle,
  type BadgeColorway,
} from "@/convex/lib/badgeArt";
import { toaster } from "@/lib/toaster";

const STYLE_OPTIONS = Object.keys(BADGE_STYLES) as BadgeStyle[];
const COLORWAY_OPTIONS = Object.keys(BADGE_COLORWAYS) as BadgeColorway[];

// Sentinel for the "custom" (unit-less) selection in the unit picker.
const CUSTOM_UNIT = "__custom__";

interface AwardBadgeDialogProps {
  open: boolean;
  onClose: () => void;
  scholarId: Id<"users">;
  scholarName: string;
}

export function AwardBadgeDialog({
  open,
  onClose,
  scholarId,
  scholarName,
}: AwardBadgeDialogProps) {
  const units = useQuery(api.units.list, open ? {} : "skip");
  const award = useMutation(api.badges.awardUnitBadge);

  const [unitId, setUnitId] = useState<string>("");
  const [style, setStyle] = useState<BadgeStyle>("patch");
  const [colorway, setColorway] = useState<BadgeColorway>("auto");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const selectedUnit = useMemo(
    () => units?.find((u) => String(u.id) === unitId) ?? null,
    [units, unitId],
  );
  const isCustom = unitId === CUSTOM_UNIT;

  const reset = () => {
    setUnitId("");
    setStyle("patch");
    setColorway("auto");
    setTitle("");
  };

  const handleClose = () => {
    if (submitting) return;
    onClose();
    reset();
  };

  const handleAward = async () => {
    if (!unitId) return;
    if (isCustom && !title.trim()) return;
    setSubmitting(true);
    try {
      const res = await award({
        scholarId,
        ...(isCustom ? {} : { unitId: unitId as Id<"units"> }),
        style,
        colorway,
        ...(title.trim() ? { title: title.trim() } : {}),
      });
      if (res.alreadyEarned) {
        toaster.success({
          title: "Already earned",
          description: `${scholarName} already has this badge.`,
        });
      } else {
        toaster.success({
          title: "Badge awarded 🎖️",
          description: `${scholarName} earned "${
            title.trim() || selectedUnit?.title
          }". The art is rendering now.`,
        });
      }
      handleClose();
    } catch (e) {
      toaster.error({
        title: "Couldn't award badge",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(d) => !d.open && handleClose()}
      placement="center"
      motionPreset="slide-in-bottom"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={6} pb={2}>
              <Stack gap={0} flex={1} minW={0}>
                <Text
                  fontSize="xs"
                  color="charcoal.400"
                  fontFamily="heading"
                  fontWeight="600"
                  textTransform="uppercase"
                  letterSpacing="0.05em"
                >
                  Award badge
                </Text>
                <Heading
                  size="md"
                  color="navy.500"
                  fontFamily="heading"
                  fontWeight="700"
                  lineClamp={2}
                >
                  Give {scholarName} a badge
                </Heading>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                >
                  <X />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>

            <Dialog.Body px={6} pb={6}>
              <Stack gap={5}>
                {/* Unit picker */}
                <Stack gap={2}>
                  <FieldLabel>Unit</FieldLabel>
                  {units === undefined ? (
                    <HStack py={4} justify="center">
                      <Spinner size="sm" color="violet.500" />
                    </HStack>
                  ) : (
                    <VStack
                      gap={1}
                      align="stretch"
                      maxH="220px"
                      overflowY="auto"
                      borderWidth="1px"
                      borderColor="gray.200"
                      borderRadius="lg"
                      p={1}
                    >
                      <Box
                        as="button"
                        textAlign="left"
                        px={3}
                        py={2}
                        borderRadius="md"
                        bg={isCustom ? "violet.50" : "transparent"}
                        borderWidth="1px"
                        borderColor={isCustom ? "violet.300" : "transparent"}
                        cursor="pointer"
                        _hover={{ bg: isCustom ? "violet.50" : "gray.100" }}
                        onClick={() => setUnitId(CUSTOM_UNIT)}
                      >
                        <HStack gap={2} minW={0}>
                          <Text fontSize="md" flexShrink={0}>
                            🎖️
                          </Text>
                          <Text
                            fontSize="sm"
                            fontFamily="body"
                            color="navy.600"
                            lineClamp={1}
                            flex={1}
                            minW={0}
                          >
                            Custom badge — not tied to a unit
                          </Text>
                        </HStack>
                      </Box>
                      {units.map((u) => {
                        const active = String(u.id) === unitId;
                        return (
                          <Box
                            as="button"
                            key={String(u.id)}
                            textAlign="left"
                            px={3}
                            py={2}
                            borderRadius="md"
                            bg={active ? "violet.50" : "transparent"}
                            borderWidth="1px"
                            borderColor={active ? "violet.300" : "transparent"}
                            cursor="pointer"
                            _hover={{ bg: active ? "violet.50" : "gray.100" }}
                            onClick={() => setUnitId(String(u.id))}
                          >
                            <HStack gap={2} minW={0}>
                              <Text fontSize="md" flexShrink={0}>
                                {u.emoji ?? "📘"}
                              </Text>
                              <Text
                                fontSize="sm"
                                fontFamily="body"
                                color="navy.600"
                                lineClamp={1}
                                flex={1}
                                minW={0}
                              >
                                {u.title}
                              </Text>
                              {u.badgeOnCompletion && (
                                <Text
                                  fontSize="2xs"
                                  color="violet.600"
                                  fontFamily="heading"
                                  fontWeight="600"
                                  flexShrink={0}
                                >
                                  has badge
                                </Text>
                              )}
                            </HStack>
                          </Box>
                        );
                      })}
                    </VStack>
                  )}
                </Stack>

                {/* Art style */}
                <Stack gap={2}>
                  <FieldLabel>Style</FieldLabel>
                  <HStack gap={2}>
                    {STYLE_OPTIONS.map((s) => (
                      <Button
                        key={s}
                        flex={1}
                        size="sm"
                        variant={style === s ? "solid" : "outline"}
                        colorPalette="violet"
                        fontFamily="heading"
                        onClick={() => setStyle(s)}
                      >
                        {BADGE_STYLES[s].label}
                      </Button>
                    ))}
                  </HStack>
                </Stack>

                {/* Colorway */}
                <Stack gap={2}>
                  <FieldLabel>Color</FieldLabel>
                  <HStack gap={2} wrap="wrap">
                    {COLORWAY_OPTIONS.map((c) => {
                      const active = colorway === c;
                      const [a, b] = BADGE_COLORWAYS[c].swatch;
                      return (
                        <Box
                          as="button"
                          key={c}
                          onClick={() => setColorway(c)}
                          px={2.5}
                          py={1.5}
                          borderRadius="full"
                          borderWidth="1px"
                          borderColor={active ? "violet.400" : "gray.200"}
                          bg={active ? "violet.50" : "white"}
                          cursor="pointer"
                          _hover={{ bg: active ? "violet.50" : "gray.100" }}
                        >
                          <HStack gap={1.5}>
                            <Box
                              w="14px"
                              h="14px"
                              borderRadius="full"
                              css={{
                                background: `linear-gradient(135deg, ${a}, ${b})`,
                              }}
                            />
                            <Text
                              fontSize="xs"
                              fontFamily="heading"
                              color={active ? "violet.700" : "charcoal.500"}
                            >
                              {BADGE_COLORWAYS[c].label}
                            </Text>
                          </HStack>
                        </Box>
                      );
                    })}
                  </HStack>
                </Stack>

                {/* Optional custom title */}
                <Stack gap={2}>
                  <FieldLabel>{isCustom ? "Title" : "Title (optional)"}</FieldLabel>
                  <Input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={
                      isCustom
                        ? "Name this badge"
                        : selectedUnit?.badgeOnCompletion?.title ??
                          selectedUnit?.title ??
                          "Defaults to the unit's badge title"
                    }
                    fontFamily="body"
                    size="sm"
                  />
                </Stack>

                <Flex justify="flex-end" gap={2} pt={1}>
                  <Button
                    variant="ghost"
                    size="sm"
                    fontFamily="heading"
                    onClick={handleClose}
                    disabled={submitting}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    colorPalette="violet"
                    fontFamily="heading"
                    onClick={handleAward}
                    disabled={!unitId || submitting || (isCustom && !title.trim())}
                    loading={submitting}
                  >
                    <Medal /> Award badge
                  </Button>
                </Flex>
              </Stack>
            </Dialog.Body>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text
      fontSize="xs"
      color="charcoal.400"
      fontFamily="heading"
      fontWeight="600"
      textTransform="uppercase"
      letterSpacing="0.04em"
    >
      {children}
    </Text>
  );
}

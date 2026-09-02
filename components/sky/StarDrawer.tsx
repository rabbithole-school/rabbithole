"use client";

/**
 * StarDrawer — the light-themed panel that a tap on any star opens.
 *
 * Per the approved interaction model, the star map itself stays simple: a star
 * is a single tap target, and everything you can *do* with it (fly there, open
 * the scholar, go deeper) lives here in a Chakra drawer rather than as in-map
 * controls. Generic + presentational so every sky surface (scholar's own sky,
 * teacher Class Galaxy, …) drives it with the same shape.
 *
 * The deliberate pause matters: opening a panel before launching is a gentle
 * speed-bump against impulsive star-to-star hopping (a real concern for our
 * scholars) — you see what a star *is* before you commit to it.
 */

import NextLink from "next/link";
import { Box, Button, Drawer, Flex, IconButton, Image, Portal, Text, VStack } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";

export type StarDrawerAction = {
  label: string;
  href?: string;
  onClick?: () => void;
  primary?: boolean;
  /** red outline — for removing / dismissing a star */
  destructive?: boolean;
  loading?: boolean;
  disabled?: boolean;
  external?: boolean;
};

export type StarDrawerContent = {
  /** small kicker above the title — a domain, "Convergence", a lens name… */
  eyebrow?: string;
  title: string;
  /** the why / rationale paragraph */
  body?: string;
  /** accent dot color (defaults to a soft star white) */
  color?: string;
  avatarUrl?: string | null;
  scholarName?: string;
  /** little fact chips (reach, scholar count, last visited…) */
  meta?: { label: string; value: string }[];
  actions: StarDrawerAction[];
};

export function StarDrawer({
  content,
  onClose,
}: {
  content: StarDrawerContent | null;
  onClose: () => void;
}) {
  const accent = content?.color ?? "#e9e6ff";

  return (
    <Drawer.Root
      open={!!content}
      onOpenChange={(d) => !d.open && onClose()}
      placement="end"
      size="sm"
    >
      <Portal>
        <Drawer.Backdrop bg="blackAlpha.300" zIndex={1600} />
        <Drawer.Positioner zIndex={1600}>
          <Drawer.Content
            bg="white"
            color="charcoal.500"
            borderLeft="1px solid"
            borderColor="gray.200"
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            {content && (
              <>
                <Drawer.Header borderBottom="1px solid" borderColor="gray.100" px={6} py={5}>
                  <Flex align="flex-start" gap={3}>
                    <Box
                      mt="6px"
                      w="12px"
                      h="12px"
                      flexShrink={0}
                      rounded="full"
                      bg={accent}
                      boxShadow={`0 0 12px 2px ${accent}`}
                    />
                    <Box minW={0} flex={1}>
                      {content.eyebrow && (
                        <Text
                          fontSize="11px"
                          fontWeight="700"
                          letterSpacing="0.08em"
                          textTransform="uppercase"
                          color="violet.500"
                          mb={1}
                        >
                          {content.eyebrow}
                        </Text>
                      )}
                      <Drawer.Title asChild>
                        <Text fontFamily="heading" fontWeight="800" fontSize="xl" lineHeight="1.2" color="navy.500">
                          {content.title}
                        </Text>
                      </Drawer.Title>
                    </Box>
                    <Drawer.CloseTrigger asChild>
                      <IconButton
                        aria-label="Close"
                        size="sm"
                        variant="ghost"
                        flexShrink={0}
                        mt="-4px"
                        mr="-8px"
                        color="charcoal.400"
                        _hover={{ bg: "gray.100", color: "charcoal.500" }}
                      >
                        <X size={18} />
                      </IconButton>
                    </Drawer.CloseTrigger>
                  </Flex>
                </Drawer.Header>

                <Drawer.Body px={6} py={5}>
                  <VStack align="stretch" gap={4}>
                    {content.scholarName && (
                      <Flex align="center" gap={2}>
                        {content.avatarUrl ? (
                          <Image
                            src={content.avatarUrl}
                            alt={content.scholarName}
                            boxSize="26px"
                            rounded="full"
                            objectFit="cover"
                          />
                        ) : (
                          <Flex
                            boxSize="26px"
                            rounded="full"
                            bg={accent}
                            align="center"
                            justify="center"
                            fontSize="12px"
                            fontWeight="800"
                            color="navy.500"
                          >
                            {content.scholarName.trim()[0]?.toUpperCase() ?? "?"}
                          </Flex>
                        )}
                        <Text fontSize="sm" fontWeight="700" color="charcoal.500">
                          {content.scholarName}
                        </Text>
                      </Flex>
                    )}

                    {content.body && (
                      <Text fontSize="sm" color="charcoal.500" lineHeight="1.55">
                        {content.body}
                      </Text>
                    )}

                    {content.meta && content.meta.length > 0 && (
                      <Flex gap={5} wrap="wrap" align="baseline">
                        {content.meta.map((m) => (
                          <Text key={m.label} fontSize="xs" color="charcoal.400">
                            <Box
                              as="span"
                              textTransform="uppercase"
                              letterSpacing="0.06em"
                              fontSize="10px"
                              fontWeight="700"
                              color="charcoal.300"
                              mr={1.5}
                            >
                              {m.label}
                            </Box>
                            <Box as="span" fontWeight="700" color="charcoal.500">
                              {m.value}
                            </Box>
                          </Text>
                        ))}
                      </Flex>
                    )}
                  </VStack>
                </Drawer.Body>

                {content.actions.length > 0 && (
                  <Drawer.Footer borderTop="1px solid" borderColor="gray.100" px={6} py={5}>
                    <VStack align="stretch" gap={2} w="full">
                      {content.actions.map((a) => {
                        const variant = a.primary ? ("solid" as const) : ("outline" as const);
                        const common = {
                          w: "full" as const,
                          size: "md" as const,
                          loading: a.loading,
                          disabled: a.disabled,
                          colorPalette: a.destructive ? ("red" as const) : ("violet" as const),
                          variant,
                          ...(a.primary
                            ? {}
                            : a.destructive
                            ? {
                                color: "red.500",
                                borderColor: "red.200",
                                _hover: { bg: "red.50", borderColor: "red.300", color: "red.600" },
                              }
                            : {
                                color: "charcoal.500",
                                borderColor: "gray.200",
                                _hover: { bg: "gray.50", borderColor: "violet.200", color: "navy.500" },
                              }),
                        };
                        if (a.href) {
                          return (
                            <Button
                              key={a.label}
                              asChild
                              {...common}
                            >
                              <NextLink
                                href={a.href}
                                {...(a.external ? { target: "_blank", rel: "noopener" } : {})}
                                onClick={a.onClick}
                              >
                                {a.label}
                              </NextLink>
                            </Button>
                          );
                        }
                        return (
                          <Button key={a.label} onClick={a.onClick} {...common}>
                            {a.label}
                          </Button>
                        );
                      })}
                    </VStack>
                  </Drawer.Footer>
                )}
              </>
            )}
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

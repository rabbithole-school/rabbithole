"use client";

/**
 * DomainSwitcherDrawer (math-skills plan §8 · Sketch 3) — the scholar's
 * "switch which math domain today's playlist is drawn from" control, opened
 * from PlaylistCard's header domain chip. Rendered ONLY when the scholar has
 * ≥2 ACTIVE focus domains (the chip is a plain, non-interactive label
 * otherwise).
 *
 * The selection is SESSION-ONLY: it re-scopes the blend + strand carousel for
 * this session, owned as React state by app/scholar/page.tsx and threaded into
 * every playlist/choice query as the requested `domain`. Nothing persists —
 * "just for now" in the title sets that expectation, and next login returns to
 * the scholar's PRIMARY active domain by construction. Only ACTIVE domains are
 * listed; dormant domains are reachable through the skills map, never here.
 *
 * A bottom Drawer (Chakra/Ark). It stays stably mounted and only toggles
 * `open` — never remounted via a changing key while open — to avoid the Ark
 * body-lock leak (.claude/rules/engineering-principles.md).
 */

import { Box, Drawer, Flex, Portal, Text, chakra } from "@chakra-ui/react";
import { CaretRight } from "@phosphor-icons/react";
import { practiceDomainLabel } from "@/shared/practiceDomainLabels";
import { scopeAllowsDomain, type PracticeScope } from "@/shared/mathPlanScope";

export function DomainSwitcherDrawer({
  open,
  onClose,
  currentDomain,
  activeDomains,
  onSelect,
  practiceScope,
}: {
  open: boolean;
  onClose: () => void;
  /** The domain the playlist is currently scoped to (highlighted, "● shown"). */
  currentDomain: string;
  /** Every ACTIVE focus domain, with which one is the scholar's primary. */
  activeDomains: { domain: string; isPrimary: boolean }[];
  /** Session-only re-scope — the page owns the state; picking closes the drawer. */
  onSelect: (domain: string) => void;
  /** Resolved Math-plan scope. Undefined preserves the loading state. */
  practiceScope?: PracticeScope;
}) {
  const availableDomains =
    practiceScope?.kind === "limited"
      ? activeDomains.filter(({ domain }) => scopeAllowsDomain(practiceScope, domain))
      : activeDomains;
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(d) => !d.open && onClose()}
      placement="bottom"
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          <Drawer.Content
            roundedTop="16px"
            bg="white"
            pb="env(safe-area-inset-bottom)"
            maxW="680px"
            mx="auto"
          >
            <Drawer.Header px={5} pt={4} pb={2}>
              <Text
                fontFamily="heading"
                fontWeight="700"
                fontSize="sm"
                color="charcoal.600"
              >
                Switch math domain{" "}
                <Text as="span" fontWeight="400" color="charcoal.400">
                  · just for now
                </Text>
              </Text>
            </Drawer.Header>

            <Drawer.Body px={5} py={2}>
              <Flex direction="column" gap={1.5}>
                {availableDomains.map(({ domain, isPrimary }) => {
                  const isCurrent = domain === currentDomain;
                  return (
                    <chakra.button
                      key={domain}
                      type="button"
                      onClick={() => {
                        if (!isCurrent) onSelect(domain);
                        else onClose();
                      }}
                      aria-current={isCurrent ? "true" : undefined}
                      display="flex"
                      alignItems="center"
                      gap={2}
                      w="full"
                      textAlign="left"
                      rounded="10px"
                      borderWidth="1px"
                      borderColor={isCurrent ? "violet.300" : "gray.200"}
                      bg={isCurrent ? "violet.50" : "white"}
                      px={3.5}
                      py={2.5}
                      transition="background 0.12s, border-color 0.12s"
                      _hover={{
                        bg: isCurrent ? "violet.50" : "gray.50",
                        borderColor: isCurrent ? "violet.300" : "gray.300",
                      }}
                      _focusVisible={{
                        outline: "2px solid",
                        outlineColor: "violet.400",
                        outlineOffset: "-2px",
                      }}
                    >
                      <Text
                        flex="1"
                        minW={0}
                        lineClamp={1}
                        fontWeight={isCurrent ? "700" : "500"}
                        fontSize="sm"
                        color={isCurrent ? "violet.700" : "charcoal.600"}
                      >
                        {practiceDomainLabel(domain)}
                      </Text>
                      {isPrimary && (
                        <Text
                          flexShrink={0}
                          fontSize="10px"
                          fontFamily="heading"
                          fontWeight="700"
                          letterSpacing="0.04em"
                          textTransform="uppercase"
                          color="charcoal.400"
                        >
                          Primary
                        </Text>
                      )}
                      {isCurrent ? (
                        <Flex flexShrink={0} align="center" gap={1}>
                          <Box w="7px" h="7px" rounded="full" bg="violet.500" aria-hidden />
                          <Text fontSize="xs" fontWeight="600" color="violet.600">
                            shown
                          </Text>
                        </Flex>
                      ) : (
                        <CaretRight
                          size={14}
                          weight="bold"
                          color="var(--chakra-colors-charcoal-300)"
                        />
                      )}
                    </chakra.button>
                  );
                })}
                {practiceScope?.kind === "limited" && availableDomains.length === 0 && (
                  <Text fontSize="sm" color="charcoal.500" py={3}>
                    No practice is available in your current Math plan.
                  </Text>
                )}
              </Flex>

              <Box px={0.5} pt={3} pb={4}>
                <Text fontSize="xs" color="charcoal.400" lineHeight="1.5">
                  Dormant domains are not listed here — find them on the skills
                  map.
                </Text>
              </Box>
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

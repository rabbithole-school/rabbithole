"use client";

import { useState, type ReactNode } from "react";
import {
  Box,
  chakra,
  Drawer,
  HStack,
  IconButton,
  Portal,
  Stack,
  Text,
} from "@chakra-ui/react";
import { List, X } from "@phosphor-icons/react";
import { AppLogo } from "@/components/AppLogo";

export interface TopNavItem<Key extends string> {
  key: Key;
  label: string;
  icon: ReactNode;
  indicator?: ReactNode;
}

function isModifiedClick(e: React.MouseEvent): boolean {
  return (
    e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0
  );
}

/**
 * The shared route-link strip used in the app header. Callers own their items
 * and URL state; this component owns the teacher-style navigation treatment.
 */
export function TopNavTabs<Key extends string>({
  items,
  activeKey,
  ariaLabel,
  hrefForKey,
  onNavigate,
  onPrefetch,
  homeHref,
  onHomeNavigate,
}: {
  items: readonly TopNavItem<Key>[];
  activeKey?: Key;
  ariaLabel: string;
  hrefForKey: (key: Key) => string;
  onNavigate: (key: Key) => void;
  onPrefetch?: (key: Key) => void;
  homeHref: string;
  onHomeNavigate?: () => void;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      <Drawer.Root
        open={mobileOpen}
        onOpenChange={(details) => setMobileOpen(details.open)}
        placement="start"
      >
        <Drawer.Trigger asChild>
          <IconButton
            aria-label="Open navigation"
            display={{ base: "inline-flex", lg: "none" }}
            size="sm"
            variant="ghost"
            color="charcoal.500"
            _hover={{ color: "navy.500", bg: "gray.100" }}
            flexShrink={0}
          >
            <List size={20} />
          </IconButton>
        </Drawer.Trigger>
        <Portal>
          <Drawer.Backdrop />
          <Drawer.Positioner>
            <Drawer.Content
              w="min(320px, 86vw)"
              bg="white"
              pt="env(safe-area-inset-top)"
              pb="env(safe-area-inset-bottom)"
            >
              <Drawer.Header
                px={4}
                py={3}
                borderBottom="1px solid"
                borderColor="gray.200"
              >
                <Drawer.Title srOnly>{ariaLabel}</Drawer.Title>
                <chakra.a
                  href={homeHref}
                  aria-label="Home"
                  display="inline-flex"
                  alignItems="center"
                  onClick={(e) => {
                    if (isModifiedClick(e) || !onHomeNavigate) return;
                    e.preventDefault();
                    setMobileOpen(false);
                    onHomeNavigate();
                  }}
                >
                  <AppLogo variant="dark" size={28} />
                </chakra.a>
                <Drawer.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close navigation"
                    size="sm"
                    variant="ghost"
                    color="charcoal.400"
                    _hover={{ color: "navy.500", bg: "gray.100" }}
                  >
                    <X size={18} />
                  </IconButton>
                </Drawer.CloseTrigger>
              </Drawer.Header>
              <Drawer.Body px={3} py={3}>
                <Stack as="nav" aria-label={ariaLabel} gap={1}>
                  {items.map(({ key, label, icon, indicator }) => {
                    const active = key === activeKey;
                    return (
                      <chakra.a
                        key={key}
                        href={hrefForKey(key)}
                        aria-current={active ? "page" : undefined}
                        onClick={(e) => {
                          if (isModifiedClick(e)) return;
                          e.preventDefault();
                          setMobileOpen(false);
                          onNavigate(key);
                        }}
                        onPointerEnter={
                          onPrefetch ? () => onPrefetch(key) : undefined
                        }
                        onFocus={
                          onPrefetch ? () => onPrefetch(key) : undefined
                        }
                        onTouchStart={
                          onPrefetch ? () => onPrefetch(key) : undefined
                        }
                        display="flex"
                        alignItems="center"
                        gap={3}
                        minH="44px"
                        px={3}
                        py={2}
                        borderRadius="md"
                        fontFamily="heading"
                        fontSize="sm"
                        fontWeight={active ? "600" : "500"}
                        color={active ? "violet.700" : "charcoal.500"}
                        bg={active ? "violet.50" : "transparent"}
                        textDecoration="none"
                        transition="background-color 0.12s, color 0.12s"
                        _hover={
                          active
                            ? undefined
                            : { color: "navy.500", bg: "gray.100" }
                        }
                      >
                        <Box display="flex" alignItems="center" flexShrink={0}>
                          {icon}
                        </Box>
                        <Text as="span" flex={1}>
                          {label}
                        </Text>
                        {indicator}
                      </chakra.a>
                    );
                  })}
                </Stack>
              </Drawer.Body>
            </Drawer.Content>
          </Drawer.Positioner>
        </Portal>
      </Drawer.Root>

      <HStack
        as="nav"
        aria-label={ariaLabel}
        display={{ base: "none", lg: "flex" }}
        gap={0}
        align="stretch"
        minW={0}
        overflowX="auto"
      >
        {items.map(({ key, label, icon, indicator }) => {
          const active = key === activeKey;
          return (
            <chakra.a
              key={key}
              href={hrefForKey(key)}
              aria-current={active ? "page" : undefined}
              onClick={(e) => {
                if (isModifiedClick(e)) return;
                e.preventDefault();
                onNavigate(key);
              }}
              onPointerEnter={onPrefetch ? () => onPrefetch(key) : undefined}
              onFocus={onPrefetch ? () => onPrefetch(key) : undefined}
              onTouchStart={onPrefetch ? () => onPrefetch(key) : undefined}
              display="flex"
              alignItems="center"
              flexShrink={0}
              whiteSpace="nowrap"
              fontFamily="heading"
              fontSize="sm"
              fontWeight={active ? "600" : "500"}
              color={active ? "violet.600" : "charcoal.400"}
              px={4}
              py={3}
              borderBottom="2px solid"
              borderColor={active ? "violet.500" : "transparent"}
              textDecoration="none"
              cursor="pointer"
              transition="color 0.15s"
              _hover={{ color: active ? "violet.600" : "navy.500" }}
            >
              <Box mr={1.5} lineHeight={0}>
                {icon}
              </Box>
              {label}
              {indicator}
            </chakra.a>
          );
        })}
      </HStack>
    </>
  );
}

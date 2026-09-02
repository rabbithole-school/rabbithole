"use client";

/**
 * Components Drawer — Perspectives / Processes library.
 *
 * Curriculum tab used to have sub-tabs for these. They're not
 * hierarchical (each is a flat list of named entities) and don't fit
 * the Unit → Lesson → Activity column-view paradigm. Now they live
 * in a drawer triggered from the Curriculum tab header, leaving the
 * tab itself fully focused on Units.
 *
 * (Personas used to be a third type here but are DEPRECATED —
 * anti-parasocial; see TODO.html — and no longer surfaced.)
 *
 * Internal layout is itself a 2-column Finder (Type → Items), with
 * the existing EntityManager rendered inline as the body for the
 * selected type. EntityManager's edit-in-place forms keep working
 * unchanged.
 */
import { useState } from "react";
import { useQuery } from "convex/react";
import {
  Box,
  Drawer,
  Flex,
  HStack,
  Heading,
  IconButton,
  Portal,
  Text,
} from "@chakra-ui/react";
import { Eye, Stack, X } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { EntityManager } from "@/components";
import {
  HierarchyColumn,
  HierarchyRow,
} from "@/components/hierarchy";

type ComponentKind = "perspective" | "process";

interface ComponentsDrawerProps {
  open: boolean;
  onClose: () => void;
}

export function ComponentsDrawer({ open, onClose }: ComponentsDrawerProps) {
  const [kind, setKind] = useState<ComponentKind>("perspective");

  // Counts so the Type column reads as "Perspectives · 18 / Processes
  // · 14". Cheap — they reuse the same queries the EntityManager would
  // fetch anyway. (Personas are DEPRECATED — anti-parasocial — and no
  // longer surfaced here; see TODO.html.)
  const perspectives = useQuery(api.perspectives.list, open ? {} : "skip");
  const processes = useQuery(api.processes.list, open ? {} : "skip");

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(d) => !d.open && onClose()}
      placement="end"
      size={{ base: "full", md: "xl" }}
    >
      <Portal>
        <Drawer.Backdrop />
        <Drawer.Positioner>
          {/* Portaled overlays are position:fixed, so the body's
              env(safe-area-inset-top) padding doesn't reach them — pad the
              drawer so its header clears the iPad status bar. env() is 0 in
              desktop browsers, so this is a no-op on web. */}
          <Drawer.Content
            pt="env(safe-area-inset-top)"
            pb="env(safe-area-inset-bottom)"
          >
            <Drawer.Header px={6} py={4} borderBottom="1px solid" borderColor="gray.200">
              <HStack gap={3} flex={1}>
                <Text fontSize="2xl">🧩</Text>
                <Heading size="md" color="navy.500" fontFamily="heading">
                  Components
                </Heading>
              </HStack>
              <Drawer.CloseTrigger asChild>
                <IconButton
                  aria-label="Close"
                  size="sm"
                  variant="ghost"
                  color="charcoal.400"
                  _hover={{ bg: "gray.100" }}
                >
                  <X />
                </IconButton>
              </Drawer.CloseTrigger>
            </Drawer.Header>
            <Drawer.Body p={0} bg="gray.50">
              <Flex h="full">
                {/* Type column */}
                <HierarchyColumn header="Type" width="190px">
                  <HierarchyRow
                    leading={<Eye />}
                    label="Perspectives"
                    sublabel={
                      perspectives !== undefined
                        ? `${perspectives.length}`
                        : "…"
                    }
                    selected={kind === "perspective"}
                    onClick={() => setKind("perspective")}
                  />
                  <HierarchyRow
                    leading={<Stack />}
                    label="Processes"
                    sublabel={
                      processes !== undefined ? `${processes.length}` : "…"
                    }
                    selected={kind === "process"}
                    onClick={() => setKind("process")}
                  />
                </HierarchyColumn>
                {/* Items + Detail — delegated to EntityManager so its
                    edit/create/archive forms keep working unchanged. */}
                <Box flex={1} overflow="auto" p={4} bg="white">
                  <EntityManager entityType={kind} hideHeader />
                </Box>
              </Flex>
            </Drawer.Body>
          </Drawer.Content>
        </Drawer.Positioner>
      </Portal>
    </Drawer.Root>
  );
}

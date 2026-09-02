"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { curriculumUnitHref } from "@/lib/curriculumHref";
import {
  Box,
  Flex,
  VStack,
  HStack,
  Text,
  Button,
  IconButton,
  Spinner,
  Badge,
  Card,
  SimpleGrid,
  Dialog,
  Portal,
} from "@chakra-ui/react";
import {
  Plus,
  Trash,
  Book,
  Smiley,
  Eye,
  Stack,
  Scroll,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { DimensionEditModal } from "./DimensionEditModal";
import type { DimensionType, DimensionEditData } from "./DimensionEditModal";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { openExternal } from "@/lib/native";

interface Entity {
  id: string;
  _id: string;
  title: string;
  slug?: string;
  description?: string;
  systemPrompt?: string;
  isActive: boolean;
  teacherName: string | null;
  createdAt: number;
  rubric?: string;
  emoji?: string;
  icon?: string;
  steps?: { key: string; title: string; description?: string }[];
  personaId?: string | null;
  perspectiveId?: string | null;
  processId?: string | null;
  lessonCount?: number;
}

interface EntityManagerProps {
  entityType: DimensionType;
  hideHeader?: boolean;
}

const CONFIG: Record<DimensionType, {
  label: string;
  plural: string;
  icon: typeof Book;
  color: string;
}> = {
  unit: { label: "Unit", plural: "Units", icon: Book, color: "violet" },
  persona: { label: "Persona", plural: "Personas", icon: Smiley, color: "orange" },
  perspective: { label: "Perspective", plural: "Perspectives", icon: Eye, color: "teal" },
  process: { label: "Process", plural: "Processes", icon: Stack, color: "blue" },
};

export function EntityManager({ entityType, hideHeader }: EntityManagerProps) {
  const router = useRouter();
  const config = CONFIG[entityType];
  const Icon = config.icon;

  const entities = useQuery(
    entityType === "persona" ? api.personas.list :
    entityType === "unit" ? api.units.list :
    entityType === "process" ? api.processes.list :
    api.perspectives.list,
    {}
  ) as Entity[] | undefined;

  // Query building block lists when managing units. (Personas DEPRECATED —
  // anti-parasocial — so the unit editor no longer offers a persona block.)
  const perspectivesList = useQuery(api.perspectives.list, entityType === "unit" ? {} : "skip");
  const processesList = useQuery(api.processes.list, entityType === "unit" ? {} : "skip");

  const deactivatePersona = useMutation(api.personas.deactivate);
  const deactivateUnit = useMutation(api.units.deactivate);
  const deactivatePerspective = useMutation(api.perspectives.deactivate);
  const deactivateProcess = useMutation(api.processes.deactivate);
  const createUnit = useMutation(api.units.create);

  const [modalOpen, setModalOpen] = useState(false);
  const [editData, setEditData] = useState<DimensionEditData | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [confirmEntity, setConfirmEntity] = useState<Entity | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const isLoading = entities === undefined;
  const visibleEntities = (entities ?? []).filter(
    (e) => showArchived || e.isActive,
  );
  const archivedCount = (entities ?? []).filter((e) => !e.isActive).length;

  const handleCreate = async () => {
    // For units, skip the modal — create with a placeholder title and let the
    // user rename inline in the designer (which auto-opens the title editor
    // when the title is still the placeholder).
    if (entityType === "unit") {
      const unitId = await createUnit({ title: "Untitled unit" });
      // New unit → Edit tab (its Summary read view would be empty); the
      // designer auto-opens the title editor for the placeholder title.
      router.push(curriculumUnitHref(unitId, { pane: "edit" }));
      return;
    }
    setEditData(null);
    setModalOpen(true);
  };

  const handleEdit = (entity: Entity) => {
    setEditData({
      _id: entity._id,
      title: entity.title,
      description: entity.description,
      systemPrompt: entity.systemPrompt,
      emoji: entity.emoji,
      icon: entity.icon,
      rubric: entity.rubric,
      steps: entity.steps,
      personaId: entity.personaId ? String(entity.personaId) : undefined,
      perspectiveId: entity.perspectiveId ? String(entity.perspectiveId) : undefined,
      processId: entity.processId ? String(entity.processId) : undefined,
    });
    setModalOpen(true);
  };

  const handleDelete = (entity: Entity) => {
    setConfirmEntity(entity);
  };

  const confirmDelete = async () => {
    if (!confirmEntity) return;
    setIsDeleting(true);
    try {
      if (entityType === "persona") {
        await deactivatePersona({ id: confirmEntity.id as Id<"personas"> });
      } else if (entityType === "unit") {
        await deactivateUnit({ id: confirmEntity.id as Id<"units"> });
      } else if (entityType === "process") {
        await deactivateProcess({ id: confirmEntity.id as Id<"processes"> });
      } else {
        await deactivatePerspective({ id: confirmEntity.id as Id<"perspectives"> });
      }
      setConfirmEntity(null);
    } catch (error) {
      console.error(`Error archiving ${config.label}:`, error);
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <Flex minH="200px" align="center" justify="center">
        <Spinner size="lg" color="violet.500" />
      </Flex>
    );
  }

  const showArchivedToggle = (
    <HStack
      gap={2}
      cursor="pointer"
      onClick={() => setShowArchived((v) => !v)}
      color="charcoal.400"
      _hover={{ color: "charcoal.600" }}
    >
      <Box
        as="span"
        w="14px"
        h="14px"
        borderWidth="1px"
        borderColor={showArchived ? "violet.500" : "gray.400"}
        borderRadius="sm"
        bg={showArchived ? "violet.500" : "white"}
        display="flex"
        alignItems="center"
        justifyContent="center"
        flexShrink={0}
      >
        {showArchived && (
          <Box as="span" color="white" fontSize="10px" lineHeight="1" fontWeight="bold">
            ✓
          </Box>
        )}
      </Box>
      <Text fontFamily="heading" fontSize="xs">
        Show archived{archivedCount > 0 ? ` (${archivedCount})` : ""}
      </Text>
    </HStack>
  );

  return (
    <Box>
      {!hideHeader ? (
        <Flex justify="space-between" align="center" mb={4}>
          <HStack gap={2}>
            <Icon color="#AD60BF" size={22} />
            <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="lg">
              {config.plural}
            </Text>
            <Badge bg="gray.100" color="charcoal.500" fontFamily="heading" fontSize="xs">
              {visibleEntities.length}
            </Badge>
          </HStack>
          {showArchivedToggle}
        </Flex>
      ) : (
        <Flex justify="flex-end" mb={3}>
          {showArchivedToggle}
        </Flex>
      )}

        <SimpleGrid columns={{ base: 1, md: 2, lg: 3 }} gap={4}>
          {/* Dashed "create new" card — always first */}
          <Box
            bg="white"
            borderRadius="xl"
            p={5}
            cursor="pointer"
            border="2px dashed"
            borderColor="violet.200"
            _hover={{ borderColor: "violet.400", shadow: "md" }}
            display="flex"
            flexDir="column"
            alignItems="center"
            justifyContent="center"
            minH="140px"
            transition="all 0.15s"
            onClick={handleCreate}
          >
            <Box
              w={12}
              h={12}
              borderRadius="full"
              bg="violet.100"
              display="flex"
              alignItems="center"
              justifyContent="center"
              mb={2}
            >
              <Plus size={24} color="#AD60BF" />
            </Box>
            <Text fontFamily="heading" fontWeight="500" color="violet.500" fontSize="sm">
              New {config.label}
            </Text>
          </Box>

          {visibleEntities.map((entity) => {
            const isUnitCard = entityType === "unit" && entity.isActive;
            return (
            <Card.Root
              key={entity.id}
              bg="white"
              shadow="sm"
              borderWidth="1px"
              borderColor="gray.200"
              opacity={entity.isActive ? 1 : 0.6}
              cursor={isUnitCard ? "pointer" : undefined}
              _hover={{ shadow: "md", borderColor: "gray.300" }}
              transition="all 0.15s"
              onClick={
                isUnitCard
                  ? (e: React.MouseEvent) => {
                      const href = curriculumUnitHref(entity._id);
                      if (e.metaKey || e.ctrlKey) {
                        openExternal(href);
                      } else {
                        router.push(href);
                      }
                    }
                  : undefined
              }
              onAuxClick={
                isUnitCard
                  ? (e: React.MouseEvent) => {
                      if (e.button !== 1) return;
                      e.preventDefault();
                      openExternal(curriculumUnitHref(entity._id));
                    }
                  : undefined
              }
            >
              <Card.Body p={4}>
                <VStack align="stretch" gap={3}>
                  <HStack justify="space-between">
                    <HStack gap={4} flex={1}>
                      {entity.emoji && <Text fontSize="xl">{entity.emoji}</Text>}
                      {entity.icon && !entity.emoji && <Text fontSize="xl">{entity.icon}</Text>}
                      <VStack gap={0} align="start">
                        <Text fontWeight="600" fontFamily="heading" color="navy.500">
                          {entity.title}
                        </Text>
                        {entityType === "process" && entity.steps && (
                          <Badge bg="blue.100" color="blue.700" fontSize="xs">
                            {entity.steps.length} steps
                          </Badge>
                        )}
                        {entityType === "unit" && entity.lessonCount !== undefined && entity.lessonCount > 0 && (
                          <Badge bg="violet.100" color="violet.700" fontSize="xs">
                            {entity.lessonCount} lesson{entity.lessonCount !== 1 ? "s" : ""}
                          </Badge>
                        )}
                      </VStack>
                    </HStack>
                    {entity.isActive && (
                      <IconButton
                        aria-label="Archive"
                        title="Archive"
                        size="xs"
                        variant="ghost"
                        color="charcoal.300"
                        _hover={{ color: "red.500", bg: "red.50" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(entity);
                        }}
                      >
                        <Trash />
                      </IconButton>
                    )}
                  </HStack>

                  {entity.description && (
                    <Text fontSize="sm" color="charcoal.500" fontFamily="body">
                      {entity.description}
                    </Text>
                  )}

                  {entity.systemPrompt && (
                    <Text
                      fontSize="xs"
                      color="charcoal.400"
                      fontFamily="body"
                      overflow="hidden"
                      textOverflow="ellipsis"
                      css={{
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {entity.systemPrompt}
                    </Text>
                  )}

                  {!entity.isActive && (
                    <Badge bg="gray.200" color="gray.600" fontSize="xs" w="fit-content">
                      Archived
                    </Badge>
                  )}

                  {entityType !== "unit" && (
                    <HStack gap={2} mt={1}>
                      <Button
                        variant="outline"
                        size="sm"
                        fontFamily="heading"
                        color="violet.500"
                        borderColor="violet.200"
                        _hover={{ bg: "violet.50", borderColor: "violet.400" }}
                        onClick={() => handleEdit(entity)}
                      >
                        <Scroll size={14} weight="bold" style={{ marginRight: "6px" }} />
                        Edit Prompt
                      </Button>
                    </HStack>
                  )}
                </VStack>
              </Card.Body>
            </Card.Root>
            );
          })}
        </SimpleGrid>

      <DimensionEditModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        dimensionType={entityType}
        data={editData}
        perspectives={perspectivesList as { _id: string; title: string; icon?: string }[] | undefined}
        processes={processesList as { _id: string; title: string; emoji?: string }[] | undefined}
      />

      <Dialog.Root
        open={confirmEntity !== null}
        onOpenChange={(e) => {
          if (!e.open && !isDeleting) setConfirmEntity(null);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Archive {config.label}?
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  Archive &quot;{confirmEntity?.title}&quot;? Scholars will no longer see it. You can restore it later if needed.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => setConfirmEntity(null)}
                  disabled={isDeleting}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={confirmDelete}
                  disabled={isDeleting}
                >
                  {isDeleting ? "Archiving..." : "Archive"}
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}

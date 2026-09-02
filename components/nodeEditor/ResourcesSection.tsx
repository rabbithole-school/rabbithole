"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  Field as ChakraField,
  Flex,
  HStack,
  IconButton,
  Input,
  Portal,
  Spinner,
  Stack,
  Text,
  chakra,
} from "@chakra-ui/react";
import {
  ArrowSquareOut,
  DotsSixVertical,
  File,
  FilePdf,
  Image as ImageIcon,
  Link as LinkIcon,
  Trash,
  Video,
  X,
} from "@phosphor-icons/react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { openExternal } from "@/lib/native";
import { toaster } from "@/lib/toaster";
import { validateActivityResourceUrl } from "@/shared/activityResourceUrl";
import { Field } from "./shared";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const FILE_ACCEPT =
  "application/pdf,image/png,image/jpeg,image/gif,image/webp,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.rtf,application/rtf,text/rtf,.txt,.md,text/plain,text/markdown";

function humanizeSourceTitle(value: string) {
  const title = value
    .replace(/\.[^.]+$/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "Handout";
}

function titleFromUrl(value: string) {
  try {
    const parsed = new URL(value);
    const lastSegment = parsed.pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    if (lastSegment && lastSegment !== "watch") {
      return humanizeSourceTitle(decodeURIComponent(lastSegment));
    }
    return humanizeSourceTitle(
      parsed.hostname.replace(/^www\./, "").replace(/\.[^.]+$/, ""),
    );
  } catch {
    return "Handout";
  }
}

export function ResourcesSection({
  activityId,
}: {
  activityId: Id<"activities">;
}) {
  const resources = useQuery(api.activityResources.listForActivity, {
    activityId,
  });
  const referenceOptions = useQuery(
    api.activityResources.referenceOptionsForActivity,
    { activityId },
  );
  const [open, setOpen] = useState(false);
  const count =
    (resources?.length ?? 0) +
    (referenceOptions?.selectedResourceIds.length ?? 0);

  return (
    <>
      <Field
        label="Materials"
        hint="Files, websites, and videos scholars can open during this activity. Readable file text also informs the tutor."
      >
        <Button
          w="full"
          variant="outline"
          justifyContent="space-between"
          size="sm"
          fontFamily="heading"
          onClick={() => setOpen(true)}
        >
          <HStack gap={2}>
            <File size={17} />
            <Text fontSize="sm" fontWeight="600">
              {count === 0
                ? "Add materials"
                : `${count} material${count === 1 ? "" : "s"}`}
            </Text>
          </HStack>
          <Text fontSize="sm" color="violet.500" fontWeight="600">
            Manage
          </Text>
        </Button>
      </Field>

      <Dialog.Root
        open={open}
        onOpenChange={(details) => setOpen(details.open)}
        size="lg"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent maxW="2xl" w="calc(100vw - 32px)">
              <Dialog.Header borderBottomWidth="1px" borderColor="gray.100">
                <Dialog.Title
                  fontFamily="heading"
                  fontSize="lg"
                  color="navy.500"
                >
                  Activity materials
                </Dialog.Title>
                <Dialog.CloseTrigger asChild>
                  <IconButton
                    aria-label="Close materials"
                    size="sm"
                    variant="ghost"
                  >
                    <X />
                  </IconButton>
                </Dialog.CloseTrigger>
              </Dialog.Header>
              <Dialog.Body p={0}>
                <ResourcesEditor activityId={activityId} />
              </Dialog.Body>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </>
  );
}

export function ResourcesEditor({
  activityId,
  assignmentId,
  onSuggestedTitle,
}: {
  activityId: Id<"activities">;
  assignmentId?: Id<"assignments">;
  onSuggestedTitle?: (title: string) => void;
}) {
  const editScope = useMemo(
    () => (assignmentId ? { assignmentId } : {}),
    [assignmentId],
  );
  const resources = useQuery(api.activityResources.listForActivity, {
    activityId,
    ...editScope,
  });
  const referenceOptions = useQuery(
    api.activityResources.referenceOptionsForActivity,
    assignmentId ? "skip" : { activityId },
  );
  const generateUploadUrl = useMutation(
    api.activityResources.generateUploadUrl,
  );
  const registerFile = useMutation(api.activityResources.registerFile);
  const discardUpload = useMutation(api.activityResources.discardUpload);
  const addLink = useMutation(api.activityResources.addLink);
  const addVideo = useMutation(api.activityResources.addVideo);
  const rename = useMutation(api.activityResources.rename);
  const reorder = useMutation(
    api.activityResources.reorder,
  ).withOptimisticUpdate((localStore, args) => {
    const queryArgs = {
      activityId: args.activityId,
      ...(args.assignmentId ? { assignmentId: args.assignmentId } : {}),
    };
    const current = localStore.getQuery(
      api.activityResources.listForActivity,
      queryArgs,
    );
    if (!current) return;
    const byId = new Map(
      current.map((resource) => [String(resource._id), resource]),
    );
    const reordered = args.resourceIds
      .map((resourceId) => byId.get(String(resourceId)))
      .filter((resource): resource is NonNullable<typeof resource> => !!resource);
    if (reordered.length === current.length) {
      localStore.setQuery(
        api.activityResources.listForActivity,
        queryArgs,
        reordered,
      );
    }
  });
  const remove = useMutation(api.activityResources.remove);
  const retry = useMutation(api.activityResources.retryExtraction);
  const setReferencedResources = useMutation(
    api.activityResources.setReferencedResources,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingStorageIdRef = useRef<Id<"_storage"> | null>(null);
  const [adding, setAdding] = useState<"link" | "video" | null>(null);
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [renamingId, setRenamingId] =
    useState<Id<"activityResources"> | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  useEffect(
    () => () => {
      if (pendingStorageIdRef.current) {
        void discardUpload({
          activityId,
          storageId: pendingStorageIdRef.current,
          ...editScope,
        }).catch((error) => {
          console.error("Failed to discard abandoned resource upload", error);
        });
      }
    },
    [activityId, discardUpload, editScope],
  );

  const addUrl = async () => {
    if (!adding) return;
    const validatedUrl = validateActivityResourceUrl(url);
    if (!validatedUrl.ok) {
      setUrlError(validatedUrl.error);
      return;
    }
    const resourceTitle =
      title.trim() || (onSuggestedTitle ? titleFromUrl(validatedUrl.url) : "");
    if (!resourceTitle) return;
    setBusy("add-url");
    try {
      const mutation =
        adding === "video" ? addVideo : addLink;
      await mutation({
        activityId,
        title: resourceTitle,
        url: validatedUrl.url,
        ...editScope,
      });
      onSuggestedTitle?.(resourceTitle);
      setTitle("");
      setUrl("");
      setUrlError(null);
      setAdding(null);
    } catch (error) {
      toaster.error({
        title: "Couldn’t add material",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const upload = async (file: globalThis.File) => {
    if (file.size > MAX_FILE_BYTES) {
      toaster.error({ title: "Files must be 25 MB or smaller" });
      return;
    }
    setBusy("upload");
    let uploadedStorageId: Id<"_storage"> | null = null;
    try {
      const resourceTitle = humanizeSourceTitle(file.name);
      const uploadUrl = await generateUploadUrl({ activityId, ...editScope });
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: file.type ? { "Content-Type": file.type } : undefined,
        body: file,
      });
      if (!response.ok) throw new Error("Upload failed");
      const { storageId } = (await response.json()) as { storageId: string };
      uploadedStorageId = storageId as Id<"_storage">;
      pendingStorageIdRef.current = uploadedStorageId;
      const result = await registerFile({
        activityId,
        title: resourceTitle,
        fileName: file.name,
        storageId: uploadedStorageId,
        ...editScope,
      });
      if (!result.ok) throw new Error(result.error);
      onSuggestedTitle?.(resourceTitle);
      pendingStorageIdRef.current = null;
    } catch (error) {
      if (uploadedStorageId) {
        try {
          await discardUpload({
            activityId,
            storageId: uploadedStorageId,
            ...editScope,
          });
        } catch (cleanupError) {
          console.error("Failed to discard resource upload", cleanupError);
        }
        pendingStorageIdRef.current = null;
      }
      toaster.error({
        title: "Couldn’t upload material",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDragEnd = async ({ active, over }: DragEndEvent) => {
    if (!resources || !over || active.id === over.id) return;
    const fromIndex = resources.findIndex(
      (resource) => String(resource._id) === String(active.id),
    );
    const toIndex = resources.findIndex(
      (resource) => String(resource._id) === String(over.id),
    );
    if (fromIndex < 0 || toIndex < 0) return;

    setBusy("reorder");
    try {
      const resourceIds = arrayMove(resources, fromIndex, toIndex).map(
        (resource) => resource._id,
      );
      await reorder({ activityId, resourceIds, ...editScope });
    } catch (error) {
      toaster.error({
        title: "Couldn’t reorder materials",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const commitRename = async (resourceId: Id<"activityResources">) => {
    const next = renameDraft.trim();
    if (next) await rename({ resourceId, title: next, ...editScope });
    setRenamingId(null);
  };

  const toggleReference = async (resourceId: Id<"activityResources">) => {
    if (!referenceOptions) return;
    const selected = new Set(referenceOptions.selectedResourceIds.map(String));
    const resourceKey = String(resourceId);
    const resourceIds = selected.has(resourceKey)
      ? referenceOptions.selectedResourceIds.filter(
          (selectedId) => selectedId !== resourceId,
        )
      : [...referenceOptions.selectedResourceIds, resourceId];
    setBusy(`reference-${resourceKey}`);
    try {
      await setReferencedResources({
        activityId,
        resourceIds,
        ...editScope,
      });
    } catch (error) {
      toaster.error({
        title: "Couldn’t update materials",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Stack gap={0}>
      <Box px={6} py={4} borderBottomWidth="1px" borderColor="gray.100">
        <input
          ref={fileInputRef}
          type="file"
          accept={FILE_ACCEPT}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void upload(file);
          }}
        />
        <HStack gap={2} flexWrap="wrap">
          <Button
            size="sm"
            colorPalette="violet"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
          >
            {busy === "upload" ? <Spinner size="xs" /> : <File />}
            Upload file
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding("link")}
            disabled={busy !== null}
          >
            <LinkIcon />
            Add link
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAdding("video")}
            disabled={busy !== null}
          >
            <Video />
            Add video
          </Button>
        </HStack>

        {adding && (
          <Stack
            gap={2}
            mt={4}
            p={3}
            borderWidth="1px"
            borderColor="gray.200"
            borderRadius="md"
            bg="white"
          >
            <Text fontFamily="heading" fontSize="sm" fontWeight="600">
              Add {adding === "video" ? "video" : "website"}
            </Text>
            <Input
              size="sm"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={
                onSuggestedTitle
                  ? "Material title (optional)"
                  : "Material title"
              }
              aria-label="Material title"
            />
            <ChakraField.Root invalid={!!urlError}>
              <Input
                size="sm"
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setUrlError(null);
                }}
                onBlur={() => {
                  if (!url.trim()) return;
                  const result = validateActivityResourceUrl(url);
                  setUrlError(result.ok ? null : result.error);
                }}
                placeholder="https://…"
                aria-label="Material URL"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addUrl();
                }}
              />
              {urlError && (
                <ChakraField.ErrorText aria-live="polite">
                  {urlError}
                </ChakraField.ErrorText>
              )}
            </ChakraField.Root>
            <HStack justify="flex-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setAdding(null);
                  setTitle("");
                  setUrl("");
                  setUrlError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                colorPalette="violet"
                onClick={() => void addUrl()}
                disabled={
                  !url.trim() ||
                  (!title.trim() && !onSuggestedTitle) ||
                  busy !== null
                }
              >
                {busy === "add-url" && <Spinner size="xs" />}
                Add material
              </Button>
            </HStack>
          </Stack>
        )}
      </Box>

      {resources === undefined ? (
        <Flex minH="140px" align="center" justify="center">
          <Spinner color="violet.500" />
        </Flex>
      ) : resources.length === 0 ? (
        <Flex
          minH="140px"
          align="center"
          justify="center"
          flexDir="column"
          gap={2}
          px={6}
          textAlign="center"
        >
          <File size={28} color="var(--chakra-colors-charcoal-300)" />
          <Text fontFamily="heading" fontSize="sm" color="charcoal.500">
            No materials added here
          </Text>
          <Text fontSize="sm" color="charcoal.400">
            {assignmentId
              ? "Upload a file, or add a link or video."
              : "Upload one, or select material from this unit below."}
          </Text>
        </Flex>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={(event) => void handleDragEnd(event)}
        >
          <SortableContext
            items={resources.map((resource) => String(resource._id))}
            strategy={verticalListSortingStrategy}
          >
            <Stack gap={0}>
              {resources.map((resource, index) => {
                const status = resource.extractionStatus;
                const isRenaming = renamingId === resource._id;
                return (
                  <SortableResourceRow
                    key={resource._id}
                    resourceId={resource._id}
                    title={resource.title}
                    isLast={index === resources.length - 1}
                    disabled={busy !== null || renamingId !== null}
                    reorderable={resources.length > 1}
                  >
                    <Box color="violet.500" flexShrink={0}>
                      <ResourceIcon
                        kind={resource.source.kind}
                        mimeType={
                          resource.source.kind === "file"
                            ? resource.source.mimeType
                            : null
                        }
                      />
                    </Box>
                    <Stack gap={0} flex={1} minW={0}>
                      {isRenaming ? (
                        <Input
                          size="sm"
                          value={renameDraft}
                          onChange={(event) => setRenameDraft(event.target.value)}
                          onBlur={() => void commitRename(resource._id)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              void commitRename(resource._id);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              event.stopPropagation();
                              setRenamingId(null);
                            }
                          }}
                          autoFocus
                          aria-label="Material title"
                        />
                      ) : (
                        <chakra.button
                          type="button"
                          fontFamily="heading"
                          fontSize="sm"
                          fontWeight="600"
                          color="navy.500"
                          textAlign="left"
                          cursor="pointer"
                          truncate
                          borderRadius="sm"
                          _hover={{ bg: "gray.50" }}
                          _focusVisible={{
                            outline: "2px solid",
                            outlineColor: "violet.400",
                            outlineOffset: "2px",
                          }}
                          aria-label={`Rename ${resource.title}`}
                          onClick={() => {
                            setRenamingId(resource._id);
                            setRenameDraft(resource.title);
                          }}
                        >
                          {resource.title}
                        </chakra.button>
                      )}
                      <Text fontSize="xs" color="charcoal.400" truncate>
                        <ResourceDetail resource={resource} />
                      </Text>
                      {status === "error" && resource.extractionError && (
                        <Text fontSize="xs" color="red.600">
                          {resource.extractionError}
                        </Text>
                      )}
                    </Stack>
                    <HStack gap={0} flexShrink={0}>
                      {resource.url && (
                        <IconButton
                          aria-label={`Open ${resource.title}`}
                          size="xs"
                          variant="ghost"
                          onClick={() => openExternal(resource.url!)}
                        >
                          <ArrowSquareOut />
                        </IconButton>
                      )}
                      {status === "error" && (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() =>
                            void retry({
                              resourceId: resource._id,
                              ...editScope,
                            })
                          }
                        >
                          Retry
                        </Button>
                      )}
                      <IconButton
                        aria-label={`Remove ${resource.title}`}
                        size="xs"
                        variant="ghost"
                        color="charcoal.300"
                        _hover={{ color: "red.500" }}
                        onClick={() =>
                          void remove({
                            resourceId: resource._id,
                            ...editScope,
                          })
                        }
                      >
                        <Trash />
                      </IconButton>
                    </HStack>
                  </SortableResourceRow>
                );
              })}
            </Stack>
          </SortableContext>
        </DndContext>
      )}

      {!assignmentId && (
        <ReferencedResourcesEditor
          data={referenceOptions}
          busy={busy !== null}
          onToggle={toggleReference}
        />
      )}
    </Stack>
  );
}

function SortableResourceRow({
  resourceId,
  title,
  isLast,
  disabled,
  reorderable,
  children,
}: {
  resourceId: Id<"activityResources">;
  title: string;
  isLast: boolean;
  disabled: boolean;
  reorderable: boolean;
  children: React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: String(resourceId),
    disabled: disabled || !reorderable,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.55 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  return (
    <Flex
      ref={setNodeRef}
      style={style}
      align="center"
      gap={3}
      px={4}
      py={3}
      borderBottomWidth={isLast ? "0" : "1px"}
      borderColor="gray.100"
      bg="white"
      shadow={isDragging ? "md" : undefined}
    >
      {reorderable && (
        <IconButton
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${title}`}
          title={`Drag to reorder ${title}`}
          size="xs"
          variant="ghost"
          color="charcoal.300"
          cursor={isDragging ? "grabbing" : "grab"}
          touchAction="none"
          flexShrink={0}
          disabled={disabled}
        >
          <DotsSixVertical weight="bold" />
        </IconButton>
      )}
      {children}
    </Flex>
  );
}

function ReferencedResourcesEditor({
  data,
  busy,
  onToggle,
}: {
  data:
    | {
        options: Array<{
          resourceId: Id<"activityResources">;
          title: string;
          kind: "file" | "link" | "video";
          fileName: string | null;
          mimeType: string | null;
          ownerActivityId: Id<"activities">;
          ownerActivityTitle: string;
          ownerLessonTitle: string;
        }>;
        selectedResourceIds: Id<"activityResources">[];
      }
    | undefined;
  busy: boolean;
  onToggle: (resourceId: Id<"activityResources">) => Promise<void>;
}) {
  const selected = new Set(data?.selectedResourceIds.map(String) ?? []);
  const groups = new Map<
    string,
    {
      activityTitle: string;
      lessonTitle: string;
      resources: NonNullable<typeof data>["options"];
    }
  >();
  for (const option of data?.options ?? []) {
    const key = String(option.ownerActivityId);
    const group = groups.get(key);
    if (group) {
      group.resources.push(option);
    } else {
      groups.set(key, {
        activityTitle: option.ownerActivityTitle,
        lessonTitle: option.ownerLessonTitle,
        resources: [option],
      });
    }
  }

  return (
    <Box borderTopWidth="1px" borderColor="gray.100" px={6} py={5}>
      <Stack gap={1} mb={4}>
        <Text fontFamily="heading" fontSize="sm" fontWeight="700" color="navy.500">
          From this unit
        </Text>
        <Text fontSize="sm" color="charcoal.400">
          Reuse scholar-visible material from another activity.
        </Text>
      </Stack>
      {data === undefined ? (
        <Flex minH="80px" align="center" justify="center">
          <Spinner color="violet.500" />
        </Flex>
      ) : groups.size === 0 ? (
        <Text fontSize="sm" color="charcoal.400">
          No materials are available in other activities yet.
        </Text>
      ) : (
        <Stack gap={4}>
          {[...groups.entries()].map(([activityId, group]) => (
            <Stack key={activityId} gap={2}>
              <Text fontSize="xs" color="charcoal.400">
                {group.lessonTitle} · {group.activityTitle}
              </Text>
              {group.resources.map((resource) => (
                <Checkbox.Root
                  key={String(resource.resourceId)}
                  checked={selected.has(String(resource.resourceId))}
                  onCheckedChange={() => void onToggle(resource.resourceId)}
                  disabled={busy}
                  colorPalette="violet"
                  w="full"
                  alignItems="center"
                >
                  <Checkbox.HiddenInput />
                  <Checkbox.Control />
                  <Checkbox.Label flex={1} minW={0}>
                    <HStack gap={3}>
                      <Box color="violet.500" flexShrink={0}>
                        <ResourceIcon
                          kind={resource.kind}
                          mimeType={resource.mimeType}
                        />
                      </Box>
                      <Stack gap={0} minW={0}>
                        <Text
                          fontFamily="heading"
                          fontSize="sm"
                          fontWeight="600"
                          color="navy.500"
                          truncate
                        >
                          {resource.title}
                        </Text>
                        <Text fontSize="xs" color="charcoal.400" truncate>
                          {resource.kind === "file"
                            ? resource.fileName
                            : resource.kind === "video"
                              ? "Video"
                              : "Website"}
                        </Text>
                      </Stack>
                    </HStack>
                  </Checkbox.Label>
                </Checkbox.Root>
              ))}
            </Stack>
          ))}
        </Stack>
      )}
    </Box>
  );
}

function ResourceIcon({
  kind,
  mimeType,
}: {
  kind: "file" | "link" | "video";
  mimeType: string | null;
}) {
  if (kind === "link") return <LinkIcon size={22} />;
  if (kind === "video") return <Video size={22} />;
  if (mimeType === "application/pdf") return <FilePdf size={22} />;
  if (mimeType?.startsWith("image/")) return <ImageIcon size={22} />;
  return <File size={22} />;
}

function ResourceDetail({
  resource,
}: {
  resource: {
    source:
      | {
          kind: "file";
          fileName: string;
          mimeType: string;
          sizeBytes: number;
        }
      | { kind: "link"; url: string }
      | { kind: "video"; url: string };
    extractionStatus: "pending" | "extracting" | "ready" | "error" | null;
  };
}) {
  if (resource.source.kind !== "file") {
    return resource.source.kind === "video" ? "Video" : "Website";
  }
  const status =
    resource.extractionStatus === "ready"
      ? "Text ready"
      : resource.extractionStatus === "error"
        ? "Extraction failed"
        : resource.extractionStatus === "extracting"
          ? "Extracting text…"
          : "Waiting to extract…";
  return `${resource.source.fileName} · ${status}`;
}

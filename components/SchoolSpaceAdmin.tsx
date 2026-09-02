"use client";

/**
 * School Space — the physical-environment curation surface (platform-admin
 * `/admin` shell). An institution's rooms (`spaces`) and the equipment the
 * tutor may invite scholars to explore. The pedagogically-important control is
 * the per-item **tutor-suggestable** gate: the AI tutor never knows an item
 * exists until a staffer flips it on (the human-in-the-loop redaction
 * boundary). Unsafe gear carries a supervision level + safety notes.
 *
 * Backend: convex/spaces.ts + convex/equipment.ts (curriculum-gated).
 * See review/physical-environment-teaching-tool-plan.html.
 */

import { useMemo, useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import {
  Badge,
  Box,
  Button,
  Dialog,
  Flex,
  HStack,
  IconButton,
  Image,
  Input,
  Portal,
  Spinner,
  Switch,
  Text,
  Textarea,
  VStack,
} from "@chakra-ui/react";
import {
  Archive,
  ArrowCounterClockwise,
  Camera,
  DeviceMobile,
  PencilSimple,
  Plus,
  Warning,
} from "@phosphor-icons/react";
import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { uploadEquipmentPhoto } from "@/lib/downscalePhoto";
import { withInstitutionScope } from "@/lib/institutionLinks";
import { toaster } from "@/lib/toaster";

const SPACE_KINDS = [
  "classroom",
  "lab",
  "music",
  "art",
  "library",
  "makerspace",
  "outdoor",
  "gym",
  "other",
] as const;

const SUPERVISION_OPTIONS: {
  value: "none" | "adult_present" | "teacher_only";
  label: string;
}[] = [
  { value: "none", label: "No adult needed" },
  { value: "adult_present", label: "Adult present" },
  { value: "teacher_only", label: "Teacher only (never suggested)" },
];

type Supervision = "none" | "adult_present" | "teacher_only";

type EquipmentRow = {
  _id: Id<"equipment">;
  spaceId?: Id<"spaces">;
  name: string;
  category?: string;
  description?: string;
  quantity?: string;
  photoStorageId?: Id<"_storage">;
  photoUrl?: string | null;
  tutorSuggestable: boolean;
  supervision?: Supervision;
  safetyNotes?: string;
  usageIdeas?: string[];
  isActive: boolean;
};

type SpaceRow = {
  _id: Id<"spaces">;
  name: string;
  kind?: (typeof SPACE_KINDS)[number];
  description?: string;
  isActive: boolean;
};

export function SchoolSpaceAdmin() {
  const institutions = useQuery(api.institutions.listForStaff, {});
  const { user } = useCurrentUser();
  const { activeInstitution, requestedScope } = useActiveInstitution();
  const [pickedId, setPickedId] = useState<Id<"institutions"> | null>(null);
  const isPlatformAdmin =
    isPlatformAdminRole(user?.role as Role | undefined) ||
    activeInstitution?.isAdmin === true;
  const requestedInstitution = institutions?.find(
    (institution) =>
      institution.slug === requestedScope || institution._id === requestedScope,
  );
  const activeId: Id<"institutions"> | null = isPlatformAdmin
      ? requestedInstitution?._id ??
        activeInstitution?.institutionId ??
        activeInstitution?.homeInstitutionId ??
        institutions?.find((institution) => institution.isPrimary)?._id ??
        null
      : pickedId ??
        (institutions?.[0]?._id as Id<"institutions"> | undefined) ??
        null;

  const spaces = useQuery(
    api.spaces.list,
    activeId ? { institutionId: activeId } : "skip",
  ) as SpaceRow[] | undefined;
  const equipment = useQuery(
    api.equipment.listByInstitution,
    activeId ? { institutionId: activeId } : "skip",
  ) as EquipmentRow[] | undefined;

  const [showArchived, setShowArchived] = useState(false);
  const [mobileAddUrl, setMobileAddUrl] = useState<string | null>(null);
  const [roomDialog, setRoomDialog] = useState<
    { mode: "create" } | { mode: "edit"; room: SpaceRow } | null
  >(null);
  const [gearDialog, setGearDialog] = useState<
    | { mode: "create"; spaceId: Id<"spaces"> | null }
    | { mode: "edit"; item: EquipmentRow }
    | null
  >(null);

  const setSuggestable = useMutation(api.equipment.setTutorSuggestable);
  const archiveGear = useMutation(api.equipment.archive);
  const updateGear = useMutation(api.equipment.update);
  const archiveRoom = useMutation(api.spaces.archive);
  const updateRoom = useMutation(api.spaces.update);

  const visibleSpaces = useMemo(
    () => (spaces ?? []).filter((s) => showArchived || s.isActive),
    [spaces, showArchived],
  );
  const gearBySpace = useMemo(() => {
    const map = new Map<string, EquipmentRow[]>();
    for (const e of equipment ?? []) {
      if (!showArchived && !e.isActive) continue;
      const key = e.spaceId ?? "__none__";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [equipment, showArchived]);

  if (institutions === undefined) {
    return (
      <Flex justify="center" py={12}>
        <Spinner color="violet.500" />
      </Flex>
    );
  }

  const unassigned = gearBySpace.get("__none__") ?? [];
  const addByPhotoHref = isPlatformAdmin
    ? withInstitutionScope(
        "/school/instructional-materials/add",
        requestedInstitution?.slug ??
          activeInstitution?.institutionSlug ??
          activeInstitution?.homeInstitutionSlug,
      )
    : "/school/instructional-materials/add";

  return (
    <Box>
      <Flex align="flex-start" justify="space-between" mb={5} gap={4} wrap="wrap">
        <Box>
          <Text fontFamily="heading" fontSize="lg" fontWeight="700" color="navy.500">
            Instructional materials
          </Text>
          <Text fontSize="sm" color="charcoal.400" maxW="640px" mt={1}>
            Rooms and equipment the tutor can invite scholars to explore
            hands-on. The tutor only sees an item once you flip{" "}
            <b>Tutor may suggest</b> — unsafe gear should stay off or be marked
            &ldquo;Teacher only&rdquo;.
          </Text>
        </Box>
        <HStack gap={3}>
          {!isPlatformAdmin && institutions.length > 1 && (
            <FieldSelect
              value={activeId ?? ""}
              onChange={(v) => setPickedId(v as Id<"institutions">)}
              w="200px"
              fieldProps={{ "aria-label": "Institution" }}
            >
              {institutions.map((i) => (
                <option key={i._id} value={i._id}>
                  {i.emoji ? `${i.emoji} ` : ""}
                  {i.name}
                </option>
              ))}
            </FieldSelect>
          )}
          <Button asChild size="sm" variant="outline" colorPalette="violet">
            <Link href={addByPhotoHref}>
              <Camera /> Add by photo
            </Link>
          </Button>
          <Button
            size="sm"
            variant="outline"
            colorPalette="violet"
            display={{ base: "none", md: "inline-flex" }}
            onClick={() =>
              setMobileAddUrl(
                new URL(addByPhotoHref, window.location.origin).toString(),
              )
            }
          >
            <DeviceMobile /> Add using mobile
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRoomDialog({ mode: "create" })}
            disabled={!activeId}
          >
            <Plus /> New room
          </Button>
        </HStack>
      </Flex>

      <HStack mb={4} gap={2}>
        <Switch.Root
          checked={showArchived}
          onCheckedChange={(d) => setShowArchived(!!d.checked)}
          colorPalette="violet"
          size="sm"
        >
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontSize="xs" color="charcoal.400">
            Show archived
          </Switch.Label>
        </Switch.Root>
      </HStack>

      {activeId === null ? (
        <Text color="charcoal.400">No institution to curate.</Text>
      ) : spaces === undefined || equipment === undefined ? (
        <Flex justify="center" py={12}>
          <Spinner color="violet.500" />
        </Flex>
      ) : visibleSpaces.length === 0 && unassigned.length === 0 ? (
        <Box
          border="1px dashed"
          borderColor="gray.300"
          borderRadius="lg"
          p={8}
          textAlign="center"
          color="charcoal.400"
        >
          <Text mb={3}>No rooms yet.</Text>
          <Button size="sm" onClick={() => setRoomDialog({ mode: "create" })}>
            <Plus /> Add the first room
          </Button>
        </Box>
      ) : (
        <VStack align="stretch" gap={4}>
          {visibleSpaces.map((room) => (
            <RoomCard
              key={room._id}
              room={room}
              gear={gearBySpace.get(room._id) ?? []}
              onEditRoom={() => setRoomDialog({ mode: "edit", room })}
              onArchiveRoom={() => archiveRoom({ id: room._id })}
              onRestoreRoom={() => updateRoom({ id: room._id, isActive: true })}
              onAddGear={() =>
                setGearDialog({ mode: "create", spaceId: room._id })
              }
              onEditGear={(item) => setGearDialog({ mode: "edit", item })}
              onToggleSuggest={(item, next) =>
                setSuggestable({ id: item._id, tutorSuggestable: next })
              }
              onArchiveGear={(item) => archiveGear({ id: item._id })}
              onRestoreGear={(item) =>
                updateGear({ id: item._id, isActive: true })
              }
            />
          ))}

          {unassigned.length > 0 && (
            <RoomCard
              room={null}
              gear={unassigned}
              onAddGear={() => setGearDialog({ mode: "create", spaceId: null })}
              onEditGear={(item) => setGearDialog({ mode: "edit", item })}
              onToggleSuggest={(item, next) =>
                setSuggestable({ id: item._id, tutorSuggestable: next })
              }
              onArchiveGear={(item) => archiveGear({ id: item._id })}
              onRestoreGear={(item) =>
                updateGear({ id: item._id, isActive: true })
              }
            />
          )}
        </VStack>
      )}

      {roomDialog && activeId && (
        <RoomDialog
          institutionId={activeId}
          existing={roomDialog.mode === "edit" ? roomDialog.room : null}
          onClose={() => setRoomDialog(null)}
        />
      )}
      {gearDialog && activeId && (
        <EquipmentDialog
          institutionId={activeId}
          spaces={(spaces ?? []).filter((s) => s.isActive)}
          existing={gearDialog.mode === "edit" ? gearDialog.item : null}
          defaultSpaceId={
            gearDialog.mode === "create" ? gearDialog.spaceId : undefined
          }
          onClose={() => setGearDialog(null)}
        />
      )}
      {mobileAddUrl && (
        <MobileAddDialog
          url={mobileAddUrl}
          onClose={() => setMobileAddUrl(null)}
        />
      )}
    </Box>
  );
}

function MobileAddDialog({
  url,
  onClose,
}: {
  url: string;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="sm" mx={4} borderRadius="xl">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                Add using mobile
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack gap={4}>
                <Text fontSize="sm" color="charcoal.400" textAlign="center">
                  Scan this QR code with your phone&apos;s camera to open the
                  photo capture page.
                </Text>
                <Box
                  bg="white"
                  p={3}
                  borderWidth="1px"
                  borderColor="gray.200"
                  borderRadius="lg"
                  lineHeight={0}
                >
                  <QRCodeSVG
                    value={url}
                    size={224}
                    marginSize={0}
                    role="img"
                    aria-label="QR code for the add by photo page"
                  />
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={3}>
              <Button onClick={onClose}>Done</Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function RoomCard({
  room,
  gear,
  onEditRoom,
  onArchiveRoom,
  onRestoreRoom,
  onAddGear,
  onEditGear,
  onToggleSuggest,
  onArchiveGear,
  onRestoreGear,
}: {
  room: SpaceRow | null;
  gear: EquipmentRow[];
  onEditRoom?: () => void;
  onArchiveRoom?: () => void;
  onRestoreRoom?: () => void;
  onAddGear: () => void;
  onEditGear: (item: EquipmentRow) => void;
  onToggleSuggest: (item: EquipmentRow, next: boolean) => void;
  onArchiveGear: (item: EquipmentRow) => void;
  onRestoreGear: (item: EquipmentRow) => void;
}) {
  return (
    <Box
      border="1px solid"
      borderColor="gray.200"
      borderRadius="lg"
      bg="white"
      opacity={room && !room.isActive ? 0.6 : 1}
    >
      <Flex
        align="center"
        justify="space-between"
        px={4}
        py={3}
        borderBottom="1px solid"
        borderColor="gray.100"
      >
        <HStack gap={2}>
          <Text fontFamily="heading" fontWeight="700" color="navy.500">
            {room ? room.name : "Elsewhere in the school"}
          </Text>
          {room?.kind && (
            <Badge colorPalette="gray" size="sm">
              {room.kind}
            </Badge>
          )}
          {room && !room.isActive && (
            <Badge colorPalette="orange" size="sm">
              archived
            </Badge>
          )}
          {room?.description && (
            <Text fontSize="xs" color="charcoal.400">
              {room.description}
            </Text>
          )}
        </HStack>
        <HStack gap={1}>
          <Button size="xs" variant="ghost" onClick={onAddGear}>
            <Plus /> Equipment
          </Button>
          {room && onEditRoom && (
            <IconButton
              aria-label="Edit room"
              size="xs"
              variant="ghost"
              color="charcoal.400"
              onClick={onEditRoom}
            >
              <PencilSimple />
            </IconButton>
          )}
          {room && room.isActive && onArchiveRoom && (
            <IconButton
              aria-label="Archive room"
              size="xs"
              variant="ghost"
              color="charcoal.400"
              onClick={onArchiveRoom}
            >
              <Archive />
            </IconButton>
          )}
          {room && !room.isActive && onRestoreRoom && (
            <IconButton
              aria-label="Restore room"
              size="xs"
              variant="ghost"
              color="charcoal.400"
              onClick={onRestoreRoom}
            >
              <ArrowCounterClockwise />
            </IconButton>
          )}
        </HStack>
      </Flex>

      {gear.length === 0 ? (
        <Text fontSize="sm" color="charcoal.300" px={4} py={3}>
          No equipment here yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={0}>
          {gear.map((item) => (
            <EquipmentRowView
              key={item._id}
              item={item}
              onEdit={() => onEditGear(item)}
              onToggleSuggest={(next) => onToggleSuggest(item, next)}
              onArchive={() => onArchiveGear(item)}
              onRestore={() => onRestoreGear(item)}
            />
          ))}
        </VStack>
      )}
    </Box>
  );
}

function EquipmentRowView({
  item,
  onEdit,
  onToggleSuggest,
  onArchive,
  onRestore,
}: {
  item: EquipmentRow;
  onEdit: () => void;
  onToggleSuggest: (next: boolean) => void;
  onArchive: () => void;
  onRestore: () => void;
}) {
  const details = [item.quantity, item.category, item.description]
    .filter(Boolean)
    .join(" · ");
  return (
    <Flex
      align="center"
      justify="space-between"
      px={4}
      py={2.5}
      borderTop="1px solid"
      borderColor="gray.50"
      gap={4}
      opacity={item.isActive ? 1 : 0.6}
    >
      {item.photoUrl && (
        <Image
          src={item.photoUrl}
          alt={item.name}
          boxSize="44px"
          objectFit="cover"
          borderRadius="md"
          borderWidth="1px"
          borderColor="gray.200"
          flexShrink={0}
        />
      )}
      <Box flex={1} minW={0}>
        <HStack gap={2}>
          <Text fontWeight="600" color="charcoal.600">
            {item.name}
          </Text>
          {item.supervision === "adult_present" && (
            <Badge colorPalette="orange" size="sm">
              adult present
            </Badge>
          )}
          {item.supervision === "teacher_only" && (
            <Badge colorPalette="red" size="sm">
              teacher only
            </Badge>
          )}
          {!item.isActive && (
            <Badge colorPalette="orange" size="sm">
              archived
            </Badge>
          )}
        </HStack>
        {details && (
          <Text fontSize="xs" color="charcoal.400" truncate>
            {details}
          </Text>
        )}
        {item.safetyNotes && (
          <HStack gap={1} color="orange.600" mt={0.5}>
            <Warning size={12} />
            <Text fontSize="xs">{item.safetyNotes}</Text>
          </HStack>
        )}
        {item.usageIdeas && item.usageIdeas.length > 0 && (
          <Text fontSize="2xs" color="charcoal.300" mt={0.5}>
            {item.usageIdeas.length} task idea
            {item.usageIdeas.length === 1 ? "" : "s"}
          </Text>
        )}
      </Box>
      <HStack gap={2} flexShrink={0}>
        <Switch.Root
          checked={item.tutorSuggestable}
          onCheckedChange={(d) => onToggleSuggest(!!d.checked)}
          colorPalette="violet"
          size="sm"
          disabled={!item.isActive}
        >
          <Switch.HiddenInput />
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
          <Switch.Label fontSize="2xs" color="charcoal.400">
            Tutor may suggest
          </Switch.Label>
        </Switch.Root>
        <IconButton
          aria-label="Edit equipment"
          size="xs"
          variant="ghost"
          color="charcoal.400"
          onClick={onEdit}
        >
          <PencilSimple />
        </IconButton>
        {item.isActive ? (
          <IconButton
            aria-label="Archive equipment"
            size="xs"
            variant="ghost"
            color="charcoal.400"
            onClick={onArchive}
          >
            <Archive />
          </IconButton>
        ) : (
          <IconButton
            aria-label="Restore equipment"
            size="xs"
            variant="ghost"
            color="charcoal.400"
            onClick={onRestore}
          >
            <ArrowCounterClockwise />
          </IconButton>
        )}
      </HStack>
    </Flex>
  );
}

function RoomDialog({
  institutionId,
  existing,
  onClose,
}: {
  institutionId: Id<"institutions">;
  existing: SpaceRow | null;
  onClose: () => void;
}) {
  const create = useMutation(api.spaces.create);
  const update = useMutation(api.spaces.update);
  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<string>(existing?.kind ?? "classroom");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      if (existing) {
        await update({
          id: existing._id,
          name,
          kind: kind as (typeof SPACE_KINDS)[number],
          description,
        });
      } else {
        await create({
          institutionId,
          name,
          kind: kind as (typeof SPACE_KINDS)[number],
          description: description || undefined,
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && onClose()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="md" mx={4} borderRadius="xl">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                {existing ? "Edit room" : "New room"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack align="stretch" gap={3}>
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Music Room"
                    autoFocus
                  />
                </Field>
                <Field label="Kind">
                  <FieldSelect value={kind} onChange={setKind}>
                    {SPACE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </FieldSelect>
                </Field>
                <Field label="Description (optional)">
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Instruments and sound-making gear"
                  />
                </Field>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={3} gap={3}>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button
                colorPalette="violet"
                onClick={save}
                loading={saving}
                disabled={!name.trim()}
              >
                {existing ? "Save" : "Create"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

function EquipmentDialog({
  institutionId,
  spaces,
  existing,
  defaultSpaceId,
  onClose,
}: {
  institutionId: Id<"institutions">;
  spaces: SpaceRow[];
  existing: EquipmentRow | null;
  defaultSpaceId?: Id<"spaces"> | null;
  onClose: () => void;
}) {
  const create = useMutation(api.equipment.create);
  const update = useMutation(api.equipment.update);
  const generateUploadUrl = useMutation(api.equipment.generateUploadUrl);
  const discardUpload = useMutation(api.equipment.discardUpload);
  const [name, setName] = useState(existing?.name ?? "");
  const [spaceId, setSpaceId] = useState<string>(
    (existing?.spaceId ?? defaultSpaceId ?? "") as string,
  );
  const [category, setCategory] = useState(existing?.category ?? "");
  const [quantity, setQuantity] = useState(existing?.quantity ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tutorSuggestable, setTutorSuggestable] = useState(
    existing?.tutorSuggestable ?? false,
  );
  const [supervision, setSupervision] = useState<Supervision>(
    existing?.supervision ?? "none",
  );
  const [safetyNotes, setSafetyNotes] = useState(existing?.safetyNotes ?? "");
  const [ideasText, setIdeasText] = useState(
    (existing?.usageIdeas ?? []).join("\n"),
  );
  // Photo: null = remove on save, undefined = leave as-is, id = new upload.
  const [pendingPhoto, setPendingPhoto] = useState<
    { storageId: Id<"_storage">; previewUrl: string } | null | undefined
  >(undefined);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);

  const shownPhotoUrl =
    pendingPhoto === null
      ? null
      : (pendingPhoto?.previewUrl ?? existing?.photoUrl ?? null);

  /** Free an uploaded-but-unsaved blob (replace-again, remove, cancel). */
  const discardPending = (
    pending:
      | { storageId: Id<"_storage">; previewUrl?: string }
      | null
      | undefined,
  ) => {
    if (pending) {
      if (pending.previewUrl) URL.revokeObjectURL(pending.previewUrl);
      void discardUpload({ storageId: pending.storageId }).catch(() => {});
    }
  };

  const onPhotoPicked = async (file: File | undefined) => {
    if (!file) return;
    setUploadingPhoto(true);
    try {
      const uploaded = (await uploadEquipmentPhoto(
        () => generateUploadUrl({}),
        file,
      )) as { storageId: Id<"_storage">; previewUrl: string };
      discardPending(pendingPhoto);
      setPendingPhoto(uploaded);
    } catch (err) {
      toaster.error({
        title: "Photo upload failed",
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setUploadingPhoto(false);
    }
  };

  const cancel = () => {
    // Dialog closed without saving — the pending upload is unreachable.
    discardPending(pendingPhoto);
    onClose();
  };

  const save = async () => {
    if (!name.trim()) return;
    setSaving(true);
    const usageIdeas = ideasText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    try {
      if (existing) {
        await update({
          id: existing._id,
          spaceId: spaceId ? (spaceId as Id<"spaces">) : null,
          name,
          category,
          quantity,
          description,
          photoStorageId:
            pendingPhoto === undefined
              ? undefined
              : (pendingPhoto?.storageId ?? null),
          tutorSuggestable,
          supervision,
          safetyNotes,
          usageIdeas,
        });
      } else {
        await create({
          institutionId,
          spaceId: spaceId ? (spaceId as Id<"spaces">) : undefined,
          name,
          category: category || undefined,
          quantity: quantity || undefined,
          description: description || undefined,
          photoStorageId: pendingPhoto?.storageId,
          tutorSuggestable,
          supervision,
          safetyNotes: safetyNotes || undefined,
          usageIdeas: usageIdeas.length > 0 ? usageIdeas : undefined,
        });
      }
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(e) => !e.open && cancel()} placement="center">
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content maxW="lg" mx={4} borderRadius="xl" maxH="90vh" overflowY="auto">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontWeight="700" color="navy.500">
                {existing ? "Edit equipment" : "New equipment"}
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack align="stretch" gap={3}>
                <Field label="Name">
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Set of hand bells"
                    autoFocus
                  />
                </Field>
                <Field label="Room">
                  <FieldSelect value={spaceId} onChange={setSpaceId}>
                    <option value="">Elsewhere in the school</option>
                    {spaces.map((s) => (
                      <option key={s._id} value={s._id}>
                        {s.name}
                      </option>
                    ))}
                  </FieldSelect>
                </Field>
                <HStack gap={3} align="flex-start">
                  <Field label="Category (optional)">
                    <Input
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                      placeholder="musical"
                    />
                  </Field>
                  <Field label="Quantity (optional)">
                    <Input
                      value={quantity}
                      onChange={(e) => setQuantity(e.target.value)}
                      placeholder="8 bells (C–C)"
                    />
                  </Field>
                </HStack>
                <Field label="Description (optional)">
                  <Input
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Tuned hand bells, one octave"
                  />
                </Field>
                <Field label="Photo (optional)">
                  <input
                    ref={photoInputRef}
                    type="file"
                    accept="image/*"
                    hidden
                    onChange={(e) => {
                      void onPhotoPicked(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                  <HStack gap={3}>
                    {shownPhotoUrl && (
                      <Image
                        src={shownPhotoUrl}
                        alt={name || "Equipment photo"}
                        boxSize="64px"
                        objectFit="cover"
                        borderRadius="md"
                        borderWidth="1px"
                        borderColor="gray.200"
                      />
                    )}
                    <Button
                      size="xs"
                      variant="outline"
                      loading={uploadingPhoto}
                      onClick={() => photoInputRef.current?.click()}
                    >
                      <Camera /> {shownPhotoUrl ? "Replace" : "Add photo"}
                    </Button>
                    {shownPhotoUrl && (
                      <Button
                        size="xs"
                        variant="ghost"
                        color="charcoal.400"
                        onClick={() => {
                          discardPending(pendingPhoto);
                          setPendingPhoto(null);
                        }}
                      >
                        Remove
                      </Button>
                    )}
                  </HStack>
                </Field>
                <Field label="Supervision">
                  <FieldSelect
                    value={supervision}
                    onChange={(v) => setSupervision(v as Supervision)}
                  >
                    {SUPERVISION_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </FieldSelect>
                </Field>
                <Field label="Safety notes (optional — shown verbatim to the tutor)">
                  <Textarea
                    value={safetyNotes}
                    onChange={(e) => setSafetyNotes(e.target.value)}
                    placeholder="The compass point is sharp — keep it pointed at the paper."
                    rows={2}
                  />
                </Field>
                <Field label="Task ideas (one per line — starting points, not scripts)">
                  <Textarea
                    value={ideasText}
                    onChange={(e) => setIdeasText(e.target.value)}
                    placeholder={
                      "Ring two bells together and describe what you hear.\nSee if you can find a pattern in which pairs blend."
                    }
                    rows={4}
                  />
                </Field>
                <Box borderTop="1px solid" borderColor="gray.100" pt={3}>
                  <Switch.Root
                    checked={tutorSuggestable}
                    onCheckedChange={(d) => setTutorSuggestable(!!d.checked)}
                    colorPalette="violet"
                    size="sm"
                  >
                    <Switch.HiddenInput />
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Switch.Label
                      fontFamily="heading"
                      fontSize="sm"
                      color="charcoal.600"
                    >
                      Tutor may suggest this
                    </Switch.Label>
                  </Switch.Root>
                  <Text fontSize="2xs" color="charcoal.400" pl={6} mt={0.5}>
                    Off by default — the tutor never sees this item until you
                    turn it on.
                  </Text>
                </Box>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={3} gap={3}>
              <Button variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button
                colorPalette="violet"
                onClick={save}
                loading={saving}
                disabled={!name.trim()}
              >
                {existing ? "Save" : "Create"}
              </Button>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Small labeled field wrapper matching the app's dialog forms. */
function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box flex={1}>
      <Text fontSize="xs" fontWeight="600" color="charcoal.500" mb={1}>
        {label}
      </Text>
      {children}
    </Box>
  );
}

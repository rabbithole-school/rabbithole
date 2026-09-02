"use client";

/**
 * Add to inventory by photo — BURST capture for the School Space inventory.
 * A staffer walks a room and goes snap-snap-snap (one tap per item); every
 * shot inherits the room selected AT SNAP TIME and is AUTO-SAVED with the
 * AI's suggested name / category / quantity / description
 * (convex/equipmentActions.identifyPhoto). The staffer then glances down the
 * list and corrects only what needs correcting — inline, in place.
 *
 * Auto-save is a convenience, NOT a lowering of the human-in-the-loop bar:
 * new items keep the tutor-suggestable gate default-OFF, so nothing a staffer
 * snapped is ever visible to the tutor until they deliberately flip it in
 * School Space. Staff-gated by the /school shell.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Flex,
  HStack,
  IconButton,
  Image,
  Input,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { ArrowLeft, Camera, X } from "@phosphor-icons/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { Surface } from "@/components/ui/Surface";
import { CameraCaptureDialog } from "@/components/CameraCaptureDialog";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { toaster } from "@/lib/toaster";
import { uploadEquipmentPhoto } from "@/lib/downscalePhoto";
import { withInstitutionScope } from "@/lib/institutionLinks";

type FieldKey = "name" | "category" | "quantity" | "description" | "safetyNotes";
type ItemStatus =
  | "uploading"
  | "identifying"
  | "saved"
  | "needs-name"
  | "failed";

const EMPTY_FIELDS: Record<FieldKey, string> = {
  name: "",
  category: "",
  quantity: "",
  description: "",
  safetyNotes: "",
};

interface QueueItem {
  localId: string;
  file: File;
  previewUrl: string;
  /** Room + institution captured AT SNAP TIME — later room changes only
   *  affect later snaps. */
  spaceId: string;
  institutionId: Id<"institutions">;
  storageId: Id<"_storage"> | null;
  equipmentId: Id<"equipment"> | null;
  status: ItemStatus;
  fields: Record<FieldKey, string>;
  error?: string;
}

const MAX_CONCURRENT = 3;

export default function AddByPhotoPage() {
  const institutions = useQuery(api.institutions.listForStaff, {});
  const { user } = useCurrentUser();
  const { activeInstitution, requestedScope } = useActiveInstitution();
  const [pickedInstitution, setPickedInstitution] =
    useState<Id<"institutions"> | null>(null);
  const isPlatformAdmin =
    isPlatformAdminRole(user?.role as Role | undefined) ||
    activeInstitution?.isAdmin === true;
  const requestedInstitution = institutions?.find(
    (institution) =>
      institution.slug === requestedScope || institution._id === requestedScope,
  );
  const institutionId: Id<"institutions"> | null = isPlatformAdmin
      ? requestedInstitution?._id ??
        activeInstitution?.institutionId ??
        activeInstitution?.homeInstitutionId ??
        institutions?.find((institution) => institution.isPrimary)?._id ??
        null
      : pickedInstitution ??
        (institutions?.[0]?._id as Id<"institutions"> | undefined) ??
        null;
  const spaces = useQuery(
    api.spaces.list,
    institutionId ? { institutionId } : "skip",
  );
  const activeSpaces = useMemo(
    () =>
      (spaces ?? []).filter((s: { isActive: boolean }) => s.isActive) as {
        _id: Id<"spaces">;
        name: string;
      }[],
    [spaces],
  );

  const generateUploadUrl = useMutation(api.equipment.generateUploadUrl);
  const discardUpload = useMutation(api.equipment.discardUpload);
  const identifyPhoto = useAction(api.equipmentActions.identifyPhoto);
  const createEquipment = useMutation(api.equipment.create);
  const updateEquipment = useMutation(api.equipment.update);
  const removeEquipment = useMutation(api.equipment.remove);

  const libraryInputRef = useRef<HTMLInputElement>(null);

  // The sticky room — persists across snaps, captured onto each item as it's
  // enqueued. Institution change resets it (rooms belong to an institution).
  const [currentRoom, setCurrentRoom] = useState<string>("");
  const previousInstitutionRef = useRef<Id<"institutions"> | null>(institutionId);
  useEffect(() => {
    if (previousInstitutionRef.current !== institutionId) {
      previousInstitutionRef.current = institutionId;
      setCurrentRoom("");
    }
  }, [institutionId]);
  const [cameraOpen, setCameraOpen] = useState(false);

  const [items, setItems] = useState<QueueItem[]>([]);
  // A live mirror of `items` so async pipeline callbacks read the latest queue
  // without re-subscribing (gen-guarding against removed/unmounted items).
  const itemsRef = useRef<QueueItem[]>(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // AI suggestions only fill fields the staffer hasn't typed in — per item.
  const touchedRef = useRef<Map<string, Set<FieldKey>>>(new Map());
  // The last values persisted to the server for a saved item, so an inline
  // edit only fires update() when a field actually changed.
  const persistedRef = useRef<Map<string, Record<FieldKey, string>>>(new Map());
  const submittingRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const idCounterRef = useRef(0);

  // Concurrency: cap the upload→identify→create pipelines at MAX_CONCURRENT.
  const runningRef = useRef(0);
  const pendingRef = useRef<string[]>([]);

  const savedCount = items.filter((i) => i.status === "saved").length;

  // itemsRef is updated SYNCHRONOUSLY alongside every state write — the
  // pipeline reads it in the same tick it's kicked off (enqueue → pump →
  // runPipeline), before React has re-rendered and re-synced the mirror
  // effect. Relying on the effect alone made every pipeline bail at its
  // first existence check.
  const updateItem = (localId: string, patch: Partial<QueueItem>) => {
    itemsRef.current = itemsRef.current.map((i) =>
      i.localId === localId ? { ...i, ...patch } : i,
    );
    setItems((prev) =>
      prev.map((i) => (i.localId === localId ? { ...i, ...patch } : i)),
    );
  };

  const errMsg = (err: unknown) =>
    err instanceof Error ? err.message : "Something went wrong";

  // ---- pipeline -----------------------------------------------------------

  const createFromItem = async (
    localId: string,
    instId: Id<"institutions">,
    storageId: Id<"_storage">,
    spaceId: string,
    fields: Record<FieldKey, string>,
  ) => {
    if (submittingRef.current.has(localId)) return;
    if (!fields.name.trim()) {
      updateItem(localId, { status: "needs-name" });
      return;
    }
    submittingRef.current.add(localId);
    try {
      const equipmentId = (await createEquipment({
        institutionId: instId,
        spaceId: spaceId ? (spaceId as Id<"spaces">) : undefined,
        name: fields.name,
        category: fields.category || undefined,
        quantity: fields.quantity || undefined,
        description: fields.description || undefined,
        safetyNotes: fields.safetyNotes || undefined,
        photoStorageId: storageId,
      })) as Id<"equipment">;
      if (!mountedRef.current) return;
      // Removed while we were saving — undo the just-created row.
      if (!itemsRef.current.some((i) => i.localId === localId)) {
        void removeEquipment({ id: equipmentId }).catch(() => {});
        return;
      }
      const created: Record<FieldKey, string> = {
        ...EMPTY_FIELDS,
        name: fields.name.trim(),
        category: fields.category.trim(),
        quantity: fields.quantity.trim(),
        description: fields.description.trim(),
        safetyNotes: fields.safetyNotes.trim(),
      };
      persistedRef.current.set(localId, created);
      updateItem(localId, { status: "saved", equipmentId, error: undefined });
      // Reconcile edits typed DURING the create round-trip: blur ignores
      // in-flight cards, so anything that diverged from the created snapshot
      // would otherwise stay local-only.
      const live = itemsRef.current.find((i) => i.localId === localId);
      if (live) {
        const diffs: Partial<Record<FieldKey, string>> = {};
        for (const key of Object.keys(created) as FieldKey[]) {
          const val = live.fields[key].trim();
          // Never push an empty name; the revert-on-blur rule owns that case.
          if (val !== created[key] && !(key === "name" && !val)) {
            diffs[key] = live.fields[key];
          }
        }
        if (Object.keys(diffs).length > 0) {
          void updateEquipment({ id: equipmentId, ...diffs })
            .then(() => {
              const persisted =
                persistedRef.current.get(localId) ?? created;
              const trimmed = Object.fromEntries(
                Object.entries(diffs).map(([k, v]) => [k, (v ?? "").trim()]),
              );
              persistedRef.current.set(localId, { ...persisted, ...trimmed });
            })
            .catch((err) =>
              toaster.error({
                title: "Couldn't save edit",
                description: errMsg(err),
              }),
            );
        }
      }
    } catch (err) {
      if (!mountedRef.current) return;
      updateItem(localId, { status: "failed", error: errMsg(err) });
    } finally {
      submittingRef.current.delete(localId);
    }
  };

  const runPipeline = async (localId: string) => {
    const start = itemsRef.current.find((i) => i.localId === localId);
    if (!start) return; // removed before it ran
    updateItem(localId, { status: "uploading", error: undefined });

    // 1. upload
    let storageId: Id<"_storage">;
    try {
      const res = (await uploadEquipmentPhoto(
        () => generateUploadUrl({}),
        start.file,
      )) as { storageId: Id<"_storage">; previewUrl: string };
      // We show our own preview (from the original File, created at enqueue),
      // so free the downscaled one uploadEquipmentPhoto handed back.
      URL.revokeObjectURL(res.previewUrl);
      storageId = res.storageId;
    } catch (err) {
      if (!mountedRef.current) return;
      if (itemsRef.current.some((i) => i.localId === localId)) {
        updateItem(localId, { status: "failed", error: errMsg(err) });
      }
      return;
    }
    // Removed/unmounted while uploading → free the now-orphaned blob.
    if (
      !mountedRef.current ||
      !itemsRef.current.some((i) => i.localId === localId)
    ) {
      void discardUpload({ storageId }).catch(() => {});
      return;
    }
    updateItem(localId, { storageId, status: "identifying" });

    // 2. identify (best-effort — a failure just means "type a name")
    let suggestion: {
      name?: string;
      category?: string;
      quantity?: string;
      description?: string;
      safetyNotes?: string;
    } | null = null;
    try {
      suggestion = await identifyPhoto({ storageId });
    } catch {
      suggestion = null;
    }
    if (!mountedRef.current) return;
    const current = itemsRef.current.find((i) => i.localId === localId);
    if (!current) {
      void discardUpload({ storageId }).catch(() => {});
      return;
    }

    // 3. merge suggestion over untouched-empty fields (a user edit made while
    // identifying is touched, so it wins over the late AI result), then save.
    const touched = touchedRef.current.get(localId) ?? new Set<FieldKey>();
    const merged = { ...current.fields };
    if (suggestion) {
      const apply = (k: FieldKey, val: string | undefined) => {
        if (val && !touched.has(k) && !merged[k]) merged[k] = val;
      };
      apply("name", suggestion.name);
      apply("category", suggestion.category);
      apply("quantity", suggestion.quantity);
      apply("description", suggestion.description);
      apply("safetyNotes", suggestion.safetyNotes);
    }
    updateItem(localId, { fields: merged });

    if (merged.name.trim()) {
      await createFromItem(
        localId,
        current.institutionId,
        storageId,
        current.spaceId,
        merged,
      );
    } else {
      updateItem(localId, { status: "needs-name" });
    }
  };

  const pump = () => {
    while (runningRef.current < MAX_CONCURRENT && pendingRef.current.length > 0) {
      const localId = pendingRef.current.shift()!;
      runningRef.current += 1;
      void runPipeline(localId).finally(() => {
        runningRef.current -= 1;
        pump();
      });
    }
  };

  const enqueue = (file: File) => {
    if (!institutionId) return;
    const localId = `q${idCounterRef.current++}`;
    const previewUrl = URL.createObjectURL(file);
    touchedRef.current.set(localId, new Set());
    const item: QueueItem = {
      localId,
      file,
      previewUrl,
      spaceId: currentRoom,
      institutionId,
      storageId: null,
      equipmentId: null,
      status: "uploading",
      fields: { ...EMPTY_FIELDS },
    };
    itemsRef.current = [item, ...itemsRef.current];
    setItems((prev) => [item, ...prev]);
    pendingRef.current.push(localId);
    pump();
  };

  // ---- inline edit --------------------------------------------------------

  const editField = (localId: string, key: FieldKey, value: string) => {
    const t = touchedRef.current.get(localId);
    if (t) t.add(key);
    updateItem(localId, {
      fields: {
        ...(itemsRef.current.find((i) => i.localId === localId)?.fields ??
          EMPTY_FIELDS),
        [key]: value,
      },
    });
  };

  const blurField = (localId: string, key: FieldKey) => {
    const item = itemsRef.current.find((i) => i.localId === localId);
    if (!item) return;

    if (item.status === "saved" && item.equipmentId) {
      const persisted = persistedRef.current.get(localId) ?? EMPTY_FIELDS;
      const value = item.fields[key];
      // Never let a saved item's name be cleared — revert to the saved value.
      if (key === "name" && !value.trim()) {
        updateItem(localId, {
          fields: { ...item.fields, name: persisted.name },
        });
        return;
      }
      if (value.trim() === (persisted[key] ?? "")) return; // unchanged
      const id = item.equipmentId;
      void updateEquipment({ id, [key]: value })
        .then(() =>
          // Merge into the LIVE map entry — a concurrent blur on another
          // field may have updated it since we captured `persisted`.
          persistedRef.current.set(localId, {
            ...(persistedRef.current.get(localId) ?? persisted),
            [key]: value.trim(),
          }),
        )
        .catch((err) =>
          toaster.error({ title: "Couldn't save edit", description: errMsg(err) }),
        );
      return;
    }

    // A needs-name card saves the moment it gets a name.
    if (
      item.status === "needs-name" &&
      key === "name" &&
      item.fields.name.trim() &&
      item.storageId
    ) {
      void createFromItem(
        localId,
        item.institutionId,
        item.storageId,
        item.spaceId,
        item.fields,
      );
    }
    // uploading / identifying / failed: edits are just stored locally.
  };

  const retry = (localId: string) => {
    const item = itemsRef.current.find((i) => i.localId === localId);
    if (!item) return;
    // Free any blob from the failed attempt so a retry can't orphan it.
    if (item.storageId) void discardUpload({ storageId: item.storageId }).catch(() => {});
    updateItem(localId, { status: "uploading", storageId: null, error: undefined });
    pendingRef.current.push(localId);
    pump();
  };

  const removeCard = (localId: string) => {
    const item = itemsRef.current.find((i) => i.localId === localId);
    if (!item) return;
    URL.revokeObjectURL(item.previewUrl);
    if (item.status === "saved" && item.equipmentId) {
      void removeEquipment({ id: item.equipmentId }).catch(() => {});
    } else if (item.storageId) {
      void discardUpload({ storageId: item.storageId }).catch(() => {});
    }
    touchedRef.current.delete(localId);
    persistedRef.current.delete(localId);
    itemsRef.current = itemsRef.current.filter((i) => i.localId !== localId);
    setItems((prev) => prev.filter((i) => i.localId !== localId));
  };

  // Leaving mid-burst: free blobs of items that never saved.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const item of itemsRef.current) {
        URL.revokeObjectURL(item.previewUrl);
        if (item.status !== "saved" && item.storageId) {
          void discardUpload({ storageId: item.storageId }).catch(() => {});
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (institutions === undefined) {
    return (
      <Flex justify="center" py={12}>
        <Spinner color="violet.500" />
      </Flex>
    );
  }

  return (
    <Box maxW="480px" mx="auto" pb={12}>
      {/* Header — on the gray shoulder, matching the rest of School Space. */}
      <HStack mb={4} gap={3}>
        <Button asChild size="sm" variant="ghost" color="charcoal.400">
          <Link
            href={
              isPlatformAdmin
                ? withInstitutionScope(
                    "/school/instructional-materials",
                    requestedInstitution?.slug ??
                      activeInstitution?.institutionSlug ??
                      activeInstitution?.homeInstitutionSlug,
                  )
                : "/school/instructional-materials"
            }
          >
            <ArrowLeft /> Instructional materials
          </Link>
        </Button>
        {savedCount > 0 && (
          <Text fontSize="sm" color="charcoal.400" ml="auto">
            {savedCount} added this session
          </Text>
        )}
      </HStack>

      <Text fontFamily="heading" fontSize="lg" fontWeight="700" color="navy.500">
        Add to inventory
      </Text>
      <Text fontSize="sm" color="charcoal.400" mt={1} mb={4}>
        Snap each item once — the AI drafts the details and saves it. Glance
        down the list and fix only what needs fixing.
      </Text>

      {!isPlatformAdmin && institutions.length > 1 && (
        <Box mb={3}>
          <Text fontSize="xs" fontWeight="600" color="charcoal.500" mb={1}>
            School
          </Text>
          <FieldSelect
            value={institutionId ?? ""}
            onChange={(v) => {
              setPickedInstitution(v as Id<"institutions">);
              // Rooms belong to an institution — a kept selection would fail
              // create's cross-institution check.
              setCurrentRoom("");
            }}
            fieldProps={{ "aria-label": "School" }}
          >
            {institutions.map((i) => (
              <option key={i._id} value={i._id}>
                {i.emoji ? `${i.emoji} ` : ""}
                {i.name}
              </option>
            ))}
          </FieldSelect>
        </Box>
      )}

      <Box mb={4}>
        <Text fontSize="xs" fontWeight="600" color="charcoal.500" mb={1}>
          Room — applied to each item as you snap it
        </Text>
        <FieldSelect
          value={currentRoom}
          onChange={setCurrentRoom}
          fieldProps={{ "aria-label": "Room" }}
        >
          <option value="">Elsewhere in the school</option>
          {activeSpaces.map((s) => (
            <option key={s._id} value={s._id}>
              {s.name}
            </option>
          ))}
        </FieldSelect>
      </Box>

      <input
        ref={libraryInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          Array.from(e.target.files ?? []).forEach((f) => enqueue(f));
          e.target.value = "";
        }}
      />

      <Surface p={4}>
        <VStack align="stretch" gap={3}>
          <Button
            size="lg"
            colorPalette="violet"
            onClick={() => setCameraOpen(true)}
            w="full"
            disabled={!institutionId}
          >
            <Camera /> Snap items
          </Button>
          <Button
            size="sm"
            variant="ghost"
            color="charcoal.400"
            fontFamily="heading"
            onClick={() => libraryInputRef.current?.click()}
            disabled={!institutionId}
          >
            Choose existing photos
          </Button>

          {items.length > 0 && (
            <VStack align="stretch" gap={0} mt={1}>
              {items.map((item, idx) => (
                <ItemCard
                  key={item.localId}
                  item={item}
                  isFirst={idx === 0}
                  onEdit={editField}
                  onBlur={blurField}
                  onRetry={retry}
                  onRemove={removeCard}
                />
              ))}
            </VStack>
          )}

          <Text fontSize="2xs" color="charcoal.400" textAlign="center">
            New items start hidden from the tutor — flip “Tutor may suggest” in
            Instructional materials when it’s ready.
          </Text>
        </VStack>
      </Surface>

      <CameraCaptureDialog
        open={cameraOpen}
        onClose={() => setCameraOpen(false)}
        onCapture={(file) => enqueue(file)}
        overlayPosition="fixed"
        multiShot
        capturedCount={items.length}
        initialFacing="environment"
      />
    </Box>
  );
}

function ItemCard({
  item,
  isFirst,
  onEdit,
  onBlur,
  onRetry,
  onRemove,
}: {
  item: QueueItem;
  isFirst: boolean;
  onEdit: (localId: string, key: FieldKey, value: string) => void;
  onBlur: (localId: string, key: FieldKey) => void;
  onRetry: (localId: string) => void;
  onRemove: (localId: string) => void;
}) {
  const inFlight = item.status === "uploading" || item.status === "identifying";
  return (
    <HStack
      align="flex-start"
      gap={3}
      py={3}
      borderTopWidth={isFirst ? "0" : "1px"}
      borderTopColor="gray.100"
    >
      <Image
        src={item.previewUrl}
        alt=""
        w="64px"
        h="64px"
        flexShrink={0}
        objectFit="cover"
        borderRadius="md"
        borderWidth="1px"
        borderColor="gray.200"
      />
      <VStack align="stretch" gap={2} flex={1} minW={0}>
        <Input
          size="sm"
          value={item.fields.name}
          placeholder={inFlight ? "Identifying…" : "Name this item"}
          onChange={(e) => onEdit(item.localId, "name", e.target.value)}
          onBlur={() => onBlur(item.localId, "name")}
        />
        <HStack gap={2}>
          <Input
            size="sm"
            flex={1}
            minW={0}
            value={item.fields.category}
            placeholder="Category"
            onChange={(e) => onEdit(item.localId, "category", e.target.value)}
            onBlur={() => onBlur(item.localId, "category")}
          />
          <Input
            size="sm"
            flex={1}
            minW={0}
            value={item.fields.quantity}
            placeholder="Quantity"
            onChange={(e) => onEdit(item.localId, "quantity", e.target.value)}
            onBlur={() => onBlur(item.localId, "quantity")}
          />
        </HStack>
        {inFlight && (
          <HStack gap={2} color="charcoal.400">
            <Spinner size="xs" />
            <Text fontSize="xs">Identifying…</Text>
          </HStack>
        )}
        {item.status === "needs-name" && (
          <Text fontSize="xs" color="orange.500" fontWeight="600">
            Needs a name
          </Text>
        )}
        {item.status === "failed" && (
          <HStack gap={2}>
            <Text fontSize="xs" color="red.500" flex={1} minW={0}>
              {item.error ?? "Couldn’t save"}
            </Text>
            <Button
              size="xs"
              variant="subtle"
              fontFamily="heading"
              onClick={() => onRetry(item.localId)}
            >
              Retry
            </Button>
          </HStack>
        )}
      </VStack>
      <IconButton
        aria-label="Remove item"
        size="xs"
        variant="ghost"
        color="charcoal.400"
        onClick={() => onRemove(item.localId)}
      >
        <X />
      </IconButton>
    </HStack>
  );
}

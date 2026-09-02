import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  AppState,
} from "react-native";
import * as ImagePicker from "expo-image-picker";
import * as SecureStore from "expo-secure-store";
import { getInfoAsync } from "expo-file-system/legacy";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import * as VideoThumbnails from "expo-video-thumbnails";
import { LinearGradient } from "expo-linear-gradient";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useMutation, useQuery, type ReactMutation } from "convex/react";

import { api } from "@/lib/convex";
import type { Id } from "@/lib/convex";
import { uploadFileUri } from "@/lib/uploadImage";
import { useCaptureStation } from "@/hooks/useCaptureStation";
import type { CaptureStationSource } from "@/hooks/useCaptureStation";
import { formatCaptureStationExpiryShort } from "@/lib/captureStationAssignment";
import {
  CAPTURE_STATION_PENDING_UPLOAD_KEY,
  captureErrorKind,
  captureStationTeamKey,
  pendingUploadCannotRetry,
  restoreTeamSelection,
  toggleRosterSelection,
} from "@/lib/captureStationState";
import { CaptureStationScholarPicker } from "@/components/CaptureStationScholarPicker";
import {
  CaptureStationGallery,
  type PendingCaptureTile,
} from "@/components/CaptureStationGallery";
import { CaptureStationExitDialog } from "@/components/CaptureStationExitDialog";
import { CaptureStationCaptureEditor } from "@/components/CaptureStationCaptureEditor";
import { GlassBar } from "@/components/Glass";
import { readManagedSerial } from "@/lib/managedClaim";
import { rabbitholeWebUrl } from "@/lib/webEmbedConfig";
import { fonts, palette } from "@/theme";

const PHOTO_MAX_BYTES = 15 * 1024 * 1024;
const VIDEO_MAX_BYTES = 100 * 1024 * 1024;

type PendingCapture = {
  reservationId: Id<"captureStationUploadReservations">;
  storageId: Id<"_storage">;
  scholarIds: Id<"users">[];
  mimeType: string;
  sizeBytes: number;
  videoDurationMs?: number;
  // The poster's OWN upload reservation. A record written by an older build
  // carries a raw `videoThumbStorageId` instead, which the server no longer
  // accepts; it simply reads as "no poster" here rather than failing recovery.
  posterReservationId?: Id<"captureStationUploadReservations">;
  sessionToken?: string;
  deviceId?: string;
};

async function clearPendingCapture(
  reservationId: Id<"captureStationUploadReservations">,
) {
  const current = await SecureStore.getItemAsync(
    CAPTURE_STATION_PENDING_UPLOAD_KEY,
  );
  if (!current) return;
  try {
    const parsed = JSON.parse(current) as PendingCapture;
    if (parsed.reservationId !== reservationId) return;
  } catch {
    return;
  }
  await SecureStore.deleteItemAsync(CAPTURE_STATION_PENDING_UPLOAD_KEY);
}

/**
 * Reserve → upload → report a video poster, returning the poster's own upload
 * reservation id (what `registerCapture` binds the still to). Undefined means
 * "no usable poster" — the capture never waits on one, and an unreported or
 * unclaimed poster reservation is swept by the server's cleanup.
 *
 * Module scope, not inline in `upload()`: the component is on the React
 * Compiler ratchet, which bails on value blocks inside a try/catch.
 */
async function uploadVideoPoster(
  posterUri: string,
  capability: { sessionToken: string; deviceId: string },
  generatePosterUploadUrl: ReactMutation<
    typeof api.captureStations.generatePosterUploadUrl
  >,
  recordUploadedBlob: ReactMutation<
    typeof api.captureStations.recordUploadedBlob
  >,
): Promise<Id<"captureStationUploadReservations"> | undefined> {
  // Size it first: a reservation we can't finish is metered debt for nothing.
  const info = await getInfoAsync(posterUri);
  if (!info.exists) return undefined;
  if (!("size" in info)) return undefined;
  const reservation = await generatePosterUploadUrl(capability);
  const storageId = await uploadFileUri(
    reservation.uploadUrl,
    posterUri,
    "image/jpeg",
  );
  const recorded = await recordUploadedBlob({
    ...capability,
    reservationId: reservation.reservationId,
    storageId,
    mimeType: "image/jpeg",
    sizeBytes: info.size,
  });
  if (!recorded.accepted) return undefined;
  return reservation.reservationId;
}

/** Quota error kinds that are resolved by refreshing the capture session. */
function isQuotaExceededErrorKind(kind: string | null): boolean {
  return (
    kind === "upload_url_quota" ||
    kind === "capture_count_quota" ||
    kind === "capture_storage_quota"
  );
}

export function CaptureStationScreen({
  source = { kind: "static" },
}: {
  source?: CaptureStationSource;
}) {
  const sourceKind = source.kind;
  const assignedCaptureStationId =
    source.kind === "assigned" ? source.assignment.captureStationId : null;
  const assignedExpiresAt =
    source.kind === "assigned" ? source.assignment.expiresAt : null;
  const assignedUpdatedAt =
    source.kind === "assigned" ? source.assignment.updatedAt : null;
  const stableSource = useMemo<CaptureStationSource>(() => {
    if (
      sourceKind !== "assigned" ||
      assignedCaptureStationId === null ||
      assignedExpiresAt === null ||
      assignedUpdatedAt === null
    ) {
      return { kind: "static" };
    }
    return {
      kind: "assigned",
      assignment: {
        captureStationId: assignedCaptureStationId,
        expiresAt: assignedExpiresAt,
        updatedAt: assignedUpdatedAt,
      },
    };
  }, [assignedCaptureStationId, assignedExpiresAt, assignedUpdatedAt, sourceKind]);

  const {
    sessionToken,
    deviceId,
    bootstrap,
    error,
    expiresAt,
    isTemporary,
    refreshSession,
  } = useCaptureStation(stableSource);
  const generateUploadUrl = useMutation(api.captureStations.generateUploadUrl);
  const recordUploadedBlob = useMutation(api.captureStations.recordUploadedBlob);
  const registerCapture = useMutation(api.captureStations.registerCapture);
  const generatePosterUploadUrl = useMutation(
    api.captureStations.generatePosterUploadUrl,
  );
  const updateCaptureScholars = useMutation(
    api.captureStations.updateCaptureScholars,
  );
  const setCaptureLabel = useMutation(api.captureStations.setCaptureLabel);
  const deleteCapture = useMutation(api.captureStations.deleteCapture);
  const recentCaptures = useQuery(
    api.captureStations.listRecentCaptures,
    sessionToken && deviceId ? { sessionToken, deviceId } : "skip",
  );

  const [uploading, setUploading] = useState(false);
  const [pendingRecovery, setPendingRecovery] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastCaptureId, setLastCaptureId] =
    useState<Id<"captureStationCaptures"> | null>(null);
  const [recoveryAttempt, setRecoveryAttempt] = useState(0);
  const recoveryTokenRef = useRef<string | null>(null);
  // Mirrors `uploading` for the AppState listener (registered once), so a
  // foreground recovery nudge never races an in-flight upload.
  const uploadingRef = useRef(false);
  useEffect(() => {
    uploadingRef.current = uploading;
  }, [uploading]);
  // `uploading` only flips once `upload()` starts, well after the picker and
  // poster generation, so the disabled state can't be the concurrency guard:
  // two taps would clobber the single pending tile and each other's spinner.
  const takingRef = useRef(false);
  // The station "team" persists across captures AND app backgrounding so a
  // station used repeatedly by one team doesn't need re-picking every time.
  const [team, setTeam] = useState<Id<"users">[]>([]);
  const [exitVisible, setExitVisible] = useState(false);
  const [editingCaptureId, setEditingCaptureId] =
    useState<Id<"captureStationCaptures"> | null>(null);
  const [pendingTile, setPendingTile] = useState<PendingCaptureTile | null>(
    null,
  );
  const rosterIdsKey = useMemo(
    () => bootstrap?.roster.map((scholar) => scholar.id).join(",") ?? "",
    [bootstrap],
  );

  const serialNumber = readManagedSerial();
  const deviceSettingsUrl = bootstrap?.deviceSettingsPath
    ? rabbitholeWebUrl(bootstrap.deviceSettingsPath)
    : null;
  const qrCodeUrl = deviceSettingsUrl ? `${deviceSettingsUrl}/qr` : null;
  // Four-finger long-press opens the same teacher exit dialog as the header
  // Exit button (mirrors the ASAM parent gate).
  const fourFingerExit = useMemo(
    () =>
      Gesture.LongPress()
        .numberOfPointers(4)
        .minDuration(2500)
        .maxDistance(28)
        .onStart(() => runOnJS(setExitVisible)(true)),
    [],
  );

  useEffect(() => {
    if (!deviceId || !rosterIdsKey) return;
    let cancelled = false;
    void (async () => {
      const stored = await SecureStore.getItemAsync(
        captureStationTeamKey(deviceId),
      );
      const storedIds: string[] = stored ? JSON.parse(stored) : [];
      const rosterIds = rosterIdsKey.split(",");
      const restored = restoreTeamSelection(storedIds, rosterIds);
      if (cancelled) return;
      setTeam(restored as Id<"users">[]);
      if (restored.length !== storedIds.length) {
        await SecureStore.setItemAsync(
          captureStationTeamKey(deviceId),
          JSON.stringify(restored),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [deviceId, rosterIdsKey]);

  const toggleTeamMember = (scholarId: Id<"users">) => {
    setTeam((current) => {
      const next = toggleRosterSelection(current, scholarId) as Id<"users">[];
      if (deviceId) {
        void SecureStore.setItemAsync(
          captureStationTeamKey(deviceId),
          JSON.stringify(next),
        );
      }
      return next;
    });
  };

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "background") {
        setLastCaptureId(null);
        setSubmitError(null);
      } else if (state === "active" && !uploadingRef.current) {
        // A capture interrupted by backgrounding durably saves its pending
        // upload but its promise may never reach the catch that re-arms
        // recovery. A preserved assigned session keeps the same token on
        // foreground, so the token-gated recovery effect won't re-run on its
        // own — nudge it to re-check SecureStore and finish the stranded
        // upload (idempotent; guarded to not collide with an active upload).
        void SecureStore.getItemAsync(CAPTURE_STATION_PENDING_UPLOAD_KEY).then(
          (stored) => {
            if (stored) {
              recoveryTokenRef.current = null;
              setRecoveryAttempt((attempt) => attempt + 1);
            }
          },
        );
      }
    });
    return () => subscription.remove();
  }, []);

  // Brief affirmation only — the durable "what's been captured" view is the
  // gallery, which also opens the per-capture editor (re-tag / delete).
  useEffect(() => {
    if (!lastCaptureId) return;
    const timer = setTimeout(() => setLastCaptureId(null), 4_000);
    return () => clearTimeout(timer);
  }, [lastCaptureId]);

  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    if (
      !sessionToken ||
      !deviceId ||
      bootstrap === undefined ||
      recoveryTokenRef.current === sessionToken
    ) {
      return;
    }
    recoveryTokenRef.current = sessionToken;
    void (async () => {
      const stored = await SecureStore.getItemAsync(
        CAPTURE_STATION_PENDING_UPLOAD_KEY,
      );
      if (!stored) {
        if (!cancelled) setPendingRecovery(false);
        return;
      }
      const pending = JSON.parse(stored) as PendingCapture;
      const recoverySessionToken = pending.sessionToken ?? sessionToken;
      const recoveryDeviceId = pending.deviceId ?? deviceId;
      const recorded = await recordUploadedBlob({
        sessionToken: recoverySessionToken,
        deviceId: recoveryDeviceId,
        reservationId: pending.reservationId,
        storageId: pending.storageId,
        mimeType: pending.mimeType,
        sizeBytes: pending.sizeBytes,
      });
      if (!recorded.accepted) {
        await clearPendingCapture(pending.reservationId);
        if (!cancelled) setPendingRecovery(false);
        return;
      }
      const result = await registerCapture({
        sessionToken: recoverySessionToken,
        deviceId: recoveryDeviceId,
        reservationId: pending.reservationId,
        scholarIds: pending.scholarIds,
        videoDurationMs: pending.videoDurationMs,
        posterReservationId: pending.posterReservationId,
      });
      await clearPendingCapture(pending.reservationId);
      if (cancelled) return;
      setPendingRecovery(false);
      setLastCaptureId(result.captureId);
      setSubmitError(null);
    })().catch(async (recoveryError) => {
      if (pendingUploadCannotRetry(recoveryError)) {
        await SecureStore.deleteItemAsync(CAPTURE_STATION_PENDING_UPLOAD_KEY);
        if (cancelled) return;
        setPendingRecovery(false);
        setSubmitError(
          "A previous upload could not be recovered. You can keep capturing.",
        );
        return;
      }
      if (cancelled) return;
      recoveryTokenRef.current = null;
      setSubmitError(
        "A previous upload still needs attention. Keep this iPad online or ask a teacher.",
      );
      retryTimer = setTimeout(
        () => setRecoveryAttempt((attempt) => attempt + 1),
        5_000,
      );
    });
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [
    bootstrap,
    deviceId,
    recoveryAttempt,
    recordUploadedBlob,
    registerCapture,
    sessionToken,
  ]);

  const upload = async (
    mediaUri: string,
    mimeType: string,
    sizeBytes: number,
    scholarIds: Id<"users">[],
    video?: { durationMs?: number; posterUri?: string },
  ) => {
    if (!sessionToken || !deviceId) {
      setSubmitError("Capture mode has expired. Reopen the station.");
      setPendingTile(null);
      return;
    }
    setUploading(true);
    setSubmitError(null);
    let pendingSaved = false;
    const videoPosterUri = video?.posterUri;
    const videoDurationMs = video?.durationMs;
    try {
      const reservation = await generateUploadUrl({ sessionToken, deviceId });
      const storageId = await uploadFileUri(
        reservation.uploadUrl,
        mediaUri,
        mimeType,
      );
      let posterReservationId:
        | Id<"captureStationUploadReservations">
        | undefined;
      if (videoPosterUri) {
        try {
          posterReservationId = await uploadVideoPoster(
            videoPosterUri,
            { sessionToken, deviceId },
            generatePosterUploadUrl,
            recordUploadedBlob,
          );
        } catch {
          // A poster is optional; never let it block the real capture. An
          // unclaimed poster reservation is swept by the server's cleanup.
        }
      }
      const pending: PendingCapture = {
        reservationId: reservation.reservationId,
        storageId,
        scholarIds,
        mimeType,
        sizeBytes,
        videoDurationMs,
        posterReservationId,
        sessionToken,
        deviceId,
      };
      await SecureStore.setItemAsync(
        CAPTURE_STATION_PENDING_UPLOAD_KEY,
        JSON.stringify(pending),
      );
      pendingSaved = true;
      setPendingRecovery(true);
      const recorded = await recordUploadedBlob({
        sessionToken,
        deviceId,
        reservationId: reservation.reservationId,
        storageId,
        mimeType,
        sizeBytes,
      });
      if (!recorded.accepted) {
        await clearPendingCapture(reservation.reservationId);
        setPendingRecovery(false);
        setSubmitError(
          "That file is too large or is not a supported photo or video.",
        );
        setPendingTile(null);
        setUploading(false);
        return;
      }
      const result = await registerCapture({
        sessionToken,
        deviceId,
        reservationId: reservation.reservationId,
        scholarIds,
        videoDurationMs,
        posterReservationId,
      });
      await clearPendingCapture(reservation.reservationId);
      setPendingRecovery(false);
      setLastCaptureId(result.captureId);
    } catch (uploadError) {
      if (pendingSaved) {
        if (pendingUploadCannotRetry(uploadError)) {
          await SecureStore.deleteItemAsync(CAPTURE_STATION_PENDING_UPLOAD_KEY);
          setPendingRecovery(false);
        } else {
          recoveryTokenRef.current = null;
          setRecoveryAttempt((attempt) => attempt + 1);
          setSubmitError(
            "The upload is saved on this iPad and will retry automatically.",
          );
          setPendingTile(null);
          setUploading(false);
          return;
        }
      }
      const kind = captureErrorKind(uploadError);
      if (isQuotaExceededErrorKind(kind)) {
        try {
          await refreshSession();
          setSubmitError("Capture session refreshed. Take that photo again.");
        } catch {
          setSubmitError("Couldn’t refresh capture mode. Ask a teacher.");
        }
      } else {
        setSubmitError(
          "Couldn’t upload that capture. Check the connection and try again.",
        );
      }
    }
    setPendingTile(null);
    setUploading(false);
  };

  const runCapture = async (kind: "image" | "video") => {
    if (pendingRecovery) {
      setSubmitError("Finish recovering the previous capture first.");
      return;
    }
    if (!team.length) {
      setSubmitError("Tap who’s at this station first.");
      return;
    }
    setSubmitError(null);
    setLastCaptureId(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Camera access needed",
        "Turn on Camera access for Rabbithole in Settings.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: [kind === "video" ? "videos" : "images"],
      quality: 0.8,
      videoQuality: ImagePicker.UIImagePickerControllerQualityType.Medium,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const fileInfo = asset.fileSize ? null : await getInfoAsync(asset.uri);
    const sizeBytes =
      asset.fileSize ??
      (fileInfo?.exists && "size" in fileInfo ? fileInfo.size : null);
    if (sizeBytes === null) {
      setSubmitError("Couldn’t read that capture. Try again.");
      return;
    }
    const maxBytes = kind === "video" ? VIDEO_MAX_BYTES : PHOTO_MAX_BYTES;
    if (sizeBytes > maxBytes) {
      Alert.alert(
        kind === "video" ? "Video is too large" : "Photo is too large",
        kind === "video"
          ? "Choose a video under 100 MB. There is no time limit, but longer videos may need to be trimmed or recorded at a lower quality."
          : "Choose a photo under 15 MB.",
      );
      return;
    }
    const mimeType =
      asset.mimeType ?? (kind === "video" ? "video/quicktime" : "image/jpeg");
    // Show the spinner tile before poster generation — that's exactly when
    // it's slow. The gallery already renders an empty uri as a glyph tile.
    setPendingTile({
      uri: kind === "image" ? asset.uri : "",
      mediaType: kind,
    });
    let posterUri: string | undefined;
    let durationMs: number | undefined;
    if (kind === "video") {
      durationMs =
        typeof asset.duration === "number" ? asset.duration : undefined;
      try {
        const poster = await VideoThumbnails.getThumbnailAsync(asset.uri, {
          time: 0,
          quality: 0.7,
        });
        posterUri = poster.uri;
        setPendingTile({ uri: poster.uri, mediaType: kind });
      } catch {
        // A poster is optional; the tile falls back to a video glyph.
      }
    }
    await upload(asset.uri, mimeType, sizeBytes, team, {
      durationMs,
      posterUri,
    });
  };

  const take = async (kind: "image" | "video") => {
    if (takingRef.current) return;
    takingRef.current = true;
    // `.finally()` rather than try/finally: a try without a catch is a
    // React Compiler bailout, and this file is on the compiler ratchet.
    await runCapture(kind).finally(() => {
      takingRef.current = false;
    });
  };

  const editingCapture =
    recentCaptures?.find((c) => c.captureId === editingCaptureId) ?? null;

  if (error) return <StationMessage title="Capture station" message={error} />;
  if (!sessionToken || !deviceId || bootstrap === undefined) {
    return (
      <StationMessage
        title="Starting capture station"
        message="Preparing this iPad…"
      />
    );
  }
  if (bootstrap === null) {
    return (
      <StationMessage
        title="Capture session expired"
        message="Close and reopen Rabbithole, then ask a teacher if this continues."
      />
    );
  }

  const captureDisabled = pendingRecovery || uploading || team.length === 0;

  return (
    <GestureDetector gesture={fourFingerExit}>
      <LinearGradient
        colors={[palette.navy[500], palette.navy[700], palette.charcoal[500]]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.fill}
      >
        <View style={styles.topBar}>
          <View style={styles.topBarSide} />
          <View style={styles.topBarCenter}>
            <Text style={styles.topTitle}>{bootstrap.groupName} Capture</Text>
            {isTemporary && expiresAt && (
              <Text style={styles.topSubhead}>
                {formatCaptureStationExpiryShort(expiresAt)}
              </Text>
            )}
          </View>
          <View style={[styles.topBarSide, styles.topBarSideEnd]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Exit capture mode"
              onPress={() => setExitVisible(true)}
              style={({ pressed }) => [
                styles.exitButton,
                pressed && styles.exitButtonPressed,
              ]}
            >
              <SymbolView
                name="rectangle.portrait.and.arrow.right"
                size={16}
                tintColor="rgba(255,255,255,0.92)"
              />
              <Text style={styles.exitButtonText}>Exit</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.split}>
          <View style={styles.paneLeft}>
            <Text style={styles.paneLabel}>Who&rsquo;s at this station</Text>
            <ScrollView
              style={styles.teamScroll}
              contentContainerStyle={styles.teamScrollContent}
              showsVerticalScrollIndicator={false}
            >
              <CaptureStationScholarPicker
                roster={bootstrap.roster}
                selectedIds={team}
                onToggle={toggleTeamMember}
              />
            </ScrollView>
            <View style={styles.captureBar}>
              <View style={styles.captureActions}>
                <CaptureAction
                  icon="camera.fill"
                  label="Take photo"
                  onPress={() => void take("image")}
                  disabled={captureDisabled}
                />
                <CaptureAction
                  icon="video.fill"
                  label="Record video"
                  onPress={() => void take("video")}
                  disabled={captureDisabled}
                />
              </View>
              {uploading ? (
                <View style={styles.captureStatus}>
                  <ActivityIndicator color={palette.violet[300]} />
                  <Text style={styles.captureStatusText}>Uploading…</Text>
                </View>
              ) : submitError ? (
                <Text style={styles.error}>{submitError}</Text>
              ) : lastCaptureId ? (
                <Text style={styles.savedNotice}>Saved.</Text>
              ) : team.length === 0 ? (
                <Text style={styles.captureHint}>
                  Tap who&rsquo;s at this station to start.
                </Text>
              ) : null}
            </View>
          </View>
          <View style={styles.paneRight}>
            <Text style={styles.paneLabel}>
              {recentCaptures && recentCaptures.length > 0
                ? `Captured · ${recentCaptures.length}`
                : "Captured"}
            </Text>
            {(recentCaptures && recentCaptures.length > 0) || pendingTile ? (
              <ScrollView
                contentContainerStyle={styles.gridScroll}
                showsVerticalScrollIndicator={false}
              >
                <CaptureStationGallery
                  captures={recentCaptures ?? []}
                  pending={pendingTile}
                  onSelect={setEditingCaptureId}
                />
              </ScrollView>
            ) : (
              <View style={styles.emptyGallery}>
                <SymbolView
                  name="photo.on.rectangle"
                  size={40}
                  tintColor="rgba(255,255,255,0.32)"
                />
                <Text style={styles.emptyText}>
                  Photos and videos you take appear here. Tap one to change who
                  it&rsquo;s tagged to, or delete it.
                </Text>
              </View>
            )}
          </View>
        </View>

        <CaptureStationExitDialog
          visible={exitVisible}
          onClose={() => setExitVisible(false)}
          serialNumber={serialNumber}
          deviceSettingsUrl={deviceSettingsUrl}
          qrCodeUrl={qrCodeUrl}
        />
        <CaptureStationCaptureEditor
          key={editingCaptureId ?? "closed"}
          capture={editingCapture}
          roster={bootstrap.roster}
          onClose={() => setEditingCaptureId(null)}
          onSave={(scholarIds) =>
            editingCaptureId
              ? updateCaptureScholars({
                  sessionToken,
                  deviceId,
                  captureId: editingCaptureId,
                  scholarIds,
                }).then(() => undefined)
              : Promise.resolve()
          }
          onSaveLabel={(label) =>
            editingCaptureId
              ? setCaptureLabel({
                  sessionToken,
                  deviceId,
                  captureId: editingCaptureId,
                  label,
                }).then(() => undefined)
              : Promise.resolve()
          }
          onDelete={() =>
            editingCaptureId
              ? deleteCapture({
                  sessionToken,
                  deviceId,
                  captureId: editingCaptureId,
                }).then(() => undefined)
              : Promise.resolve()
          }
        />
      </LinearGradient>
    </GestureDetector>
  );
}

function StationMessage({ title, message }: { title: string; message: string }) {
  return (
    <LinearGradient
      colors={[palette.navy[500], palette.navy[700], palette.charcoal[500]]}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.center}
    >
      <ActivityIndicator color={palette.violet[300]} />
      <Text style={styles.msgTitle}>{title}</Text>
      <Text style={styles.msgBody}>{message}</Text>
    </LinearGradient>
  );
}

function CaptureAction({
  icon,
  label,
  onPress,
  disabled = false,
}: {
  icon: SymbolViewProps["name"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <View style={[styles.captureAction, { opacity: disabled ? 0.45 : 1 }]}>
      <GlassBar
        glassEffectStyle="clear"
        isInteractive
        edge="none"
        style={styles.captureActionGlass}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onPress}
          style={({ pressed }) => [
            styles.captureActionPressable,
            {
              backgroundColor: pressed
                ? "rgba(8,10,28,0.42)"
                : "rgba(8,10,28,0.28)",
            },
          ]}
        >
          <SymbolView name={icon} size={46} tintColor={palette.white} />
        </Pressable>
      </GlassBar>
      <Text style={styles.captureActionLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 28,
    gap: 12,
  },
  msgTitle: {
    fontFamily: fonts.bold,
    fontSize: 26,
    textAlign: "center",
    color: palette.white,
  },
  msgBody: {
    fontFamily: fonts.regular,
    fontSize: 16,
    textAlign: "center",
    color: "rgba(255,255,255,0.7)",
    maxWidth: 440,
  },

  // Full-width iOS-style header spanning both panes.
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 14,
    paddingBottom: 12,
    paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.12)",
  },
  topBarSide: { width: 120, justifyContent: "center" },
  topBarSideEnd: { alignItems: "flex-end" },
  topBarCenter: { flex: 1, alignItems: "center", gap: 1 },
  topTitle: {
    fontFamily: fonts.semibold,
    fontSize: 18,
    letterSpacing: -0.2,
    color: palette.white,
  },
  topSubhead: { fontFamily: fonts.regular, fontSize: 13, color: "rgba(255,255,255,0.6)" },
  exitButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
    backgroundColor: "rgba(255,255,255,0.08)",
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  exitButtonPressed: { backgroundColor: "rgba(255,255,255,0.16)" },
  exitButtonText: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: "rgba(255,255,255,0.92)",
  },

  // Two-pane split.
  split: { flex: 1, flexDirection: "row" },
  paneLeft: {
    width: "40%",
    maxWidth: 470,
    paddingVertical: 22,
    paddingHorizontal: 26,
    borderRightWidth: 1,
    borderRightColor: "rgba(255,255,255,0.12)",
  },
  paneRight: { flex: 1, paddingVertical: 22, paddingHorizontal: 26 },
  paneLabel: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "rgba(255,255,255,0.5)",
    marginBottom: 12,
  },
  teamScroll: { flex: 1 },
  teamScrollContent: { paddingBottom: 12 },
  captureBar: { marginTop: 18, gap: 10 },
  captureActions: { flexDirection: "row", justifyContent: "center", gap: 32 },
  captureAction: { alignItems: "center", gap: 9 },
  captureActionGlass: {
    width: 104,
    height: 104,
    aspectRatio: 1,
    borderRadius: 52,
    overflow: "hidden",
  },
  captureActionPressable: { flex: 1, alignItems: "center", justifyContent: "center" },
  captureActionLabel: {
    fontFamily: fonts.semibold,
    fontSize: 15,
    textAlign: "center",
    color: "rgba(255,255,255,0.92)",
  },
  captureStatus: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  captureStatusText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: "rgba(255,255,255,0.7)",
  },
  savedNotice: {
    fontFamily: fonts.medium,
    fontSize: 14,
    textAlign: "center",
    color: "rgba(255,255,255,0.6)",
  },
  captureHint: {
    fontFamily: fonts.regular,
    fontSize: 14,
    textAlign: "center",
    color: "rgba(255,255,255,0.5)",
  },

  gridScroll: { paddingBottom: 20 },
  emptyGallery: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingBottom: 40,
  },
  emptyText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    textAlign: "center",
    color: "rgba(255,255,255,0.5)",
    maxWidth: 320,
  },
  error: {
    fontFamily: fonts.medium,
    fontSize: 14,
    textAlign: "center",
    color: "#ff8a8a",
  },
});

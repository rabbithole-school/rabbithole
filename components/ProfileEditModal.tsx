"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  ROLES,
  canUsePassword,
  isPasskeyRole,
  type Role,
} from "@/convex/lib/roles";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  Dialog,
  Flex,
  Heading,
  HStack,
  IconButton,
  Input,
  Menu,
  Portal,
  Spinner,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import { Camera, Image as ImageIcon, Key, X } from "@phosphor-icons/react";
import { SetPasswordDialog } from "@/components/SetPasswordDialog";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { GoogleAccountConnect } from "@/components/GoogleAccountConnect";
import { PasskeyManager } from "@/components/PasskeyManager";
import { McpConnections } from "@/components/McpConnections";
import { isClientStaffRole } from "@/hooks/useSchoolOperationsAccess";

const FONT_OPTIONS = [
  { value: "", label: "System Default" },
  { value: "andika", label: "Andika" },
  { value: "opendyslexic", label: "OpenDyslexic" },
];

interface ProfileEditModalProps {
  open: boolean;
  onClose: () => void;
  /** When true, shows "Welcome" heading and "Skip for now" instead of "Cancel" */
  isSetup?: boolean;
  user: {
    _id?: string;
    name?: string;
    username?: string;
    email?: string;
    image?: string;
    dateOfBirth?: string;
    preferredFont?: string;
    role?: string;
  };
}

/**
 * Self-service email row — any user can set/update their own email to turn
 * on passwordless magic-link sign-in. Role-agnostic on purpose: magic-link
 * is capability-based (any account with an email can use it). For scholars
 * it's purely additive — their username + password keeps working.
 */
function AccountEmailRow({ currentEmail }: { currentEmail?: string }) {
  const setMyEmail = useMutation(api.users.setMyEmail);
  const clearMyEmail = useMutation(api.users.clearMyEmail);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(currentEmail ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setMyEmail({ email: value.trim() });
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await clearMyEmail({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Flex gap={3} w="full" align="start">
      <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={2.5}>
        Email
      </Text>
      <VStack align="stretch" gap={1} flex={1}>
        {editing ? (
          <>
            <Input
              type="email"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && save()}
              placeholder="name@example.com"
              bg="gray.50"
              border="1px solid"
              borderColor="gray.300"
              borderRadius="lg"
              fontFamily="body"
              h={10}
              autoFocus
              autoComplete="email"
            />
            {error && (
              <Text fontSize="xs" color="red.500" fontFamily="body">
                {error}
              </Text>
            )}
            <HStack gap={2}>
              <Button size="xs" variant="ghost" fontFamily="heading" color="charcoal.400" onClick={() => { setEditing(false); setError(""); }} disabled={busy}>
                Cancel
              </Button>
              <Button size="xs" bg="violet.500" color="white" _hover={{ bg: "violet.600" }} fontFamily="heading" onClick={save} disabled={busy || !value.trim()} loading={busy}>
                Save
              </Button>
            </HStack>
          </>
        ) : (
          <>
          <HStack gap={2}>
            <Text fontFamily="body" fontSize="sm" color={currentEmail ? "charcoal.500" : "charcoal.300"}>
              {currentEmail ?? "none"}
            </Text>
            <Button
              size="2xs"
              variant="outline"
              fontFamily="heading"
              disabled={busy}
              onClick={() => { setValue(currentEmail ?? ""); setEditing(true); setError(""); }}
            >
              {currentEmail ? "Edit" : "Add"}
            </Button>
            {currentEmail && (
              <Button
                size="2xs"
                variant="ghost"
                color="charcoal.400"
                _hover={{ color: "red.500" }}
                fontFamily="heading"
                disabled={busy}
                onClick={remove}
              >
                Remove
              </Button>
            )}
            {saved && (
              <Text fontFamily="heading" fontSize="xs" color="green.500">
                Saved
              </Text>
            )}
          </HStack>
          {error && (
            <Text fontSize="xs" color="red.500" fontFamily="body">
              {error}
            </Text>
          )}
          </>
        )}
        <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
          Set an email to sign in with a one-time link instead of your password.
        </Text>
      </VStack>
    </Flex>
  );
}

export function ProfileEditModal({ open, onClose, isSetup, user }: ProfileEditModalProps) {
  const updateProfile = useMutation(api.users.updateProfile);
  const updatePreferredFont = useMutation(api.users.updatePreferredFont);
  const generateUploadUrl = useMutation(api.files.generateUploadUrl);

  const [name, setName] = useState("");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [preferredFont, setPreferredFont] = useState("");
  const [avatarPreview, setAvatarPreview] = useState<string | undefined>();
  const [pendingStorageId, setPendingStorageId] = useState<Id<"_storage"> | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showCamera, setShowCamera] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const initialized = useRef(false);

  const isScholar = user.role === ROLES.SCHOLAR;
  const role = user.role as Role | undefined;

  // Every staff role can link their own Google account (mirrors the server
  // gate on googleAccountsActions.beginOAuth). Narrowing this to teachers
  // left operations staff and curriculum designers with no way to connect at all.
  const showGoogleRow = isClientStaffRole(user.role);

  // Connect Claude is a staff surface. The MCP server scopes what each role
  // actually gets (see TOOLS_BY_ROLE in convex/lib/scholarReadPolicy.ts —
  // an operations staffer gets the roster lookup only, with readingLevel redacted).
  const showMcpRow = isClientStaffRole(user.role);

  // Is a passkey a REPLACEMENT for this account's password, or an addition
  // to it? For PASSKEY_ROLES, `blockPasswordIfPasskeyEnrolled` refuses
  // password login once one is enrolled; for everyone else the password
  // keeps working, which is what lets a scholar's passkey be safely opt-in.
  const passwordlessPrimary = isPasskeyRole(role);

  // Only offer "Change Password" while the password can still be used to
  // sign in — mirroring that server rule exactly rather than approximating
  // it by role, so nobody is offered a password they'd be blocked from
  // using, and nobody who still needs one loses the way to set it.
  // The passkey list only changes the answer for passwordless-primary
  // roles, so everyone else renders immediately instead of waiting on it.
  //
  // Suppressed entirely while impersonating: `user` here is the TARGET but
  // `listMine` deliberately resolves the REAL session owner, so combining
  // them would judge one account's password by another's passkeys. Writes
  // are blocked under an overlay anyway (assertNotImpersonating), so the
  // button has nothing to offer a viewer.
  const myPasskeys = useQuery(api.passkeys.listMine);
  const impersonation = useQuery(api.impersonation.myImpersonation);
  const passwordStillWorks =
    impersonation === null &&
    (!passwordlessPrimary ||
      (myPasskeys !== undefined && canUsePassword(role, myPasskeys.length > 0)));

  // Populate form from user data when modal opens
  useEffect(() => {
    if (open && !initialized.current) {
      initialized.current = true;
      setName(user.name ?? "");
      setDateOfBirth(user.dateOfBirth ?? "");
      setPreferredFont(user.preferredFont ?? "");
      setAvatarPreview(user.image ?? undefined);
    }
    if (!open) {
      initialized.current = false;
    }
  }, [open, user, isSetup]);

  const uploadFile = useCallback(
    async (file: File) => {
      setIsUploading(true);
      try {
        const localUrl = URL.createObjectURL(file);
        setAvatarPreview(localUrl);
        const uploadUrl = await generateUploadUrl();
        const res = await fetch(uploadUrl, {
          method: "POST",
          headers: { "Content-Type": file.type },
          body: file,
        });
        const { storageId } = await res.json();
        setPendingStorageId(storageId as Id<"_storage">);
      } catch (err) {
        console.error("Profile photo upload failed:", err);
        setCameraError(true);
      } finally {
        setIsUploading(false);
      }
    },
    [generateUploadUrl]
  );

  const handleAvatarUpload = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset so re-selecting the same file fires onChange again
      e.target.value = "";
      if (file) await uploadFile(file);
    },
    [uploadFile]
  );

  const closeCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setShowCamera(false);
  }, []);

  const openCamera = useCallback(async () => {
    setCameraError(false);
    setShowCamera(true);
    try {
      // Front camera ("user") is the natural choice for a profile selfie.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        // Some browsers need an explicit play() before frames flow.
        void videoRef.current.play().catch(() => {});
      }
    } catch {
      // Permission denied / no camera — surface a fallback to the file picker.
      setShowCamera(false);
      setCameraError(true);
    }
  }, []);

  const capturePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      setCameraError(true);
      return;
    }

    // A real webcam doesn't deliver its first frame instantly. If the shutter is
    // tapped before the stream is ready, video.videoWidth is 0 and we'd capture a
    // blank 0x0 image. Wait (up to ~3s) for a real frame before grabbing it.
    if (video.videoWidth === 0 || video.videoHeight === 0) {
      const ready = await new Promise<boolean>((resolve) => {
        const start = Date.now();
        const check = () => {
          if (video.videoWidth > 0 && video.videoHeight > 0) return resolve(true);
          if (Date.now() - start > 3000) return resolve(false);
          requestAnimationFrame(check);
        };
        check();
      });
      if (!ready) {
        closeCamera();
        setCameraError(true);
        return;
      }
    }

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")!.drawImage(video, 0, 0);
    closeCamera();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92)
    );
    if (!blob) {
      setCameraError(true);
      return;
    }
    const file = new File([blob], `profile-${Date.now()}.jpg`, { type: "image/jpeg" });
    await uploadFile(file);
  }, [closeCamera, uploadFile]);

  // Stop the live camera stream when the modal closes (external cleanup only —
  // the overlay itself is gated on `open` below, so no state reset is needed here).
  useEffect(() => {
    if (open) return;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, [open]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaved(false);
    try {
      const args: {
        name?: string;
        dateOfBirth?: string;
        imageStorageId?: Id<"_storage">;
        profileSetupComplete?: boolean;
      } = {};
      if (name) args.name = name;
      if (dateOfBirth) args.dateOfBirth = dateOfBirth;
      if (pendingStorageId) args.imageStorageId = pendingStorageId;
      if (isSetup) args.profileSetupComplete = true;

      await updateProfile(args);
      if (isScholar) {
        await updatePreferredFont({ preferredFont: preferredFont || null });
      }
      setPendingStorageId(null);
      if (isSetup) {
        onClose();
        return;
      }
      setSaved(true);
      setTimeout(() => {
        setSaved(false);
        onClose();
      }, 800);
    } catch (err) {
      console.error("Save failed:", err);
    } finally {
      setIsSaving(false);
    }
  }, [updateProfile, updatePreferredFont, name, dateOfBirth, preferredFont, pendingStorageId, isScholar, isSetup, onClose]);

  const handleSkipOrCancel = useCallback(async () => {
    if (isSetup) {
      await updateProfile({ profileSetupComplete: true });
    }
    onClose();
  }, [isSetup, updateProfile, onClose]);

  return (
    <Dialog.Root
      open={open}
      // View-as is read-only. Keep its global exit banner interactive even if
      // this dialog was opened from the account menu.
      modal={impersonation === null}
      onOpenChange={(e) => {
        // While the camera overlay is up, its <video> grabs focus, which the
        // dialog would otherwise treat as an outside interaction and close on.
        // Ignore close requests until the camera is dismissed.
        if (!e.open && showCamera) return;
        // Only allow closing via our buttons in setup mode
        if (!e.open && !isSetup) onClose();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="lg">
            <Dialog.Header px={6} pt={6} pb={0}>
              <HStack gap={4} w="full">
                {/* Avatar upload — choose between live camera capture and a file */}
                <Menu.Root positioning={{ placement: "bottom-start" }}>
                  <Menu.Trigger asChild>
                    <Box position="relative" cursor="pointer" flexShrink={0}>
                      <Avatar size="lg" name={name || user.name} src={avatarPreview} colorKey={user._id} />
                      <Box
                        position="absolute"
                        bottom={0}
                        right={0}
                        bg="violet.500"
                        borderRadius="full"
                        w={6}
                        h={6}
                        display="flex"
                        alignItems="center"
                        justifyContent="center"
                        border="2px solid white"
                      >
                        {isUploading ? (
                          <Spinner size="xs" color="white" />
                        ) : (
                          <Camera size={12} color="white" />
                        )}
                      </Box>
                    </Box>
                  </Menu.Trigger>
                  <Portal>
                    <Menu.Positioner>
                      <Menu.Content>
                        <Menu.Item value="camera" cursor="pointer" onClick={openCamera}>
                          <Camera style={{ marginRight: "8px" }} />
                          Take Photo
                        </Menu.Item>
                        <Menu.Item value="file" cursor="pointer" onClick={() => fileRef.current?.click()}>
                          <ImageIcon style={{ marginRight: "8px" }} />
                          Choose Photo
                        </Menu.Item>
                      </Menu.Content>
                    </Menu.Positioner>
                  </Portal>
                </Menu.Root>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  style={{ display: "none" }}
                  onChange={handleAvatarUpload}
                />
                <VStack gap={0} align="start">
                  <Dialog.Title asChild>
                    <Heading
                      size="lg"
                      fontFamily="heading"
                      color="navy.500"
                      fontWeight="600"
                    >
                      {isSetup ? "Welcome! Set up your profile" : "Account details"}
                    </Heading>
                  </Dialog.Title>
                  {!isSetup && user.role && (
                    <Text
                      fontSize="xs"
                      fontFamily="heading"
                      fontWeight="600"
                      color="charcoal.400"
                      textTransform="capitalize"
                    >
                      {user.role.replace(/_/g, " ")}
                    </Text>
                  )}
                </VStack>
              </HStack>
            </Dialog.Header>

            <Dialog.Body px={6} py={5}>
              <VStack gap={4} w="full">
                {cameraError && (
                  <Text fontSize="xs" color="red.500" fontFamily="heading" w="full">
                    The camera didn&apos;t work. Check camera permissions, or use
                    &ldquo;Choose Photo&rdquo; to pick an image instead.
                  </Text>
                )}
                {/* Label-left, input-right rows */}
                <Flex gap={3} w="full" align="center">
                  <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0}>
                    Name{isSetup && <Text as="span" color="red.500"> *</Text>}
                  </Text>
                  <Input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    bg="gray.50"
                    border="1px solid"
                    borderColor="gray.300"
                    borderRadius="lg"
                    fontFamily="body"
                    h={10}
                    _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
                    _focusVisible={{ boxShadow: "none", outline: "none" }}
                  />
                </Flex>

                <Flex gap={3} w="full" align="center">
                  <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0}>
                    Username
                  </Text>
                  <Input
                    value={user.username ?? ""}
                    readOnly
                    bg="gray.100"
                    border="1px solid"
                    borderColor="gray.200"
                    borderRadius="lg"
                    fontFamily="body"
                    h={10}
                    color="charcoal.400"
                    cursor="not-allowed"
                  />
                </Flex>

                <Flex gap={3} w="full" align="start">
                  <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={2.5}>
                    Date of Birth
                  </Text>
                  <VStack gap={1} align="stretch" flex={1}>
                    <Input
                      type="date"
                      value={dateOfBirth}
                      onChange={(e) => setDateOfBirth(e.target.value)}
                      bg="gray.50"
                      border="1px solid"
                      borderColor="gray.300"
                      borderRadius="lg"
                      fontFamily="body"
                      h={10}
                      _focus={{ borderColor: "violet.400", boxShadow: "none", outline: "none" }}
                      _focusVisible={{ boxShadow: "none", outline: "none" }}
                    />
                    <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
                      Helps us match you to the right reading level.
                    </Text>
                  </VStack>
                </Flex>

                {showGoogleRow && (
                  <Flex gap={3} w="full" align="start">
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={1.5}>
                      Linked Accounts
                    </Text>
                    <VStack gap={1} align="start" flex={1}>
                      <GoogleAccountConnect compact hideLabel textSize="sm" />
                      <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
                        Lets Rabbithole open Drive files as you — slides, docs, and scans.
                      </Text>
                    </VStack>
                  </Flex>
                )}

                {isScholar && (
                  <Flex gap={3} w="full" align="start">
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={2.5}>
                      Font
                    </Text>
                    <VStack gap={1} align="stretch" flex={1}>
                      <select
                        value={preferredFont}
                        onChange={(e) => setPreferredFont(e.target.value)}
                        style={{
                          background: "var(--chakra-colors-gray-50)",
                          border: "1px solid var(--chakra-colors-gray-300)",
                          borderRadius: "var(--chakra-radii-lg)",
                          fontFamily: "var(--chakra-fonts-body)",
                          height: "40px",
                          paddingLeft: "12px",
                          paddingRight: "12px",
                          fontSize: "14px",
                          width: "100%",
                          appearance: "auto",
                        }}
                      >
                        {FONT_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                      <Text fontSize="xs" color="charcoal.300" fontFamily="heading">
                        Applies to your chat view.
                      </Text>
                    </VStack>
                  </Flex>
                )}

                {!isSetup && <AccountEmailRow currentEmail={user.email} />}

                {!isSetup && passwordlessPrimary && (
                  <Flex gap={3} w="full" align="start">
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={1.5}>
                      Passkeys
                    </Text>
                    <PasskeyManager />
                  </Flex>
                )}

                {!isSetup && showMcpRow && (
                  <Flex gap={3} w="full" align="start">
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={1.5}>
                      AI assistants
                    </Text>
                    <McpConnections />
                  </Flex>
                )}

                {/* Additive passkeys: for these roles the password always
                    keeps working, so a lost passkey never locks a kid out
                    (see review/native-passkey-plan.md Phase B). Registrars
                    and parents are NOT here — enrolling retires their
                    password, so promising them otherwise would be a lie. */}
                {!isSetup && !passwordlessPrimary && (
                  <Flex gap={3} w="full" align="start">
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.400" fontWeight="500" w="120px" flexShrink={0} mt={1.5}>
                      Passkeys
                    </Text>
                    <VStack align="stretch" gap={2} flex={1}>
                      <Text fontSize="xs" fontFamily="body" color="charcoal.400">
                        Sign in with your fingerprint or face instead of typing
                        your password. Your password always works too.
                      </Text>
                      <PasskeyManager />
                    </VStack>
                  </Flex>
                )}

              </VStack>
            </Dialog.Body>

            <Dialog.Footer px={6} py={4} borderTop="1px solid" borderColor="gray.100">
              <HStack gap={3} w="full" justify="flex-end">
                {!isSetup && passwordStillWorks && user.username && (
                  <Button
                    variant="ghost"
                    size="sm"
                    color="charcoal.400"
                    fontFamily="heading"
                    _hover={{ color: "violet.500" }}
                    onClick={() => setShowChangePassword(true)}
                    mr="auto"
                  >
                    <Key style={{ marginRight: "4px" }} />
                    Change Password
                  </Button>
                )}
                {!isSetup && (
                  <Button
                    variant="ghost"
                    size="sm"
                    color="charcoal.400"
                    fontFamily="heading"
                    _hover={{ color: "violet.500" }}
                    onClick={handleSkipOrCancel}
                  >
                    Cancel
                  </Button>
                )}
                <Button
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  fontWeight="500"
                  px={8}
                  disabled={isSaving || (isSetup && !name.trim())}
                  onClick={handleSave}
                >
                  {isSaving ? "Saving..." : saved ? "Saved!" : "Save"}
                </Button>
              </HStack>
            </Dialog.Footer>

            {/*
              Full-screen camera capture overlay. Rendered INSIDE Dialog.Content
              (not a separate portal) so the modal dialog treats it as part of
              itself — pointer events and focus reach the shutter button. A
              sibling/outside portal gets its clicks swallowed by the modal's
              interaction layer (that was the "shutter does nothing" bug).
              position:fixed still makes it cover the whole viewport.
            */}
            {open && showCamera && (
              <Flex
                position="fixed"
                inset={0}
                zIndex={2147483000}
                bg="black"
                flexDir="column"
                align="center"
                justify="center"
              >
                <Box position="relative" maxW="100%" maxH="100%" flex={1} display="flex" alignItems="center" justifyContent="center">
                  <video
                    ref={(el) => {
                      (videoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                      if (el && streamRef.current) {
                        el.srcObject = streamRef.current;
                        void el.play().catch(() => {});
                      }
                    }}
                    autoPlay
                    playsInline
                    muted
                    style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain", transform: "scaleX(-1)" }}
                  />
                </Box>
                <Flex gap={4} py={4}>
                  <IconButton
                    aria-label="Cancel"
                    onClick={closeCamera}
                    bg="whiteAlpha.200"
                    color="white"
                    _hover={{ bg: "whiteAlpha.400" }}
                    borderRadius="full"
                    size="lg"
                    w={14}
                    h={14}
                  >
                    <X size={24} />
                  </IconButton>
                  <IconButton
                    aria-label="Take photo"
                    onClick={() => void capturePhoto()}
                    bg="white"
                    color="gray.800"
                    _hover={{ bg: "gray.200" }}
                    borderRadius="full"
                    size="lg"
                    w={16}
                    h={16}
                  >
                    <Camera size={28} />
                  </IconButton>
                </Flex>
              </Flex>
            )}
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>

      {/* Change Password Dialog */}
      {user.username && (
        <SetPasswordDialog
          open={showChangePassword}
          onClose={() => setShowChangePassword(false)}
          requireCurrentPassword={true}
        />
      )}

    </Dialog.Root>
  );
}

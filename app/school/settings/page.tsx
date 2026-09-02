"use client";

// School settings — institution-local identity and operating cadence.
// Registrars can use the School Directory, but changing the school record is an
// institution leader action (school_admin / platform_admin via the school shell).

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { useAction, useMutation, useQuery } from "convex/react";
import { useEffect, useRef, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Field,
  Heading,
  HStack,
  Input,
  Text,
  VStack,
} from "@chakra-ui/react";
import { api } from "@/convex/_generated/api";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { toaster } from "@/lib/toaster";
import { formatRelative } from "@/lib/relativeTime";
import { TimeZoneField } from "@/components/ui/TimeZoneField";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { InstitutionMark } from "@/components/InstitutionMark";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { DeleteSchoolDialog } from "@/components/DeleteSchoolDialog";
import { DisableSchoolDialog } from "@/components/DisableSchoolDialog";
import { disableSchoolCopy } from "@/components/schoolLifecycleCopy";
import type { Id } from "@/convex/_generated/dataModel";

// Mirror the server guard (convex validates MIME + size too) so a bad pick
// gets a friendly message instead of a raw rejection. Same allow-list + cap
// the profile-photo path enforces.
const ACCEPTED_LOGO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_LOGO_BYTES = 5 * 1024 * 1024;
const WEEKDAY_OPTIONS = Array.from({ length: 7 }, (_, weekday) => ({
  weekday,
  label: new Intl.DateTimeFormat("en", {
    weekday: "long",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2026, 0, 4 + weekday))),
}));

function minutesToTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(
    minutes % 60,
  ).padStart(2, "0")}`;
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function canManageSchoolSettings(role: Role | string | undefined): boolean {
  return role === "school_admin" || isPlatformAdminRole(role as Role | undefined);
}


export default function SchoolSettingsPage() {
  const suspensionCopy = disableSchoolCopy("school");
  const { user, isLoading } = useCurrentUser();
  const allowed = canManageSchoolSettings(user?.role);
  const authorization = useAuthorizationGuard({
    isLoading,
    hasUser: !!user,
    isAllowed: allowed,
    unauthorizedRedirect: "/school/directory/scholars",
  });
  // Honor the active institution lens (?inst=) so a platform admin edits the
  // school they're currently lensed into. The backend resolver only honors a
  // school the caller may act on, so a school_admin's scope always resolves to
  // their own school.
  const { scopeParam } = useActiveInstitution(!!user && allowed);
  const school = useQuery(
    api.institutions.getMySchool,
    allowed ? { scope: scopeParam } : "skip",
  );
  const updateSettings = useMutation(api.institutions.updateSettings);
  const setRoundsCadences = useMutation(api.institutions.setRoundsCadences);
  const generateLogoUploadUrl = useMutation(api.institutions.generateLogoUploadUrl);
  const setLogo = useMutation(api.institutions.setLogo);
  const removeLogo = useMutation(api.institutions.removeLogo);
  const discardLogoUpload = useMutation(api.institutions.discardLogoUpload);

  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("");
  const [timeZone, setTimeZone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [academicWeekday, setAcademicWeekday] = useState("1");
  const [academicTime, setAcademicTime] = useState("00:00");
  const [selEnabled, setSelEnabled] = useState(false);
  const [selWeekday, setSelWeekday] = useState("1");
  const [selTime, setSelTime] = useState("00:00");
  const [cadenceSaving, setCadenceSaving] = useState(false);
  const [cadenceError, setCadenceError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const enableInstitution = useMutation(
    api.institutionLifecycle.enableInstitution,
  );
  // Suspension (temporary disable) is a PLATFORM-admin billing action — a
  // school_admin sees delete (their own school) but never the pause control.
  const isPlatformAdmin = isPlatformAdminRole(user?.role as Role | undefined);

  const handleEnable = async () => {
    if (!school) return;
    setEnabling(true);
    try {
      await enableInstitution({ institutionId: school._id });
      toaster.success({
        title: `Resumed ${school.name}`,
        description: "Members can use Rabbithole again.",
      });
    } catch (e) {
      toaster.error({
        title: "Couldn't resume school",
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setEnabling(false);
    }
  };

  /* eslint-disable react-hooks/set-state-in-effect -- Convex query hydration initializes this editable draft. */
  useEffect(() => {
    if (!school) return;
    setName(school.name);
    setEmoji(school.emoji ?? "");
    setTimeZone(school.timeZone);
    const academic =
      school.roundsCadences.find((cadence) => cadence.kind === "academic") ??
      school.roundsAnchor;
    const sel = school.roundsCadences.find((cadence) => cadence.kind === "sel");
    setAcademicWeekday(String(academic.weekday));
    setAcademicTime(minutesToTime(academic.minutes));
    setSelEnabled(!!sel);
    setSelWeekday(String(sel?.weekday ?? 1));
    setSelTime(minutesToTime(sel?.minutes ?? 0));
    setCadenceError("");
    setError("");
  }, [school]);
  /* eslint-enable react-hooks/set-state-in-effect */

  if (authorization !== "allowed" || !user) {
    return <AuthorizationPending />;
  }

  const dirty =
    !!school && (
      name.trim() !== school.name
      || emoji.trim() !== (school.emoji ?? "")
      || timeZone !== school.timeZone
    );

  const handleSubmit = async () => {
    if (!school || saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("School name is required");
      return;
    }

    setSaving(true);
    setError("");
    try {
      await updateSettings({
        name: trimmedName,
        emoji: emoji.trim() || null,
        timeZone,
        scope: scopeParam,
      });
      toaster.success({ title: "School settings saved" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to save settings";
      setError(message);
      toaster.error({ title: "Failed to save settings", description: message });
    } finally {
      setSaving(false);
    }
  };

  const handleCadenceSubmit = async () => {
    if (!school || cadenceSaving) return;
    const academicMinutes = timeToMinutes(academicTime);
    const selMinutes = timeToMinutes(selTime);
    if (
      academicMinutes === null ||
      (selEnabled && selMinutes === null)
    ) {
      setCadenceError("Enter a valid meeting time");
      return;
    }
    setCadenceSaving(true);
    setCadenceError("");
    try {
      const cadences: Array<{
        kind: "academic" | "sel";
        weekday: number;
        minutes: number;
      }> = [
        {
          kind: "academic",
          weekday: Number(academicWeekday),
          minutes: academicMinutes,
        },
      ];
      if (selEnabled && selMinutes !== null) {
        cadences.push({
          kind: "sel",
          weekday: Number(selWeekday),
          minutes: selMinutes,
        });
      }
      await setRoundsCadences({
        cadences,
        scope: scopeParam,
      });
      toaster.success({ title: "Rounds cadence saved" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "Failed to save cadence";
      setCadenceError(message);
      toaster.error({ title: "Failed to save cadence", description: message });
    } finally {
      setCadenceSaving(false);
    }
  };

  const handleLogoFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so re-picking the same file fires onChange again.
    e.target.value = "";
    if (!file || !school || logoBusy) return;
    if (!ACCEPTED_LOGO_TYPES.includes(file.type)) {
      setLogoError("Choose a JPEG, PNG, WebP, or GIF image.");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("Image is too large (max 5 MB).");
      return;
    }
    setLogoBusy(true);
    setLogoError("");
    let uploadedId: Id<"_storage"> | null = null;
    try {
      const uploadUrl = await generateLogoUploadUrl({});
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId } = (await res.json()) as { storageId: string };
      uploadedId = storageId as Id<"_storage">;
      const result = await setLogo({
        storageId: uploadedId,
        contentType: file.type,
        scope: scopeParam,
      });
      if (!result.ok) throw new Error(result.error);
      uploadedId = null; // attached — don't reclaim it
      toaster.success({ title: "Logo updated" });
    } catch (err) {
      // Reclaim a blob we uploaded but couldn't attach so it doesn't leak.
      // discardLogoUpload no-ops if the blob is actually in use.
      if (uploadedId) {
        await discardLogoUpload({ storageId: uploadedId }).catch(() => {});
      }
      const message = err instanceof Error ? err.message : "Failed to upload logo";
      setLogoError(message);
      toaster.error({ title: "Failed to upload logo", description: message });
    } finally {
      setLogoBusy(false);
    }
  };

  const handleLogoRemove = async () => {
    if (!school || logoBusy) return;
    setLogoBusy(true);
    setLogoError("");
    try {
      await removeLogo({ scope: scopeParam });
      toaster.success({ title: "Logo removed" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to remove logo";
      setLogoError(message);
      toaster.error({ title: "Failed to remove logo", description: message });
    } finally {
      setLogoBusy(false);
    }
  };


  return (
    <VStack align="stretch" gap={5}>
      <Box>
        <Heading size="md" fontFamily="heading" color="navy.500">
          Settings
        </Heading>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Edit your school identity and the local calendar Rabbithole uses.
        </Text>
      </Box>

      <Box
        as="form"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        bg="white"
        p={{ base: 4, md: 6 }}
      >
        <VStack align="stretch" gap={4} maxW="xl">
          {school === undefined ? (
            <Text fontFamily="body" color="charcoal.400">
              Loading school settings…
            </Text>
          ) : (
            <>
              <Field.Root required invalid={!!error && !name.trim()}>
                <Field.Label fontFamily="heading" color="charcoal.500">
                  School name
                </Field.Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={saving}
                  bg="gray.50"
                  fontFamily="body"
                  placeholder="School name"
                />
                <Field.HelperText fontFamily="body">
                  This appears in school staff surfaces and institution switchers.
                </Field.HelperText>
                <Field.ErrorText>{error}</Field.ErrorText>
              </Field.Root>

              <Field.Root>
                <Field.Label fontFamily="heading" color="charcoal.500">
                  School logo
                </Field.Label>
                <HStack gap={4} align="center" wrap="wrap">
                  <Box
                    borderWidth="1px"
                    borderColor="gray.200"
                    borderRadius="lg"
                    bg="gray.50"
                    p={2}
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                  >
                    <InstitutionMark
                      logoUrl={school.logoUrl}
                      emoji={school.emoji}
                      name={school.name}
                      size={56}
                    />
                  </Box>
                  <HStack gap={2}>
                    <Button
                      type="button"
                      variant="outline"
                      colorPalette="violet"
                      fontFamily="heading"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={saving || logoBusy}
                      loading={logoBusy}
                    >
                      {school.logoUrl ? "Replace logo" : "Upload logo"}
                    </Button>
                    {school.logoUrl && (
                      <Button
                        type="button"
                        variant="ghost"
                        fontFamily="heading"
                        onClick={() => void handleLogoRemove()}
                        disabled={saving || logoBusy}
                      >
                        Remove
                      </Button>
                    )}
                  </HStack>
                </HStack>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  onChange={(e) => void handleLogoFile(e)}
                  style={{ display: "none" }}
                />
                <Field.HelperText fontFamily="body">
                  The mark shown across school surfaces. PNG, JPEG, WebP, or GIF
                  up to 5&nbsp;MB. Without a logo, the emoji below is used as a
                  fallback.
                </Field.HelperText>
                {logoError && (
                  <Text fontSize="sm" color="red.500" fontFamily="body" mt={1}>
                    {logoError}
                  </Text>
                )}
              </Field.Root>

              <Field.Root>
                <Field.Label fontFamily="heading" color="charcoal.500">
                  Emoji
                </Field.Label>
                <Input
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value)}
                  disabled={saving}
                  bg="gray.50"
                  fontFamily="body"
                  maxW="8rem"
                  placeholder="🏫"
                />
                <Field.HelperText fontFamily="body">
                  Fallback mark, used only when no logo is uploaded. Optional —
                  leave blank to clear it.
                </Field.HelperText>
              </Field.Root>

              <Field.Root required>
                <Field.Label fontFamily="heading" color="charcoal.500">
                  Home time zone
                </Field.Label>
                <TimeZoneField
                  value={timeZone}
                  onChange={setTimeZone}
                  disabled={saving}
                  maxW="20rem"
                  inputProps={{ "aria-label": "Home time zone" }}
                />
                <Field.HelperText fontFamily="body">
                  Daily playlists and recaps reset at midnight in this time zone.
                </Field.HelperText>
              </Field.Root>

              <HStack gap={2} wrap="wrap">
                <Badge colorPalette="gray">Slug: {school.slug}</Badge>
                <Badge colorPalette="gray">Kind: {school.kind}</Badge>
              </HStack>

              {error && name.trim() && (
                <Text fontSize="sm" color="red.500" fontFamily="body">
                  {error}
                </Text>
              )}

              <HStack justify="flex-end" pt={2}>
                <Button
                  type="submit"
                  bg="violet.500"
                  color="white"
                  _hover={{ bg: "violet.600" }}
                  fontFamily="heading"
                  disabled={saving || !dirty || !name.trim() || !timeZone}
                  loading={saving}
                  loadingText="Saving..."
                >
                  Save
                </Button>
              </HStack>
            </>
          )}
        </VStack>
      </Box>

      <Box
        as="section"
        borderWidth="1px"
        borderColor="gray.200"
        borderRadius="xl"
        bg="white"
        p={{ base: 4, md: 6 }}
      >
        <VStack align="stretch" gap={4} maxW="xl">
          <Box>
            <Heading size="sm" fontFamily="heading" color="charcoal.600">
              Rounds cadence
            </Heading>
            <Text fontFamily="body" fontSize="sm" color="charcoal.400">
              Set the local meeting day and time for each weekly Rounds meeting.
            </Text>
          </Box>

          <Box>
            <Text fontFamily="heading" fontWeight="600" color="charcoal.600" mb={2}>
              Academic Rounds
            </Text>
            <HStack gap={3} align="end" wrap="wrap">
              <Field.Root maxW="13rem">
                <Field.Label fontFamily="heading">Meeting day</Field.Label>
                <FieldSelect
                  value={academicWeekday}
                  onChange={setAcademicWeekday}
                  disabled={cadenceSaving}
                  fieldProps={{ "aria-label": "Academic Rounds meeting day" }}
                >
                  {WEEKDAY_OPTIONS.map((option) => (
                    <option key={option.weekday} value={option.weekday}>
                      {option.label}
                    </option>
                  ))}
                </FieldSelect>
              </Field.Root>
              <Field.Root maxW="10rem">
                <Field.Label fontFamily="heading">Meeting time</Field.Label>
                <Input
                  type="time"
                  value={academicTime}
                  onChange={(event) => setAcademicTime(event.target.value)}
                  disabled={cadenceSaving}
                  bg="gray.50"
                  fontFamily="heading"
                  aria-label="Academic Rounds meeting time"
                />
              </Field.Root>
            </HStack>
          </Box>

          <Box borderTopWidth="1px" borderColor="gray.100" pt={4}>
            <Checkbox.Root
              checked={selEnabled}
              onCheckedChange={(details) => setSelEnabled(details.checked === true)}
              disabled={cadenceSaving}
              colorPalette="violet"
            >
              <Checkbox.HiddenInput />
              <Checkbox.Control />
              <Checkbox.Label fontFamily="heading" fontWeight="600">
                Enable SEL Rounds
              </Checkbox.Label>
            </Checkbox.Root>
            {selEnabled && (
              <HStack gap={3} align="end" wrap="wrap" mt={3}>
                <Field.Root maxW="13rem">
                  <Field.Label fontFamily="heading">Meeting day</Field.Label>
                  <FieldSelect
                    value={selWeekday}
                    onChange={setSelWeekday}
                    disabled={cadenceSaving}
                    fieldProps={{ "aria-label": "SEL Rounds meeting day" }}
                  >
                    {WEEKDAY_OPTIONS.map((option) => (
                      <option key={option.weekday} value={option.weekday}>
                        {option.label}
                      </option>
                    ))}
                  </FieldSelect>
                </Field.Root>
                <Field.Root maxW="10rem">
                  <Field.Label fontFamily="heading">Meeting time</Field.Label>
                  <Input
                    type="time"
                    value={selTime}
                    onChange={(event) => setSelTime(event.target.value)}
                    disabled={cadenceSaving}
                    bg="gray.50"
                    fontFamily="heading"
                    aria-label="SEL Rounds meeting time"
                  />
                </Field.Root>
              </HStack>
            )}
          </Box>

          {cadenceError && (
            <Text fontSize="sm" color="red.500" fontFamily="body">
              {cadenceError}
            </Text>
          )}
          <HStack justify="flex-end">
            <Button
              type="button"
              colorPalette="violet"
              fontFamily="heading"
              onClick={() => void handleCadenceSubmit()}
              disabled={cadenceSaving || !school}
              loading={cadenceSaving}
              loadingText="Saving…"
            >
              Save cadence
            </Button>
          </HStack>
        </VStack>
      </Box>

      {/* School access (temporary suspend/resume) — a PLATFORM-admin billing
          control, distinct from delete: nothing is destroyed and it is fully
          reversible. Hidden for the primary school (never suspendable; the
          server refuses it regardless) and for non-platform-admins. */}
      {school && !school.isPrimary && isPlatformAdmin && (
        <Box
          borderWidth="1px"
          borderColor={school.disabled ? "amber.300" : "gray.200"}
          borderRadius="xl"
          bg={school.disabled ? "amber.50" : "white"}
          p={{ base: 4, md: 6 }}
        >
          <VStack align="stretch" gap={3} maxW="xl">
            <Box>
              <HStack gap={2}>
                <Heading size="sm" fontFamily="heading" color="charcoal.600">
                  School access
                </Heading>
                {school.disabled && (
                  <Badge colorPalette="orange" fontFamily="heading">
                    Paused
                  </Badge>
                )}
              </HStack>
              {school.disabled ? (
                <Text fontFamily="body" fontSize="sm" color="charcoal.500">
                  This school&apos;s access is <b>paused</b>
                  {school.disabledByName ? ` by ${school.disabledByName}` : ""}
                  {school.disabledReason ? ` — ${school.disabledReason}` : ""}.
                  {" "}
                  {suspensionCopy.accessPausedDescription} All data is preserved.
                  Resume to fully restore access.
                </Text>
              ) : (
                <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                  Temporarily pause this school (e.g. billing). Members are
                  blocked from the app with a clear message; nothing is deleted
                  and you can resume any time. Anyone who also belongs to another
                  active school keeps working there.
                </Text>
              )}
            </Box>
            <HStack justify="flex-start">
              {school.disabled ? (
                <Button
                  colorPalette="green"
                  fontFamily="heading"
                  onClick={() => void handleEnable()}
                  loading={enabling}
                  loadingText="Resuming…"
                >
                  Resume access
                </Button>
              ) : (
                <Button
                  variant="outline"
                  colorPalette="orange"
                  fontFamily="heading"
                  onClick={() => setDisableOpen(true)}
                >
                  Pause school access…
                </Button>
              )}
            </HStack>
          </VStack>
        </Box>
      )}

      {/* Danger zone — deleting a school cascade-deletes every scholar, staff
          account, and record scoped to it. Hidden for the primary school
          (undeletable); the server refuses it regardless. */}
      {school && !school.isPrimary && (
        <Box
          borderWidth="1px"
          borderColor="red.200"
          borderRadius="xl"
          bg="white"
          p={{ base: 4, md: 6 }}
        >
          <VStack align="stretch" gap={3} maxW="xl">
            <Box>
              <Heading size="sm" fontFamily="heading" color="red.600">
                Danger zone
              </Heading>
              <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                Permanently delete this school and everything scoped to it —
                every scholar, staff account, session, assignment, and record.
                This cannot be undone.
              </Text>
            </Box>
            <HStack justify="flex-start">
              <Button
                variant="outline"
                colorPalette="red"
                fontFamily="heading"
                onClick={() => setDeleteOpen(true)}
              >
                Delete this school…
              </Button>
            </HStack>
          </VStack>
        </Box>
      )}

      {school && !school.isPrimary && (
        <DeleteSchoolDialog
          open={deleteOpen}
          onClose={() => setDeleteOpen(false)}
          institutionId={school._id}
          schoolName={school.name}
          noun="school"
        />
      )}

      {school && !school.isPrimary && isPlatformAdmin && (
        <DisableSchoolDialog
          open={disableOpen}
          onClose={() => setDisableOpen(false)}
          institutionId={school._id}
          schoolName={school.name}
          noun="school"
        />
      )}
    </VStack>
  );
}

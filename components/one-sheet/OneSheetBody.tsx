/**
 * OneSheetBody — the actual content of a student emergency one-sheet.
 * Shared between the single-scholar page and the batch page so both surfaces
 * render identically. Designed for print: fits one scholar on one letter-size
 * page using compact typography and `break-inside: avoid` guards.
 *
 * Receives the typed return value from `api.scholarHealthRecords.getOneSheetForStaff`.
 * If `record` is null (no signed health record on file) it shows a placeholder
 * rather than rendering partial draft data.
 */

import { format } from "date-fns";
import {
  Avatar,
  Badge,
  Box,
  Flex,
  Grid,
  Heading,
  HStack,
  Stack,
  Text,
} from "@chakra-ui/react";
import {
  Warning,
  FirstAid,
  Phone,
  Pill,
  Heart,
  Star,
  User,
  Stethoscope,
} from "@phosphor-icons/react";
import { AppLogo } from "@/components/AppLogo";
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

type OneSheetData = NonNullable<
  FunctionReturnType<typeof api.scholarHealthRecords.getOneSheetForStaff>
>;
type OneSheetRecord = NonNullable<OneSheetData["record"]>;
type EmergencyContact = OneSheetRecord["emergencyContacts"][number];
type Allergy = OneSheetRecord["allergies"][number];
type Medication = OneSheetRecord["medications"][number];

/**
 * Compact section wrapper. `avoid` keeps sections together across page breaks.
 */
function Section({
  icon,
  title,
  children,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  accent?: "red" | "amber" | "gray";
}) {
  const borderColor =
    accent === "red"
      ? "red.300"
      : accent === "amber"
        ? "orange.300"
        : "gray.200";
  const headerBg =
    accent === "red"
      ? "red.50"
      : accent === "amber"
        ? "orange.50"
        : "gray.50";

  return (
    <Box
      borderWidth="1px"
      borderColor={borderColor}
      borderRadius="md"
      overflow="hidden"
      style={{ breakInside: "avoid" }}
    >
      <HStack
        px={3}
        py={1.5}
        bg={headerBg}
        borderBottomWidth="1px"
        borderColor={borderColor}
        gap={1.5}
      >
        {icon}
        <Text
          fontFamily="heading"
          fontWeight="700"
          fontSize="xs"
          textTransform="uppercase"
          letterSpacing="wider"
          color={accent === "red" ? "red.700" : accent === "amber" ? "orange.700" : "charcoal.600"}
        >
          {title}
        </Text>
      </HStack>
      <Box px={3} py={2}>
        {children}
      </Box>
    </Box>
  );
}

function FieldRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <HStack gap={1.5} align="baseline">
      <Text
        fontFamily="heading"
        fontWeight="600"
        fontSize="2xs"
        color="charcoal.400"
        minW="80px"
        flexShrink={0}
      >
        {label}
      </Text>
      <Text fontFamily="body" fontSize="xs" color="charcoal.700">
        {value}
      </Text>
    </HStack>
  );
}

function NoneKnown({ label }: { label: string }) {
  return (
    <Text fontFamily="body" fontSize="xs" color="charcoal.300" fontStyle="italic">
      {label}
    </Text>
  );
}

export function OneSheetBody({ data }: { data: OneSheetData }) {
  const { scholar, record } = data;
  const displayName =
    record?.childPreferredName || record?.childName || scholar.name || "Scholar";
  const dob = record?.childDob ?? scholar.dob;

  const printedAt = format(new Date(), "MMM d, yyyy");

  return (
    <Stack gap={3}>
      {/* ── Masthead ─────────────────────────────────────────────── */}
      <Flex
        justify="space-between"
        align="flex-start"
        borderBottomWidth="2px"
        borderColor="navy.500"
        pb={3}
        mb={1}
        style={{ breakInside: "avoid" }}
      >
        {/* Scholar identity */}
        <HStack gap={3} align="flex-start">
          {/* Scholar photo.
              NOTE: The publicMediaOptOut flag on the health record restricts
              public/website/social-media use only. It does NOT restrict internal
              operational staff use such as this emergency one-sheet. The photo
              is always included here regardless of opt-out status. */}
          <Avatar.Root size="2xl" borderRadius="md" overflow="hidden" flexShrink={0}>
            {scholar.image ? (
              <Avatar.Image src={scholar.image} alt={displayName} />
            ) : null}
            <Avatar.Fallback fontFamily="heading" bg="violet.100" color="violet.700">
              {displayName.slice(0, 2).toUpperCase()}
            </Avatar.Fallback>
          </Avatar.Root>

          <Stack gap={0.5} pt={1}>
            <Heading size="xl" fontFamily="heading" color="navy.700" lineHeight="1.1">
              {displayName}
            </Heading>
            {record?.childPreferredName && record.childName && (
              <Text fontFamily="body" fontSize="xs" color="charcoal.400">
                Legal name: {record.childName}
              </Text>
            )}
            {dob && (
              <Text fontFamily="body" fontSize="xs" color="charcoal.500">
                DOB: {dob}{" "}
                {scholar.gradeLevel && `· Grade ${scholar.gradeLevel}`}
              </Text>
            )}
            {record && (
              <Text fontFamily="body" fontSize="2xs" color="charcoal.300">
                Record signed {format(new Date(record.signedAt), "MMM d, yyyy")}
              </Text>
            )}
          </Stack>
        </HStack>

        {/* Top-right: logo + document label */}
        <Stack gap={0.5} align="flex-end" pt={1} flexShrink={0}>
          <HStack gap={1.5}>
            <AppLogo size={18} />
            <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.500">
              Rabbithole
            </Text>
          </HStack>
          <Text fontFamily="heading" fontWeight="600" fontSize="xs" color="charcoal.500">
            Staff Emergency Reference
          </Text>
          <Text fontFamily="body" fontSize="2xs" color="charcoal.300">
            Printed {printedAt} · staff only
          </Text>
        </Stack>
      </Flex>

      {/* ── No record placeholder ────────────────────────────────── */}
      {!record && (
        <Box
          borderWidth="1px"
          borderColor="orange.200"
          borderRadius="md"
          bg="orange.50"
          px={4}
          py={5}
          textAlign="center"
          style={{ breakInside: "avoid" }}
        >
          <Text fontFamily="heading" fontWeight="700" color="orange.700" fontSize="md" mb={1}>
            No health record on file
          </Text>
          <Text fontFamily="body" fontSize="sm" color="orange.600">
            A guardian-signed health record has not been submitted for this
            scholar. Contact the family to complete enrollment health forms.
          </Text>
        </Box>
      )}

      {record && (
        <>
          {/* ── Emergency contacts + guardian contacts ───────────── */}
          <Grid templateColumns={{ base: "1fr", md: "1fr 1fr" }} gap={2}>
            <Section
              icon={<Phone size={12} weight="bold" color="var(--chakra-colors-charcoal-600)" />}
              title="Emergency Contacts"
            >
              {record.emergencyContacts.length === 0 ? (
                <NoneKnown label="None listed" />
              ) : (
                <Stack gap={2}>
                  {record.emergencyContacts.map((c: EmergencyContact, i: number) => (
                    <Box key={i}>
                      <HStack gap={1} align="baseline">
                        <Text fontFamily="heading" fontWeight="600" fontSize="xs" color="charcoal.700">
                          {c.name}
                        </Text>
                        <Text fontFamily="body" fontSize="2xs" color="charcoal.400">
                          {c.relationship}
                          {c.canPickUp ? " · can pick up" : ""}
                        </Text>
                      </HStack>
                      <Text fontFamily="body" fontSize="xs" color="charcoal.600">
                        {c.phone}
                        {c.altPhone ? ` / ${c.altPhone}` : ""}
                      </Text>
                    </Box>
                  ))}
                </Stack>
              )}
            </Section>

            <Section
              icon={<User size={12} weight="bold" color="var(--chakra-colors-charcoal-600)" />}
              title="Guardian & Physician"
            >
              <Stack gap={1.5}>
                {record.guardian1Name && (
                  <FieldRow label="Guardian 1" value={`${record.guardian1Name}${record.guardian1Phone ? ` · ${record.guardian1Phone}` : ""}`} />
                )}
                {record.guardian2Name && (
                  <FieldRow label="Guardian 2" value={`${record.guardian2Name}${record.guardian2Phone ? ` · ${record.guardian2Phone}` : ""}`} />
                )}
                {record.physicianName && (
                  <FieldRow
                    label="Physician"
                    value={`${record.physicianName}${record.physicianPhone ? ` · ${record.physicianPhone}` : ""}`}
                  />
                )}
              </Stack>
            </Section>
          </Grid>

          {/* ── Allergies ─────────────────────────────────────────── */}
          <Section
            icon={<Warning size={12} weight="bold" color={record.noKnownAllergies ? "var(--chakra-colors-charcoal-400)" : "var(--chakra-colors-red-600)"} />}
            title="Allergies"
            accent={record.allergies.length > 0 ? "red" : undefined}
          >
            {record.noKnownAllergies || record.allergies.length === 0 ? (
              <NoneKnown label={record.noKnownAllergies ? "No known allergies" : "None listed"} />
            ) : (
              <Stack gap={2}>
                {record.allergies.map((a: Allergy, i: number) => (
                  <Box key={i}>
                    <HStack gap={2} align="baseline" flexWrap="wrap">
                      <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="red.700">
                        {a.allergen}
                      </Text>
                      <Badge colorPalette={a.severity === "severe" ? "red" : a.severity === "moderate" ? "orange" : "gray"} size="sm" fontFamily="heading">
                        {a.severity}
                      </Badge>
                      {a.epipenOnFile && (
                        <Badge colorPalette="red" variant="outline" size="sm" fontFamily="heading">
                          EpiPen on file
                        </Badge>
                      )}
                    </HStack>
                    {a.reaction && (
                      <Text fontFamily="body" fontSize="xs" color="charcoal.600">
                        Reaction: {a.reaction}
                      </Text>
                    )}
                    {a.emergencyTreatment && (
                      <Text fontFamily="body" fontSize="xs" color="red.700" fontWeight="500">
                        Treatment: {a.emergencyTreatment}
                      </Text>
                    )}
                  </Box>
                ))}
                {record.allergyNotes && (
                  <Text fontFamily="body" fontSize="xs" color="charcoal.500" fontStyle="italic" mt={1}>
                    {record.allergyNotes}
                  </Text>
                )}
              </Stack>
            )}
          </Section>

          {/* ── Medications ───────────────────────────────────────── */}
          <Section
            icon={<Pill size={12} weight="bold" color="var(--chakra-colors-charcoal-600)" />}
            title="Medications"
            accent={record.medications.length > 0 ? "amber" : undefined}
          >
            {record.noCurrentMedications || record.medications.length === 0 ? (
              <NoneKnown label={record.noCurrentMedications ? "No current medications" : "None listed"} />
            ) : (
              <Stack gap={2}>
                {record.medications.map((m: Medication, i: number) => (
                  <Box key={i}>
                    <HStack gap={1.5} align="baseline">
                      <Text fontFamily="heading" fontWeight="600" fontSize="xs" color="charcoal.700">
                        {m.name}
                      </Text>
                      {m.storedAtSchool && (
                        <Badge colorPalette="blue" size="sm" fontFamily="heading">
                          Stored at school
                        </Badge>
                      )}
                    </HStack>
                    {m.dosage && (
                      <Text fontFamily="body" fontSize="xs" color="charcoal.600">
                        {m.dosage}{m.frequency ? ` · ${m.frequency}` : ""}
                      </Text>
                    )}
                    {m.administrationInstructions && (
                      <Text fontFamily="body" fontSize="xs" color="charcoal.500">
                        {m.administrationInstructions}
                      </Text>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </Section>

          {/* ── Chronic conditions ────────────────────────────────── */}
          <Section
            icon={<Heart size={12} weight="bold" color="var(--chakra-colors-charcoal-600)" />}
            title="Chronic Conditions"
          >
            {record.noChronicConditions || record.chronicConditions.length === 0 ? (
              <NoneKnown label={record.noChronicConditions ? "None known" : "None listed"} />
            ) : (
              <Stack gap={0.5}>
                <HStack gap={1} flexWrap="wrap">
                  {record.chronicConditions.map((c: string) => (
                    <Badge key={c} colorPalette="purple" size="sm" fontFamily="heading">
                      {c}
                    </Badge>
                  ))}
                </HStack>
                {record.chronicConditionDetails && (
                  <Text fontFamily="body" fontSize="xs" color="charcoal.500" mt={1}>
                    {record.chronicConditionDetails}
                  </Text>
                )}
              </Stack>
            )}
          </Section>

          {/* ── Healthcare action plan ────────────────────────────── */}
          {record.hap && !record.hap.none && (
            <Section
              icon={<FirstAid size={12} weight="bold" color="var(--chakra-colors-red-600)" />}
              title="Healthcare Action Plan"
              accent="red"
            >
              <Stack gap={1}>
                <HStack gap={1} flexWrap="wrap">
                  {record.hap.allergy && <Badge colorPalette="red" fontFamily="heading" size="sm">Allergy</Badge>}
                  {record.hap.asthma && <Badge colorPalette="blue" fontFamily="heading" size="sm">Asthma</Badge>}
                  {record.hap.seizure && <Badge colorPalette="orange" fontFamily="heading" size="sm">Seizure</Badge>}
                  {record.hap.diabetes && <Badge colorPalette="teal" fontFamily="heading" size="sm">Diabetes</Badge>}
                  {record.hap.behavioralHealth && <Badge colorPalette="purple" fontFamily="heading" size="sm">Behavioral Health</Badge>}
                  {record.hap.other && (
                    <Badge colorPalette="gray" fontFamily="heading" size="sm">
                      Other{record.hap.otherDesc ? `: ${record.hap.otherDesc}` : ""}
                    </Badge>
                  )}
                </HStack>
                {record.hap.notes && (
                  <Text fontFamily="body" fontSize="xs" color="red.700" fontWeight="500">
                    {record.hap.notes}
                  </Text>
                )}
                <Text fontFamily="body" fontSize="2xs" color="charcoal.300" fontStyle="italic">
                  Signed action-plan document on file with school health records.
                </Text>
              </Stack>
            </Section>
          )}

          {/* ── Field trip restriction ────────────────────────────── */}
          {record.fieldTripRestriction && (
            <Section
              icon={<Star size={12} weight="bold" color="var(--chakra-colors-orange-600)" />}
              title="Field Trip Restriction"
              accent="amber"
            >
              {record.fieldTripRestrictionDetails ? (
                <Text fontFamily="body" fontSize="xs" color="orange.700">
                  {record.fieldTripRestrictionDetails}
                </Text>
              ) : (
                <Text fontFamily="body" fontSize="xs" color="orange.700">
                  Guardian has requested a field trip restriction — see full health record for details.
                </Text>
              )}
            </Section>
          )}

          {/* ── Emergency medical authorization ───────────────────── */}
          <Box
            borderWidth="1px"
            borderColor={record.emergencyMedAuthAck ? "green.200" : "red.200"}
            borderRadius="md"
            px={3}
            py={2}
            bg={record.emergencyMedAuthAck ? "green.50" : "red.50"}
            style={{ breakInside: "avoid" }}
          >
            <HStack gap={2} align="flex-start">
              <Stethoscope
                size={14}
                weight="bold"
                color={record.emergencyMedAuthAck ? "var(--chakra-colors-green-700)" : "var(--chakra-colors-red-700)"}
                style={{ flexShrink: 0, marginTop: 2 }}
              />
              <Stack gap={0.5}>
                <Text
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="xs"
                  color={record.emergencyMedAuthAck ? "green.700" : "red.700"}
                >
                  Emergency Medical Authorization:{" "}
                  {record.emergencyMedAuthAck ? "Authorized" : "NOT authorized"}
                </Text>
                {record.emergencyMedAuthNotes && (
                  <Text fontFamily="body" fontSize="xs" color="charcoal.600">
                    {record.emergencyMedAuthNotes}
                  </Text>
                )}
              </Stack>
            </HStack>
          </Box>
        </>
      )}
    </Stack>
  );
}

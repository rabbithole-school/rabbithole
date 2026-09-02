"use client";

import { useRef, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import {
  Box,
  Button,
  chakra,
  Container,
  Flex,
  Grid,
  HStack,
  Heading,
  Input,
  Spinner,
  Switch,
  Text,
  VStack,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import {
  ArrowSquareOut,
  Camera,
  FileText,
  MapTrifold,
} from "@phosphor-icons/react";
import { ScholarPhotoDialog } from "@/components/ScholarPhotoDialog";
import { formatRelative } from "@/lib/relativeTime";
import { ParentMessages } from "@/components/ParentMessages";
import { PasskeyUpsell } from "@/components/PasskeyUpsell";
import SharedNarratives from "@/components/parent/SharedNarratives";
import { type ParentTab } from "@/components/parent/parentTabs";
import { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";
import type { ParentChild } from "@/components/parent/ParentNav";
import { ParentLibraryCard } from "@/components/parent/ParentLibraryCard";
import { ParentCalendarTab } from "@/components/parent/ParentCalendarTab";
import {
  parentMathCannedQuestions,
  sendParentMathCannedQuestion,
} from "@/components/parent/parentMathQuestions";
import { MathSkillsPortrait } from "@/components/practice/MathSkillsPortrait";
import { useAideDockOptional } from "@/components/aide/AideDockProvider";
import {
  ParentPortfolioViewer,
  type ParentPortfolioItem,
} from "@/components/parent/ParentPortfolioViewer";
import { pageCountForRange } from "@/components/parent/parentPortfolioViewerLogic";

/**
 * The parent portal: a guardian sees ONLY their own linked children's
 * non-sensitive learning data. Every query here is guardian-gated server
 * side (parents.child* / portfolio.listForGuardian). No raw transcripts.
 */
export function ParentDashboard({
  childOptions,
  activeChild,
  tab,
}: {
  childOptions: ParentChild[];
  activeChild: Id<"users"> | null;
  tab: ParentTab;
}) {
  if (childOptions.length === 0) {
    return (
      <Container maxW="lg" py={16}>
        <VStack gap={3} textAlign="center">
          <Heading size="lg" fontFamily="heading" color="navy.500">
            No children linked yet
          </Heading>
          <Text fontFamily="body" color="charcoal.400">
            Once the school links your child to your account, their learning
            progress will appear here. Reach out to the front office if you think
            this is a mistake.
          </Text>
        </VStack>
      </Container>
    );
  }

  if (tab === "messages") {
    const activeChildOption = childOptions.find(
      (child) => child._id === activeChild,
    );
    return (
      <Box h="full" minH={0}>
        {activeChild && (
          <ParentMessages
            scholarId={activeChild}
            programGuest={
              activeChildOption?.enrollmentStanding === "program_guest"
            }
          />
        )}
      </Box>
    );
  }

  return (
    <Container maxW="4xl" py={6}>
      {/* Post-login nudge to add a passkey (faster sign-in next time).
          Self-hides once the parent has one or dismisses it. */}
      <PasskeyUpsell />

      {activeChild && (
        <ChildView
          scholarId={activeChild}
          childName={
            childOptions.find((c) => c._id === activeChild)?.name ?? ""
          }
          childImage={
            childOptions.find((c) => c._id === activeChild)?.image ?? null
          }
          programGuest={
            childOptions.find((c) => c._id === activeChild)
              ?.enrollmentStanding === "program_guest"
          }
          tab={tab}
        />
      )}
    </Container>
  );
}

function ChildView({
  scholarId,
  childName,
  childImage,
  programGuest,
  tab,
}: {
  scholarId: Id<"users">;
  childName: string;
  childImage: string | null;
  programGuest: boolean;
  tab: ParentTab;
}) {
  const summary = useQuery(
    api.parents.childSummary,
    programGuest ? "skip" : { scholarId },
  );
  const setChildPhoto = useMutation(api.parents.setChildPhoto);
  const [photoDialogOpen, setPhotoDialogOpen] = useState(false);
  return (
    <VStack align="stretch" gap={6}>
      {tab === "records" && (
        <>
          <Box
            bg="white"
            borderRadius="xl"
            borderWidth="1px"
            borderColor="gray.200"
            p={6}
          >
            <HStack gap={4} align="center">
              <Box
                as="button"
                position="relative"
                flexShrink={0}
                cursor="pointer"
                borderRadius="full"
                aria-label={`Change ${childName || "your child"}'s photo`}
                onClick={() => setPhotoDialogOpen(true)}
              >
                <Avatar
                  name={childName || summary?.name}
                  src={childImage ?? undefined}
                  size="lg"
                  colorKey={scholarId}
                />
                <Box
                  position="absolute"
                  bottom={0}
                  right={0}
                  bg="violet.500"
                  borderRadius="full"
                  w={7}
                  h={7}
                  display="flex"
                  alignItems="center"
                  justifyContent="center"
                  border="2px solid white"
                >
                  <Camera size={14} color="white" />
                </Box>
              </Box>
              <Box flex={1} minW={0}>
                <Heading
                  size="lg"
                  fontFamily="heading"
                  color="navy.500"
                  mb={1}
                >
                  {summary?.name ?? childName ?? "Loading…"}
                </Heading>
                {summary &&
                  (summary.totalSessions > 0 ||
                    summary.masteryDomainCount > 0 ||
                    summary.masteryObservationCount > 0) && (
                    <HStack gap={6} mt={3} flexWrap="wrap">
                      {summary.totalSessions > 0 && (
                        <Stat
                          label="Sessions"
                          value={String(summary.totalSessions)}
                        />
                      )}
                      {summary.masteryDomainCount > 0 && (
                        <Stat
                          label="Topics explored"
                          value={String(summary.masteryDomainCount)}
                        />
                      )}
                      {summary.masteryObservationCount > 0 && (
                        <Stat
                          label="Mastery notes"
                          value={String(summary.masteryObservationCount)}
                        />
                      )}
                    </HStack>
                  )}
              </Box>
            </HStack>
          </Box>

          <ScholarPhotoDialog
            open={photoDialogOpen}
            onClose={() => setPhotoDialogOpen(false)}
            scholarName={childName || summary?.name || "your child"}
            currentImage={childImage}
            onSave={async (imageStorageId) => {
              await setChildPhoto({ scholarId, imageStorageId });
            }}
          />
        </>
      )}

      {tab === "progress" && (
        <>
          <ProgressTab scholarId={scholarId} />
          <SharedNarratives scholarId={scholarId} />
        </>
      )}
      {tab === "portfolio" && !programGuest && (
        <PortfolioGrid scholarId={scholarId} />
      )}
      {tab === "records" && (
        <VStack align="stretch" gap={4}>
          {!programGuest && (
            <ParentLibraryCard key={scholarId} scholarId={scholarId} />
          )}
        </VStack>
      )}
      {tab === "math" && (
        <ParentMathSkillsTab
          scholarId={scholarId}
          scholarName={summary?.name ?? ""}
        />
      )}
      {tab === "calendar" && <ParentCalendarTab scholarId={scholarId} />}
      {tab === "settings" && <NotificationSettings />}
    </VStack>
  );
}

/**
 * An Extended Education child has no school record — no sessions, mastery,
 * portfolio or school calendar — so the portal shows their guardian a
 * deliberately limited view. This explains what IS here (forms and messages)
 * instead of leaving the missing surfaces unexplained.
 */
function ExtendedEducationNotice({ childName }: { childName: string }) {
  return (
    <Box
      bg="violet.50"
      borderRadius="xl"
      borderWidth="1px"
      borderColor="violet.100"
      p={5}
    >
      <Heading size="sm" fontFamily="heading" color="navy.500" mb={1}>
        {EXTENDED_EDUCATION_LABEL}
      </Heading>
      <Text fontFamily="body" fontSize="sm" color="charcoal.500">
        {childName || "Your child"} joins us as a visiting student, so school
        record pages — learning sessions, mastery, portfolio and the school
        calendar — aren&apos;t part of this account. You can still complete the
        forms below and message the program team.
      </Text>
    </Box>
  );
}

/**
 * The parent Math Skills tab: the shared per-domain grade + growth portrait
 * (guardian-gated, non-sensitive), with a CTA that seeds the parent aide's
 * docked composer with "What is <name> working on in math?" — the parent
 * reviews/edits and hits send in the ONE portal chat (the header-Robot dock),
 * exactly like the teacher Curriculum landing's "Ask the bot" door. No second
 * inline chat; the tab stays a calm portrait.
 *
 * Below the portrait sits a row of CANNED QUESTIONS focused narrowly on ways
 * parents can enrich math at home, not skill tracking or progress reporting.
 * Because each is complete as written, a tap sends it
 * immediately via `seedComposer(q, { send: true })` rather than prefilling.
 * The chips render only when the aide dock is present.
 */
function ParentMathSkillsTab({
  scholarId,
  scholarName,
}: {
  scholarId: Id<"users">;
  scholarName: string;
}) {
  const portrait = useQuery(api.parents.childMathPortrait, { scholarId });
  const aide = useAideDockOptional();
  const cannedQuestions = parentMathCannedQuestions(scholarName);

  return (
    <VStack align="stretch" gap={5}>
      <MathSkillsPortrait
        portrait={portrait}
        scholarName={scholarName}
        onAskAi={aide ? (question) => aide.seedComposer(question) : undefined}
      />
      {aide && (
        <Flex wrap="wrap" gap={2}>
          {cannedQuestions.map((q) => (
            <Button
              key={q}
              size="sm"
              variant="outline"
              colorPalette="violet"
              fontFamily="heading"
              fontWeight="500"
              h="auto"
              py={2}
              whiteSpace="normal"
              textAlign="left"
              onClick={() =>
                sendParentMathCannedQuestion(q, aide.seedComposer)
              }
            >
              {q}
            </Button>
          ))}
        </Flex>
      )}
    </VStack>
  );
}

/**
 * Notification preferences. SCAFFOLD — toggling these stores the setting;
 * nothing actually sends yet (digests + homework reminders are a future
 * phase). Copy is honest about that so a parent isn't misled.
 */
function NotificationSettings() {
  const prefs = useQuery(api.notifications.getMyPrefs);
  const update = useMutation(api.notifications.updateMyPrefs);
  // `null` = not editing (show the saved value); a string = an in-progress
  // edit. Deriving the input value this way avoids syncing state in an effect.
  const [draftPhone, setDraftPhone] = useState<string | null>(null);
  const [draftAddress, setDraftAddress] = useState<string | null>(null);

  if (prefs === undefined) return <Spinner size="sm" color="violet.400" />;

  const savedPhone = prefs.phone ?? "";
  const phone = draftPhone ?? savedPhone;
  const phoneDirty = draftPhone !== null && draftPhone !== savedPhone;

  const savedAddress = prefs.address ?? "";
  const address = draftAddress ?? savedAddress;
  const addressDirty = draftAddress !== null && draftAddress !== savedAddress;

  return (
    <Card title="Notifications">
      <Text fontFamily="body" fontSize="sm" color="charcoal.400" mb={4}>
        Choose how you&apos;d like to hear about your child&apos;s learning.
        These are coming soon — saving your choices now means you&apos;ll be
        set up when they go live.
      </Text>
      <VStack align="stretch" gap={4}>
        <ToggleRow
          label="Email updates"
          checked={prefs.emailEnabled}
          onChange={(v) => update({ emailEnabled: v })}
        />
        <ToggleRow
          label="Weekly digest"
          help="A Sunday summary of the week's learning."
          checked={prefs.weeklyDigest}
          onChange={(v) => update({ weeklyDigest: v })}
        />
        <ToggleRow
          label="Homework reminders"
          help="A nudge when an assignment is still open past its date."
          checked={prefs.homeworkReminders}
          onChange={(v) => update({ homeworkReminders: v })}
        />
        <ToggleRow
          label="Text message (SMS) updates"
          help="Requires a mobile number below."
          checked={prefs.smsEnabled}
          onChange={(v) => update({ smsEnabled: v })}
        />
        <Box>
          <Text fontFamily="heading" fontSize="xs" color="charcoal.500" mb={1}>
            Mobile number (for SMS)
          </Text>
          <HStack>
            <Input
              size="sm"
              type="tel"
              placeholder="(808) 555-0123"
              value={phone}
              onChange={(e) => setDraftPhone(e.target.value)}
              bg="gray.50"
              fontFamily="body"
              maxW="240px"
            />
            {phoneDirty && (
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={async () => {
                  await update({ phone });
                  setDraftPhone(null);
                }}
              >
                Save
              </Button>
            )}
          </HStack>
        </Box>
        <Box>
          <Text fontFamily="heading" fontSize="xs" color="charcoal.500" mb={1}>
            Mailing address
          </Text>
          <Text fontFamily="body" fontSize="2xs" color="charcoal.400" mb={1}>
            Shared with the school office only — never with other families.
          </Text>
          <HStack>
            <Input
              size="sm"
              placeholder="123 Kalakaua Ave, Honolulu, HI 96815"
              value={address}
              onChange={(e) => setDraftAddress(e.target.value)}
              bg="gray.50"
              fontFamily="body"
              maxW="360px"
            />
            {addressDirty && (
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={async () => {
                  await update({ address });
                  setDraftAddress(null);
                }}
              >
                Save
              </Button>
            )}
          </HStack>
        </Box>
      </VStack>
    </Card>
  );
}

function ToggleRow({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Flex justify="space-between" align="center" gap={4}>
      <Box>
        <Text fontFamily="heading" fontSize="sm" color="charcoal.600">
          {label}
        </Text>
        {help && (
          <Text fontFamily="body" fontSize="xs" color="charcoal.300">
            {help}
          </Text>
        )}
      </Box>
      <Switch.Root
        checked={checked}
        onCheckedChange={(e) => onChange(e.checked)}
      >
        <Switch.HiddenInput />
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Root>
    </Flex>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <VStack gap={0} align="start">
      <Text fontFamily="heading" fontSize="2xl" fontWeight="700" color="violet.600">
        {value}
      </Text>
      <Text fontFamily="body" fontSize="xs" color="charcoal.400">
        {label}
      </Text>
    </VStack>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box bg="white" borderRadius="xl" borderWidth="1px" borderColor="gray.200" p={5}>
      <Heading size="sm" fontFamily="heading" color="navy.500" mb={3}>
        {title}
      </Heading>
      {children}
    </Box>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <Text fontFamily="body" fontSize="sm" color="charcoal.300">
      {children}
    </Text>
  );
}

function ProgressTab({ scholarId }: { scholarId: Id<"users"> }) {
  const mastery = useQuery(api.parents.childMastery, { scholarId });
  const signals = useQuery(api.parents.childSignals, { scholarId });
  const seeds = useQuery(api.parents.childSeeds, { scholarId });
  const sessions = useQuery(api.parents.childSessions, { scholarId });

  return (
    <VStack align="stretch" gap={5}>
      <Card title="What they understand — and what they don't yet">
        {mastery === undefined ? (
          <Spinner size="sm" color="violet.400" />
        ) : Object.keys(mastery).length === 0 ? (
          <Empty>No mastery notes yet — they&apos;ll appear as your child works.</Empty>
        ) : (
          <VStack align="stretch" gap={6}>
            {Object.entries(mastery).map(([domain, groups]) => (
              <Box key={domain}>
                <Text
                  fontFamily="heading"
                  fontWeight="700"
                  fontSize="sm"
                  color="navy.500"
                  mb={3}
                >
                  {domain}
                </Text>

                {groups.understands.length > 0 && (
                  <Box mb={groups.notYet.length > 0 ? 4 : 0}>
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize="xs"
                      textTransform="uppercase"
                      letterSpacing="wide"
                      color="green.700"
                      mb={2}
                    >
                      Understands
                    </Text>
                    <VStack align="stretch" gap={3}>
                      {groups.understands.map((c, i) => (
                        <Box key={i}>
                          <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.600">
                            {c.concept}
                          </Text>
                          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.5">
                            {c.evidence}
                          </Text>
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                )}

                {groups.notYet.length > 0 && (
                  <Box
                    borderLeftWidth="3px"
                    borderColor="orange.300"
                    pl={3}
                    py={1}
                  >
                    <Text
                      fontFamily="heading"
                      fontWeight="600"
                      fontSize="xs"
                      textTransform="uppercase"
                      letterSpacing="wide"
                      color="orange.700"
                      mb={2}
                    >
                      Doesn&apos;t understand yet
                    </Text>
                    <VStack align="stretch" gap={3}>
                      {groups.notYet.map((c, i) => (
                        <Box key={i}>
                          <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.600">
                            {c.concept}
                          </Text>
                          <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.5">
                            {c.note ?? c.evidence}
                          </Text>
                        </Box>
                      ))}
                    </VStack>
                  </Box>
                )}
              </Box>
            ))}
          </VStack>
        )}
      </Card>

      <Card title="Learning strengths">
        {signals === undefined ? (
          <Spinner size="sm" color="violet.400" />
        ) : Object.keys(signals).length === 0 ? (
          <Empty>No signals recorded yet.</Empty>
        ) : (
          <Flex gap={2} flexWrap="wrap">
            {Object.entries(signals)
              .sort((a, b) => b[1].count - a[1].count)
              .map(([type, s]) => (
                <Box
                  key={type}
                  px={3}
                  py={1.5}
                  borderRadius="full"
                  borderWidth="1px"
                  borderColor="gray.200"
                  bg="gray.50"
                >
                  <Text fontFamily="heading" fontSize="xs" color="charcoal.600" textTransform="capitalize">
                    {type.replace(/_/g, " ")} · {s.count}
                  </Text>
                </Box>
              ))}
          </Flex>
        )}
      </Card>

      <Card title="What's next">
        {seeds === undefined ? (
          <Spinner size="sm" color="violet.400" />
        ) : seeds.length === 0 ? (
          <Empty>No exploration suggestions right now.</Empty>
        ) : (
          <VStack align="stretch" gap={3}>
            {seeds.map((s, i) => (
              <Box key={i}>
                <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.600">
                  {s.topic}
                  {s.domain ? (
                    <Text as="span" color="charcoal.300" fontWeight="400">
                      {" "}· {s.domain}
                    </Text>
                  ) : null}
                </Text>
                <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                  {s.rationale}
                </Text>
              </Box>
            ))}
          </VStack>
        )}
      </Card>

      <Card title="Recent work">
        {sessions === undefined ? (
          <Spinner size="sm" color="violet.400" />
        ) : sessions.length === 0 ? (
          <Empty>No sessions yet.</Empty>
        ) : (
          <VStack align="stretch" gap={3}>
            {sessions.map((p, i) => (
              <Box key={i} pb={3} borderBottomWidth={i < sessions.length - 1 ? "1px" : "0"} borderColor="gray.100">
                <Flex justify="space-between" align="baseline" gap={3}>
                  <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.600">
                    {p.title}
                    {p.unitTitle ? (
                      <Text as="span" color="charcoal.300" fontWeight="400">
                        {" "}· {p.unitTitle}
                      </Text>
                    ) : null}
                  </Text>
                  <Text fontFamily="body" fontSize="xs" color="charcoal.300" flexShrink={0}>
                    {formatRelative(p.createdAt)}
                  </Text>
                </Flex>
                {p.analysisSummary && (
                  <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1}>
                    {p.analysisSummary}
                  </Text>
                )}
              </Box>
            ))}
          </VStack>
        )}
      </Card>
    </VStack>
  );
}

function PortfolioGrid({ scholarId }: { scholarId: Id<"users"> }) {
  const items = useQuery(api.portfolio.listForGuardian, { scholarId });
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  if (items === undefined) {
    return <Spinner size="sm" color="violet.400" />;
  }
  if (items.length === 0) {
    return <Empty>No family-visible work samples yet.</Empty>;
  }
  const modalItems = items.filter(
    (item) => item.kind !== "file" || item.fileMimeType !== "application/pdf",
  );
  const closeViewer = () => {
    setOpenIndex(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <>
      {openIndex !== null && (
        <ParentPortfolioViewer
          activeIndex={openIndex}
          fileUrl={modalItems[openIndex]?.fileUrl}
          items={modalItems as ParentPortfolioItem[]}
          onClose={closeViewer}
          onIndexChange={setOpenIndex}
        />
      )}

      <Grid templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={4}>
        {items.map((item, index) => {
          const isPdf =
            item.kind === "file" &&
            item.fileMimeType === "application/pdf";
          const pageCount = pageCountForRange(
            item.kind === "file" ? item.pageRange : undefined,
          );
          const viewable = item.kind !== "file" || item.hasFile;
          const content = (
            <>
              {item.kind === "map" && (
                <Flex
                  align="center"
                  bg="violet.50"
                  borderRadius="lg"
                  color="violet.600"
                  direction="column"
                  gap={2}
                  h={{ base: "180px", md: "220px" }}
                  justify="center"
                  mb={3}
                >
                  <MapTrifold size={44} weight="duotone" />
                  <Text fontFamily="heading" fontSize="sm" fontWeight="600">
                    View map
                  </Text>
                </Flex>
              )}
              {item.kind === "text" && (
                <Box
                  bg="gray.50"
                  borderRadius="lg"
                  h={{ base: "180px", md: "220px" }}
                  mb={3}
                  overflow="hidden"
                  p={5}
                  position="relative"
                >
                  <FileText size={24} color="#805AD5" />
                  <Text
                    color="charcoal.500"
                    fontFamily="body"
                    fontSize="sm"
                    lineClamp={6}
                    mt={3}
                    whiteSpace="pre-wrap"
                  >
                    {item.content}
                  </Text>
                </Box>
              )}
              {item.thumbUrl && (
                <Box
                  bg="gray.50"
                  borderRadius="lg"
                  h={{ base: "180px", md: "220px" }}
                  mb={3}
                  overflow="hidden"
                  position="relative"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- Convex signed storage URL is dynamic. */}
                  <img
                    src={item.thumbUrl}
                    alt=""
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                  {pageCount !== null && (
                    <Text
                      bg="blackAlpha.700"
                      borderRadius="full"
                      bottom={2}
                      color="white"
                      fontFamily="heading"
                      fontSize="xs"
                      left={2}
                      lineHeight="1"
                      position="absolute"
                      px={2.5}
                      py={1.5}
                    >
                      {pageCount} {pageCount === 1 ? "page" : "pages"}
                    </Text>
                  )}
                  {isPdf && item.fileUrl && (
                    <Flex
                      data-new-tab-hint
                      align="center"
                      bg="whiteAlpha.900"
                      borderRadius="full"
                      color="charcoal.700"
                      fontFamily="heading"
                      fontSize="xs"
                      gap={1.5}
                      opacity={0}
                      position="absolute"
                      px={2.5}
                      py={1.5}
                      right={2}
                      top={2}
                      transform="translateY(-4px)"
                      transition="opacity 120ms ease, transform 120ms ease"
                    >
                      Open in new tab <ArrowSquareOut weight="bold" />
                    </Flex>
                  )}
                </Box>
              )}
              <Text fontFamily="heading" fontWeight="600" fontSize="sm" color="charcoal.600">
                {item.title}
              </Text>
              {item.attributionCount > 1 && (
                <Text color="violet.600" fontFamily="heading" fontSize="xs" mt={1}>
                  Shared work · {item.attributionCount} scholars
                </Text>
              )}
              {item.kind === "file" && item.aiCaption && (
                <Text fontFamily="body" fontSize="sm" color="charcoal.400" mt={1}>
                  {item.aiCaption}
                </Text>
              )}
              <Text fontFamily="body" fontSize="xs" color="charcoal.300" mt={2}>
                {formatRelative(item._creationTime)}
                {item.activityTitle ? ` · ${item.activityTitle}` : ""}
                {viewable
                  ? isPdf
                    ? " · Opens in new tab"
                    : item.kind === "map"
                      ? " · View map"
                      : " · View work"
                  : ""}
              </Text>
            </>
          );
          const interactionStyles = viewable
            ? {
                borderColor: "violet.300",
                "& [data-new-tab-hint]": {
                  opacity: 1,
                  transform: "translateY(0)",
                },
              }
            : undefined;

          if (isPdf && item.fileUrl) {
            return (
              <chakra.a
                key={item._id}
                bg="white"
                borderColor="gray.200"
                borderRadius="xl"
                borderWidth="1px"
                cursor="pointer"
                href={item.fileUrl}
                p={4}
                rel="noopener noreferrer"
                role="group"
                target="_blank"
                textAlign="left"
                _focusVisible={{
                  outline: "2px solid",
                  outlineColor: "violet.400",
                  outlineOffset: "2px",
                  ...interactionStyles,
                }}
                _hover={interactionStyles}
              >
                {content}
              </chakra.a>
            );
          }

          return (
            <chakra.button
              key={item._id}
              bg="white"
              borderColor="gray.200"
              borderRadius="xl"
              borderWidth="1px"
              cursor={viewable ? "pointer" : "default"}
              disabled={!viewable}
              onClick={(event) => {
                if (!viewable) return;
                triggerRef.current = event.currentTarget;
                setOpenIndex(
                  modalItems.findIndex(
                    (modalItem) => modalItem._id === items[index]._id,
                  ),
                );
              }}
              p={4}
              role="group"
              textAlign="left"
              _hover={interactionStyles}
            >
              {content}
            </chakra.button>
          );
        })}
      </Grid>
    </>
  );
}

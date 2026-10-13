"use client";

import { useNow } from "@/hooks/useNow";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useAction } from "convex/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useHealthManagementAccess } from "@/hooks/useSchoolOperationsAccess";
import { isPlatformAdminRole } from "@/convex/lib/roles";
import {
  MIN_TYPED_WORDS_FOR_ESTIMATE,
  READ_LEVELS,
  READ_LEVEL_LABELS,
  WRITE_MODES,
  WRITE_MODE_LABELS,
  talkLevelLabel,
  writingEstimateText,
  type ReadLevel,
  type WriteMode,
} from "@/convex/lib/readingLevels";
import { api } from "@/convex/_generated/api";
import { toaster } from "@/lib/toaster";
import type { Id } from "@/convex/_generated/dataModel";
import { EXTENDED_EDUCATION_LABEL } from "@/shared/scholarGroupRouting";
import { serverErrorMessage } from "@/lib/serverErrorMessage";
import {
  Box,
  Flex,
  VStack,
  HStack,
  Text,
  Button,
  IconButton,
  Textarea,
  Spinner,
  Badge,
  Input,
  Dialog,
  Portal,
  Switch,
  Separator,
  Menu,
} from "@chakra-ui/react";
import { Avatar } from "@/components/Avatar";
import {
  Trash,
  BookOpenText,
  FileText,
  User,
  FolderSimple,
  Clock,
  Chat,
  House,
  TrendUp,
  Eye,
  SpeakerHigh,
  Key,
  Flag,
  DotsThree,
  Gear,
  Notebook,
  Sparkle,
  Plus,
  PenNib,
  FirstAid,
  RocketLaunch,
  TreeStructure,
  BracketsCurly,
} from "@phosphor-icons/react";
import { ParentsManager } from "@/components/ParentsManager";
import {
  ISSUE_FAILED_GUIDANCE,
  canIssueSignInLink,
  passwordActionLabel,
} from "@/components/scholarSignInLinkUtils";
import { usernameError } from "@/convex/lib/username";
import { AwardBadgeDialog } from "@/components/AwardBadgeDialog";
import { ScholarAssignmentsCard } from "@/components/ScholarAssignmentsCard";
import { ScholarHomeMirrorCard } from "@/components/ScholarHomeMirrorCard";
import { ScholarQuestsCard } from "@/components/ScholarQuestsCard";
import { ScholarBadgesCard } from "@/components/ScholarBadgesCard";
import { ScholarFeed } from "@/components/ScholarFeed";
import {
  ObservationCard,
  type ObservationType,
} from "@/components/ObservationCard";
import { ActivitySessionsCard } from "@/components/ActivitySessionsCard";
import { MasteryTab } from "@/components/MasteryTab";
import { Map } from "@/components/Map";
import { SeedsTab } from "@/components/SeedsTab";
import { DirectivesTab } from "@/components/DirectivesTab";
import TeacherGoalsPanel from "@/components/scholarGoals/TeacherGoalsPanel";
import TeacherWeeklyGoalsPanel from "@/components/scholarGoals/TeacherWeeklyGoalsPanel";
import { DocumentsTab } from "@/components/DocumentsTab";
import { PortfolioTab } from "@/components/PortfolioTab";
import { SignalsTab } from "@/components/SignalsTab";
import { GraphemeInventoryEditor } from "@/components/GraphemeInventoryEditor";
import { FieldSelect } from "@/components/ui/FieldSelect";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";
import { Surface } from "@/components/ui/Surface";
import { PaneTabs } from "@/components/ui/PaneTabs";
import { SubNav } from "@/components/ui/SubNav";
import { MathSkillsPortrait } from "@/components/practice/MathSkillsPortrait";
import { useAideDockOptional } from "@/components/aide/AideDockProvider";
import { EmptyState } from "@/components/ui/EmptyState";
import { GenericBodySkeleton } from "@/app/teacher/(dashboard)/_components/Skeletons";
import { useSmoothedQuery, useSmoothedQueryWithPending } from "@/hooks/useSmoothedQuery";
import {
  LevelsGrowthChart,
  ReadEvidence,
  TalkEvidence,
  WriteEvidence,
  type ScannedSample,
  type VocabularyWin,
} from "@/components/TalkReadWriteEvidence";
import { ScholarAppsManager } from "@/components/ScholarAppsManager";
import { HealthRecordStaffView } from "@/components/HealthRecordStaffView";
import { formatRelative, formatTimeAgo } from "@/lib/relativeTime";

export type ScholarTabKey = "feed" | "map" | "quests" | "skills" | "dossier" | "documents" | "now" | "portfolio" | "guidance" | "settings";
/** Intents dispatched from the header "+ Add" menu. */
export type ScholarAddAction = "note" | "report" | "file" | "badge";
type TabKey = ScholarTabKey;
// Map tab sections (spatial Tree/Sky moved out to the Quests + Math Skills tabs).
type MapSection = "mastery" | "connections" | "reading";
// Math Skills tab sections.
type SkillsSection = "portrait" | "tree";

interface ScholarProfileProps {
  scholarId: string;
  institutionScope?: string;
  activeTab?: TabKey;
  onTabChange?: (tab: TabKey) => void;
  onDelete?: () => void;
  /** Open one observation's evidence record (a ?obs= deep link); threaded to the Feed. */
  onOpenObservation?: (observationId: string) => void;
  /**
   * "teacher" (default) shows all controls; "operations" restricts to
   * account-admin + portfolio and hides all sensitive learning data.
   * (Scholars have their own purpose-built self-view — MyLearningView at
   * /me — and parents have ParentDashboard; neither renders this.)
   */
  mode?: "teacher" | "operations";
  /**
   * A pending "add" intent dispatched from the header "+ Add" menu. The page
   * switches to the right tab (for note/report/file) and sets this; the profile
   * opens the matching form/dialog and calls onAddConsumed to clear it.
   */
  addAction?: ScholarAddAction | null;
  onAddConsumed?: () => void;
}

function buildReadingLevels(): { value: string; label: string }[] {
  const levels: { value: string; label: string }[] = [
    { value: "", label: "Not set" },
    { value: "K", label: "K — Kindergarten" },
  ];
  for (let grade = 1; grade <= 12; grade++) {
    levels.push({ value: String(grade), label: `Grade ${grade}` });
    for (let tenth = 1; tenth <= 9; tenth++) {
      levels.push({ value: `${grade}.${tenth}`, label: `Grade ${grade}.${tenth}` });
    }
  }
  levels.push({ value: "college", label: "College" });
  return levels;
}
const READING_LEVELS = buildReadingLevels();

// Read and write controls (TRA-503). Unset reads as the default (reader / own),
// so there is no "Not set" option: the select shows what the tutor acts on.
const READ_OPTIONS = READ_LEVELS.map((value) => ({
  value,
  label: READ_LEVEL_LABELS[value],
}));
const WRITE_OPTIONS = WRITE_MODES.map((value) => ({
  value,
  label: WRITE_MODE_LABELS[value],
}));

// Chronological grade options for the Knowledge Tree notch (users.gradeLevel).
// K–8 only — must match the acceleration grade columns (ACCELERATION_GRADES).
// Common pronoun sets offered as a datalist. Deliberately a SUGGESTION list on
// a free-text input, not a closed select: a fixed menu tells a child their
// answer has to be on someone else's list. Staff can type anything.
const PRONOUN_SUGGESTIONS = ["she/her", "he/him", "they/them", "she/they", "he/they"];

const GRADE_LEVELS: { value: string; label: string }[] = [
  { value: "", label: "Not set" },
  { value: "K", label: "K — Kindergarten" },
  ...["1", "2", "3", "4", "5", "6", "7", "8"].map((g) => ({
    value: g,
    label: `Grade ${g}`,
  })),
];

const ALL_TABS: { key: TabKey; label: string; icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }> }[] = [
  { key: "feed", label: "Feed", icon: House },
  { key: "map", label: "Map", icon: TrendUp },
  { key: "quests", label: "Quests", icon: RocketLaunch },
  { key: "skills", label: "Math skills", icon: TreeStructure },
  { key: "dossier", label: "Dossier", icon: FileText },
  { key: "documents", label: "Documents", icon: Notebook },
  { key: "now", label: "Now", icon: Clock },
  { key: "portfolio", label: "Portfolio", icon: FolderSimple },
  { key: "guidance", label: "Guidance", icon: Sparkle },
  { key: "settings", label: "Settings", icon: Gear },
];

// Tabs visible to operations staff: the Feed (non-sensitive overview), Portfolio
// (the accumulated record — portfolio items only for operations staff), Documents
// (the administrative record kinds they may file — incident reports, transfer
// records, conference notes, doctor's notes, report cards — plus health-record
// attachments; the merged list never shows them an assessment or IEP), and
// Settings (identity + password + parents). No map/dossier/guidance/now (all sensitive learning data).
// Settings is the gear.
const OPERATIONS_TABS: TabKey[] = [
  "feed",
  "portfolio",
  "documents",
  "settings",
];

// timeAgo dropped — use formatTimeAgo from lib/relativeTime

// One shape for every section header inside a Surface card: a violet.500
// icon (token, not the old hard-coded #AD60BF) + a navy.500 title, with an
// optional right-aligned action (e.g. an "Add" affordance). Keeps every
// section on Scholar detail reading identically instead of each card
// re-deriving its own heading.
function CardHeading({
  icon,
  title,
  hint,
  action,
  mb = 3,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  mb?: number;
}) {
  return (
    <Flex justify="space-between" align="center" gap={2} mb={mb}>
      <HStack gap={2} minW={0} flex={1}>
        {icon && (
          <Box color="violet.500" lineHeight="0" display="flex" flexShrink={0}>
            {icon}
          </Box>
        )}
        <Text fontWeight="600" fontFamily="heading" color="navy.500" fontSize="sm" whiteSpace="nowrap" flexShrink={0}>
          {title}
        </Text>
        {hint && (
          <Text fontSize="xs" color="charcoal.400" fontFamily="body" lineClamp={1} minW={0}>
            {hint}
          </Text>
        )}
      </HStack>
      {action && <Box flexShrink={0}>{action}</Box>}
    </Flex>
  );
}

// The quiet house empty state now lives in components/ui/EmptyState (the one
// canonical primitive). This file's three former QuietEmpty call sites use
// <EmptyState title=… hint=… /> directly.

// The ghost-violet "+ Add X" affordance used to reveal a collapsed entry
// form — same idiom as the Seeds tab's "Add Seed" / "Add Directive" so adding an
// observation, report, seed, or directive all look and behave alike.
function AddToggle({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="xs"
      variant="ghost"
      color={active ? "charcoal.400" : "violet.500"}
      fontFamily="heading"
      fontSize="xs"
      _hover={{ bg: active ? "gray.100" : "violet.50" }}
      onClick={onClick}
    >
      {active ? "Cancel" : (<><Plus style={{ marginRight: "4px" }} /> {label}</>)}
    </Button>
  );
}

// Interests block for the Dossier tab — the canonical home for a scholar's
// interests (T1: one rendering). `how` is the interest's provenance; its pill
// hue is fixed here so the same source always reads the same way.
type TeacherInterestHow = "said" | "picked" | "menu" | "teacher";
type TeacherInterest = {
  label: string;
  how: TeacherInterestHow;
  dates: number[];
  sessionIds: Id<"sessions">[];
  words?: string;
  state: "active" | "past";
  changedBy?: "teacher" | "observer";
};

const INTEREST_PILL: Record<TeacherInterestHow, { bg: string; color: string; label: string }> = {
  said: { bg: "teal.50", color: "teal.600", label: "said" },
  picked: { bg: "violet.50", color: "violet.600", label: "picked" },
  menu: { bg: "gray.100", color: "charcoal.500", label: "menu" },
  teacher: { bg: "amber.50", color: "amber.600", label: "teacher" },
};

function formatInterestDate(ms: number): string {
  // UTC, to match how mergeInterests dedupes days and how the prompt renders them.
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function InterestRow({
  interest,
  onToggle,
}: {
  interest: TeacherInterest;
  onToggle: (label: string, state: "active" | "past") => void;
}) {
  const pill = INTEREST_PILL[interest.how];
  const isPast = interest.state === "past";
  const recent = [...interest.dates].sort((a, b) => b - a);
  const shown = recent.slice(0, 3).reverse();
  const extra = recent.length - shown.length;
  return (
    <HStack gap={2} align="baseline" opacity={isPast ? 0.6 : 1}>
      <Text fontSize="sm" fontFamily="body" fontWeight="600" color="charcoal.600" flexShrink={0}>
        {interest.label}
      </Text>
      <Badge bg={pill.bg} color={pill.color} fontSize="xs" flexShrink={0}>
        {pill.label}
      </Badge>
      {shown.length > 0 && (
        <Text as="span" fontSize="xs" color="charcoal.400" fontFamily="body" flexShrink={0}>
          {shown.map(formatInterestDate).join(", ")}
          {extra > 0 ? ` +${extra}` : ""}
        </Text>
      )}
      {interest.words && (
        <Text
          as="span"
          fontSize="xs"
          color="charcoal.400"
          fontFamily="body"
          fontStyle="italic"
          lineClamp={1}
          minW={0}
          title={interest.words}
        >
          “{interest.words}”
        </Text>
      )}
      {isPast && (
        <Text as="span" fontSize="xs" color="charcoal.300" fontFamily="body" flexShrink={0}>
          past
        </Text>
      )}
      <Button
        size="xs"
        variant="ghost"
        color="violet.500"
        fontFamily="heading"
        fontSize="xs"
        flexShrink={0}
        ml="auto"
        _hover={{ bg: "violet.50" }}
        onClick={() => onToggle(interest.label, isPast ? "active" : "past")}
      >
        {isPast ? "Mark active" : "Mark past"}
      </Button>
    </HStack>
  );
}

function InterestsBlock({
  interests,
  legend,
  onToggle,
}: {
  interests: TeacherInterest[] | undefined;
  legend: string | undefined;
  onToggle: (label: string, state: "active" | "past") => void;
}) {
  if (!interests || interests.length === 0) {
    return (
      <Text fontSize="xs" color="charcoal.400" fontFamily="body" mb={4}>
        No interests recorded yet — the observer adds them from what the scholar says or picks.
      </Text>
    );
  }
  const ordered = [
    ...interests.filter((i) => i.state === "active"),
    ...interests.filter((i) => i.state === "past"),
  ];
  return (
    <Box mb={4}>
      <VStack gap="6px" align="stretch">
        {ordered.map((interest) => (
          <InterestRow key={interest.label.trim().toLowerCase()} interest={interest} onToggle={onToggle} />
        ))}
      </VStack>
      {legend && (
        <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={2}>
          {legend}
        </Text>
      )}
    </Box>
  );
}

export function ScholarProfile({ scholarId, institutionScope, activeTab: controlledTab, onTabChange, onDelete, onOpenObservation, mode = "teacher", addAction = null, onAddConsumed }: ScholarProfileProps) {
  // Operations staff: account-admin + portfolio only. Skip every sensitive read
  // (they're teacher-gated server-side and would 403) and hide the
  // sensitive UI blocks below.
  const isOperationsMode = mode === "operations";
  const { user: currentUser } = useCurrentUser();
  // Health records are a capability distinct from the operations access that
  // grants this ops-mode view — resolve it against the institution in view so
  // the "Health & emergency information" block (which mounts teacher/health-
  // gated queries that throw for a viewer without health:manage) only renders
  // for someone who may actually read it. Tri-state: `undefined` while loading;
  // gate on `=== true` so an unknown signal never mounts the health surface.
  const { hasHealthManagementAccess } = useHealthManagementAccess(
    currentUser,
    !!currentUser,
  );
  const isAdmin = isPlatformAdminRole(currentUser?.role);
  const [internalTab, setInternalTab] = useState<TabKey>("feed");
  const activeTab = controlledTab ?? internalTab;
  const setActiveTab = onTabChange ?? setInternalTab;
  const [progressSection, setProgressSection] = useState<MapSection>("mastery");
  const [skillsSection, setSkillsSection] = useState<SkillsSection>("portrait");
  // The Map tab shows the UNIFIED all-domains tree (no per-domain switcher) —
  // every seeded practice domain on one big map, grouped + colour-coded by
  // domain (the tree analogue of the sky's per-domain regions).
  const deleteUser = useMutation(api.users.deleteUser);
  const issuePinLink = useMutation(api.enrollment.issueScholarEnrollLink);
  // Passkey recovery: scholars' passwords always keep working, so removing
  // a lost passkey instantly restores password sign-in (no token dance).
  const resetPasskeys = useMutation(api.passkeys.resetForScholar);
  const passkeyCount =
    useQuery(api.passkeys.countForScholar, {
      scholarId: scholarId as Id<"users">,
    }) ?? 0;
  // Smoothed so switching scholars in the left rail doesn't drop the whole
  // profile to a skeleton and back (a hard flicker + layout jump): the previous
  // scholar's profile is held until the new one loads, and `profileSwapping`
  // dims the body during the swap so stale data is never read as current.
  // `profile === undefined` now only before the very first load.
  const { data: profile, isPending: profileSwapping } =
    useSmoothedQueryWithPending(api.scholars.getProfile, {
      scholarId: scholarId as Id<"users">,
    });
  // "Create password" (none stored yet) vs "Reset password" (already has one) —
  // the same credential-presence signal the school-admin roster uses, so one
  // concept has one name across both surfaces. Undefined while loading →
  // "Create password".
  const hasCredential = profile?.scholar.hasCredential;
  const passwordLabel = passwordActionLabel(hasCredential);
  // The one-time link keys off the username, so the password dialog points at
  // Account details instead of offering a link that can only fail.
  const needsUsername =
    profile !== undefined && !canIssueSignInLink(profile.scholar.username);
  // Math Skills portrait — loaded only while the Skills tab is open. Reuses the
  // same gatherer the parent portal reads, gated teacher/admin + institution.
  const mathPortrait = useQuery(
    api.mathPortrait.forScholar,
    !isOperationsMode && activeTab === "skills"
      ? { scholarId: scholarId as Id<"users"> }
      : "skip",
  );
  // The staff aide is mounted globally in the teacher shell; when present the
  // portrait's "what are they working on" CTA seeds it (no new chat surface).
  const aide = useAideDockOptional();
  const observations = useQuery(api.observations.listByScholar, isOperationsMode ? "skip" : { scholarId: scholarId as Id<"users"> }) ?? [];
  // Anti-parasocial signal: how often this scholar has flagged the AI as
  // wrong. Celebrated as a strength (healthy skepticism), not a concern.
  const aiCatches = useQuery(api.messageFlags.listForScholar, isOperationsMode ? "skip" : { scholarId: scholarId as Id<"users"> });
  const dossierContent = useQuery(api.dossier.getForTeacher, isOperationsMode ? "skip" : { scholarId: scholarId as Id<"users"> });
  const scholarSessions = useQuery(api.sessions.list, isOperationsMode ? "skip" : { userId: scholarId as Id<"users"> });
  const scholarAppStates = useQuery(
    api.appStates.listSessionStatesForScholar,
    !isOperationsMode && activeTab === "portfolio"
      ? { scholarId: scholarId as Id<"users"> }
      : "skip",
  );
  const shouldLoadReadingLevelInsights =
    !isOperationsMode && activeTab === "map" && progressSection === "reading";
  // Ages the estimate line ("N days ago"); a minute tick is plenty.
  const estimateNow = useNow(60_000);
  const scholarReadingTrend = useQuery(
    api.messages.getScholarReadingTrend,
    shouldLoadReadingLevelInsights ? { scholarId: scholarId as Id<"users"> } : "skip"
  );
  const tutorReadability = useQuery(
    api.messages.getRecentTutorReadabilityByScholar,
    shouldLoadReadingLevelInsights ? { scholarId: scholarId as Id<"users">, limit: 20 } : "skip"
  );
  // Evidence + growth for the three levels (TRA-515). The clock is a
  // minute-rounded argument (T11), so the 7-day / 2-week / 13-week windows
  // move without the query reading the wall clock.
  const minuteNow = Math.floor(useNow(60_000) / 60_000) * 60_000;
  const levelEvidence = useSmoothedQuery(
    api.levelEvidence.forScholar,
    shouldLoadReadingLevelInsights
      ? { scholarId: scholarId as Id<"users">, now: minuteNow }
      : "skip",
  );
  const adminUpdateScholarProfile = useMutation(api.users.adminUpdateScholarProfile);
  const institutions = useQuery(api.institutions.list, {}) ?? [];
  const setScholarInstitution = useMutation(api.institutions.setScholarInstitution);
  const setScholarEnrollmentStanding = useMutation(api.users.setScholarEnrollmentStanding);
  const updateDossier = useMutation(api.dossier.updateByTeacher);
  const scholarInterests = useQuery(
    api.dossier.interestsForTeacher,
    isOperationsMode ? "skip" : { scholarId: scholarId as Id<"users"> }
  );
  const setInterestState = useMutation(api.dossier.setInterestState);
  const updateReadingLevel = useMutation(api.scholars.updateReadingLevel);
  const updateReadLevel = useMutation(api.scholars.updateReadLevel);
  const updateWriteMode = useMutation(api.scholars.updateWriteMode);
  const updateAudioSettings = useMutation(api.scholars.updateAudioSettings);
  const runAIAnalysis = useAction(api.readingLevelAnalysis.analyzeReadingLevelAI);
  const addObservation = useMutation(api.observations.add);
  const removeObservation = useMutation(api.observations.remove);
  const setObservationType = useMutation(api.observations.setType);
  const { scholar, stats } = profile ?? {
    scholar: null,
    stats: { sessionCount: 0, messageCount: 0, observationCount: 0 },
  };

  const isLoading = profile === undefined;
  const vocabularyWinItems: VocabularyWin[] = scholarReadingTrend?.vocabularyWins ?? [];
  const scholarPortfolioSamples: ScannedSample[] = scholarReadingTrend?.portfolioSamples ?? [];

  const [dossierDraft, setDossierDraft] = useState<string | null>(null);
  const [isSavingReadingLevel, setIsSavingReadingLevel] = useState(false);
  const [awardBadgeOpen, setAwardBadgeOpen] = useState(false);
  // A report/file add intent forwarded to the Documents tab's modals.
  const [docsOpenAdd, setDocsOpenAdd] = useState<"report" | "file" | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [newObservation, setNewObservation] = useState({
    type: "praise" as ObservationType,
    note: "",
  });
  const [isAddingObservation, setIsAddingObservation] = useState(false);
  // Collapsed-form toggle for the Dossier's Observations section: the entry form
  // starts hidden so existing notes stay above the fold; an "Add" affordance
  // reveals it on demand (Seeds tab pattern).
  const [showObsForm, setShowObsForm] = useState(false);
  // The observation queued for deletion, awaiting confirm (destructive; no undo).
  const [obsPendingDelete, setObsPendingDelete] = useState<
    { _id: string; type: string; _creationTime: number } | null
  >(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [resetLink, setResetLink] = useState<string | null>(null);
  const [resetError, setResetError] = useState("");
  // Clears ALL reset-dialog state. Chakra's controlled `onOpenChange` only
  // fires on user-driven close (Esc / outside-click), NOT when we flip the
  // `open` prop from a button — so every close path (Cancel, Done, backdrop)
  // must route through here, or a stale link/error shows on the next open.
  const closeResetDialog = () => {
    setShowResetPassword(false);
    setResetLink(null);
    setResetError("");
  };
  // Operations-staff basic-details editor (name / username / DOB / grade) —
  // null until the user edits a field, then it holds the draft.
  const [detailsName, setDetailsName] = useState<string | null>(null);
  const [detailsUsername, setDetailsUsername] = useState<string | null>(null);
  const [detailsDob, setDetailsDob] = useState<string | null>(null);
  const [detailsGrade, setDetailsGrade] = useState<string | null>(null);
  const [detailsPronouns, setDetailsPronouns] = useState<string | null>(null);
  const [savingDetails, setSavingDetails] = useState(false);
  const [detailsError, setDetailsError] = useState("");
  // The profile stays mounted while the rail switches scholars, so drop the
  // drafts when the scholar changes — otherwise Save writes one scholar's
  // half-typed name or username onto the next one.
  const [detailsScholarId, setDetailsScholarId] = useState(scholarId);
  if (detailsScholarId !== scholarId) {
    setDetailsScholarId(scholarId);
    setDetailsName(null);
    setDetailsUsername(null);
    setDetailsDob(null);
    setDetailsGrade(null);
    setDetailsPronouns(null);
    setDetailsError("");
  }
  const [savingInstitution, setSavingInstitution] = useState(false);
  // The picked-but-not-yet-confirmed standing, so the select doesn't snap back
  // to the query value for the duration of the save round-trip.
  const [pendingStanding, setPendingStanding] = useState<
    "enrolled" | "program_guest" | null
  >(null);

  const handleSaveDetails = async () => {
    const username = detailsUsername?.trim() ?? "";
    const usernameChanged =
      detailsUsername !== null && username !== (scholar?.username ?? "");
    const usernameProblem = usernameChanged ? usernameError(username) : null;
    if (usernameProblem) {
      setDetailsError(usernameProblem);
      return;
    }
    setSavingDetails(true);
    setDetailsError("");
    try {
      await adminUpdateScholarProfile({
        scholarId: scholarId as Id<"users">,
        ...(detailsName !== null ? { name: detailsName } : {}),
        ...(usernameChanged ? { username } : {}),
        ...(detailsDob !== null ? { dateOfBirth: detailsDob } : {}),
        ...(detailsGrade !== null ? { gradeLevel: detailsGrade || null } : {}),
        ...(detailsPronouns !== null
          ? { pronouns: detailsPronouns.trim() || null }
          : {}),
      });
      setDetailsName(null);
      setDetailsUsername(null);
      setDetailsDob(null);
      setDetailsGrade(null);
      setDetailsPronouns(null);
    } catch (error) {
      console.error("Error saving scholar details:", error);
      setDetailsError(
        serverErrorMessage(error, "Couldn't save these details. Try again."),
      );
    } finally {
      setSavingDetails(false);
    }
  };

  const handleReadingLevelChange = async (newLevel: string) => {
    setIsSavingReadingLevel(true);
    try {
      await updateReadingLevel({
        scholarId: scholarId as Id<"users">,
        readingLevel: newLevel || null,
      });
    } catch (error) {
      console.error("Error updating reading level:", error);
    } finally {
      setIsSavingReadingLevel(false);
    }
  };

  const handleReadLevelChange = async (readLevel: ReadLevel) => {
    setIsSavingReadingLevel(true);
    try {
      await updateReadLevel({ scholarId: scholarId as Id<"users">, readLevel });
    } catch (error) {
      console.error("Error updating read level:", error);
    } finally {
      setIsSavingReadingLevel(false);
    }
  };

  const handleWriteModeChange = async (writeMode: WriteMode) => {
    setIsSavingReadingLevel(true);
    try {
      await updateWriteMode({ scholarId: scholarId as Id<"users">, writeMode });
    } catch (error) {
      console.error("Error updating write mode:", error);
    } finally {
      setIsSavingReadingLevel(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset of analysis state when scholar changes
    setAiLoading(false);
  }, [scholarId]);

  const handleAIRerun = async () => {
    setAiLoading(true);
    try {
      const result = await runAIAnalysis({ scholarId: scholarId as Id<"users"> });
      // null = below the typed-word floor (or no usable answer): say so rather
      // than leave the click looking like it did nothing.
      if (!result) {
        toaster.info({
          title: `Not enough typed writing in the last 30 days (needs ${MIN_TYPED_WORDS_FOR_ESTIMATE} words)`,
        });
      }
    } finally {
      setAiLoading(false);
    }
  };

  const handleSetInterestState = async (
    label: string,
    state: "active" | "past",
  ) => {
    try {
      await setInterestState({ scholarId: scholarId as Id<"users">, label, state });
    } catch (error) {
      toaster.error({
        title: "Couldn't update interest",
        description: serverErrorMessage(error) || undefined,
      });
    }
  };

  const handleAddObservation = async () => {
    if (!newObservation.note.trim()) return;
    setIsAddingObservation(true);
    try {
      await addObservation({
        scholarId: scholarId as Id<"users">,
        type: newObservation.type,
        note: newObservation.note,
      });
      setNewObservation({ type: "praise", note: "" });
      setShowObsForm(false);
    } catch (error) {
      console.error("Error adding observation:", error);
    } finally {
      setIsAddingObservation(false);
    }
  };

  const handleDeleteObservation = async (observationId: string) => {
    try {
      await removeObservation({ observationId: observationId as Id<"observations"> });
    } catch (error) {
      console.error("Error deleting observation:", error);
    }
  };

  const handleSetObservationType = async (
    observationId: string,
    type: ObservationType,
  ) => {
    try {
      await setObservationType({
        observationId: observationId as Id<"observations">,
        type,
      });
    } catch (error) {
      console.error("Error updating observation type:", error);
    }
  };

  // Dispatch a pending "+ Add" intent from the header menu to the right surface.
  // The page has already switched tabs for note/report/file; here we open the
  // matching form/dialog and clear the intent.
  useEffect(() => {
    if (!addAction) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    if (addAction === "badge") setAwardBadgeOpen(true);
    else if (addAction === "note") setShowObsForm(true);
    else if (addAction === "report" || addAction === "file") setDocsOpenAdd(addAction);
    /* eslint-enable react-hooks/set-state-in-effect */
    onAddConsumed?.();
  }, [addAction, onAddConsumed]);

  if (isLoading) {
    return <GenericBodySkeleton />;
  }

  const visibleTabs = isOperationsMode
    ? ALL_TABS.filter((t) => OPERATIONS_TABS.includes(t.key))
    : ALL_TABS;
  // The Map / Quests / Math Skills tabs share a non-scrolling flex frame — a
  // pinned strip (subnav or none) above a full-bleed spatial canvas (Quests =
  // Sky, Math Skills → Tree) or an internally-scrolling content panel (Map's
  // Mastery/Connections/Reading, Math skills → Focus). Every other
  // profile tab is the normal padded, page-scrolling content area.
  const isMapTab = activeTab === "map";
  const isQuestsTab = activeTab === "quests";
  const isSkillsTab = activeTab === "skills";
  const isFramedTab = isMapTab || isQuestsTab || isSkillsTab;
  return (
    <Box
      w="full"
      bg="gray.50"
      h="full"
      display="flex"
      flexDir="column"
      opacity={profileSwapping ? 0.55 : 1}
      transition="opacity 0.15s ease"
      pointerEvents={profileSwapping ? "none" : undefined}
    >

      {/* Tab bar — the canonical L1 tab recipe (components/ui/PaneTabs). ("+ Add"
          and "Award badge" now live in the header's single Add menu; "View as"
          stays in the header.) */}
      <PaneTabs
        value={activeTab}
        // Always drive tab state through setActiveTab — which is onTabChange when
        // provided (the dashboard's native-History pushUrl), so switching tabs is
        // a smooth client re-render, not an RSC navigation that reloads the page.
        onChange={(v) => setActiveTab(v as TabKey)}
        px={5}
        items={visibleTabs.map((tab) => {
          const TabIcon = tab.icon;
          return { value: tab.key, label: tab.label, icon: <TabIcon size={14} /> };
        })}
      />

      {mode === "teacher" && scholar && (
        <AwardBadgeDialog
          open={awardBadgeOpen}
          onClose={() => setAwardBadgeOpen(false)}
          scholarId={scholarId as Id<"users">}
          scholarName={scholar.name ?? "this scholar"}
        />
      )}

      {/* Tab content — the Map / Quests / Math Skills tabs swap this to a
          non-scrolling, unpadded flex frame (a pinned strip + a full-bleed or
          internally-scrolling sub-panel below); every other tab stays the
          normal padded, page-scrolling content area. */}
      <Box
        flex={1}
        minH={0}
        overflow={isFramedTab ? "hidden" : "auto"}
        p={isFramedTab ? 0 : 4}
        display={isFramedTab ? "flex" : "block"}
        flexDir={isFramedTab ? "column" : undefined}
      >


        {/* ── Feed — a social-profile read of "what's this kid been up to?" ── */}
        {activeTab === "feed" && (
          isOperationsMode ? (
            <Box maxW="360px">
              <Surface p={5}>
                <VStack gap={3} align="center" mb={4}>
                  <Avatar
                    size="xl"
                    name={scholar?.name || "Scholar"}
                    src={scholar?.image || undefined}
                    colorKey={scholarId}
                  />
                  <VStack gap={0} align="center">
                    <Text fontWeight="700" fontFamily="heading" color="navy.500" fontSize="xl" textAlign="center">
                      {scholar?.name}
                    </Text>
                    {scholar?.username && (
                      <Text color="charcoal.300" fontSize="xs" fontFamily="heading">
                        @{scholar.username}
                      </Text>
                    )}
                  </VStack>
                </VStack>

                <VStack gap={3} align="stretch" divideY="1px">
                  {/* Stats + reading level */}
                  <VStack gap={2} align="stretch" pb={3}>
                    {!isOperationsMode && scholar?.readingLevel && (
                      <HStack justify="space-between">
                        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Talk level</Text>
                        <Badge bg="violet.100" color="violet.700" fontSize="xs" fontFamily="heading">
                          {talkLevelLabel(scholar.readingLevel)}
                        </Badge>
                      </HStack>
                    )}
                    {/* Read / write only when they differ from the default —
                        a fluent reader-writer shows nothing new. */}
                    {!isOperationsMode && scholar?.readLevel && scholar.readLevel !== "reader" && (
                      <HStack justify="space-between">
                        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Read</Text>
                        <Badge bg="violet.100" color="violet.700" fontSize="xs" fontFamily="heading">
                          {READ_LEVEL_LABELS[scholar.readLevel]}
                        </Badge>
                      </HStack>
                    )}
                    {!isOperationsMode && scholar?.writeMode === "voice" && (
                      <HStack justify="space-between">
                        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Write</Text>
                        <Badge bg="violet.100" color="violet.700" fontSize="xs" fontFamily="heading">
                          {WRITE_MODE_LABELS.voice}
                        </Badge>
                      </HStack>
                    )}
                    <HStack justify="space-between">
                      <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Sessions</Text>
                      <Text fontSize="xs" color="charcoal.600" fontFamily="heading" fontWeight="600">{stats.sessionCount}</Text>
                    </HStack>
                    <HStack justify="space-between">
                      <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Messages</Text>
                      <Text fontSize="xs" color="charcoal.600" fontFamily="heading" fontWeight="600">{stats.messageCount}</Text>
                    </HStack>
                    {!isOperationsMode && stats.observationCount > 0 && (
                      <HStack justify="space-between">
                        <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Observations</Text>
                        <Text fontSize="xs" color="charcoal.600" fontFamily="heading" fontWeight="600">{stats.observationCount}</Text>
                      </HStack>
                    )}
                    {!isOperationsMode && (aiCatches?.count ?? 0) > 0 && (
                      <HStack justify="space-between">
                        <HStack gap={1}>
                          <Text fontSize="xs" aria-hidden>🎯</Text>
                          <Text fontSize="xs" color="charcoal.400" fontFamily="heading">Caught the AI</Text>
                        </HStack>
                        <Badge bg="amber.100" color="amber.800" fontSize="xs" fontFamily="heading">
                          {aiCatches!.count}
                        </Badge>
                      </HStack>
                    )}
                  </VStack>

                  {/* Most recent "caught the AI" moment — healthy skepticism,
                      celebrated. */}
                  {!isOperationsMode && aiCatches && aiCatches.recent.length > 0 && (
                    <Box pt={3}>
                      <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={2}>Latest AI catch</Text>
                      <Box>
                        <Badge bg="amber.100" color="amber.800" fontSize="2xs" mb={1}>
                          🎯 flagged as wrong
                        </Badge>
                        <Text fontSize="xs" color="charcoal.500" fontFamily="body" lineHeight="1.4" lineClamp={3} fontStyle="italic">
                          &ldquo;{aiCatches.recent[0].snippet}&rdquo;
                        </Text>
                      </Box>
                    </Box>
                  )}

                  {/* Most recent observation */}
                  {observations.length > 0 && (
                    <Box pt={3}>
                      <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={2}>Latest observation</Text>
                      <Box>
                        <Badge
                          bg={
                            observations[0].type === "praise" ? "green.100" :
                            observations[0].type === "concern" ? "red.100" :
                            observations[0].type === "suggestion" ? "blue.100" :
                            observations[0].type === "intervention" ? "orange.100" : "gray.100"
                          }
                          color={
                            observations[0].type === "praise" ? "green.700" :
                            observations[0].type === "concern" ? "red.700" :
                            observations[0].type === "suggestion" ? "blue.700" :
                            observations[0].type === "intervention" ? "orange.700" : "charcoal.600"
                          }
                          fontSize="2xs"
                          mb={1}
                        >
                          {observations[0].type}
                        </Badge>
                        <Text fontSize="xs" color="charcoal.500" fontFamily="body" lineHeight="1.4" lineClamp={3}>
                          {observations[0].note}
                        </Text>
                      </Box>
                    </Box>
                  )}

                  {/* Dossier snippet */}
                  {dossierContent && (
                    <Box pt={3}>
                      <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={2}>Learner profile</Text>
                      <Text fontSize="xs" color="charcoal.500" fontFamily="body" lineHeight="1.5" lineClamp={5} fontStyle="italic">
                        {dossierContent}
                      </Text>
                    </Box>
                  )}
                </VStack>
              </Surface>
            </Box>
          ) : (
            <ScholarFeed
              scholarId={scholarId}
              onOpenTab={setActiveTab}
              onOpenReading={() => {
                setProgressSection("reading");
                setActiveTab("map");
              }}
              onOpenObservation={onOpenObservation}
              canCurate={mode === "teacher"}
              canRounds={mode === "teacher"}
            />
          )
        )}


        {/* ── Map (Mastery + Connections + Reading) ── */}
        {activeTab === "map" && (
          <Flex direction="column" h="full" minH={0}>
            {/* Subtabs — the canonical L2 SubNav, pinned directly above the
                content panel below; always visible regardless of which
                subsection is active. */}
            <Box
              flexShrink={0}
              bg="white"
              borderBottom="1px solid"
              borderColor="gray.200"
              px={3}
              py={2}
            >
              <SubNav
                items={[
                  { value: "mastery", label: "Mastery" },
                  { value: "connections", label: "Connections" },
                  { value: "reading", label: "Reading" },
                ]}
                value={progressSection}
                onChange={(v) => setProgressSection(v as MapSection)}
                mb={0}
              />
            </Box>
            {/* Mastery / Connections / Reading — a padded,
                internally-scrolling content panel. The spatial Tree + Sky
                lenses now live in the Math skills and Quests tabs. */}
            <Box flex={1} minH={0} overflow="auto" p={4}>
                {progressSection === "mastery" && (
                  <>
                    <CardHeading icon={<TrendUp />} title="Mastery" hint="demonstrated concepts and the evidence behind them" />
                    <MasteryTab scholarId={scholarId} />
                  </>
                )}
                {progressSection === "connections" && <SignalsTab scholarId={scholarId} />}
                {progressSection === "reading" && !isOperationsMode && (
              <Surface p={5}>
                <CardHeading
                  icon={<BookOpenText />}
                  title="Talk, read and write"
                  hint={"how the tutor talks, reads and listens"}
                  action={isSavingReadingLevel ? <Spinner size="xs" color="violet.500" /> : undefined}
                />

                {/* One row per level: the setting, then its evidence lines
                    (each shown only when it means something), then ONE growth
                    chart for all three (TRA-515). */}
                <Box display="grid" gridTemplateColumns="56px 1fr 24px" columnGap={2} alignItems="center">
                  {/* Talk — the grade band the tutor talks at */}
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.500" py={1.5}>Talk</Text>
                  <Box py={1.5}>
                    <FieldSelect
                      w="full"
                      size="xs"
                      fieldProps={{ "aria-label": "Talk level" }}
                      value={scholar?.readingLevel || ""}
                      onChange={(v) => handleReadingLevelChange(v)}
                      disabled={isSavingReadingLevel}
                    >
                      {READING_LEVELS.map((level) => (
                        <option key={level.value} value={level.value}>
                          {level.label}
                        </option>
                      ))}
                    </FieldSelect>
                  </Box>
                  <Box py={1.5} />
                  <Box gridColumn="1 / -1" pb={2}>
                    <TalkEvidence
                      talkLevel={scholar?.readingLevel || null}
                      tutorReadability={tutorReadability}
                      vocabularyWins={vocabularyWinItems}
                    />
                  </Box>

                  {/* Read — how the tutor's words arrive (TRA-503).
                      Listener turns on voice-first. */}
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.500" py={1.5} borderTop="1px solid" borderColor="gray.100">Read</Text>
                  <Box py={1.5} borderTop="1px solid" borderColor="gray.100">
                    <FieldSelect
                      w="full"
                      size="xs"
                      fieldProps={{ "aria-label": "Read" }}
                      value={scholar?.readLevel ?? "reader"}
                      onChange={(v) => handleReadLevelChange(v as ReadLevel)}
                      disabled={isSavingReadingLevel}
                    >
                      {READ_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </FieldSelect>
                  </Box>
                  <Box py={1.5} borderTop="1px solid" borderColor="gray.100" />
                  {/* Read-aloud evidence exists only for a beginner: a
                      listener doesn't read aloud, a reader isn't checked. */}
                  {scholar?.readLevel === "beginner" && (
                    <Box gridColumn="1 / -1" pb={2}>
                      <ReadEvidence evidence={levelEvidence} />
                    </Box>
                  )}

                  {/* Write — how the scholar's words get in (TRA-503) */}
                  <Text fontSize="xs" fontFamily="heading" color="charcoal.500" py={1.5} borderTop="1px solid" borderColor="gray.100">Write</Text>
                  <Box py={1.5} borderTop="1px solid" borderColor="gray.100">
                    <FieldSelect
                      w="full"
                      size="xs"
                      fieldProps={{ "aria-label": "Write" }}
                      value={scholar?.writeMode ?? "own"}
                      onChange={(v) => handleWriteModeChange(v as WriteMode)}
                      disabled={isSavingReadingLevel}
                    >
                      {WRITE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </FieldSelect>
                  </Box>
                  <Box py={1.5} borderTop="1px solid" borderColor="gray.100">
                    {!aiLoading && (
                      <Menu.Root positioning={{ placement: "bottom-end" }}>
                        <Menu.Trigger asChild>
                          <IconButton aria-label="Writing estimate actions" variant="ghost" size="2xs" color="charcoal.300" _hover={{ color: "charcoal.500" }}>
                            <DotsThree />
                          </IconButton>
                        </Menu.Trigger>
                        <Menu.Positioner>
                          <Menu.Content minW="170px">
                            <Menu.Item value="rerun" cursor="pointer" onClick={handleAIRerun}>
                              {scholar?.readingLevelSuggestion ? "Re-analyze typed writing" : "Analyze typed writing"}
                            </Menu.Item>
                          </Menu.Content>
                        </Menu.Positioner>
                      </Menu.Root>
                    )}
                  </Box>
                  {/* Spoken share + the writing estimate — information, never
                      a setting (TRA-513): nothing here can promote the
                      estimate into the talk level. */}
                  <Box gridColumn="1 / -1" pb={2}>
                    {aiLoading ? (
                      <Spinner size="xs" color="violet.500" />
                    ) : (
                      <WriteEvidence
                        evidence={levelEvidence}
                        writingEstimate={writingEstimateText(
                          scholar?.readingLevelSuggestion ?? null,
                          scholar?.readingLevelSuggestionWords ?? null,
                          scholar?.readingLevelSuggestionAt ?? null,
                          estimateNow,
                        )}
                      />
                    )}
                  </Box>
                </Box>

                {levelEvidence && (
                  <LevelsGrowthChart evidence={levelEvidence} scans={scholarPortfolioSamples} />
                )}
              </Surface>
            )}
            {/* Reading-ramp grapheme inventory — read level listener or
                beginner (§10; TRA-504: a beginner's "your turn" line is built
                from these teams too). The per-team fade editor lives next to
                the levels because it's the same "how does this scholar read?"
                region. */}
            {progressSection === "reading" &&
              !isOperationsMode &&
              (scholar?.readLevel === "listener" ||
                scholar?.readLevel === "beginner") && (
                <GraphemeInventoryEditor scholarId={scholarId as Id<"users">} />
              )}
              </Box>
          </Flex>
        )}


        {/* ── Quests — the Sky view (cross-domain atlas), moved wholesale from
            the old Map → Sky subsection. Full-bleed spatial canvas. ── */}
        {activeTab === "quests" && (
          <Box flex={1} minH={0}>
            <Map
              scholarId={scholarId as Id<"users">}
              audience="teacher"
              mode="sky"
              showToggle={false}
              fill
            />
          </Box>
        )}


        {/* ── Math Skills — Portrait (the compact per-domain grade + growth
            roll-up, the default) and Tree (the spatial skills map + "Rehearse
            as scholar"). ── */}
        {activeTab === "skills" && (
          <Flex direction="column" h="full" minH={0}>
            <Box
              flexShrink={0}
              bg="white"
              borderBottom="1px solid"
              borderColor="gray.200"
              px={3}
              py={2}
            >
              <SubNav
                items={[
                  { value: "portrait", label: "Portrait" },
                  { value: "tree", label: "Tree" },
                ]}
                value={skillsSection}
                onChange={(v) => setSkillsSection(v as SkillsSection)}
                mb={0}
                action={
                  skillsSection === "tree" ? (
                    <a
                      href={`/scholar/practice?remote=${scholarId}`}
                      target="_blank"
                      rel="noopener"
                      style={{ textDecoration: "none", flexShrink: 0 }}
                    >
                      <Button
                        variant="ghost"
                        size="xs"
                        color="violet.700"
                        fontFamily="heading"
                        fontWeight="600"
                        _hover={{ bg: "violet.50" }}
                      >
                        <PenNib />
                        Rehearse as scholar
                      </Button>
                    </a>
                  ) : undefined
                }
              />
            </Box>
            {skillsSection === "portrait" ? (
              <Box flex={1} minH={0} overflow="auto" p={4}>
                <MathSkillsPortrait
                  portrait={mathPortrait}
                  scholarName={scholar?.name ?? ""}
                  onAskAi={
                    aide
                      ? (question) => aide.seedComposer(question)
                      : undefined
                  }
                />
              </Box>
            ) : (
              // Full-bleed spatial map (the Math Skills Tree), moved wholesale
              // from the old Map → Tree subsection. Only the canvas pans.
              <Box flex={1} minH={0}>
                <Map
                  scholarId={scholarId as Id<"users">}
                  audience="teacher"
                  mode="tree"
                  showToggle={false}
                  fill
                />
              </Box>
            )}
          </Flex>
        )}


        {/* ── Dossier (Learner profile + Mastery + Observations) ── */}
        {activeTab === "dossier" && (
          <VStack gap={4} align="stretch" maxW="820px">
            <Surface p={5}>
              <CardHeading icon={<User />} title="Learner profile" />
              <InterestsBlock
                interests={scholarInterests?.interests as TeacherInterest[] | undefined}
                legend={scholarInterests?.legend}
                onToggle={handleSetInterestState}
              />
              <Textarea
                size="sm"
                placeholder="No dossier yet — the AI will build one during conversations."
                value={dossierDraft ?? dossierContent ?? ""}
                onChange={(e) => setDossierDraft(e.target.value)}
                onBlur={async () => {
                  if (dossierDraft !== null && dossierDraft !== (dossierContent ?? "")) {
                    await updateDossier({
                      scholarId: scholarId as Id<"users">,
                      content: dossierDraft,
                    });
                  }
                  setDossierDraft(null);
                }}
                rows={14}
                bg="gray.50"
                fontFamily="body"
                fontSize="sm"
                lineHeight="1.6"
              />
              <Text fontSize="xs" color="charcoal.400" fontFamily="body" mt={2}>
                AI-maintained learning profile. You can also edit manually.
              </Text>
            </Surface>
            <Surface p={5}>
              <CardHeading
                icon={<FileText />}
                title="Observations"
                action={
                  <AddToggle
                    label="Add"
                    active={showObsForm}
                    onClick={() => setShowObsForm((v) => !v)}
                  />
                }
              />

              {showObsForm && (
                <Box mb={observations.length > 0 ? 4 : 0} pb={observations.length > 0 ? 4 : 0} borderBottom={observations.length > 0 ? "1px solid" : undefined} borderColor="gray.100">
                  <FieldSelect
                    w="160px"
                    size="sm"
                    value={newObservation.type}
                    onChange={(v) => setNewObservation((prev) => ({ ...prev, type: v as typeof prev.type }))}
                    fieldProps={{ "aria-label": "Observation type" }}
                  >
                    <option value="praise">Praise</option>
                    <option value="concern">Concern</option>
                    <option value="suggestion">Suggestion</option>
                    <option value="intervention">Intervention</option>
                    <option value="note">Note</option>
                  </FieldSelect>
                  <Textarea
                    size="sm"
                    placeholder="Record an observation…"
                    value={newObservation.note}
                    onChange={(e) => setNewObservation((prev) => ({ ...prev, note: e.target.value }))}
                    rows={2}
                    bg="gray.50"
                    fontFamily="body"
                    mt={2}
                    mb={2}
                    autoFocus
                  />
                  <Flex justify="flex-end">
                    <Button
                      size="sm"
                      bg="violet.500"
                      color="white"
                      _hover={{ bg: "violet.600" }}
                      fontFamily="heading"
                      fontWeight="600"
                      onClick={handleAddObservation}
                      disabled={isAddingObservation || !newObservation.note.trim()}
                    >
                      Save
                    </Button>
                  </Flex>
                </Box>
              )}

              {observations.length > 0 ? (
                <VStack gap="7px" align="stretch">
                  {observations.map((obs) => (
                    <ObservationCard
                      key={obs._id}
                      observation={obs}
                      scholarFirstName={scholar?.name?.split(" ")[0] ?? null}
                      onSetType={(type) => handleSetObservationType(obs._id, type)}
                      onDelete={() =>
                        setObsPendingDelete({
                          _id: obs._id,
                          type: obs.type,
                          _creationTime: obs._creationTime,
                        })
                      }
                      onDiscuss={aide ? (prompt) => aide.seedComposer(prompt) : undefined}
                    />
                  ))}
                </VStack>
              ) : !showObsForm ? (
                <EmptyState
                  title="No observations yet"
                  hint="Use Add to record praise, a concern, a suggestion, an intervention, or a neutral note."
                />
              ) : null}
            </Surface>
          </VStack>
        )}

        {/* ── Documents (reports, assessments, IEPs, parent notes, links) ── */}
        {activeTab === "documents" && (
          <Box maxW="820px">
            <DocumentsTab
              scholarId={scholarId}
              institutionScope={institutionScope}
              openAdd={docsOpenAdd}
              onOpenAddConsumed={() => setDocsOpenAdd(null)}
            />
          </Box>
        )}


        {/* ── Now — the live execution snapshot (home mirror · quests ·
            assignments). Teacher-only; operations staff never reach this tab. ── */}
        {activeTab === "now" && !isOperationsMode && (
          <VStack gap={4} align="stretch" maxW="1100px">
            {/* Home screen mirror — what this scholar sees on their iPad
                right now. Rendered FIRST so a teacher can spot/clear stray
                Home items before anything else. */}
            <ScholarHomeMirrorCard scholarId={scholarId as Id<"users">} />
            {/* Per-scholar quest management (IA step 3). */}
            <ScholarQuestsCard scholarId={scholarId as Id<"users">} />
            {/* Active assignments (Phase 5 cross-link). */}
            <ScholarAssignmentsCard scholarId={scholarId as Id<"users">} />
          </VStack>
        )}

        {/* ── Portfolio — the accumulated record (Renzulli Total Talent
            Portfolio): portfolio items · badges · session history · web
            activity. Registrars see portfolio items only. ── */}
        {activeTab === "portfolio" && (
          isOperationsMode ? (
            <PortfolioTab scholarId={scholarId} />
          ) : (
            <VStack gap={4} align="stretch" maxW="1100px">
              {/* PortfolioTab renders its own Surface — no wrapper card here. */}
              <PortfolioTab scholarId={scholarId} />
              {/* Earned unit-completion badges (per-scholar view). */}
              <ScholarBadgesCard scholarId={scholarId as Id<"users">} />
              {/* Session history — every transcript. The "View as" (remote)
                  entry point lives here with the grid; keep exactly one. */}
              <Box>
                <CardHeading
                  icon={<FolderSimple />}
                  title={`Sessions (${stats.sessionCount})`}
                  action={
                    <a href={`/scholar?remote=${scholarId}`} target="_blank" rel="noopener" style={{ textDecoration: "none" }}>
                      <Button
                        variant="ghost"
                        size="xs"
                        color="violet.700"
                        fontFamily="heading"
                        fontWeight="600"
                        _hover={{ bg: "violet.50" }}
                      >
                        <Eye />
                        View as
                      </Button>
                    </a>
                  }
                />
                {scholarSessions === undefined ? (
                  <Flex justify="center" py={4}><Spinner size="sm" color="violet.500" /></Flex>
                ) : scholarSessions.length === 0 ? (
                  <EmptyState
                    title="No sessions yet"
                    hint="Sessions this scholar starts with the tutor will appear here."
                  />
                ) : (
                  <Box display="grid" gridTemplateColumns="repeat(auto-fill, minmax(260px, 1fr))" gap={3}>
                    {scholarSessions.slice(0, 9).map((session) => (
                      <a
                        key={session._id}
                        href={`/scholar/${String(session._id)}?remote=${scholarId}`}
                        target="_blank"
                        rel="noopener"
                        style={{ textDecoration: "none", color: "inherit", display: "contents" }}
                      >
                        <Box
                          bg="white"
                          borderRadius="lg"
                          p={3}
                          shadow="xs"
                          cursor="pointer"
                          _hover={{ shadow: "sm", borderColor: "violet.200" }}
                          border="1px solid"
                          borderColor="gray.100"
                        >
                          <Text fontFamily="heading" fontSize="sm" fontWeight="600" color="navy.500" lineClamp={1}>
                            {session.title}
                          </Text>
                          {session.unitTitle && (
                            <Text fontSize="xs" color="violet.500" fontFamily="heading" mt={0.5}>
                              {session.unitEmoji ? `${session.unitEmoji} ` : ""}{session.unitTitle}
                            </Text>
                          )}
                          <HStack mt={2} gap={3}>
                            <HStack gap={1}>
                              <Chat size={11} color="#888" />
                              <Text fontSize="xs" color="charcoal.400" fontFamily="heading">{session.messageCount}</Text>
                            </HStack>
                            <Text fontSize="xs" color="charcoal.400" fontFamily="heading">{formatTimeAgo(session._creationTime)}</Text>
                          </HStack>
                          {session.analysisSummary && (
                            <Text fontSize="xs" color="charcoal.500" fontFamily="body" mt={1.5} lineClamp={2}>
                              {session.analysisSummary}
                            </Text>
                          )}
                        </Box>
                      </a>
                    ))}
                  </Box>
                )}
                {!isOperationsMode && (scholarAppStates === undefined ? (
                  <Flex justify="center" py={4}>
                    <Spinner size="sm" color="violet.500" />
                  </Flex>
                ) : scholarAppStates.length > 0 ? (
                  <Box mt={5}>
                    <CardHeading
                      icon={<BracketsCurly />}
                      title="App state"
                      hint="Final saved values and recent console output from Vibecode sessions."
                    />
                    <VStack gap={2} align="stretch">
                      {scholarAppStates.map((state) => {
                        let prettyDoc = "";
                        try {
                          prettyDoc = JSON.stringify(state.doc, null, 2) ?? "";
                        } catch {
                          prettyDoc = "";
                        }
                        return (
                          <Box
                            as="details"
                            key={state.sessionId}
                            bg="white"
                            borderWidth="1px"
                            borderColor="gray.200"
                            borderRadius="lg"
                            overflow="hidden"
                          >
                            <Box
                              as="summary"
                              cursor="pointer"
                              px={3}
                              py={2.5}
                              _hover={{ bg: "gray.50" }}
                            >
                              <Text
                                as="span"
                                fontFamily="heading"
                                fontSize="sm"
                                fontWeight="600"
                                color="navy.500"
                              >
                                {state.sessionTitle}
                              </Text>
                              <Text
                                as="span"
                                ml={2}
                                fontFamily="body"
                                fontSize="xs"
                                color="charcoal.400"
                              >
                                {state.artifactTitle} · updated{" "}
                                {formatTimeAgo(state.updatedAt)}
                              </Text>
                            </Box>
                            <VStack
                              gap={3}
                              align="stretch"
                              px={3}
                              pb={3}
                              borderTopWidth="1px"
                              borderColor="gray.100"
                            >
                              <Box pt={3}>
                                <Text
                                  fontFamily="heading"
                                  fontSize="xs"
                                  fontWeight="600"
                                  color="charcoal.500"
                                  mb={1}
                                >
                                  Saved values
                                </Text>
                                <Box
                                  as="pre"
                                  m={0}
                                  p={3}
                                  bg="gray.50"
                                  borderRadius="md"
                                  overflowX="auto"
                                  whiteSpace="pre-wrap"
                                  fontFamily="mono"
                                  fontSize="xs"
                                  color="charcoal.600"
                                >
                                  {prettyDoc || "{}"}
                                </Box>
                              </Box>
                              <Box>
                                <Text
                                  fontFamily="heading"
                                  fontSize="xs"
                                  fontWeight="600"
                                  color="charcoal.500"
                                  mb={1}
                                >
                                  Recent console output
                                </Text>
                                {state.log.length > 0 ? (
                                  <VStack gap={1} align="stretch">
                                    {state.log.map((entry, index) => (
                                      <HStack
                                        key={`${entry.at}-${index}`}
                                        align="start"
                                        gap={2}
                                        fontFamily="mono"
                                        fontSize="xs"
                                      >
                                        <Badge
                                          flexShrink={0}
                                          size="sm"
                                          colorPalette={
                                            entry.level === "error"
                                              ? "red"
                                              : entry.level === "warn"
                                                ? "orange"
                                                : "gray"
                                          }
                                        >
                                          {entry.level}
                                        </Badge>
                                        <Text
                                          color="charcoal.600"
                                          overflowWrap="anywhere"
                                        >
                                          {entry.message}
                                        </Text>
                                      </HStack>
                                    ))}
                                  </VStack>
                                ) : (
                                  <Text
                                    fontFamily="body"
                                    fontSize="xs"
                                    color="charcoal.400"
                                  >
                                    No console output saved.
                                  </Text>
                                )}
                              </Box>
                            </VStack>
                          </Box>
                        );
                      })}
                    </VStack>
                  </Box>
                ) : null)}
              </Box>
              {/* Web Assignment sessions (external practice apps, etc.) — hides
                  itself when the scholar has none. */}
              <ActivitySessionsCard scholarId={scholarId as Id<"users">} />
            </VStack>
          )
        )}


        {/* ── Seeds (Seeds + Directives) ── */}
        {activeTab === "guidance" && (
          <VStack gap={6} align="stretch" maxW="760px">
            <SeedsTab scholarId={scholarId} />
            <Separator borderColor="gray.200" />
            <Box>
              <CardHeading
                icon={<Flag />}
                title="Goals"
                hint="long-term learning goals set with the scholar — active ones gently reach the AI tutor"
              />
              <TeacherGoalsPanel scholarId={scholarId as Id<"users">} />
            </Box>
            <Separator borderColor="gray.200" />
            <Box>
              <CardHeading
                icon={<Flag />}
                title="Goals this week"
                hint="the scholar's own weekly commitments — active when they set one, or suggest one for them to accept"
              />
              <TeacherWeeklyGoalsPanel scholarId={scholarId as Id<"users">} />
            </Box>
            <Separator borderColor="gray.200" />
            <Box>
              <CardHeading
                icon={<Flag />}
                title="Directives"
                hint="standing rules injected into the AI tutor's system prompt"
              />
              <DirectivesTab scholarId={scholarId} />
            </Box>
          </VStack>
        )}


        {/* ── Settings (Account details + Audio + Account actions + Parents) ── */}
        {activeTab === "settings" && (
          <VStack gap={4} align="stretch" maxW="680px">
            <Surface p={5}>
              <CardHeading icon={<User />} title="Account details" />
              <VStack gap={3} align="stretch">
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Name</Text>
                  <Input
                    size="sm"
                    value={detailsName ?? scholar?.name ?? ""}
                    onChange={(e) => setDetailsName(e.target.value)}
                    fontFamily="body"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Username</Text>
                  <Input
                    size="sm"
                    aria-label="Username"
                    placeholder="Not set"
                    value={detailsUsername ?? scholar?.username ?? ""}
                    onChange={(e) => setDetailsUsername(e.target.value)}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    fontFamily="body"
                  />
                  <Text fontSize="2xs" color="charcoal.300" fontFamily="body" mt={1}>
                    What they sign in with, along with a password.{" "}
                    {!scholar?.username
                      ? "Add one before creating their password — school iPads don't need it."
                      : hasCredential
                        ? "If you change it, their old username stops working — their password stays the same."
                        : null}
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Date of birth</Text>
                  <Input
                    size="sm"
                    type="date"
                    value={detailsDob ?? scholar?.dateOfBirth ?? ""}
                    onChange={(e) => setDetailsDob(e.target.value)}
                    fontFamily="body"
                  />
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Pronouns</Text>
                  <Input
                    size="sm"
                    list="scholar-pronoun-suggestions"
                    placeholder="Not set"
                    value={detailsPronouns ?? scholar?.pronouns ?? ""}
                    onChange={(e) => setDetailsPronouns(e.target.value)}
                    fontFamily="body"
                  />
                  <datalist id="scholar-pronoun-suggestions">
                    {PRONOUN_SUGGESTIONS.map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                  <Text fontSize="2xs" color="charcoal.300" fontFamily="body" mt={1}>
                    How staff tools refer to this scholar. Staff-only — never
                    shown to the scholar or their family.
                  </Text>
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Grade level</Text>
                  <FieldSelect
                    w="full"
                    size="sm"
                    value={detailsGrade ?? scholar?.gradeLevel ?? ""}
                    onChange={(v) => setDetailsGrade(v)}
                  >
                    {GRADE_LEVELS.map((g) => (
                      <option key={g.value} value={g.value}>
                        {g.label}
                      </option>
                    ))}
                  </FieldSelect>
                  <Text fontSize="2xs" color="charcoal.300" fontFamily="body" mt={1}>
                    Chronological grade — the age notch on the Skills Tree.
                  </Text>
                </Box>
                {scholar?.enrollmentStanding === "program_guest" &&
                  scholar.externalSchoolName && (
                    <Box>
                      <Text
                        fontSize="xs"
                        color="charcoal.400"
                        fontFamily="heading"
                        mb={1}
                      >
                        School
                      </Text>
                      <Text fontSize="sm" color="navy.600">
                        {scholar.externalSchoolName}
                      </Text>
                      <Text
                        fontSize="2xs"
                        color="charcoal.300"
                        fontFamily="body"
                        mt={1}
                      >
                        {EXTENDED_EDUCATION_LABEL} participant
                      </Text>
                    </Box>
                  )}
                {isAdmin && (
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Institution</Text>
                  <FieldSelect
                    w="full"
                    size="sm"
                    value={scholar?.institutionId ?? ""}
                    disabled={savingInstitution}
                    onChange={async (v) => {
                      if (!v) return;
                      setSavingInstitution(true);
                      try {
                        await setScholarInstitution({
                          scholarId: scholarId as Id<"users">,
                          institutionId: v as Id<"institutions">,
                        });
                      } finally {
                        setSavingInstitution(false);
                      }
                    }}
                  >
                    <option value="" disabled>Select institution</option>
                    {institutions.map((inst) => (
                      <option key={inst._id} value={inst._id}>
                        {inst.emoji ? `${inst.emoji} ` : ""}{inst.name}
                      </option>
                    ))}
                  </FieldSelect>
                  <Text fontSize="2xs" color="charcoal.300" fontFamily="body" mt={1}>
                    Which school this scholar belongs to. Guests are hidden from the default roster. Admin-only — moving a scholar grants access.
                  </Text>
                </Box>
                )}
                {isAdmin && (
                <Box>
                  <Text fontSize="xs" color="charcoal.400" fontFamily="heading" mb={1}>Participation</Text>
                  <FieldSelect
                    w="full"
                    size="sm"
                    value={pendingStanding ?? scholar?.enrollmentStanding ?? "enrolled"}
                    disabled={pendingStanding !== null}
                    onChange={async (v) => {
                      if (!v || v === (scholar?.enrollmentStanding ?? "enrolled")) return;
                      const next = v as "enrolled" | "program_guest";
                      setPendingStanding(next);
                      try {
                        await setScholarEnrollmentStanding({
                          scholarId: scholarId as Id<"users">,
                          enrollmentStanding: next,
                        });
                      } catch (error) {
                        toaster.error({
                          title: "Couldn't change participation",
                          description: serverErrorMessage(error) || undefined,
                        });
                      } finally {
                        setPendingStanding(null);
                      }
                    }}
                  >
                    <option value="enrolled">Enrolled</option>
                    <option value="program_guest">{EXTENDED_EDUCATION_LABEL}</option>
                  </FieldSelect>
                  <Text fontSize="2xs" color="charcoal.300" fontFamily="body" mt={1}>
                    {EXTENDED_EDUCATION_LABEL} scholars stay out of enrolled-only rosters and school workflows. Admin-only.
                  </Text>
                </Box>
                )}
                {detailsError && (
                  <Text fontSize="xs" color="red.500" fontFamily="body">
                    {detailsError}
                  </Text>
                )}
                <Button
                  size="sm"
                  colorPalette="violet"
                  alignSelf="flex-start"
                  fontFamily="heading"
                  fontSize="xs"
                  disabled={savingDetails || (detailsName === null && detailsUsername === null && detailsDob === null && detailsGrade === null && detailsPronouns === null)}
                  onClick={handleSaveDetails}
                >
                  {savingDetails ? "Saving…" : "Save"}
                </Button>
              </VStack>
            </Surface>
            {hasHealthManagementAccess === true && (
            <Surface p={5}>
              <CardHeading
                icon={<FirstAid />}
                title="Health & emergency information"
              />
              <HealthRecordStaffView
                scholarId={scholarId as Id<"users">}
                institutionScope={institutionScope}
              />
            </Surface>
            )}
            {!isOperationsMode && (
            <Surface p={5}>
              <CardHeading icon={<SpeakerHigh />} title="Audio" />
              <VStack gap={4} align="stretch">
                <HStack justify="space-between">
                  <VStack align="start" gap={0}>
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.500" fontWeight="500">
                      Text-to-Speech
                    </Text>
                    <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                      Read AI responses aloud
                    </Text>
                  </VStack>
                  <Switch.Root
                    checked={scholar?.ttsEnabled !== false}
                    onCheckedChange={(e) =>
                      updateAudioSettings({
                        scholarId: scholarId as Id<"users">,
                        ttsEnabled: e.checked,
                      })
                    }
                  >
                    <Switch.HiddenInput />
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Root>
                </HStack>
                <HStack justify="space-between">
                  <VStack align="start" gap={0}>
                    <Text fontSize="sm" fontFamily="heading" color="charcoal.500" fontWeight="500">
                      Voice Dictation
                    </Text>
                    <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                      Speech-to-text input
                    </Text>
                  </VStack>
                  <Switch.Root
                    checked={scholar?.sttEnabled !== false}
                    onCheckedChange={(e) =>
                      updateAudioSettings({
                        scholarId: scholarId as Id<"users">,
                        sttEnabled: e.checked,
                      })
                    }
                  >
                    <Switch.HiddenInput />
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                  </Switch.Root>
                </HStack>
              </VStack>
            </Surface>
            )}
            <ScholarAppsManager scholarId={scholarId as Id<"users">} />
            <Surface p={5}>
              <CardHeading icon={<Gear />} title="Account" />
              <VStack gap={2} align="stretch">
                <Button
                  size="sm"
                  variant="outline"
                  color="charcoal.500"
                  fontFamily="heading"
                  fontSize="xs"
                  borderColor="gray.200"
                  _hover={{ bg: "gray.50" }}
                  justifyContent="flex-start"
                  onClick={() => setShowResetPassword(true)}
                >
                  <Key style={{ marginRight: "6px" }} />
                  {passwordLabel}
                </Button>
                {passkeyCount > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    color="charcoal.500"
                    fontFamily="heading"
                    fontSize="xs"
                    borderColor="gray.200"
                    _hover={{ bg: "gray.50" }}
                    justifyContent="flex-start"
                    onClick={async () => {
                      try {
                        const res = await resetPasskeys({
                          scholarId: scholarId as Id<"users">,
                        });
                        toaster.success({
                          title: `Removed ${res.removed} passkey${res.removed === 1 ? "" : "s"}`,
                          description: "They can sign in with their password.",
                        });
                      } catch {
                        toaster.error({ title: "Couldn't remove passkeys" });
                      }
                    }}
                  >
                    <Key style={{ marginRight: "6px" }} />
                    Remove Passkeys ({passkeyCount})
                  </Button>
                )}
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="outline"
                    color="red.500"
                    fontFamily="heading"
                    fontSize="xs"
                    borderColor="red.100"
                    _hover={{ bg: "red.50" }}
                    justifyContent="flex-start"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash style={{ marginRight: "6px" }} />
                    Delete Scholar
                  </Button>
                )}
              </VStack>
            </Surface>
            {/* Parents */}
            <ParentsManager scholarId={scholarId as Id<"users">} />
          </VStack>
        )}

      </Box>

      {/* Create / reset password dialog */}
      <Dialog.Root
        open={showResetPassword}
        onOpenChange={(e) => {
          if (!e.open) closeResetDialog();
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  {resetLink ? "One-time sign-in link" : passwordLabel}
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                {resetLink ? (
                  <VStack gap={2} align="stretch">
                    <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                      Open this one-time link in a browser with{" "}
                      {scholar?.name ?? "the scholar"} to{" "}
                      {hasCredential ? "set a new password" : "choose a password"}.
                      Shown once:
                    </Text>
                    <Input
                      value={resetLink}
                      readOnly
                      onFocus={(e) => e.target.select()}
                      size="sm"
                      fontFamily="mono"
                      fontSize="xs"
                      borderColor="gray.300"
                    />
                    <Text fontSize="xs" fontFamily="body" color="charcoal.400">
                      {hasCredential
                        ? "Their old password keeps working until they set the new one. Setting it signs them out of other devices."
                        : "Setting it signs them in on that device."}{" "}
                      A locked-down school iPad can&apos;t open this link — those
                      sign in through device setup instead.
                    </Text>
                  </VStack>
                ) : needsUsername ? (
                  <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                    A password needs a username first. Add one in Account
                    details above, then create the password.
                  </Text>
                ) : (
                  <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                    {hasCredential ? "Reset" : "Create"} the password for{" "}
                    <strong>{scholar?.name ?? "this scholar"}</strong>? You&apos;ll
                    get a one-time link for them to{" "}
                    {hasCredential ? "set a new one" : "choose one"}.
                  </Text>
                )}
                {resetError && (
                  <Text fontSize="xs" fontFamily="body" color="red.500" mt={2}>
                    {resetError}
                  </Text>
                )}
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                {resetLink ? (
                  <Button
                    size="sm"
                    bg="violet.500"
                    color="white"
                    _hover={{ bg: "violet.600" }}
                    fontFamily="heading"
                    onClick={closeResetDialog}
                  >
                    Done
                  </Button>
                ) : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      fontFamily="heading"
                      onClick={closeResetDialog}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      bg="violet.500"
                      color="white"
                      _hover={{ bg: "violet.600" }}
                      fontFamily="heading"
                      disabled={needsUsername}
                      onClick={async () => {
                        setResetError("");
                        try {
                          const result = await issuePinLink({ userId: scholarId as Id<"users"> });
                          setResetLink(window.location.origin + result.path);
                        } catch (err) {
                          console.error("Issue reset link failed:", err);
                          setResetError(ISSUE_FAILED_GUIDANCE);
                        }
                      }}
                    >
                      Get link
                    </Button>
                  </>
                )}
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Delete confirmation dialog */}
      <Dialog.Root
        open={showDeleteConfirm}
        onOpenChange={(e) => setShowDeleteConfirm(e.open)}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Delete Scholar
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  Delete <strong>{scholar?.name ?? "this scholar"}</strong> and ALL their data? This cannot be undone.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => setShowDeleteConfirm(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={async () => {
                    setShowDeleteConfirm(false);
                    onDelete?.();
                    await deleteUser({ userId: scholarId as Id<"users"> });
                  }}
                >
                  Delete
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>

      {/* Observation delete confirmation */}
      <Dialog.Root
        open={obsPendingDelete !== null}
        onOpenChange={(e) => {
          if (!e.open) setObsPendingDelete(null);
        }}
        placement="center"
      >
        <Portal>
          <Dialog.Backdrop />
          <Dialog.Positioner>
            <StyledDialogContent>
              <Dialog.Header px={6} pt={5} pb={2}>
                <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                  Delete observation
                </Dialog.Title>
              </Dialog.Header>
              <Dialog.Body px={6} py={3}>
                <Text fontSize="sm" fontFamily="body" color="charcoal.500">
                  Delete this <strong>{obsPendingDelete?.type}</strong> observation
                  {obsPendingDelete ? ` from ${formatRelative(obsPendingDelete._creationTime)}` : ""}? This cannot be undone.
                </Text>
              </Dialog.Body>
              <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
                <Button
                  size="sm"
                  variant="ghost"
                  fontFamily="heading"
                  onClick={() => setObsPendingDelete(null)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  bg="red.500"
                  color="white"
                  _hover={{ bg: "red.600" }}
                  fontFamily="heading"
                  onClick={async () => {
                    const id = obsPendingDelete?._id;
                    setObsPendingDelete(null);
                    if (id) await handleDeleteObservation(id);
                  }}
                >
                  Delete
                </Button>
              </Dialog.Footer>
            </StyledDialogContent>
          </Dialog.Positioner>
        </Portal>
      </Dialog.Root>
    </Box>
  );
}

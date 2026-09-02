// ─── Rich-cohort seed: ROSTER ─────────────────────────────────────────────
//
// A fictional school at the end of Week 1. Two teachers and two grade-band cohorts
// of six scholars each — a K-2 group and a 3-5 group. Each cohort is one
// scholarGroup: the social/peer unit (name + emoji surface in scholar-facing
// features) and the unit the weekly schedule is stamped onto. Within a cohort
// levels are mixed (a 2nd-grader doing 4th-grade math sits beside a peer on
// geometry, per the school's philosophy). Five parent accounts (one a
// two-sibling household) linked via guardianships.
//
// Hand-authored. Keys are stable; the inserter resolves them to Ids.

import type {
  SeedTeacher,
  SeedScholar,
  SeedParent,
  SeedGroup,
  SeedTeacherAffinity,
  SeedDossier,
  SeedDirective,
  SeedReadingLevelHistory,
} from "./types";

export const teachers: SeedTeacher[] = [
  {
    key: "t.kawena",
    username: "kawena",
    name: "Kawena Naʻeole",
    email: "kawena@moli.school",
    role: "teacher",
  },
  {
    key: "t.daniel",
    username: "dchar",
    name: "Daniel Char",
    email: "dchar@moli.school",
    role: "teacher",
  },
  {
    key: "t.lehua",
    username: "lehua",
    name: "Lehua Torres",
    email: "lehua@moli.school",
    role: "teacher",
  },
];

// The ʻIwa cohort (🐦‍⬛ K-2, Kawena) and the Honu cohort (🐢 3-5, Daniel).
// Both teachers see every scholar (role-based, not ACL).
export const scholars: SeedScholar[] = [
  {
    key: "s.keoni",
    username: "keoni_alama",
    name: "Keoni Alama",
    grade: "K",
    readingLevel: "1",
    readingLevelSuggestion: "2",
    dateOfBirth: "2020-09-04",
  },
  {
    key: "s.malia",
    username: "malia_fukunaga",
    name: "Malia Fukunaga",
    grade: "Grade 1",
    readingLevel: "3",
    dateOfBirth: "2019-05-22",
  },
  {
    key: "s.iokepa",
    username: "iokepa_lindsey",
    name: "ʻIokepa Lindsey",
    grade: "Grade 2",
    readingLevel: "2",
    dateOfBirth: "2018-11-13",
    preferredFont: "andika",
  },
  {
    key: "s.sage",
    username: "sage_watanabe",
    name: "Sage Watanabe",
    grade: "Grade 3",
    readingLevel: "3",
    dateOfBirth: "2017-07-30",
  },
  {
    key: "s.kalei",
    username: "kalei_bautista",
    name: "Kalei Bautista",
    grade: "Grade 4",
    readingLevel: "5",
    dateOfBirth: "2016-03-18",
  },
  {
    key: "s.tiare",
    username: "tiare_souza",
    name: "Tiare Souza",
    grade: "Grade 5",
    readingLevel: "6",
    dateOfBirth: "2015-10-09",
  },
  {
    key: "s.nainoa",
    username: "nainoa_kekoa",
    name: "Nainoa Kekoa",
    grade: "K",
    readingLevel: "K",
    readingLevelSuggestion: "1",
    dateOfBirth: "2020-12-01",
  },
  {
    key: "s.emma",
    username: "emma_higa",
    name: "Emma Higa",
    grade: "Grade 1",
    readingLevel: "1",
    dateOfBirth: "2019-02-14",
  },
  {
    key: "s.koa",
    username: "koa_demello",
    name: "Koa De Mello",
    grade: "Grade 2",
    readingLevel: "2",
    dateOfBirth: "2018-08-27",
  },
  {
    key: "s.leilani",
    username: "leilani_park",
    name: "Leilani Park",
    grade: "Grade 3",
    readingLevel: "5",
    dateOfBirth: "2017-04-06",
  },
  {
    key: "s.makoa",
    username: "makoa_texeira",
    name: "Makoa Texeira",
    grade: "Grade 4",
    readingLevel: "2",
    readingLevelSuggestion: "3",
    dateOfBirth: "2016-06-21",
    preferredFont: "opendyslexic",
  },
  {
    key: "s.anela",
    username: "anela_cruz",
    name: "Anela Cruz",
    grade: "Grade 5",
    readingLevel: "6",
    dateOfBirth: "2015-12-30",
  },
  {
    key: "s.mae",
    username: "mae_nakamura",
    name: "Mae Nakamura",
    grade: "Grade 4",
    readingLevel: "4",
    dateOfBirth: "2016-09-12",
    enrollmentStanding: "program_guest",
  },
  {
    key: "s.theo",
    username: "theo_kim",
    name: "Theo Kim",
    grade: "Grade 5",
    readingLevel: "5",
    dateOfBirth: "2015-07-19",
    enrollmentStanding: "program_guest",
  },
  {
    key: "s.luca",
    username: "luca_martin",
    name: "Luca Martin",
    grade: "Grade 3",
    readingLevel: "4",
    dateOfBirth: "2017-01-26",
    enrollmentStanding: "program_guest",
  },
];

// One cohort per scholar — the group is both the social/peer unit (name +
// emoji surface in scholar-facing features) and the unit the weekly schedule
// is stamped onto. Two grade bands: ʻIwa (K-2, Kawena) and Honu (3-5, Daniel).
export const groups: SeedGroup[] = [
  {
    key: "group.iwa",
    name: "ʻIwa",
    emoji: "🐦‍⬛",
    teacherKey: "t.kawena",
    scholarKeys: ["s.keoni", "s.malia", "s.iokepa", "s.nainoa", "s.emma", "s.koa"],
  },
  {
    key: "group.honu",
    name: "Honu",
    emoji: "🐢",
    teacherKey: "t.daniel",
    scholarKeys: ["s.sage", "s.kalei", "s.tiare", "s.leilani", "s.makoa", "s.anela"],
  },
  {
    key: "group.robotics",
    name: "Robotics",
    emoji: "🤖",
    type: "robotics",
    teacherKey: "t.lehua",
    scholarKeys: [
      "s.kalei",
      "s.leilani",
      "s.malia",
      "s.iokepa",
      "s.mae",
      "s.theo",
      "s.luca",
    ],
  },
];

export const teacherAffinities: SeedTeacherAffinity[] = [
  {
    teacherKey: "t.kawena",
    scholarKeys: ["s.keoni", "s.malia", "s.iokepa", "s.nainoa", "s.emma", "s.koa"],
    groupKeys: ["group.iwa"],
  },
  {
    teacherKey: "t.daniel",
    scholarKeys: ["s.sage", "s.kalei", "s.tiare", "s.leilani", "s.makoa", "s.anela"],
    groupKeys: ["group.honu"],
  },
];

// Five parents; the Fukunaga–Souza household has two children across grades
// 1 and 5 (a two-sibling guardian), the rest single-child. Seven of twelve
// scholars have a linked parent — realistic for Week 1.
export const parents: SeedParent[] = [
  {
    key: "p.alama",
    username: "parent_alama",
    name: "Pua Alama",
    email: "pua.alama@example.com",
    childKeys: ["s.keoni"],
    notificationPrefs: { weeklyDigest: true, homeworkReminders: true },
  },
  {
    key: "p.fukunaga",
    username: "parent_fukunaga",
    name: "Grace Fukunaga",
    email: "grace.fukunaga@example.com",
    childKeys: ["s.malia", "s.tiare"],
    notificationPrefs: { weeklyDigest: true, homeworkReminders: true, digestDay: "sunday" },
  },
  {
    key: "p.bautista",
    username: "parent_bautista",
    name: "Rommel Bautista",
    email: "rommel.bautista@example.com",
    childKeys: ["s.kalei"],
    notificationPrefs: { weeklyDigest: true, smsEnabled: false },
  },
  {
    key: "p.park",
    username: "parent_park",
    name: "Hana Park",
    email: "hana.park@example.com",
    childKeys: ["s.leilani"],
  },
  {
    key: "p.cruz",
    username: "parent_cruz",
    name: "Marcus Cruz",
    email: "marcus.cruz@example.com",
    childKeys: ["s.anela", "s.nainoa"],
    notificationPrefs: { weeklyDigest: true, homeworkReminders: false },
  },
  {
    key: "p.nakamura",
    username: "parent_nakamura",
    name: "Jordan Nakamura",
    email: "jordan.nakamura@example.com",
    childKeys: ["s.mae"],
    notificationPrefs: { weeklyDigest: false, homeworkReminders: false },
  },
  {
    key: "p.kim",
    username: "parent_kim",
    name: "Alex Kim",
    email: "alex.kim@example.com",
    childKeys: ["s.theo"],
    notificationPrefs: { weeklyDigest: false, homeworkReminders: false },
  },
  {
    key: "p.martin",
    username: "parent_martin",
    name: "Sam Martin",
    email: "sam.martin@example.com",
    childKeys: ["s.luca"],
    notificationPrefs: { weeklyDigest: false, homeworkReminders: false },
  },
];

export const dossiers: SeedDossier[] = [
  {
    scholarKey: "s.kalei",
    content:
      "Grade 4, working two grade levels up in mathematics (Acme Practice: Algebra I foundations). Hungry for challenge; deflates fast when a task feels 'babyish'. Give him the hard version first. Strong number sense, impatient with showing work.",
  },
  {
    scholarKey: "s.makoa",
    content:
      "Grade 4. Brilliant verbal reasoner — explains cause-and-effect in science better than most fifth graders — but writing output lags far behind his thinking. Suspected stealth dyslexia (see directive). Let him talk first, scribe later. Never make decoding the gate to participation.",
  },
  {
    scholarKey: "s.leilani",
    content:
      "Grade 3, profoundly asynchronous — reads at Grade 5, reasons abstractly, but is 8 and cries when she gets something 'wrong'. Perfectionism is the real instructional target, not the content. Praise process and risk-taking, not correctness.",
  },
  {
    scholarKey: "s.keoni",
    content:
      "Kindergarten, intense early-math kid — counts in patterns, asks about infinity. Reads a year up. Short attention for anything that isn't numbers or building. Channel the math obsession into everything.",
  },
];

export const directives: SeedDirective[] = [
  {
    scholarKey: "s.makoa",
    label: "Stealth dyslexia — talk-first",
    content:
      "Makoa's reasoning is ahead of his decoding. ALWAYS let him explain his thinking out loud (or via dictation) before any writing. When he writes, accept invented spelling without comment — capture the idea, never red-pen the spelling. Offer to scribe. Reading aloud to the group is opt-in only.",
    authorKey: "t.kawena",
    isActive: true,
  },
  {
    scholarKey: "s.leilani",
    label: "Perfectionism — praise the risk",
    content:
      "Leilani avoids anything she might get wrong. Frame mistakes as information. Notice and name when she tries a hard thing or revises. Do NOT rush to reassure her that an answer is 'right' — sit with the not-knowing.",
    authorKey: "t.kawena",
    isActive: true,
  },
];

export const readingLevelHistory: SeedReadingLevelHistory[] = [
  { scholarKey: "s.keoni", level: "K", source: "teacher", changedByKey: "t.daniel", agoDays: 6 },
  { scholarKey: "s.keoni", level: "1", source: "observer", agoDays: 2 },
  { scholarKey: "s.makoa", level: "3", source: "teacher", changedByKey: "t.kawena", agoDays: 6 },
  { scholarKey: "s.makoa", level: "2", source: "observer", agoDays: 1 },
  { scholarKey: "s.nainoa", level: "K", source: "teacher", changedByKey: "t.kawena", agoDays: 6 },
];

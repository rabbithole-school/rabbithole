// ─── Rich-cohort seed: WEEKLY SCHEDULE ─────────────────────────────────────
//
// A realistic small-school cadence: the two grade-band cohorts (K-2 and 3-5)
// share a bell schedule, rotate Humanities / Language Arts / Science
// Monday-Thursday, and use Friday morning for paired Humanities + Science
// blocks.

import type {
  SeedExternalApp,
  SeedReportingPeriod,
  SeedScheduleBlock,
  SeedSchedulePlacement,
} from "./types";

const MON_THU = [1, 2, 3, 4];
const MON_FRI = [1, 2, 3, 4, 5];

// The "standing assignment" demo (review/app-access-unification-plan.html
// §robotics): Robotics' recurring Block E meeting grants LEGO SPIKE for
// exactly that meeting's window, via schedulePlacements.externalAppId. One
// minimal catalog row is enough to demo the mechanism.
export const externalApps: SeedExternalApp[] = [
  {
    key: "app.spike",
    name: "LEGO SPIKE",
    webUrl: "https://spike.legoeducation.com",
    nativeUrlScheme: "spike://",
    iconEmoji: "🤖",
    color: "#d81921",
  },
];

export const reportingPeriods: SeedReportingPeriod[] = [
  {
    key: "period.current",
    label: "Current Term",
    startsAgoDays: 30,
    endsInDays: 60,
    status: "open",
  },
];

export const scheduleBlocks: SeedScheduleBlock[] = [
  {
    key: "block.morning-circle",
    periodKey: "period.current",
    label: "Morning Circle",
    startLocal: "08:00",
    endLocal: "08:30",
    weekdays: MON_FRI,
    order: 0,
    kind: "class",
  },
  {
    key: "block.a",
    periodKey: "period.current",
    label: "Block A",
    startLocal: "08:30",
    endLocal: "09:40",
    weekdays: MON_FRI,
    order: 1,
    kind: "class",
  },
  {
    key: "block.b",
    periodKey: "period.current",
    label: "Block B",
    startLocal: "09:40",
    endLocal: "10:50",
    weekdays: MON_FRI,
    order: 2,
    kind: "class",
  },
  {
    key: "block.recess-a",
    periodKey: "period.current",
    label: "Recess A",
    startLocal: "10:50",
    endLocal: "11:05",
    weekdays: MON_THU,
    order: 3,
    kind: "recess",
    staffNeed: 2,
  },
  {
    key: "block.c",
    periodKey: "period.current",
    label: "Block C",
    startLocal: "11:10",
    endLocal: "12:20",
    weekdays: MON_THU,
    order: 4,
    kind: "class",
  },
  {
    key: "block.lunch",
    periodKey: "period.current",
    label: "Lunch / Recess",
    startLocal: "12:20",
    endLocal: "13:00",
    weekdays: MON_THU,
    order: 5,
    kind: "lunch",
    staffNeed: 2,
  },
  {
    key: "block.d",
    periodKey: "period.current",
    label: "Block D",
    startLocal: "13:00",
    endLocal: "14:10",
    weekdays: MON_THU,
    order: 6,
    kind: "class",
  },
  {
    key: "block.recess-b",
    periodKey: "period.current",
    label: "Recess B",
    startLocal: "14:10",
    endLocal: "14:25",
    weekdays: MON_THU,
    order: 7,
    kind: "recess",
    staffNeed: 2,
  },
  {
    key: "block.practice-lab",
    periodKey: "period.current",
    label: "Scholar’s Prep",
    startLocal: "14:30",
    endLocal: "15:00",
    weekdays: MON_THU,
    order: 8,
    kind: "prep",
  },
  {
    key: "block.e",
    periodKey: "period.current",
    label: "Block E",
    startLocal: "15:05",
    endLocal: "16:30",
    weekdays: MON_THU,
    order: 9,
    kind: "class",
  },
];

const placement = (
  groupKey: string,
  weekday: number,
  blockKey: string,
  subject: string,
  teacherKey: string,
): SeedSchedulePlacement => ({
  periodKey: "period.current",
  groupKey,
  weekday,
  blockKey,
  subject,
  teacherKey,
});

export const schedulePlacements: SeedSchedulePlacement[] = [
  // K-2: Mon/Wed Humanities; Tue/Thu Science + Language Arts.
  placement("group.iwa", 1, "block.a", "Math Workshop", "t.kawena"),
  placement("group.iwa", 1, "block.b", "Humanities", "t.kawena"),
  placement("group.iwa", 2, "block.a", "Math Workshop", "t.kawena"),
  placement("group.iwa", 2, "block.b", "Science", "t.daniel"),
  placement("group.iwa", 2, "block.c", "Language Arts", "t.kawena"),
  placement("group.iwa", 3, "block.a", "Math Workshop", "t.kawena"),
  placement("group.iwa", 3, "block.b", "Humanities", "t.kawena"),
  placement("group.iwa", 4, "block.a", "Math Workshop", "t.kawena"),
  placement("group.iwa", 4, "block.b", "Science", "t.daniel"),
  placement("group.iwa", 4, "block.c", "Language Arts", "t.kawena"),
  placement("group.iwa", 5, "block.a", "Humanities", "t.kawena"),
  placement("group.iwa", 5, "block.b", "Science", "t.daniel"),

  // 3-5: Mon/Wed Humanities + Science; Tue/Thu Language Arts.
  placement("group.honu", 1, "block.a", "Math Workshop", "t.daniel"),
  placement("group.honu", 1, "block.c", "Humanities", "t.kawena"),
  placement("group.honu", 1, "block.d", "Science", "t.daniel"),
  placement("group.honu", 2, "block.a", "Math Workshop", "t.daniel"),
  placement("group.honu", 2, "block.b", "Language Arts", "t.kawena"),
  placement("group.honu", 3, "block.a", "Math Workshop", "t.daniel"),
  placement("group.honu", 3, "block.c", "Humanities", "t.kawena"),
  placement("group.honu", 3, "block.d", "Science", "t.daniel"),
  placement("group.honu", 4, "block.a", "Math Workshop", "t.daniel"),
  placement("group.honu", 4, "block.b", "Language Arts", "t.kawena"),
  placement("group.honu", 5, "block.a", "Science", "t.daniel"),
  placement("group.honu", 5, "block.b", "Humanities", "t.kawena"),

  // Extended Education: the Robotics roster intentionally overlaps both
  // enrolled cohorts and includes program guests. Monday's meeting demos the
  // "standing assignment" app target (externalAppKey → LEGO SPIKE); Wednesday
  // stays a plain bare cell, so the seed shows both shapes side by side.
  {
    ...placement("group.robotics", 1, "block.e", "Robotics", "t.lehua"),
    externalAppKey: "app.spike",
  },
  placement("group.robotics", 3, "block.e", "Robotics", "t.lehua"),
];

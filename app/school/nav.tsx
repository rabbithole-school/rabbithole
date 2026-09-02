import { type ReactNode } from "react";
import {
  Buildings,
  ChalkboardTeacher,
  ClipboardText,
  DeviceTablet,
  FirstAid,
  GearSix,
  Student,
  Ticket,
  UsersFour,
  UsersThree,
} from "@phosphor-icons/react";
import {
  ROLES,
  isPlatformAdminRole,
  isStaffRole,
  isTeacherRole,
  type Role,
} from "@/convex/lib/roles";

export type NavRequires =
  | "staff"
  | "scholarAdmin"
  | "schoolAdmin"
  | "deviceAccess"
  | "health";

export type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  requires: NavRequires;
};

export const NAV: NavItem[] = [
  { href: "/school/directory/scholars", label: "Scholars", icon: <Student />, requires: "scholarAdmin" },
  { href: "/school/directory/guardians", label: "Guardians", icon: <UsersThree />, requires: "scholarAdmin" },
  { href: "/school/directory/staff", label: "Staff", icon: <ChalkboardTeacher />, requires: "scholarAdmin" },
  { href: "/school/directory/forms", label: "Forms", icon: <ClipboardText />, requires: "scholarAdmin" },
  { href: "/school/groups", label: "Groups", icon: <UsersFour />, requires: "scholarAdmin" },
  { href: "/school/health", label: "Health", icon: <FirstAid />, requires: "health" },
  { href: "/school/devices", label: "Devices", icon: <DeviceTablet />, requires: "deviceAccess" },
  { href: "/school/instructional-materials", label: "Instructional materials", icon: <Buildings />, requires: "staff" },
  { href: "/school/invites", label: "Invites", icon: <Ticket />, requires: "schoolAdmin" },
  { href: "/school/settings", label: "Settings", icon: <GearSix />, requires: "schoolAdmin" },
];

function canManageStaff(role: Role | string | undefined): boolean {
  return role === ROLES.SCHOOL_ADMIN || isPlatformAdminRole(role as Role | undefined);
}

export function isStaffRoleForSchool(role: Role | string | undefined): boolean {
  return role === "staff" || isStaffRole(role as Role | undefined);
}

export function isNavItemVisible(
  item: NavItem,
  role: Role | string | undefined,
  hasCaptureReviewAccess = false,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): boolean {
  switch (item.requires) {
    case "staff":
      return isStaffRoleForSchool(role);
    case "scholarAdmin":
      return isTeacherRole(role as Role | undefined) || hasSchoolOperationsAccess;
    case "schoolAdmin":
      return canManageStaff(role);
    case "deviceAccess":
      return isTeacherRole(role as Role | undefined)
        || hasSchoolOperationsAccess
        || hasCaptureReviewAccess;
    case "health":
      return hasHealthManagementAccess;
  }
}

export function firstVisibleNavHref(
  role: Role | string | undefined,
  hasCaptureReviewAccess = false,
  hasSchoolOperationsAccess = false,
  hasHealthManagementAccess = false,
): string | undefined {
  return NAV.find((item) =>
    isNavItemVisible(
      item,
      role,
      hasCaptureReviewAccess,
      hasSchoolOperationsAccess,
      hasHealthManagementAccess,
    ),
  )?.href;
}

"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { DriveSyncAdmin } from "@/components/DriveSyncAdmin";
import {
  isPlatformAdminRole,
  isSchoolAdminRole,
  type Role,
} from "@/convex/lib/roles";

// Drive sync — institution infra. A platform_admin manages any school's inbox;
// a school_admin manages their own. Everyone else deep-linking here is bounced
// home. (The per-institution scope is enforced server-side in driveSync.ts.)
export default function DriveSyncPage() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  const role = user?.role as Role | undefined;
  const canManage = isPlatformAdminRole(role) || isSchoolAdminRole(role);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!canManage) {
      router.replace("/");
    }
  }, [user, canManage, isLoading, router]);

  if (isLoading || !user || !canManage) {
    return null;
  }

  return <DriveSyncAdmin />;
}

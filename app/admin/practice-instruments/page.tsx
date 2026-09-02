"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { PracticeInstrumentsPanel } from "@/components/PracticeInstrumentsPanel";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";

// Practice instruments — platform-admin-only, read-only calibration panel
// (review/practice/practice-plan-of-record.html §9). A non-platform-admin
// deep-linking here is bounced home, mirroring app/admin/drive-sync/page.tsx.
export default function PracticeInstrumentsPage() {
  const { user, isLoading } = useCurrentUser();
  const router = useRouter();
  const isAdmin = isPlatformAdminRole(user?.role as Role | undefined);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isAdmin) {
      router.replace("/");
    }
  }, [user, isAdmin, isLoading, router]);

  if (isLoading || !user || !isAdmin) {
    return null;
  }

  return <PracticeInstrumentsPanel />;
}

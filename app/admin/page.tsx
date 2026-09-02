"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// /admin has no content of its own — it redirects to Accounts (the platform
// console landing). The layout gates non-platform-admins. (The school-scoped
// School Directory moved to /school/directory.)
export default function AdminIndex() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/admin/accounts");
  }, [router]);

  return null;
}

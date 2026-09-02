"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { withInstitutionScope } from "@/lib/institutionLinks";

// /school/directory has no content of its own — the directory is its tabs
// (scholars / guardians / staff); default to the Scholars lens.
export default function SchoolDirectoryIndex() {
  const router = useRouter();
  const { scopeParam } = useActiveInstitution();
  useEffect(() => {
    router.replace(
      withInstitutionScope(
        "/school/directory/scholars",
        scopeParam === "all" ? "" : scopeParam,
      ),
    );
  }, [router, scopeParam]);
  return null;
}

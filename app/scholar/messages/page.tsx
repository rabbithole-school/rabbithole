"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ScholarPrepShell } from "@/components/ScholarPrepShell";
import { ScholarMessages } from "@/components/ScholarMessages";

/**
 * The scholar's Messages — mentor conversations and Workshop idea threads in
 * one list. Reached from the account menu and from a Workshop card
 * (`?kind=workshop&thread=…`), whose Back returns to the Workshop.
 */
function ScholarMessagesPageBody() {
  const params = useSearchParams();
  const fromWorkshop = params.get("kind") === "workshop";
  return (
    <ScholarPrepShell
      title="Messages"
      backHref={fromWorkshop ? "/scholar/workshop" : "/scholar"}
    >
      <ScholarMessages />
    </ScholarPrepShell>
  );
}

export default function ScholarMessagesPage() {
  return (
    <Suspense fallback={null}>
      <ScholarMessagesPageBody />
    </Suspense>
  );
}

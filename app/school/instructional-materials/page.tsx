"use client";

import { SchoolSpaceAdmin } from "@/components/SchoolSpaceAdmin";

// The /school shell (app/school/layout.tsx) gates entry to staff and provides
// the header, breadcrumb and account menu; the page just renders the curation
// surface.
export default function SchoolSpacePage() {
  return <SchoolSpaceAdmin />;
}

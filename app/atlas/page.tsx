import { redirect } from "next/navigation";

// The Concept Atlas lives at /teacher/galaxy (one surface, three lenses).
// Keep /atlas working for old links by redirecting.
export default function AtlasRedirect() {
  redirect("/teacher/galaxy");
}

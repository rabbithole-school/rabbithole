import { redirect } from "next/navigation";

// The Concept Atlas was unified into /teacher/galaxy (one surface, three
// lenses). Keep /teacher/atlas working for old links by redirecting.
export default function AtlasRedirect() {
  redirect("/teacher/galaxy");
}

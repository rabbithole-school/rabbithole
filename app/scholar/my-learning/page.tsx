import { redirect } from "next/navigation";

/**
 * /scholar/my-learning was an old alias for the scholar self-view. Keep it as a
 * route-level redirect so hard loads do not fall through to /scholar/[sessionId].
 */
export default function ScholarMyLearningRedirect() {
  redirect("/me");
}

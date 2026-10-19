// /tutor-key — add the tutor's Anthropic key from inside Rabbithole (TRA-536).
// Served only on the public local runner (`pnpm local:setup`); a 404 on every
// other deployment. The gate lives in lib/localRunnerKey.ts.
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { localRunnerKeySetup, loopbackHost } from "@/lib/localRunnerKey";
import { TutorKeyForm } from "./TutorKeyForm";

export const dynamic = "force-dynamic";

export default async function TutorKeyPage() {
  if (!loopbackHost(await headers())) notFound();
  const setup = await localRunnerKeySetup();
  if (!setup.available) notFound();
  return <TutorKeyForm />;
}

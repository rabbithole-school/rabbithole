import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST() {
  const activityPort = process.env.RH_DEV_ACTIVITY_PORT;
  if (
    process.env.NODE_ENV !== "development" ||
    !activityPort ||
    !/^\d{2,5}$/.test(activityPort)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  const stateDir = process.env.RH_DEV_STATE_DIR || join(homedir(), ".rabbithole", "dev-servers");
  const statePath = join(stateDir, `${activityPort}.activity`);
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, "");
  return new NextResponse(null, { status: 204 });
}

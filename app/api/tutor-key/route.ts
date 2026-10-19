// POST /api/tutor-key — check an Anthropic key and store it as the local
// runner's ANTHROPIC_API_KEY (TRA-536). A 404 on every deployment except the
// public local runner; see lib/localRunnerKey.ts for the gate and why it is
// shaped this way. Never logs or echoes the key.
import { NextResponse } from "next/server";
import {
  checkAnthropicKey,
  localRunnerKeySetup,
  loopbackHost,
  plausibleAnthropicKey,
  sameOriginPost,
  saveKeyToLocalBackend,
} from "@/lib/localRunnerKey";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function refuse(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

// Set-once, strictly: requests run one at a time, and each re-checks that the
// runner still has no key immediately before saving. A second request that was
// already in flight when the first saved gets the same 404 as a later one.
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export async function POST(request: Request) {
  if (!loopbackHost(request.headers)) return new NextResponse(null, { status: 404 });
  return oneAtATime(() => handle(request));
}

async function handle(request: Request) {
  const setup = await localRunnerKeySetup();
  if (!setup.available) return new NextResponse(null, { status: 404 });
  if (!sameOriginPost(request.headers)) {
    return refuse(403, "Add the key from Rabbithole's own page.");
  }

  let key = "";
  try {
    const body = (await request.json()) as { key?: unknown };
    if (typeof body.key === "string") key = body.key.trim();
  } catch {
    /* falls through to the shape check */
  }
  if (!plausibleAnthropicKey(key)) {
    return refuse(400, "That doesn't look like an Anthropic API key.");
  }

  const check = await checkAnthropicKey(key);
  if (check === "rejected") {
    return refuse(400, "Anthropic didn't accept that key. Check it and try again.");
  }
  if (check === "unreachable") {
    return refuse(502, "Couldn't reach Anthropic to check the key. Try again in a moment.");
  }

  // The check above takes a network round trip: confirm nothing set a key
  // meanwhile (another tab, or `pnpm local:setup`) before saving this one.
  if (!(await localRunnerKeySetup()).available) {
    return new NextResponse(null, { status: 404 });
  }
  if (!(await saveKeyToLocalBackend(key))) {
    return refuse(500, "The key works, but saving it failed. Try again.");
  }
  return NextResponse.json({ ok: true });
}

/**
 * `/tts` spends our OpenAI key, so it must refuse anonymous callers
 * (TRA-491). A signed-in user whose account and school are still active, and
 * the Wonder Lens Pi (device secret), get speech; a signed-in call is
 * attributed to the caller's institution. Everyone else is refused before
 * any OpenAI spend.
 */
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { seedScholarInInstitution, seedTestInstitution } from "./institutionTestHelpers";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

let openaiCalls = 0;

beforeEach(() => {
  openaiCalls = 0;
  vi.stubEnv("OPENAI_API_KEY", "test-openai-key");
  vi.stubEnv("WONDER_SNAP_SECRET", "test-wonder-secret");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    expect(String(input)).toBe("https://api.openai.com/v1/audio/speech");
    openaiCalls += 1;
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Type": "audio/mpeg" },
    });
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function withUser(t: ReturnType<typeof convexTest>, userId: Id<"users">) {
  const sessionId = await t.run(async (ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 1000 * 60 * 60,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

const speak = (
  as: { fetch: ReturnType<typeof convexTest>["fetch"] },
  headers: Record<string, string> = {},
  extra: Record<string, string> = {},
) =>
  as.fetch("/tts", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ text: "Hello there.", ...extra }),
  });

const STYLED = { instructions: "Speak warmly." };

describe("/tts auth", () => {
  test("an anonymous browser caller is refused before any OpenAI spend", async () => {
    const t = convexTest(schema, modules);
    const res = await speak(t, { Origin: "https://evil.example" });
    expect(res.status).toBe(401);
    expect(openaiCalls).toBe(0);
  });

  test("a bare request with no credential is refused (the old tokenless iPad shape)", async () => {
    const t = convexTest(schema, modules);
    const res = await speak(t);
    expect(res.status).toBe(401);
    expect(openaiCalls).toBe(0);
  });

  test("an anonymous styled request is refused", async () => {
    const t = convexTest(schema, modules);
    const res = await speak(t, {}, STYLED);
    expect(res.status).toBe(401);
    expect(openaiCalls).toBe(0);
  });

  test("a wrong device secret is refused", async () => {
    const t = convexTest(schema, modules);
    const res = await speak(t, { "x-wonder-secret": "nope" });
    expect(res.status).toBe(401);
    expect(openaiCalls).toBe(0);
  });

  test("a bearer token that doesn't verify is refused, never treated as anonymous", async () => {
    const t = convexTest(schema, modules);
    const res = await speak(t, { Authorization: "Bearer not-a-real-token" });
    expect(res.status).toBe(401);
    expect(openaiCalls).toBe(0);
  });

  test("a deleted user's still-valid token gets no speech", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "tts-deleted",
      name: "Deleted Scholar",
    });
    const as = await withUser(t, scholarId);
    await t.run((ctx) => ctx.db.delete(scholarId));
    const res = await speak(as);
    expect(res.status).toBe(401);
    expect(openaiCalls).toBe(0);
  });

  test("a caller whose only institution is suspended gets no speech", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "tts-paused",
      name: "Paused Scholar",
    });
    await t.run((ctx) => ctx.db.patch(institutionId, { disabledAt: Date.now() }));
    const res = await speak(await withUser(t, scholarId));
    expect(res.status).toBe(403);
    expect(openaiCalls).toBe(0);
  });

  test("a signed-in scholar gets speech from a browser, attributed to their institution", async () => {
    const t = convexTest(schema, modules);
    const institutionId = await seedTestInstitution(t);
    const scholarId = await seedScholarInInstitution(t, {
      institutionId,
      username: "tts-scholar",
      name: "TTS Scholar",
    });
    const res = await speak(await withUser(t, scholarId), {
      Origin: "https://rabbithole.school",
    });
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(openaiCalls).toBe(1);

    const rows = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "tts",
      role: "scholar",
      institutionId,
      characters: "Hello there.".length,
    });
  });

  test("the Wonder Lens device secret gets styled speech without a user session", async () => {
    const t = convexTest(schema, modules);
    const res = await speak(t, { "x-wonder-secret": "test-wonder-secret" }, STYLED);
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    expect(openaiCalls).toBe(1);
    const rows = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(rows[0]).toMatchObject({ source: "tts", model: "gpt-4o-mini-tts" });
    expect(rows[0].role).toBeUndefined();
  });
});

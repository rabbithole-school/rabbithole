import { convexTest } from "convex-test";
import {
  makeFunctionReference,
  type FunctionReference,
} from "convex/server";
import { afterEach, describe, expect, test } from "vitest";
import schema from "../schema";
import type { Doc, Id } from "../_generated/dataModel";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type MintResult = {
  clientSecret: string;
  expiresAtMs: number;
  model: string;
};

const mintTranscriptionSecret = makeFunctionReference<
  "action",
  Record<string, never>,
  MintResult
>(
  "realtimeTranscription:mintTranscriptionSecret",
) as FunctionReference<
  "action",
  "public",
  Record<string, never>,
  MintResult
>;

const originalApiKey = process.env.OPENAI_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalApiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = originalApiKey;
  }
});

async function seedScholar(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    ctx.db.insert("users", {
      name: "Realtime Scholar",
      username: "realtime_scholar",
      role: "scholar",
    }),
  );
}

async function withUser(
  t: ReturnType<typeof convexTest>,
  userId: Id<"users">,
) {
  const sessionId = await t.run(async (ctx) => {
    const session: Omit<Doc<"authSessions">, "_id" | "_creationTime"> = {
      userId,
      expirationTime: Date.now() + 3_600_000,
    };
    return await ctx.db.insert("authSessions", session);
  });
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

describe("mintTranscriptionSecret", () => {
  test("rejects an unauthenticated caller", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async () => {
      throw new Error("OpenAI must not be called for an anonymous request");
    }) as typeof fetch;

    const t = convexTest(schema, modules);
    await expect(
      t.action(mintTranscriptionSecret, {}),
    ).rejects.toThrow("Not authenticated");
  });

  test("mints a server-configured transcription client secret", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (
      url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          value: "ek_test_secret",
          expires_at: 1_800_000_000,
          session: { type: "transcription" },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.action(mintTranscriptionSecret, {}),
    ).resolves.toEqual({
      clientSecret: "ek_test_secret",
      expiresAtMs: 1_800_000_000_000,
      model: "gpt-4o-transcribe",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://api.openai.com/v1/realtime/client_secrets",
    );
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toMatchObject({
      Authorization: "Bearer sk-test",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      expires_after: {
        anchor: "created_at",
        seconds: 600,
      },
      session: {
        type: "transcription",
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-transcribe",
              language: "en",
            },
            turn_detection: {
              type: "semantic_vad",
            },
            noise_reduction: {
              type: "far_field",
            },
          },
        },
      },
    });
  });

  test("surfaces a clear error when OpenAI rejects the request", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    globalThis.fetch = (async () =>
      new Response("upstream failure", { status: 429 })) as typeof fetch;

    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.action(mintTranscriptionSecret, {}),
    ).rejects.toThrow(
      "OpenAI realtime client-secret request failed with status 429.",
    );
  });
});

describe("recordTranscriptionUsage", () => {
  const recordTranscriptionUsage = makeFunctionReference<
    "mutation",
    { audioSeconds: number },
    null
  >("realtimeTranscription:recordTranscriptionUsage") as FunctionReference<
    "mutation",
    "public",
    { audioSeconds: number },
    null
  >;

  test("rejects unauthenticated callers", async () => {
    const t = convexTest(schema, modules);
    await expect(
      t.mutation(recordTranscriptionUsage, { audioSeconds: 5 }),
    ).rejects.toThrow();
  });

  test("writes a clamped audioSeconds usage row for the realtime model", async () => {
    const t = convexTest(schema, modules);
    const scholarId = await seedScholar(t);
    const asScholar = await withUser(t, scholarId);

    await asScholar.mutation(recordTranscriptionUsage, {
      audioSeconds: 12.5,
    });
    // A wildly inflated client report gets clamped, and a zero/negative
    // report writes nothing.
    await asScholar.mutation(recordTranscriptionUsage, {
      audioSeconds: 100_000,
    });
    await asScholar.mutation(recordTranscriptionUsage, { audioSeconds: 0 });

    const rows = await t.run(async (ctx) =>
      ctx.db.query("usageEvents").collect(),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source: "realtime-transcription",
      model: "gpt-4o-transcribe",
      audioSeconds: 12.5,
    });
    expect(rows[1].audioSeconds).toBe(900);
  });
});

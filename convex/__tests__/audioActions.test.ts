import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "../schema";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { Role } from "../lib/roles";
import { MESSAGE_ATTACHMENT_MAX_BYTES } from "../../shared/messageAttachments";

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

type T = ReturnType<typeof convexTest>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function seedUser(t: T, role: Role, username: string) {
  return await t.run((ctx) =>
    ctx.db.insert("users", {
      name: `Test ${username}`,
      username,
      role,
    }),
  );
}

async function withUser(t: T, userId: Id<"users">) {
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 60 * 60 * 1_000,
    }),
  );
  return t.withIdentity({
    subject: `${userId}|${sessionId}`,
    issuer: "https://convex.dev",
  });
}

async function storeBlob(t: T, type: string, size = 8) {
  return await t.run((ctx) =>
    ctx.storage.store(new Blob([new Uint8Array(size).buffer], { type })),
  );
}

describe("transcribeAttachment", () => {
  test("requires an authenticated staff caller", async () => {
    const t = convexTest(schema, modules);
    const storageId = await storeBlob(t, "audio/webm");

    await expect(
      t.action(api.audioActions.transcribeAttachment, { storageId }),
    ).rejects.toThrow("Not signed in");

    const scholarId = await seedUser(t, "scholar", "scholar-audio");
    const asScholar = await withUser(t, scholarId);
    await expect(
      asScholar.action(api.audioActions.transcribeAttachment, { storageId }),
    ).rejects.toThrow("Forbidden: staff role required");
  });

  test("rejects files over Whisper's 25 MB cap before fetching", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "teacher-large-audio");
    const asTeacher = await withUser(t, teacherId);
    const storageId = await storeBlob(
      t,
      "audio/webm",
      MESSAGE_ATTACHMENT_MAX_BYTES + 1,
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      asTeacher.action(api.audioActions.transcribeAttachment, { storageId }),
    ).rejects.toThrow("Attachment exceeds Whisper's 25 MB limit");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("rejects non-media files before fetching", async () => {
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "teacher-text-file");
    const asTeacher = await withUser(t, teacherId);
    const storageId = await storeBlob(t, "text/plain");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(
      asTeacher.action(api.audioActions.transcribeAttachment, { storageId }),
    ).rejects.toThrow("Attachment must be an audio or video recording");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns transcript and reported duration for video", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const t = convexTest(schema, modules);
    const teacherId = await seedUser(t, "teacher", "teacher-video");
    const asTeacher = await withUser(t, teacherId);
    const storageId = await storeBlob(t, "video/quicktime");
    let filename = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const file = (init?.body as FormData).get("file") as File;
        filename = file.name;
        return new Response(
          JSON.stringify({ text: "The pendulum slows down.", duration: 2.25 }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    await expect(
      asTeacher.action(api.audioActions.transcribeAttachment, { storageId }),
    ).resolves.toEqual({
      transcript: "The pendulum slows down.",
      durationSeconds: 2.25,
    });
    expect(filename).toBe("recording.mp4");

    const usage = await t.run((ctx) => ctx.db.query("usageEvents").collect());
    expect(usage[0]).toMatchObject({
      source: "whisper-transcription",
      model: "whisper-1",
      audioSeconds: 2.25,
    });
    expect(usage[0]?.sessionId).toBeUndefined();
  });
});

describe("transcribe without OPENAI_API_KEY", () => {
  test("refuses clearly before calling Whisper", async () => {
    // vitest.setup.ts strips the key; keep it absent explicitly.
    vi.stubEnv("OPENAI_API_KEY", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const t = convexTest(schema, modules);
    const scholarId = await seedUser(t, "scholar", "scholar-nokey");
    const asScholar = await withUser(t, scholarId);

    await expect(
      asScholar.action(api.audioActions.transcribe, {
        audioBase64: Buffer.from("audio").toString("base64"),
      }),
    ).rejects.toThrow("OPENAI_API_KEY is not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

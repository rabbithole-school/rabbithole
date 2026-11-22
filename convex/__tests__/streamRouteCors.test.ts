/**
 * Browser-facing stream routes answer from *.convex.site to the app's origin,
 * so every response the browser reads must carry `Access-Control-Allow-Origin`
 * — refusals and failures included. Without it the browser reports a CORS
 * error and hides the status and body (TRA-600: `/aide-stream`'s 401 and a
 * throw on a preview with no SITE_URL both read as "No
 * 'Access-Control-Allow-Origin' header").
 */
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import schema from "../schema";
import { makeWorld } from "./factories/world";

// No test here should reach a model; the mock keeps a regression from
// reaching the network instead of failing.
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    beta = {
      messages: {
        toolRunner: () => {
          throw new Error("unexpected model call");
        },
      },
    };
  }
  return { default: FakeAnthropic, Anthropic: FakeAnthropic };
});

const modules = (
  import.meta as ImportMeta & {
    glob: (pattern: string) => Record<string, () => Promise<unknown>>;
  }
).glob("../**/*.ts");

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const STREAM_ROUTES = [
  "/session-stream",
  "/aide-stream",
  "/story-open",
  "/tts",
  "/parent-chat-stream",
  "/meta-stream",
] as const;

const ONE_SCHOOL = {
  schools: 1,
  scholarsPerSchool: 0,
  parentsPerSchool: 0,
  includePlatformAdmin: false,
};

const post = (
  t: { fetch: ReturnType<typeof convexTest>["fetch"] },
  route: string,
  body: string,
) =>
  t.fetch(route, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://app.example" },
    body,
  });

describe("stream routes send CORS headers on every response", () => {
  test.each(STREAM_ROUTES)("%s refuses an anonymous caller readably", async (route) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const res = await post(t, route, JSON.stringify({ text: "Hello there." }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  // Signed in, so routes that refuse anonymous callers before parsing (/tts)
  // reach the parse too.
  test.each(STREAM_ROUTES)("%s answers a malformed body readably", async (route) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, ONE_SCHOOL);
    const teacher = await world.as.staffOf(world.schools[0]);
    const res = await post(teacher, route, "{not json");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("/aide-stream errors reach the browser", () => {
  test("an anonymous caller sees Not authenticated, not a CORS failure", async () => {
    const t = convexTest(schema, modules);
    const res = await post(t, "/aide-stream", JSON.stringify({ assistantMsgId: "x" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await res.text()).toContain('"error":"Not authenticated"');
  });

  // The unit-designer branch's own 404 (unitDesignerStream.ts) sends no CORS
  // header; the route wrapper adds it.
  test("the unit designer's Context not found reaches the browser", async () => {
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, ONE_SCHOOL);
    const teacher = await world.as.staffOf(world.schools[0]);
    const admin = await world.as.staffOf(world.schools[0], "school_admin");
    // Another staffer's chat: the owner check returns no context.
    const sessionId = await teacher.mutation(api.curriculumAssistant.createChat, {});

    const res = await post(
      admin,
      "/aide-stream",
      JSON.stringify({ unitId: "any-unit", sessionId, assistantMsgId: "x" }),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
    expect(await res.text()).toContain('"error":"Context not found"');
  });

  test("a throw before streaming (a preview with no SITE_URL) is a readable 500", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("SITE_URL", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    const world = await makeWorld(t, ONE_SCHOOL);
    const teacher = await world.as.staffOf(world.schools[0]);
    const sessionId = await teacher.mutation(api.curriculumAssistant.createChat, {});
    const { streamId, assistantMsgId } = await teacher.mutation(
      api.curriculumAssistant.sendSessionMessage,
      { sessionId, message: "Make my class a fractions app." },
    );

    const res = await post(
      teacher,
      "/aide-stream",
      JSON.stringify({ streamId, assistantMsgId, sessionId, scope: "" }),
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(await res.text()).toContain('"error":"Server error"');
    // The cause stays in the deployment logs, where a developer can read it.
    expect(
      errors.mock.calls.some(
        ([label, error]) =>
          String(label).includes("[aide-stream]") &&
          String((error as Error)?.message).includes("SITE_URL"),
      ),
    ).toBe(true);
  });
});

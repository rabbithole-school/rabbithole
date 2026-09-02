import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import {
  makeCustomAppTools,
  CUSTOM_APPS_SYSTEM_PROMPT_SECTION,
} from "../lib/customAppTools";

const CALLER = "user_1" as Id<"users">;
const fakeCtx = {} as unknown as ActionCtx;
const noopEmit = () => {};

function stubCtx(overrides: {
  runQuery?: ReturnType<typeof vi.fn>;
  runMutation?: ReturnType<typeof vi.fn>;
}): ActionCtx {
  return {
    runQuery: overrides.runQuery ?? vi.fn(),
    runMutation: overrides.runMutation ?? vi.fn(),
    runAction: vi.fn(),
    scheduler: { runAfter: vi.fn() },
  } as unknown as ActionCtx;
}

async function runTool(
  tool: unknown,
  input: Record<string, unknown>,
): Promise<unknown> {
  return (
    tool as { run: (args: Record<string, unknown>) => Promise<unknown> }
  ).run(input);
}

const toolNames = async (role: Parameters<typeof makeCustomAppTools>[2]["role"]) =>
  (
    await makeCustomAppTools(fakeCtx, noopEmit, {
      role,
      callerUserId: CALLER,
      sessionId: null,
    })
  )
    .map((t) => t.name)
    .sort();

afterEach(() => {
  delete process.env.INTROSPECTION_ENABLED;
});

describe("makeCustomAppTools gating", () => {
  test("returns [] for a scholar", async () => {
    expect(await toolNames("scholar")).toEqual([]);
  });

  // Installing an app FOR a scholar is a teaching action, so the two
  // non-teaching staff roles get nothing — matching their curated no-scholar/
  // no-learning-writes tool sets in aideTools.test.ts.
  test("returns [] for non-teaching staff (curriculum_designer, staff)", async () => {
    expect(await toolNames("curriculum_designer")).toEqual([]);
    expect(await toolNames("staff")).toEqual([]);
  });

  test("returns the four custom-app tools for every teacher role", async () => {
    for (const role of ["teacher", "school_admin", "platform_admin"] as const) {
      expect(await toolNames(role)).toEqual([
        "create_custom_app",
        "install_external_app",
        "update_custom_app",
      ]);
    }
  });

  test("describes the configured deployment URL for static apps", async () => {
    const tools = await makeCustomAppTools(fakeCtx, noopEmit, {
      role: "teacher",
      callerUserId: CALLER,
      sessionId: null,
    });
    const tool = tools.find((candidate) => candidate.name === "create_custom_app");
    if (
      !tool ||
      !("description" in tool) ||
      typeof tool.description !== "string"
    ) {
      throw new Error("create_custom_app is missing its description");
    }
    expect(tool.description).toContain(
      "https://rabbithole.test/custom-apps?token=",
    );
    expect(tool.description).not.toContain("example.invalid");
  });
});

describe("custom-app write behavior", () => {
  test("refuses an ambiguous scholar partial instead of installing for the first match", async () => {
    const runQuery = vi.fn().mockResolvedValue({
      scholars: [
        { id: "scholar_kai_h" as Id<"users">, name: "Kai Hale" },
        { id: "scholar_kai_w" as Id<"users">, name: "Kai Wong" },
      ],
      extendedEducationOmitted: 0,
    });
    const runMutation = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runQuery, runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "create_custom_app")!;

    const result = String(
      await runTool(tool, {
        name: "Fraction Tiles",
        html: "<!doctype html><h1>Fractions</h1>",
        scholarNames: ["Kai"],
      }),
    );

    expect(result).toContain('Multiple scholars match "Kai"');
    expect(result).toContain("Kai Hale, Kai Wong");
    expect(runMutation).not.toHaveBeenCalled();
  });

  test("update_custom_app updates a static app in place", async () => {
    const runMutation = vi.fn().mockResolvedValue({
      kind: "updated",
      name: "Fraction Tiles",
      token: "stable-token",
      url: "https://rabbithole.test/custom-apps?token=stable-token",
      status: "live",
    });
    const emit = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      emit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "update_custom_app")!;
    const html = "<!doctype html><h1>Updated fractions</h1>";

    const result = String(
      await runTool(tool, { name: "fraction tiles", html }),
    );

    // The lens args are part of the mutation's contract now: updateStaticApp
    // fails CLOSED without them, so a caller that stops threading them is a
    // regression this assertion must catch.
    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      {
        name: "fraction tiles",
        html,
        callerUserId: CALLER,
        allowedScholarIds: undefined,
        scholarLensResolved: false,
      },
    );
    expect(result).toContain("Updated **Fraction Tiles** in place");
    expect(result).toContain("stable-token");
    expect(emit).toHaveBeenCalledWith({
      toolComplete: {
        name: "update_custom_app",
        result: "Updated Fraction Tiles",
      },
    });
  });

  test("update_custom_app threads the caller's institution lens", async () => {
    // The security fix lives or dies on this hand-off: updateStaticApp scopes
    // its name scan by the lens the TOOL passes, so a lens resolved upstream
    // must arrive intact (as an array, not the Set the tool holds).
    const runMutation = vi.fn().mockResolvedValue({
      kind: "updated",
      name: "Fraction Tiles",
      token: "stable-token",
      url: "https://rabbithole.test/custom-apps?token=stable-token",
      status: "live",
    });
    const scholar = "user_scholar_1" as Id<"users">;
    const tools = await makeCustomAppTools(stubCtx({ runMutation }), noopEmit, {
      role: "teacher",
      callerUserId: CALLER,
      sessionId: null,
      allowedScholarIds: new Set([scholar]),
    });
    const tool = tools.find(
      (candidate) => candidate.name === "update_custom_app",
    )!;

    await runTool(tool, { name: "Fraction Tiles", html: "<!doctype html><p>x" });

    expect(runMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        callerUserId: CALLER,
        allowedScholarIds: [scholar],
        scholarLensResolved: true,
      }),
    );
  });

  test("update_custom_app refuses ambiguous app names", async () => {
    const runMutation = vi.fn().mockResolvedValue({ kind: "ambiguous" });
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "update_custom_app")!;

    const result = String(
      await runTool(tool, {
        name: "Timer",
        html: "<!doctype html><h1>Timer</h1>",
      }),
    );

    expect(result).toMatch(/more than one custom app/i);
  });

  test("update_custom_app refuses oversize HTML before mutation", async () => {
    const runMutation = vi.fn();
    const tools = await makeCustomAppTools(
      stubCtx({ runMutation }),
      noopEmit,
      { role: "teacher", callerUserId: CALLER, sessionId: null },
    );
    const tool = tools.find((candidate) => candidate.name === "update_custom_app")!;

    const result = String(
      await runTool(tool, {
        name: "Timer",
        html: "x".repeat(700 * 1024 + 1),
      }),
    );

    expect(result).toMatch(/too large/i);
    expect(runMutation).not.toHaveBeenCalled();
  });

});

describe("CUSTOM_APPS_SYSTEM_PROMPT_SECTION", () => {
  test("names the available tools so the model can choose and revise", () => {
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("install_external_app");
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("create_custom_app");
    expect(CUSTOM_APPS_SYSTEM_PROMPT_SECTION).toContain("update_custom_app");
  });
});

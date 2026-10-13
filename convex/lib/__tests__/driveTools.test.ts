import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { assembleCurriculumTools } from "../aideTools";
import { resolveDriveLinks } from "../driveTools";
import { makeSlackTools, writeSurfaceFor } from "../slackTools";

// The Drive tools ride the SHARED staff-aide assembly (lib/aideTools.ts →
// lib/driveTools.ts), so the in-app aide (/aide-stream), the Slack bot, and
// the MCP connector all get them from one place. These tests drive that
// assembly, not one transport. Google is never called: fetch is stubbed.

const DRIVE_TOOLS = ["read_drive_link", "search_drive"];
const STAFF_ROLES = [
  "teacher",
  "school_admin",
  "platform_admin",
  "curriculum_designer",
  "staff",
];
const NON_STAFF_ROLES = ["scholar", "parent", "lifelong_learner"];
const TRANSPORTS = ["app", "slack", "mcp"] as const;

const ASKER = "user_asker" as Id<"users">;
const OTHER = "user_other" as Id<"users">;
const FRESH = Date.now() + 3_600_000;
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";
const account = (email: string, accessToken: string) => ({
  email,
  accessToken,
  expiresAt: FRESH,
  scopes: [DRIVE_SCOPE],
});

type NamedTool = { name: string; run: (input: unknown) => Promise<string> };

/** ctx whose only meaningful query is googleAccounts.getForUserInternal,
 *  answered per user from `accounts`; every other query answers false. */
const ctxWithAccounts = (accounts: Record<string, unknown>) => {
  const googleLookups: unknown[] = [];
  const ctx = {
    runQuery: async (ref: unknown, args: { userId?: string }) => {
      if (getFunctionName(ref as never) === "googleAccounts:getForUserInternal") {
        googleLookups.push(args.userId);
        return accounts[args.userId ?? ""] ?? null;
      }
      return false;
    },
    runMutation: async () => undefined,
  } as unknown as ActionCtx;
  return { ctx, googleLookups };
};

const assemble = async (
  ctx: ActionCtx,
  role: string,
  transport?: (typeof TRANSPORTS)[number],
) =>
  (await assembleCurriculumTools(ctx, () => {}, {
    role: role as never,
    callerUserId: ASKER,
    surface: "private",
    transport,
  })) as unknown as NamedTool[];

const toolNamed = (tools: NamedTool[], name: string) => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} not assembled`);
  return tool;
};

const stubFetch = (handler: (url: string, init?: RequestInit) => Response) => {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Drive tools on the shared staff aide", () => {
  test("every staff role gets both tools on every named transport", async () => {
    const { ctx } = ctxWithAccounts({});
    for (const transport of TRANSPORTS) {
      for (const role of STAFF_ROLES) {
        const names = (await assemble(ctx, role, transport)).map((t) => t.name);
        for (const name of DRIVE_TOOLS) {
          expect(names.filter((n) => n === name)).toHaveLength(1);
        }
      }
    }
  });

  test("non-staff roles, and a caller that names no transport, get neither", async () => {
    const { ctx } = ctxWithAccounts({});
    for (const transport of TRANSPORTS) {
      for (const role of NON_STAFF_ROLES) {
        const names = (await assemble(ctx, role, transport)).map((t) => t.name);
        for (const name of DRIVE_TOOLS) expect(names).not.toContain(name);
      }
    }
    for (const role of STAFF_ROLES) {
      const names = (await assemble(ctx, role)).map((t) => t.name);
      for (const name of DRIVE_TOOLS) expect(names).not.toContain(name);
    }
  });

  test("Slack offers each Drive tool exactly once alongside its own extras", async () => {
    const { ctx } = ctxWithAccounts({});
    for (const surface of ["channel", "dm", "mpim"] as const) {
      for (const role of STAFF_ROLES) {
        const shared = await assembleCurriculumTools(ctx, () => {}, {
          role: role as never,
          callerUserId: ASKER,
          surface: writeSurfaceFor(surface),
          transport: "slack",
        });
        const extras = await makeSlackTools(ctx, () => {}, {
          role: role as never,
          callerUserId: ASKER,
          surface,
          slackChannelId: "C1",
          token: "xoxb-test",
        });
        const names = [...shared, ...extras].map((t) => (t as { name: string }).name);
        for (const name of DRIVE_TOOLS) {
          expect(names.filter((n) => n === name)).toHaveLength(1);
        }
      }
    }
  });

  test("search_drive reads with the ASKER's linked token, never another user's", async () => {
    const { ctx, googleLookups } = ctxWithAccounts({
      [ASKER]: account("asker@example.test", "asker-token"),
      [OTHER]: account("other@example.test", "other-token"),
    });
    const fetchSpy = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            files: [
              {
                id: "f1",
                name: "Volcano unit",
                mimeType: "application/vnd.google-apps.document",
              },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const out = await toolNamed(await assemble(ctx, "teacher", "app"), "search_drive").run({
      query: "volcano",
    });
    expect(out).toContain("asker@example.test");
    expect(out).not.toContain("other@example.test");
    // Every Google-account lookup (getDriveAccess + the token refresh) is the asker.
    expect(new Set(googleLookups)).toEqual(new Set([ASKER]));
    expect(fetchSpy).toHaveBeenCalled();
    for (const [, init] of fetchSpy.mock.calls) {
      const auth = new Headers(init?.headers).get("Authorization");
      expect(auth).toBe("Bearer asker-token");
    }
  });

  test("read_drive_link reads with the ASKER's linked token, never another user's", async () => {
    const { ctx, googleLookups } = ctxWithAccounts({
      [ASKER]: account("asker@example.test", "asker-token"),
      [OTHER]: account("other@example.test", "other-token"),
    });
    const fetchSpy = stubFetch((url) =>
      url.includes("/export")
        ? new Response("The whole draft.")
        : new Response(
            JSON.stringify({
              id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
              name: "Unit Plan",
              mimeType: "application/vnd.google-apps.document",
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    const out = await toolNamed(await assemble(ctx, "staff", "mcp"), "read_drive_link").run({
      url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
    });
    expect(out).toContain("The whole draft.");
    expect(out).toContain("asker@example.test");
    // Every Google-account lookup (getDriveAccess + the token refresh) is the asker.
    expect(new Set(googleLookups)).toEqual(new Set([ASKER]));
    for (const [, init] of fetchSpy.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer asker-token",
      );
    }
  });

  test("an unlinked asker gets a connect link in the transport's format and no Google call", async () => {
    const { ctx } = ctxWithAccounts({
      // Another user being linked must not stand in for the asker.
      [OTHER]: account("other@example.test", "other-token"),
    });
    const fetchSpy = stubFetch(() => new Response("unexpected", { status: 500 }));
    for (const transport of TRANSPORTS) {
      const tools = await assemble(ctx, "teacher", transport);
      const outputs = [
        await toolNamed(tools, "search_drive").run({ query: "volcano" }),
        await toolNamed(tools, "read_drive_link").run({
          url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
        }),
      ];
      for (const out of outputs) {
        expect(out).toContain("/connect-google");
        expect(out).not.toContain("other@example.test");
        if (transport === "slack") {
          expect(out).toMatch(/<https?:\/\/[^|]+\/connect-google[^|]*\|Connect Google Drive>/);
        } else {
          expect(out).toMatch(/\[Connect Google Drive\]\(https?:\/\/[^)]+\/connect-google[^)]*\)/);
        }
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// Moved from slackBot.test.ts with the helper (it now lives in lib/driveTools.ts
// and serves Slack's inline pass and read_drive_link alike).
describe("resolveDriveLinks", () => {
  const ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
  const LINK = `https://docs.google.com/document/d/${ID}/edit`;
  const USER = "user_1" as Id<"users">;

  /** ctx whose only query is googleAccounts.getForUserInternal. */
  const ctxFor = (acct: unknown) =>
    ({
      runQuery: async () => acct,
      runMutation: async () => undefined,
    }) as unknown as ActionCtx;

  const LINKED = account("lehua@moli.school", "tok");

  test("no Drive link in the text is a no-op (no token work at all)", async () => {
    const runQuery = vi.fn();
    const ctx = { runQuery } as unknown as ActionCtx;
    expect(await resolveDriveLinks(ctx, USER, "just a normal message", "slack")).toBe("");
    expect(runQuery).not.toHaveBeenCalled();
  });

  test("unlinked account relays the reconnect link, markup intact", async () => {
    const out = await resolveDriveLinks(ctxFor(null), USER, `see ${LINK}`, "slack");
    expect(out).toMatch(/<https?:\/\/[^|]+\/connect-google[^|]*\|Connect Google Drive>/);
    // The model must be told to preserve the markup, or it renders as prose.
    expect(out).toContain("keeping the link markup exactly as written");
  });

  // A 404 used to be reported flatly as "isn't shared with you", which sent
  // people chasing access they already had when the model had simply invented
  // the URL. It has to leave both explanations open and prefer re-searching.
  test("an unreachable file doesn't get blamed on permissions", async () => {
    stubFetch(() => new Response("no", { status: 404 }));
    const out = await resolveDriveLinks(ctxFor(LINKED), USER, LINK, "slack");
    expect(out).toContain("lehua@moli.school");
    expect(out).toContain("search_drive");
    expect(out).not.toMatch(/isn't shared with lehua@moli.school\./);
    expect(out).not.toContain("Resolved a Google Drive link");
  });

  test("a readable Doc is folded in with its text", async () => {
    stubFetch((url) =>
      url.includes("/export")
        ? new Response("The whole draft.")
        : new Response(
            JSON.stringify({
              id: ID,
              name: "Unit Plan",
              mimeType: "application/vnd.google-apps.document",
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    const out = await resolveDriveLinks(ctxFor(LINKED), USER, `read ${LINK}`, "slack");
    expect(out).toContain("Resolved a Google Drive link");
    expect(out).toContain("Unit Plan");
    expect(out).toContain("The whole draft.");
    // Attribution matters: the reader is the ASKER, not the bot.
    expect(out).toContain("lehua@moli.school");
  });

  test("an unreadable file names the file and the reason", async () => {
    stubFetch((url) =>
      url.includes("alt=media")
        ? new Response("x")
        : new Response(
            JSON.stringify({
              id: ID,
              name: "scan.pdf",
              mimeType: "application/pdf",
            }),
            { headers: { "content-type": "application/json" } },
          ),
    );
    const out = await resolveDriveLinks(ctxFor(LINKED), USER, LINK, "slack");
    expect(out).toContain("scan.pdf");
    expect(out).toContain("attached to a message");
  });
});

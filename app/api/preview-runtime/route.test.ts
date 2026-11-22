import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

describe("GET /api/preview-runtime", () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(["production", "development", undefined])("is a 404 on VERCEL_ENV=%s", (env) => {
    vi.stubEnv("VERCEL_ENV", env as string);
    vi.stubEnv("NEXT_PUBLIC_DEV_LOGIN_SECRET", "secret");
    expect(GET().status).toBe(404);
  });

  it("describes a Preview, with the commit it was built from", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "abc");
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://brave-otter-1.convex.cloud");
    vi.stubEnv("NEXT_PUBLIC_DEV_LOGIN_SECRET", "secret");
    expect(await GET().json()).toEqual({
      commitSha: "abc",
      convexUrl: "https://brave-otter-1.convex.cloud",
      convexSiteUrl: "https://brave-otter-1.convex.site",
      devLoginSecret: "secret",
    });
  });
});

// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyticsMeasurementId, browserHoldsSignIn, isPublicAnalyticsPath } from "./publicAnalyticsConfig";

const ROOT = path.resolve(__dirname, "../..");

/**
 * Children use the signed-in app, so analytics may load only on pages a
 * stranger sees. Adding a page here is a privacy decision: it must be a
 * public page, and one a signed-in person can open must mount
 * SignedOutAnalytics, never PublicAnalytics.
 */
const ALLOWED_MOUNTS = {
  "app/HomeLanding.tsx": "PublicAnalytics", // inside the signed-out branch only
  "app/math-worksheets/layout.tsx": "NoAccountAnalytics", // no providers; skips a browser holding a sign-in
  "app/waitlist/layout.tsx": "SignedOutAnalytics",
  "app/davidson/page.tsx": "SignedOutAnalytics",
};

describe("public analytics boundary", () => {
  it("is mounted only by the allowed public pages", () => {
    const pattern = String.raw`components/analytics/(PublicAnalytics|SignedOutAnalytics|NoAccountAnalytics)["']`;
    // A plain folder walk, not git grep: the public Foundation build copy is
    // not a git checkout.
    const files = ["app", "components", "lib", "hooks"]
      .filter((dir) => existsSync(path.join(ROOT, dir)))
      .flatMap((dir) => readdirSync(path.join(ROOT, dir), { recursive: true, encoding: "utf8" }).map((f) => `${dir}/${f}`))
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("node_modules") && !f.startsWith("components/analytics/"))
      .filter((f) => new RegExp(pattern).test(readFileSync(path.join(ROOT, f), "utf8")));
    const mounts: Record<string, string> = {};
    for (const f of files) {
      mounts[f] = readFileSync(path.join(ROOT, f), "utf8").match(new RegExp(pattern))![1];
    }
    // The public Foundation copy leaves some of these pages out (the Davidson
    // page is private), so compare only the allowed pages present in this tree.
    const allowedHere = Object.fromEntries(
      Object.entries(ALLOWED_MOUNTS).filter(([f]) => existsSync(path.join(ROOT, f))),
    );
    expect(mounts).toEqual(allowedHere);
  });

  it("mounts the homepage tag only where the landing page renders for a signed-out visitor", () => {
    const src = readFileSync(path.join(ROOT, "app/HomeLanding.tsx"), "utf8");
    expect(src.match(/<PublicAnalytics \/>/g)).toHaveLength(1);
    expect(src).toMatch(/if \(!isAuthenticated\)\s*return \(\s*<>\s*<PublicAnalytics \/>/);
  });
});

describe("analyticsMeasurementId", () => {
  const prod = { nodeEnv: "production", vercelEnv: "production" };
  it("loads a configured id in a production build", () => {
    expect(analyticsMeasurementId("G-ABC123", prod)).toBe("G-ABC123");
    expect(analyticsMeasurementId("G-ABC123", { nodeEnv: "production", vercelEnv: undefined })).toBe("G-ABC123");
  });
  it("loads nothing without an id, in dev, on a preview, or for a malformed id", () => {
    expect(analyticsMeasurementId(null, prod)).toBeNull();
    expect(analyticsMeasurementId("G-ABC123", { nodeEnv: "development", vercelEnv: undefined })).toBeNull();
    expect(analyticsMeasurementId("G-ABC123", { nodeEnv: "production", vercelEnv: "preview" })).toBeNull();
    expect(analyticsMeasurementId("G-abc');alert(1)//", prod)).toBeNull();
  });
});

describe("isPublicAnalyticsPath", () => {
  it("counts the public pages and nothing in the app", () => {
    for (const p of ["/", "/math-worksheets", "/math-worksheets/adding-fractions", "/waitlist", "/davidson"]) {
      expect(isPublicAnalyticsPath(p), p).toBe(true);
    }
    for (const p of ["/scholar", "/teacher", "/parent", "/admin", "/school", "/how-it-works", "/math-worksheets-x", "/waitlisted"]) {
      expect(isPublicAnalyticsPath(p), p).toBe(false);
    }
  });
});

describe("browserHoldsSignIn", () => {
  const storageWith = (keys: string[]) => ({ length: keys.length, key: (i: number) => keys[i] ?? null });
  it("finds a Convex Auth token or refresh token under any namespace", () => {
    expect(browserHoldsSignIn(storageWith(["theme", "__convexAuthJWT_httpsfantasticdotterel572convexcloud"]))).toBe(true);
    expect(browserHoldsSignIn(storageWith(["__convexAuthRefreshToken_x"]))).toBe(true);
  });
  it("is false for a browser with no sign-in, and true when storage can't be read", () => {
    expect(browserHoldsSignIn(storageWith(["theme", "__convexAuthOAuthVerifier_x"]))).toBe(false);
    expect(browserHoldsSignIn(null)).toBe(true);
  });
});

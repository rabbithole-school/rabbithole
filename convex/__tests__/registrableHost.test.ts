// The webview allowlist is derived from the app's URL, and deriving the EXACT
// host is too tight: a teacher pastes a deep link, and the site's own sign-in
// then navigates to a sibling host the lock cancels — leaving the scholar on an
// endless spinner. That shipped: "Epic" was added as `kids.getepic.com/students`
// (auto-deriving `["kids.getepic.com"]`), and a valid class code navigates to
// `www.getepic.com/app/profile-select` (2026-08-19).
//
// `registrableHost` is the fix: subdomains are interchangeable. It is
// deliberately permissive — the standing instruction is to err that way and
// tighten later — with one guard, so widening never reaches a public suffix and
// unlocks a whole registry.
//
// `native/src/lib/webActivityExtract.ts` carries a hand-maintained copy (metro
// has no watchFolders for the repo root); the last case here pins the two
// together so they cannot drift apart silently.

import { describe, expect, test } from "vitest";
import { registrableHost } from "../lib/externalAppsResolve";
import { registrableHost as nativeRegistrableHost } from "../../native/src/lib/webActivityExtract";
import { hostMatchesAllowlist } from "../../native/src/lib/webActivityExtract";

describe("registrableHost", () => {
  test("widens a subdomain to its site", () => {
    expect(registrableHost("kids.getepic.com")).toBe("getepic.com");
    expect(registrableHost("www.getepic.com")).toBe("getepic.com");
    expect(registrableHost("www.acmepractice.com")).toBe("acmepractice.com");
    expect(registrableHost("docs.google.com")).toBe("google.com");
    expect(registrableHost("a.b.c.example.org")).toBe("example.org");
  });

  test("leaves an apex, a bare name and an IP literal alone", () => {
    expect(registrableHost("getepic.com")).toBe("getepic.com");
    expect(registrableHost("localhost")).toBe("localhost");
    expect(registrableHost("10.0.0.1")).toBe("10.0.0.1");
    expect(registrableHost("")).toBe("");
  });

  test("normalises case and a trailing root dot", () => {
    expect(registrableHost("  KIDS.GetEpic.COM. ")).toBe("getepic.com");
  });

  test("stops at a two-label public suffix instead of unlocking the registry", () => {
    // Without the guard these would widen to "co.uk" / "github.io" — every UK
    // site, every GitHub Pages tenant.
    expect(registrableHost("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableHost("someclass.github.io")).toBe("someclass.github.io");
    expect(registrableHost("app.school.vercel.app")).toBe("school.vercel.app");
  });

  test("the derived host actually admits the sign-in hop that broke Epic", () => {
    const derived = [registrableHost("kids.getepic.com")];
    expect(hostMatchesAllowlist("kids.getepic.com", derived)).toBe(true);
    expect(hostMatchesAllowlist("www.getepic.com", derived)).toBe(true);
    expect(hostMatchesAllowlist("getepic.com", derived)).toBe(true);
    // Still a lock: an unrelated site is not admitted.
    expect(hostMatchesAllowlist("notepic.com", derived)).toBe(false);
    expect(hostMatchesAllowlist("getepic.com.evil.test", derived)).toBe(false);
    // …and the exact-host allowlist we used to derive is what cancelled it.
    expect(hostMatchesAllowlist("www.getepic.com", ["kids.getepic.com"])).toBe(
      false,
    );
  });

  test("the native mirror agrees with the convex original", () => {
    const hosts = [
      "kids.getepic.com",
      "www.getepic.com",
      "getepic.com",
      "docs.google.com",
      "a.b.c.example.org",
      "www.bbc.co.uk",
      "someclass.github.io",
      "localhost",
      "10.0.0.1",
      "  KIDS.GetEpic.COM. ",
      "",
    ];
    for (const host of hosts) {
      expect(nativeRegistrableHost(host)).toBe(registrableHost(host));
    }
  });
});

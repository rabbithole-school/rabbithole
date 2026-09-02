import { describe, expect, it } from "vitest";

import {
  isDevNavigationCommand,
  navigationHrefMatches,
  sitemapHasPathname,
  type DevSitemapNode,
} from "../devNavigationBridge";

const sitemap: DevSitemapNode = {
  href: "/",
  isGenerated: false,
  isInternal: false,
  children: [
    {
      href: "/sky",
      isGenerated: false,
      isInternal: false,
      children: [],
    },
    {
      href: "/session/[id]",
      isGenerated: false,
      isInternal: false,
      children: [],
    },
    {
      href: "/[...not-found]",
      isGenerated: true,
      isInternal: true,
      children: [],
    },
  ],
};

describe("dev navigation app bridge", () => {
  it("matches static and dynamic Expo Router routes without accepting the generated fallback", () => {
    expect(sitemapHasPathname(sitemap, "/")).toBe(true);
    expect(sitemapHasPathname(sitemap, "/sky")).toBe(true);
    expect(sitemapHasPathname(sitemap, "/session/abc123")).toBe(true);
    expect(sitemapHasPathname(sitemap, "/missing")).toBe(false);
  });

  it("accepts only complete Metro command payloads", () => {
    expect(
      isDevNavigationCommand({
        serverId: "server-a",
        id: 1,
        pathname: "/sky?view=tree",
        routePathname: "/sky",
        queuedAt: 123,
      }),
    ).toBe(true);
    expect(isDevNavigationCommand({ serverId: "server-a", id: 1, pathname: "/sky" })).toBe(
      false,
    );
    expect(
      isDevNavigationCommand({
        serverId: "server-a",
        id: "1",
        pathname: "/sky",
        routePathname: "/sky",
      }),
    ).toBe(false);
  });

  it("matches query parameters as an order-independent value multimap", () => {
    expect(
      navigationHrefMatches(
        "/practice?tag=fractions&level=2&tag=geometry",
        "/practice?tag=geometry&tag=fractions&level=2",
      ),
    ).toBe(true);
    expect(
      navigationHrefMatches(
        "/practice?tag=fractions&tag=fractions",
        "/practice?tag=fractions",
      ),
    ).toBe(false);
    expect(navigationHrefMatches("/practice?a=1", "/sky?a=1")).toBe(false);
  });
});

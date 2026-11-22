import { describe, expect, it } from "vitest";

import {
  LINK_REDIRECT_GRACE_MS,
  httpsForm,
  isFragmentJump,
  isYouTubeSiteUrl,
  linkNavigationVerdict,
  linkSite,
  linkViewerTitle,
} from "../linkViewer";

const opened = ["example.com"];
const settled = { loadInFlight: false, msSinceLoadEnd: 60_000, allowedSites: opened };

describe("linkNavigationVerdict", () => {
  it("allows anything on the opened link's site, subdomains included", () => {
    for (const url of [
      "https://example.com/next",
      "https://www.example.com/",
      "https://docs.example.com/page",
    ]) {
      expect(linkNavigationVerdict({ ...settled, url, navigationType: "click" })).toBe("allow");
    }
  });

  it("lets a server redirect through to a new site, even one iOS labels a click", () => {
    // A hop while the viewer's load is still running (a link shortener, a
    // sign-in bounce) can carry the original tap's "click" type.
    expect(
      linkNavigationVerdict({
        ...settled,
        url: "https://news.example.org/story",
        navigationType: "click",
        loadInFlight: true,
      }),
    ).toBe("widen");
  });

  it("lets a script redirect through just after the page loads", () => {
    expect(
      linkNavigationVerdict({
        ...settled,
        url: "https://cdn.example.net/file.pdf",
        navigationType: "other",
        msSinceLoadEnd: 500,
      }),
    ).toBe("widen");
  });

  it("keeps the scholar on the page for a later navigation to another site, however it is wired", () => {
    for (const navigationType of ["click", "formsubmit", "other"]) {
      expect(
        linkNavigationVerdict({ ...settled, url: "https://games.example.io/", navigationType }),
      ).toBe("block");
    }
    expect(
      linkNavigationVerdict({
        ...settled,
        url: "https://games.example.io/",
        navigationType: "other",
        msSinceLoadEnd: LINK_REDIRECT_GRACE_MS,
      }),
    ).toBe("block");
  });

  it("keeps the scholar on the page for a tap right after load", () => {
    expect(
      linkNavigationVerdict({
        ...settled,
        url: "https://games.example.io/",
        navigationType: "click",
        msSinceLoadEnd: 200,
      }),
    ).toBe("block");
  });

  it("allows a tap to a site a redirect already reached", () => {
    expect(
      linkNavigationVerdict({
        ...settled,
        url: "https://news.example.org/another-story",
        navigationType: "click",
        allowedSites: [...opened, "example.org"],
      }),
    ).toBe("allow");
  });

  it("never reaches YouTube, even by redirect", () => {
    for (const url of ["https://www.youtube.com/@channel", "https://youtu.be/abc"]) {
      expect(
        linkNavigationVerdict({ ...settled, url, navigationType: "other", loadInFlight: true }),
      ).toBe("block");
    }
  });
});

describe("isYouTubeSiteUrl", () => {
  it("matches every YouTube host and nothing else", () => {
    expect(isYouTubeSiteUrl("https://www.youtube.com/results?search_query=x")).toBe(true);
    expect(isYouTubeSiteUrl("https://music.youtube.com/")).toBe(true);
    expect(isYouTubeSiteUrl("https://youtu.be/abc")).toBe(true);
    expect(isYouTubeSiteUrl("https://www.youtube-nocookie.com/embed/abc")).toBe(true);
    expect(isYouTubeSiteUrl("https://notyoutube.com/")).toBe(false);
    expect(isYouTubeSiteUrl("https://example.com/youtube.com")).toBe(false);
  });
});

describe("linkSite", () => {
  it("widens a host to its site", () => {
    expect(linkSite("https://www.bbc.co.uk/news?x=1")).toBe("bbc.co.uk");
    expect(linkSite("https://docs.google.com/document/d/1")).toBe("google.com");
  });

  it("has no site for a non-web link", () => {
    expect(linkSite("mailto:someone@example.com")).toBeNull();
  });
});

describe("httpsForm", () => {
  it("upgrades http and leaves https alone", () => {
    expect(httpsForm("http://example.com/a")).toBe("https://example.com/a");
    expect(httpsForm("HTTP://example.com/a")).toBe("https://example.com/a");
    expect(httpsForm("https://example.com/a")).toBe("https://example.com/a");
  });
});

describe("isFragmentJump", () => {
  it("is true only when the documents match and the fragment differs", () => {
    expect(isFragmentJump("https://example.com/a", "https://example.com/a#notes")).toBe(true);
    expect(isFragmentJump("https://example.com/a#x", "https://example.com/a#y")).toBe(true);
    // The same URL again is a real load (a reload, a form posting to itself).
    expect(isFragmentJump("https://example.com/a", "https://example.com/a")).toBe(false);
    expect(isFragmentJump("https://example.com/a", "https://example.com/b#x")).toBe(false);
  });
});

describe("linkViewerTitle", () => {
  it("keeps the link's own words", () => {
    expect(linkViewerTitle("https://example.com/a", "Field trip form")).toBe("Field trip form");
  });

  it("shows the host for a bare pasted link", () => {
    expect(
      linkViewerTitle("https://www.example.com/a/b.pdf", "https://www.example.com/a/b.pdf"),
    ).toBe("example.com");
  });
});

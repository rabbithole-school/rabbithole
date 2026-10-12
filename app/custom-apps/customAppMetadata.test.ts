import { describe, expect, test } from "vitest";
import {
  GENERIC_SITE_DESCRIPTION,
  GENERIC_SITE_TITLE,
  buildCustomAppMetadata,
} from "./customAppMetadata";

describe("buildCustomAppMetadata", () => {
  test("uses the app name, starter description, and token image", () => {
    const metadata = buildCustomAppMetadata(
      {
        name: "  Fraction Forge  ",
        kind: "static",
        status: "live",
        origin: "starter",
      },
      "token with spaces",
    );

    expect(metadata).toMatchObject({
      title: "Fraction Forge",
      description: "An interactive learning app made in Rabbithole.",
      openGraph: {
        title: "Fraction Forge",
        images: [
          {
            url: "/custom-apps/og?token=token%20with%20spaces",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: "Fraction Forge",
      },
    });
  });

  test("falls back when a live app has no usable name", () => {
    const metadata = buildCustomAppMetadata(
      { name: " ", kind: "coded", status: "building" },
      "coded-token",
    );

    expect(metadata.title).toBe("A Rabbithole app");
    expect(metadata.description).toBe(
      "An interactive app built in Rabbithole.",
    );
  });

  test.each([
    ["unknown", null],
    [
      "archived",
      {
        name: "Retired app",
        kind: "static" as const,
        status: "archived" as const,
      },
    ],
  ])("uses generic site metadata for %s tokens", (_label, app) => {
    const metadata = buildCustomAppMetadata(app, "secret-token");

    expect(metadata).toMatchObject({
      title: GENERIC_SITE_TITLE,
      description: GENERIC_SITE_DESCRIPTION,
      openGraph: {
        title: GENERIC_SITE_TITLE,
        images: [{ url: "/opengraph-image.png" }],
      },
      twitter: {
        title: GENERIC_SITE_TITLE,
        images: [{ url: "/opengraph-image.png" }],
      },
    });
    expect(JSON.stringify(metadata)).not.toContain("secret-token");
    expect(JSON.stringify(metadata)).not.toContain("Retired app");
  });
});

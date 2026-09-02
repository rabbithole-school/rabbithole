import { describe, expect, test } from "vitest";
import {
  describeMissingGoogleCapabilities,
  googleReconsentReason,
  needsGoogleReconsent,
} from "./googleConsentStatus";

describe("Google consent status", () => {
  test("requires a reconnect for a missing refresh token or missing consent", () => {
    expect(needsGoogleReconsent({ hasRefreshToken: false })).toBe(true);
    expect(
      needsGoogleReconsent({
        hasRefreshToken: true,
        requiresReconsent: true,
      }),
    ).toBe(true);
    expect(
      needsGoogleReconsent({
        hasRefreshToken: true,
        requiresReconsent: false,
      }),
    ).toBe(false);
  });

  test("evaluates the capability required by each surface", () => {
    const slidesAndDrive = {
      hasRefreshToken: true,
      requiresReconsent: true,
      grantedScopes: [
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/drive.file",
        "https://www.googleapis.com/auth/drive.readonly",
      ],
      missingRequiredScopes: ["https://www.googleapis.com/auth/documents"],
    };

    expect(needsGoogleReconsent(slidesAndDrive, "slides")).toBe(false);
    expect(needsGoogleReconsent(slidesAndDrive, "drive")).toBe(false);
    expect(needsGoogleReconsent(slidesAndDrive, "all")).toBe(true);
    expect(googleReconsentReason(slidesAndDrive, "all")).toBe(
      "Google Docs access is missing.",
    );
  });

  test("turns missing OAuth scopes into capability names", () => {
    expect(
      describeMissingGoogleCapabilities([
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/presentations",
        "https://www.googleapis.com/auth/drive.readonly",
      ]),
    ).toBe("Google Docs, Google Slides, and Google Drive access is missing.");
  });

  test("does not expose unknown OAuth scopes", () => {
    expect(
      googleReconsentReason({
        hasRefreshToken: true,
        requiresReconsent: true,
        grantedScopes: [],
        missingRequiredScopes: ["https://example.com/private-scope"],
      }),
    ).toBe("Required Google access is missing.");
  });

  test("keeps Workspace reconnect copy focused on Docs and Slides", () => {
    expect(
      googleReconsentReason(
        {
          hasRefreshToken: false,
          requiresReconsent: true,
        },
        "workspace",
      ),
    ).toBe(
      "Google needs a new connection to keep Google Docs and Google Slides access working.",
    );
    expect(
      googleReconsentReason(
        {
          hasRefreshToken: true,
          requiresReconsent: true,
          grantedScopes: [
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/presentations",
          ],
        },
        "workspace",
      ),
    ).toBe("Google file creation access is missing.");
  });
});

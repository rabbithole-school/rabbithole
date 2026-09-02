import { describe, expect, test } from "vitest";
import {
  clientAuthorization,
  signInRedirectForLocation,
} from "./clientAuthorization";

describe("signInRedirectForLocation", () => {
  test("preserves the protected path, query, and hash through sign-in", () => {
    expect(
      signInRedirectForLocation({
        pathname: "/school/devices/device_123",
        search: "?inst=moli",
        hash: "#lock",
      }),
    ).toBe(
      "/sign-in?next=%2Fschool%2Fdevices%2Fdevice_123%3Finst%3Dmoli%23lock",
    );
  });

  test("preserves a deep-linked teacher schedule view through sign-in", () => {
    expect(
      signInRedirectForLocation({
        pathname: "/teacher/schedule/assignment_123",
        search: "?view=list",
        hash: "",
      }),
    ).toBe(
      "/sign-in?next=%2Fteacher%2Fschedule%2Fassignment_123%3Fview%3Dlist",
    );
  });
});

describe("clientAuthorization", () => {
  test("keeps an unresolved permission query in the loading state", () => {
    expect(
      clientAuthorization({
        isLoading: true,
        hasUser: false,
        isAllowed: false,
      }),
    ).toEqual({ state: "loading" });
  });

  test("distinguishes a resolved signed-out denial", () => {
    expect(
      clientAuthorization({
        isLoading: false,
        hasUser: false,
        isAllowed: false,
      }),
    ).toEqual({ state: "denied", reason: "signed-out" });
  });

  test("distinguishes a resolved authorization denial", () => {
    expect(
      clientAuthorization({
        isLoading: false,
        hasUser: true,
        isAllowed: false,
      }),
    ).toEqual({ state: "denied", reason: "unauthorized" });
  });

  test("allows a resolved authorized user", () => {
    expect(
      clientAuthorization({
        isLoading: false,
        hasUser: true,
        isAllowed: true,
      }),
    ).toEqual({ state: "allowed" });
  });
});

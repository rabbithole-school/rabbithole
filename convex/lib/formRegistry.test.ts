import { describe, expect, test } from "vitest";

import { dayKeyForTimezone, shiftDayKey } from "../../shared/institutionDay";
import {
  REQUIRED_FORMS,
  formClosedMessage,
  isFormExpired,
} from "./formRegistry";

const HONOLULU = "Pacific/Honolulu";
const form = { expiresOn: "2026-03-14" };

describe("isFormExpired", () => {
  test("the day before and the expiry day itself are open; the day after is closed", () => {
    expect(isFormExpired(form, "2026-03-13")).toBe(false);
    expect(isFormExpired(form, "2026-03-14")).toBe(false);
    expect(isFormExpired(form, "2026-03-15")).toBe(true);
  });

  test("crosses month and year boundaries by calendar day, not string length", () => {
    expect(isFormExpired({ expiresOn: "2026-12-31" }, "2027-01-01")).toBe(true);
    expect(isFormExpired({ expiresOn: "2026-09-30" }, "2026-09-09")).toBe(false);
  });

  test("a form without an expiry never closes", () => {
    expect(isFormExpired({}, "2099-01-01")).toBe(false);
    expect(isFormExpired({ expiresOn: null }, "2099-01-01")).toBe(false);
  });

  test("is decided on the school's day, not UTC's", () => {
    // 07:00 UTC on Mar 15 is still 21:00 on Mar 14 in Honolulu: already
    // "tomorrow" in UTC, but the form's last open day at the school.
    const lateOnExpiryDay = Date.UTC(2026, 2, 15, 7, 0);
    expect(dayKeyForTimezone(lateOnExpiryDay, "UTC")).toBe("2026-03-15");
    expect(
      isFormExpired(form, dayKeyForTimezone(lateOnExpiryDay, HONOLULU)),
    ).toBe(false);

    // 10:00 UTC on Mar 15 is midnight in Honolulu: the form has closed.
    const schoolMidnight = Date.UTC(2026, 2, 15, 10, 0);
    expect(
      isFormExpired(form, dayKeyForTimezone(schoolMidnight, HONOLULU)),
    ).toBe(true);
  });
});

test("formClosedMessage names the last open day in plain words", () => {
  expect(formClosedMessage("2026-03-14")).toBe(
    "This form closed on March 14, 2026.",
  );
});

test("every registered expiry is a real YYYY-MM-DD day key", () => {
  for (const entry of REQUIRED_FORMS) {
    if (entry.expiresOn === undefined) continue;
    expect(entry.expiresOn, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // shiftDayKey throws on an impossible date such as 2026-02-30.
    expect(shiftDayKey(entry.expiresOn, 0), entry.id).toBe(entry.expiresOn);
  }
});

import { describe, expect, test } from "vitest";
import { deleteSchoolCopy, disableSchoolCopy } from "./schoolLifecycleCopy";

/**
 * Regression guard for the shared school-lifecycle dialogs (DeleteSchoolDialog,
 * DisableSchoolDialog). Both are opened from two callers with different
 * vocabularies, and the noun-dependent copy is a pure function of the
 * caller-supplied noun (T12 — the caller owns the sentence):
 *
 *   • /school/settings         → noun="school"      (a school leader, one school)
 *   • /admin/institutions      → noun="institution" (a platform admin, any tenant)
 *
 * The "school" cases are pinned BYTE-FOR-BYTE to the strings that shipped
 * before the #1704 roster vocabulary pass, so the school-leader surface can
 * never silently drift into admin ("institution") vocabulary again.
 */

describe("deleteSchoolCopy", () => {
  test('the /school/settings caller (noun="school") renders the pre-#1704 school copy', () => {
    expect(deleteSchoolCopy("school")).toEqual({
      confirmButton: "Delete this school",
      errorTitle: "Couldn't delete school",
      inProgressDescription:
        "The school and all of its data are being deleted in the background.",
      cannotDelete: "This school cannot be deleted.",
      confirmInputAriaLabel: "Type the school name to confirm deletion",
      deletingSelf:
        "This is your own school — deleting it will delete your account and sign you out.",
      survivingAccountsClause: "belong to another school",
    });
  });

  test('the /admin/institutions caller (noun="institution") renders institution copy', () => {
    expect(deleteSchoolCopy("institution")).toEqual({
      confirmButton: "Delete this institution",
      errorTitle: "Couldn't delete institution",
      inProgressDescription:
        "The institution and all of its data are being deleted in the background.",
      cannotDelete: "This institution cannot be deleted.",
      confirmInputAriaLabel: "Type the institution name to confirm deletion",
      deletingSelf:
        "This is your own institution — deleting it will delete your account and sign you out.",
      survivingAccountsClause: "belong to another institution",
    });
  });

  test("neither noun leaks the other noun's vocabulary", () => {
    for (const value of Object.values(deleteSchoolCopy("school"))) {
      expect(value).not.toMatch(/institution/i);
    }
    for (const value of Object.values(deleteSchoolCopy("institution"))) {
      expect(value).not.toMatch(/school/i);
    }
  });
});

describe("disableSchoolCopy", () => {
  test('the /school/settings caller (noun="school") renders the pre-#1704 school copy', () => {
    expect(disableSchoolCopy("school")).toEqual({
      confirmButton: "Pause this school",
      errorTitle: "Couldn't pause school",
      reasonAriaLabel: "Optional reason for pausing this school",
      accessPausedDescription:
        "Members who can only use Rabbithole through this school are blocked from the app and see an “access is paused” message.",
      successDescription:
        "Members who can only use Rabbithole through this school are blocked from the app and see an “access is paused” message. Nothing was deleted — resume any time.",
      otherActiveSentence:
        "Anyone who also belongs to another active school keeps working there.",
    });
  });

  test('the /admin/institutions caller (noun="institution") renders institution copy', () => {
    expect(disableSchoolCopy("institution")).toEqual({
      confirmButton: "Pause this institution",
      errorTitle: "Couldn't pause institution",
      reasonAriaLabel: "Optional reason for pausing this institution",
      accessPausedDescription:
        "Members who can only use Rabbithole through this institution are blocked from the app and see an “access is paused” message.",
      successDescription:
        "Members who can only use Rabbithole through this institution are blocked from the app and see an “access is paused” message. Nothing was deleted — resume any time.",
      otherActiveSentence:
        "Anyone who also belongs to another active institution keeps working there.",
    });
  });

  test("neither noun leaks the other noun's vocabulary", () => {
    for (const value of Object.values(disableSchoolCopy("school"))) {
      expect(value).not.toMatch(/institution/i);
    }
    for (const value of Object.values(disableSchoolCopy("institution"))) {
      expect(value).not.toMatch(/school/i);
    }
  });

  test("pause copy describes blocked access without promising sign-out", () => {
    for (const noun of ["school", "institution"] as const) {
      const copy = disableSchoolCopy(noun);
      expect(copy.accessPausedDescription).toMatch(
        /only use Rabbithole through this .*blocked.*access is paused/i,
      );
      expect(copy.successDescription).toMatch(
        /only use Rabbithole through this .*blocked.*access is paused/i,
      );
      expect(Object.values(copy).join(" ")).not.toMatch(/sign(?:ed)? out/i);
    }
  });
});

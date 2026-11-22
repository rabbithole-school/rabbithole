/**
 * Scholar accounts that are staff tests, not children. Nothing in the schema
 * marks a test account, so staff-facing roundups skip these by id: a test
 * account's missing form is not a family's missing answer, and its screen
 * time is not a child's. Add the ids of your own deployment's test scholar
 * accounts here; with none listed, every scholar counts.
 */
export const TEST_ACCOUNT_IDS: ReadonlySet<string> = new Set([]);

export function isTestAccount(userId: string): boolean {
  return TEST_ACCOUNT_IDS.has(userId);
}

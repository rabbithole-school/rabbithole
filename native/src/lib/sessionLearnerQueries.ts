export function shouldSkipLearnerQueries(
  data:
    | {
        session?: {
          isTestDrive?: boolean;
        };
      }
    | undefined,
): boolean {
  return data !== undefined && data.session?.isTestDrive === true;
}

interface ProfileSetupUser {
  role?: string;
  profileSetupComplete?: boolean;
}

/**
 * A read-only view must never enter an onboarding flow whose only exits write
 * to the viewed account. `undefined` means the viewing state is still loading.
 */
export function shouldShowProfileSetup(
  user: ProfileSetupUser | null | undefined,
  isImpersonating: boolean | undefined,
): boolean {
  return (
    isImpersonating === false &&
    user?.role === "scholar" &&
    !user.profileSetupComplete
  );
}

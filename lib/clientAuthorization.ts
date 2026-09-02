export type ClientAuthorization =
  | { state: "loading" }
  | { state: "denied"; reason: "signed-out" | "unauthorized" }
  | { state: "allowed" };

export function signInRedirectForLocation(
  location: Pick<Location, "pathname" | "search" | "hash">,
): string {
  const next = `${location.pathname}${location.search}${location.hash}`;
  return `/sign-in?next=${encodeURIComponent(next)}`;
}

export function clientAuthorization({
  isLoading,
  hasUser,
  isAllowed,
}: {
  isLoading: boolean;
  hasUser: boolean;
  isAllowed: boolean;
}): ClientAuthorization {
  if (isLoading) return { state: "loading" };
  if (!hasUser) return { state: "denied", reason: "signed-out" };
  if (!isAllowed) return { state: "denied", reason: "unauthorized" };
  return { state: "allowed" };
}

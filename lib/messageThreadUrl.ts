export function messageThreadHref(
  pathname: string,
  searchParams: URLSearchParams | Readonly<URLSearchParams>,
  threadId: string | null,
): string {
  const params = new URLSearchParams(searchParams.toString());
  if (threadId) params.set("thread", threadId);
  else params.delete("thread");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

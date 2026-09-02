export type DevSitemapNode = {
  href: unknown;
  isGenerated: boolean;
  isInternal: boolean;
  children: DevSitemapNode[];
};

export type DevNavigationCommand = {
  serverId: string;
  id: number;
  pathname: string;
  routePathname: string;
  /** Middleware enqueue time (ms epoch) — the app expires stale commands so a
   * wake-from-suspension never replays an old queue as surprise navigations. */
  queuedAt: number;
};

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function routeRegex(href: string): RegExp | null {
  let pathname: string;
  try {
    pathname = new URL(href, "http://rabbithole.invalid").pathname;
  } catch {
    return null;
  }
  if (pathname === "/") return /^\/$/;

  let pattern = "^";
  for (const segment of pathname.split("/").filter(Boolean)) {
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) {
      pattern += "(?:/.*)?";
    } else if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      pattern += "/.+";
    } else if (/^\[[^\]]+\]$/.test(segment)) {
      pattern += "/[^/]+";
    } else {
      pattern += `/${escapeRegex(segment)}`;
    }
  }
  return new RegExp(`${pattern}/?$`);
}

export function sitemapHasPathname(
  sitemap: DevSitemapNode | null,
  pathname: string,
): boolean {
  if (!sitemap) return false;

  const pending = [sitemap];
  while (pending.length > 0) {
    const node = pending.pop()!;
    pending.push(...node.children);
    if (node.isGenerated || node.isInternal || typeof node.href !== "string") continue;
    if (routeRegex(node.href)?.test(pathname)) return true;
  }
  return false;
}

function queryMultimap(searchParams: URLSearchParams): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const [key, value] of searchParams) {
    const values = result.get(key) ?? [];
    values.push(value);
    result.set(key, values);
  }
  for (const values of result.values()) values.sort();
  return result;
}

export function navigationHrefMatches(
  currentHref: string,
  targetHref: string,
): boolean {
  try {
    const current = new URL(currentHref, "http://rabbithole.invalid");
    const target = new URL(targetHref, "http://rabbithole.invalid");
    if (current.pathname !== target.pathname) return false;

    const currentQuery = queryMultimap(current.searchParams);
    const targetQuery = queryMultimap(target.searchParams);
    if (currentQuery.size !== targetQuery.size) return false;
    for (const [key, targetValues] of targetQuery) {
      const currentValues = currentQuery.get(key);
      if (
        !currentValues ||
        currentValues.length !== targetValues.length ||
        currentValues.some((value, index) => value !== targetValues[index])
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function isDevNavigationCommand(value: unknown): value is DevNavigationCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Partial<DevNavigationCommand>;
  return (
    typeof command.serverId === "string" &&
    Number.isSafeInteger(command.id) &&
    typeof command.pathname === "string" &&
    typeof command.routePathname === "string" &&
    Number.isFinite(command.queuedAt)
  );
}

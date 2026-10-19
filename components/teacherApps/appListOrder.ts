// The order of the teacher Apps list when it mixes catalog apps with apps
// scholars built (All, Archived): catalog apps first, in the chosen sort, then
// scholar-built apps in the order the server pages them. Catalog rows always
// come whole, so "Show more" only ever appends scholar rows at the bottom and
// nothing already on screen moves — which is also why scholar rows are never
// re-sorted here: the server walks them by session start (newest or oldest
// first), and there is no index to page them by edit time.

export type ListItem<C, S> =
  | { kind: "catalog"; row: C }
  | { kind: "scholar"; app: S };

/** Name (A–Z, the default), by when the app was added, or by its last edit. */
export type AppSort = "name" | "newest" | "oldest" | "edited";

export type SortableCatalogRow = {
  name: string;
  createdAt: number;
  /** null when the app records no edit (web and native apps). */
  lastEditedAt: number | null;
};

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" });

/** Catalog rows in the chosen order. An app with no recorded edit sorts by
 *  when it was added; ties fall back to the name so the order is stable. */
export function sortCatalog<C extends SortableCatalogRow>(
  catalog: ReadonlyArray<C>,
  sort: AppSort,
): C[] {
  const edited = (row: C) => row.lastEditedAt ?? row.createdAt;
  const compare: (a: C, b: C) => number =
    sort === "newest"
      ? (a, b) => b.createdAt - a.createdAt || byName(a, b)
      : sort === "oldest"
        ? (a, b) => a.createdAt - b.createdAt || byName(a, b)
        : sort === "edited"
          ? (a, b) => edited(b) - edited(a) || byName(a, b)
          : byName;
  return [...catalog].sort(compare);
}

export function appListItems<C extends SortableCatalogRow, S>(
  catalog: ReadonlyArray<C>,
  scholarApps: ReadonlyArray<S>,
  sort: AppSort = "name",
): ListItem<C, S>[] {
  return [
    ...sortCatalog(catalog, sort).map((row) => ({ kind: "catalog" as const, row })),
    ...scholarApps.map((app) => ({ kind: "scholar" as const, app })),
  ];
}

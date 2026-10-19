import { describe, expect, test } from "vitest";
import { appListItems, type SortableCatalogRow } from "./appListOrder";

type Row = SortableCatalogRow;

const row = (name: string, createdAt = 0, lastEditedAt: number | null = null): Row => ({
  name,
  createdAt,
  lastEditedAt,
});

const names = (items: ReturnType<typeof appListItems<Row, string>>) =>
  items.map((i) => (i.kind === "catalog" ? `c:${i.row.name}` : `s:${i.app}`));

describe("appListItems", () => {
  test("catalog A–Z first, then scholar apps in server order", () => {
    const items = appListItems(
      [row("PressReader"), row("lego spike"), row("Math Academy")],
      ["Star Painter", "Bouncing Sun"],
    );
    expect(names(items)).toEqual([
      "c:lego spike",
      "c:Math Academy",
      "c:PressReader",
      "s:Star Painter",
      "s:Bouncing Sun",
    ]);
  });

  test("loading more scholar apps only appends", () => {
    const catalog = [row("B"), row("A")];
    const first = names(appListItems(catalog, ["new", "older"], "edited"));
    const more = names(appListItems(catalog, ["new", "older", "oldest"], "edited"));
    expect(more.slice(0, first.length)).toEqual(first);
    expect(more.at(-1)).toBe("s:oldest");
  });

  test("newest and oldest order catalog apps by when they were added", () => {
    const catalog = [row("Mid", 20), row("Old", 10), row("New", 30)];
    expect(names(appListItems(catalog, [], "newest"))).toEqual([
      "c:New",
      "c:Mid",
      "c:Old",
    ]);
    expect(names(appListItems(catalog, [], "oldest"))).toEqual([
      "c:Old",
      "c:Mid",
      "c:New",
    ]);
  });

  test("last edited uses the edit time, falling back to when an app was added", () => {
    const catalog = [
      row("Web app added late", 50, null),
      row("Custom edited recently", 10, 90),
      row("Custom never re-edited", 5, 5),
    ];
    expect(names(appListItems(catalog, ["kept in server order"], "edited"))).toEqual([
      "c:Custom edited recently",
      "c:Web app added late",
      "c:Custom never re-edited",
      "s:kept in server order",
    ]);
  });
});

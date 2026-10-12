/** "with Chris Mentor-Test" — the OTHER named adults on a scholar thread, as
 *  the signed-in staffer reads them. Never names the viewer (no "you"): a
 *  line that only says who you already are carries nothing. Null when no
 *  other adult is named. */
export function staffWithLine(
  staff: { _id: string; name: string }[],
  viewerId: string | null | undefined,
): string | null {
  const names = staff.filter((p) => p._id !== viewerId).map((p) => p.name);
  if (names.length === 0) return null;
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `with ${list}`;
}

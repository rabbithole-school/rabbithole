import type { EnrollmentStanding } from "@/convex/lib/enrollmentStanding";
import { uploadableKinds } from "@/convex/lib/documentKinds";
import type { Role } from "@/convex/lib/roles";

export type FamiliesDirectoryView = "guardians" | "scholars";

export function canUploadDirectoryDocuments(
  role: Role | undefined | null,
  hasHealthManagementAccess: boolean,
): boolean {
  return uploadableKinds(role, false, hasHealthManagementAccess).length > 0;
}

export interface ParentChildLike<IdT extends string = string> {
  _id: IdT;
  name: string;
  gradeLevel?: string | null;
  image?: string | null;
  username?: string | null;
  enrollmentStanding?: EnrollmentStanding;
}

export interface ParentRowLike<IdT extends string = string> {
  _id: IdT;
  name: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string | null;
  phone?: string | null;
  address?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  image?: string | null;
  children: readonly ParentChildLike<IdT>[];
}

export interface ScholarRowLike<IdT extends string = string> {
  _id: IdT;
  name: string;
  image?: string | null;
  username?: string | null;
  enrollmentStanding?: EnrollmentStanding;
  /** Whether the scholar already has a stored password → "Reset password" vs
   *  "Create password". Only the authoritative roster
   *  (users.listDirectoryScholars)
   *  knows this; a guardian-derived-only row leaves it undefined (treated as
   *  "Create password"). */
  hasCredential?: boolean;
  parents: {
    _id: IdT;
    name: string | null;
    email: string | null;
    image?: string | null;
  }[];
}

export function filterParents<IdT extends string>(
  parents: ParentRowLike<IdT>[],
  query: string,
): ParentRowLike<IdT>[] {
  const q = query.trim().toLowerCase();
  if (!q) return parents;
  return parents.filter(
    (p) =>
      (p.name ?? "").toLowerCase().includes(q) ||
      (p.email ?? "").toLowerCase().includes(q) ||
      p.children.some((c) => c.name.toLowerCase().includes(q)),
  );
}

export function scholarIdsFromParents<IdT extends string>(
  parents: ParentRowLike<IdT>[],
): IdT[] {
  const seen = new Set<IdT>();
  for (const parent of parents) {
    for (const child of parent.children) {
      seen.add(child._id);
    }
  }
  return Array.from(seen);
}

export function deriveScholarRows<IdT extends string>(
  parents: ParentRowLike<IdT>[],
): ScholarRowLike<IdT>[] {
  const scholars = new Map<IdT, ScholarRowLike<IdT>>();
  for (const parent of parents) {
    for (const child of parent.children) {
      const existing = scholars.get(child._id);
      if (existing) {
        existing.parents.push({
          _id: parent._id,
          name: parent.name,
          email: parent.email,
          image: parent.image ?? null,
        });
        // A scholar can appear under several guardians; keep the first photo we
        // see (they all resolve to the same scholar record anyway).
        if (existing.image == null && child.image != null) {
          existing.image = child.image;
        }
        continue;
      }
      scholars.set(child._id, {
        _id: child._id,
        name: child.name,
        image: child.image ?? null,
        username: child.username ?? null,
        parents: [
          {
            _id: parent._id,
            name: parent.name,
            email: parent.email,
            image: parent.image ?? null,
          },
        ],
      });
    }
  }
  return Array.from(scholars.values())
    .map((scholar) => ({
      ...scholar,
      parents: scholar.parents.sort((a, b) =>
        parentLabel(a).localeCompare(parentLabel(b)),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function filterScholarRows<IdT extends string>(
  scholars: ScholarRowLike<IdT>[],
  query: string,
): ScholarRowLike<IdT>[] {
  const q = query.trim().toLowerCase();
  if (!q) return scholars;
  return scholars.filter(
    (scholar) =>
      scholar.name.toLowerCase().includes(q) ||
      scholar.parents.some(
        (parent) =>
          (parent.name ?? "").toLowerCase().includes(q) ||
          (parent.email ?? "").toLowerCase().includes(q),
      ),
  );
}

/**
 * Union the authoritative lens-scoped scholar set
 * (from users.listDirectoryScholars)
 * with guardian info derived from the parents directory. A scholar with no
 * guardian yet still appears (empty `parents`) — the guardian-derived list
 * alone would hide a freshly-added scholar until a guardian was linked, which
 * would make the "Add scholar" button look broken.
 */
export function mergeScholarRows<IdT extends string>(
  scholars: readonly {
    _id: IdT;
    name: string | null;
    image?: string | null;
    username?: string | null;
    enrollmentStanding: EnrollmentStanding;
    hasCredential?: boolean;
  }[],
  guardianDerived: readonly ScholarRowLike<IdT>[],
): ScholarRowLike<IdT>[] {
  const guardiansById = new Map<IdT, ScholarRowLike<IdT>["parents"]>();
  for (const row of guardianDerived) guardiansById.set(row._id, row.parents);
  return scholars
    .map((s) => ({
      _id: s._id,
      name: s.name ?? "Scholar",
      image: s.image ?? null,
      username: s.username ?? null,
      enrollmentStanding: s.enrollmentStanding,
      hasCredential: s.hasCredential,
      parents: guardiansById.get(s._id) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parentLabel(parent: {
  name: string | null;
  email: string | null;
}): string {
  return parent.name ?? parent.email ?? "Family";
}

/** Shape required by {@link buildGuardiansCsv}. */
export interface GuardianExportRow {
  name: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  children: readonly { name: string; gradeLevel?: string | null }[];
}

export function guardianNameParts(parent: {
  name: string | null;
  firstName?: string | null;
  lastName?: string | null;
}): { firstName: string; lastName: string } {
  const firstName = parent.firstName?.trim() ?? "";
  const lastName = parent.lastName?.trim() ?? "";
  if (firstName || lastName) return { firstName, lastName };

  const name = parent.name?.trim() ?? "";
  if (!name) return { firstName: "", lastName: "" };
  const comma = name.match(/^([^,]+),\s*(.+)$/);
  if (comma) {
    return { firstName: comma[2].trim(), lastName: comma[1].trim() };
  }
  const parts = name.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export function guardianAddressParts(parent: {
  address: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): { streetAddress: string; city: string; state: string; zip: string } {
  const streetAddress = parent.streetAddress?.trim() ?? "";
  const city = parent.city?.trim() ?? "";
  const state = parent.state?.trim() ?? "";
  const zip = parent.zip?.trim() ?? "";
  if (streetAddress || city || state || zip) {
    return { streetAddress, city, state, zip };
  }

  const address = (parent.address ?? "").replace(/\s+/g, " ").trim();
  if (!address) return { streetAddress: "", city: "", state: "", zip: "" };
  const parsed = address.match(
    /^(.+?),\s*([^,]+?)(?:,?\s+)([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/,
  );
  if (!parsed) {
    return { streetAddress: address, city: "", state: "", zip: "" };
  }
  return {
    streetAddress: parsed[1].trim(),
    city: parsed[2].trim(),
    state: parsed[3].trim().toUpperCase(),
    zip: parsed[4].trim(),
  };
}

/** Wrap a CSV field in double-quotes and escape embedded double-quotes. */
function csvField(value: string | null | undefined): string {
  const s = value ?? "";
  // Always quote so that commas, newlines, and quotes inside are safe.
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build a guardian-contact CSV string from a (possibly filtered) list of
 * guardian rows. One row is emitted per linked child, with guardian contact
 * fields repeated on each child row.
 *
 * Columns: Child Name, Grade, First Name, Last Name, Email, Phone,
 * Street Address, City, State, ZIP
 */
export function buildGuardiansCsv(rows: GuardianExportRow[]): string {
  const header = [
    "Child Name",
    "Grade",
    "First Name",
    "Last Name",
    "Email",
    "Phone",
    "Street Address",
    "City",
    "State",
    "ZIP",
  ]
    .map(csvField)
    .join(",");
  const body = rows.flatMap((row) => {
    const { firstName, lastName } = guardianNameParts(row);
    const { streetAddress, city, state, zip } = guardianAddressParts(row);
    return [...row.children]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) =>
        [
          child.name,
          child.gradeLevel ?? "",
          firstName,
          lastName,
          row.email,
          row.phone,
          streetAddress,
          city,
          state,
          zip,
        ]
          .map(csvField)
          .join(","),
      );
  });
  return `\uFEFF${[header, ...body].join("\r\n")}`;
}

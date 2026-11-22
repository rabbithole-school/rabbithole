/**
 * Who made the free tools, read from the deployment's own brand file.
 *
 * `lib/primaryInstitutionBrand.ts` is the sanctioned home for a school's
 * identity: it stays private, and the Foundation export recreates it from
 * `foundation/templates/lib/primaryInstitutionBrand.ts` with neutral values.
 * So this public file never names a school; the deployment fills it in, and a
 * deployment with the neutral brand shows no school credit at all. It is a
 * deployment setting, not a tenant read: no request decides which school is
 * credited.
 */

import { PRIMARY_INSTITUTION_BRAND } from "@/lib/primaryInstitutionBrand";

const NEUTRAL_NAME = "Rabbithole";

export type SchoolCredit = { name: string; url: string | null };

export function schoolCredit(): SchoolCredit | null {
  const name: string = PRIMARY_INSTITUTION_BRAND.schoolName;
  if (!name || name === NEUTRAL_NAME) return null;
  const url: string | null = PRIMARY_INSTITUTION_BRAND.websiteUrl ?? null;
  return { name, url };
}

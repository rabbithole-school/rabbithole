"use client";

import { Field } from "@chakra-ui/react";
import { useQuery } from "convex/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { api } from "@/convex/_generated/api";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { useActiveInstitution } from "@/hooks/useActiveInstitution";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import {
  canonicalInstitutionScope,
  withInstitutionScope,
} from "@/lib/institutionLinks";
import { FieldSelect } from "@/components/ui/FieldSelect";

/**
 * The School shell is always scoped to one institution. Platform admins can
 * pivot that scope here; institution-scoped staff keep their fixed membership.
 */
export function SchoolInstitutionSelect() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user } = useCurrentUser();
  const { activeInstitution, requestedScope } = useActiveInstitution();
  const canSwitch =
    isPlatformAdminRole(user?.role as Role | undefined) ||
    activeInstitution?.isAdmin === true;
  const institutions = useQuery(
    api.institutions.listForStaff,
    canSwitch ? {} : "skip",
  );
  const currentHref = `${pathname}${
    searchParams.size > 0 ? `?${searchParams.toString()}` : ""
  }`;
  const primarySlug =
    institutions?.find((institution) => institution.isPrimary)?.slug ?? null;

  useEffect(() => {
    if (canSwitch && requestedScope === "all" && primarySlug) {
      router.replace(withInstitutionScope(currentHref, primarySlug), {
        scroll: false,
      });
    }
  }, [canSwitch, currentHref, primarySlug, requestedScope, router]);

  if (!canSwitch || institutions === undefined || institutions.length < 2) {
    return null;
  }

  const selectedScope = canonicalInstitutionScope(
    requestedScope,
    activeInstitution,
    institutions,
    "institution",
  );

  return (
    <Field.Root gap={1.5}>
      <Field.Label
        fontFamily="heading"
        fontSize="sm"
        fontWeight="600"
        color="charcoal.500"
      >
        School
      </Field.Label>
      <FieldSelect
        value={selectedScope}
        onChange={(scope) =>
          router.push(withInstitutionScope(currentHref, scope), {
            scroll: false,
          })
        }
        w="full"
        fieldProps={{ "aria-label": "School" }}
      >
        {institutions.map((institution) => (
          <option
            key={institution._id}
            value={institution.slug}
          >
            {institution.emoji ? `${institution.emoji} ` : ""}
            {institution.name}
            {institution.disabled ? " (paused)" : ""}
          </option>
        ))}
      </FieldSelect>
    </Field.Root>
  );
}

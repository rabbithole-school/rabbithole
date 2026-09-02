"use client";

// School › Groups — the administrative home for scholar-group management
// (create / rename / recolor / set membership / delete), moved off the
// Scholars-tab rail (Andy: "more of an administrative function"). It hosts the
// <ManageGroupsDialog> — opened full (no initial group) for whole-set
// management. This is now the ONLY place group membership is edited; the
// Scholars-tab Snapshot's redundant "Add/edit scholars" button was removed
// (2026-08-24).
//
// GATE — teacher-visible, deliberately. The nav item is `scholarAdmin`
// (teacher OR school:operations) and this page admits the same set, because the
// backing `convex/scholarGroups` mutations (create/update/setScholars/remove)
// gate on `requireScholarAdmin`, which already admits teachers. Gating this
// page ops-only would strip a permission teachers currently hold server-side
// (and held via the old rail affordance) — a regression beyond the location
// move Andy asked for. Operations staff keep access too (they run rosters).

import { useState } from "react";
import { Box, Button, Heading, Stack, Text } from "@chakra-ui/react";
import { UsersThree } from "@phosphor-icons/react";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { useAuthorizationGuard } from "@/hooks/useAuthorizationGuard";
import { AuthorizationPending } from "@/components/AuthorizationPending";
import { useSchoolOperationsAccess } from "@/hooks/useSchoolOperationsAccess";
import { ManageGroupsDialog } from "@/components/ManageGroupsDialog";
import { isScholarAdminRole } from "@/convex/lib/roles";

export default function SchoolGroupsPage() {
  const { user, isLoading } = useCurrentUser();
  const { activeInstitution, hasSchoolOperationsAccess } =
    useSchoolOperationsAccess(user, !!user);
  // Teacher OR school:operations — the same set `requireScholarAdmin` gates the
  // group mutations on (see the file header for why not ops-only).
  const allowed =
    isScholarAdminRole(user?.role) || hasSchoolOperationsAccess === true;
  const authorization = useAuthorizationGuard({
    isLoading: isLoading || activeInstitution === undefined,
    hasUser: !!user,
    isAllowed: allowed,
    unauthorizedRedirect: "/",
  });

  const [manageOpen, setManageOpen] = useState(false);

  if (authorization !== "allowed" || !user) {
    return <AuthorizationPending />;
  }

  return (
    <Box p={{ base: 5, lg: 8 }} maxW="720px">
      <Stack gap={2} mb={6}>
        <Heading size="md" color="navy.500" fontFamily="heading">
          Groups
        </Heading>
        <Text fontFamily="body" fontSize="sm" color="charcoal.500" lineHeight="1.6">
          Scholar groups (pods) organize scholars for scoped surfaces across the
          app. Create, rename, recolor, set membership, or delete a group here.
        </Text>
      </Stack>

      <Button
        colorPalette="violet"
        fontFamily="heading"
        onClick={() => setManageOpen(true)}
        data-testid="open-manage-groups"
      >
        <UsersThree size={16} style={{ marginRight: "8px" }} /> Manage groups
      </Button>

      <ManageGroupsDialog open={manageOpen} onClose={() => setManageOpen(false)} />
    </Box>
  );
}

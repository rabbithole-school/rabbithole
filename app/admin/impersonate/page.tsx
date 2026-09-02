"use client";

// Platform-admin "View as…" (impersonation) picker for the OVERLAY model.
// Picking a user records a server-side, read-only overlay on the admin's OWN
// session and full-reloads to "/", so the whole app resolves as the target in
// the SAME tab (no token, no URL, no incognito) with a persistent banner.
// "Exit" on the banner clears the overlay. The backend re-validates every
// guard (escalation, self, disabled) — this UI is a convenience, not the trust
// boundary. See convex/impersonation.ts + review/admin-impersonation-redesign-plan.html.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import {
  Box,
  Button,
  Heading,
  HStack,
  Input,
  Text,
  VStack,
} from "@chakra-ui/react";
import { PersonCell } from "@/components/PersonCell";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { isPlatformAdminRole, type Role } from "@/convex/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toaster } from "@/lib/toaster";

type AdminUser = {
  _id: Id<"users">;
  username: string | null;
  name: string | null;
  image?: string | null;
  role: string;
};

function displayName(user: AdminUser) {
  return user.name?.trim() || "Unnamed account";
}

export default function AdminImpersonatePage() {
  const router = useRouter();
  const { user, isLoading } = useCurrentUser();
  const isAdmin = isPlatformAdminRole(user?.role as Role | undefined);
  const enabled = useQuery(api.impersonation.isEnabled, {});
  const users = useQuery(
    api.users.listAllUsers,
    isAdmin && enabled ? {} : "skip",
  );
  const startImpersonation = useMutation(api.impersonation.startImpersonation);

  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("");
  const [busyUserId, setBusyUserId] = useState<Id<"users"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      router.replace("/sign-in");
      return;
    }
    if (!isAdmin) {
      router.replace("/");
    }
  }, [isAdmin, isLoading, router, user]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ((users ?? []) as AdminUser[])
      .filter((u) => !isPlatformAdminRole(u.role as Role)) // can't view as a platform-admin (escalation guard)
      .filter((u) =>
        [u.username, u.name].some((value) =>
          (value ?? "").toLowerCase().includes(q),
        ),
      )
      .sort((a, b) => {
        const byName = displayName(a).localeCompare(displayName(b));
        return byName || (a.username ?? "").localeCompare(b.username ?? "");
      });
  }, [search, users]);

  if (isLoading || !user || !isAdmin) {
    return null;
  }

  const handleStart = async (target: AdminUser) => {
    setBusyUserId(target._id);
    setError(null);
    try {
      const trimmedReason = reason.trim();
      await startImpersonation({
        targetUserId: target._id,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      });
      if (typeof window !== "undefined") {
        // Full-document reload — the app now renders as the target with the banner.
        window.location.assign(new URL("/", window.location.href));
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      toaster.error({ title: "Could not start viewing as this user", description: message });
      setBusyUserId(null);
    }
  };

  return (
    <VStack align="stretch" gap={6}>
      <Box>
        <Heading as="h1" fontFamily="heading" fontSize="2xl" color="navy.500" mb={1}>
          View as… (impersonate)
        </Heading>
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Pick a non-platform-admin account to view the app exactly as they see it —
          read-only, in this same tab. A persistent banner stays up until you exit.
        </Text>
      </Box>

      {enabled === undefined ? null : !enabled ? (
        <Box bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200" shadow="xs" p={5}>
          <Text fontFamily="body" fontSize="sm" color="charcoal.500">
            View-as is not enabled on this deployment.
          </Text>
        </Box>
      ) : (
        <Box bg="white" borderRadius="lg" borderWidth="1px" borderColor="gray.200" shadow="xs" p={5}>
          <VStack align="stretch" gap={4}>
            <HStack align="start" gap={3} flexWrap="wrap">
              <Box flex="1 1 260px">
                <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                  Username or name search
                </Text>
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="e.g. oliver_stone or Oliver Stone"
                  bg="gray.50"
                  fontFamily="body"
                />
              </Box>
              <Box flex="1 1 260px">
                <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                  Reason <Text as="span" color="charcoal.300">(optional)</Text>
                </Text>
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Support/debugging context"
                  bg="gray.50"
                  fontFamily="body"
                />
              </Box>
            </HStack>

            {error && (
              <Text fontFamily="body" fontSize="sm" color="red.500">
                {error}
              </Text>
            )}

            <VStack align="stretch" gap={2}>
              {users === undefined ? (
                <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                  Loading users…
                </Text>
              ) : filteredUsers.length === 0 ? (
                <Text fontFamily="body" fontSize="sm" color="charcoal.400">
                  No users match that username or name.
                </Text>
              ) : (
                filteredUsers.map((target) => {
                  const name = displayName(target);
                  const username = target.username?.trim();
                  return (
                    <HStack
                      key={target._id}
                      justify="space-between"
                      align="center"
                      gap={3}
                      borderWidth="1px"
                      borderColor="gray.200"
                      borderRadius="lg"
                      px={3}
                      py={2}
                    >
                      <VStack align="start" gap={0.5} minW={0} flex="1 1 auto">
                        <PersonCell
                          name={name}
                          image={target.image}
                          size="xs"
                          colorKey={target._id}
                        />
                        <Text
                          pl={8}
                          fontFamily="body"
                          fontSize="2xs"
                          color="charcoal.400"
                          overflowWrap="anywhere"
                        >
                          {username && (
                            <>
                              <Text as="span" fontFamily="mono">
                                @{username}
                              </Text>
                              {" · "}
                            </>
                          )}
                          {target.role.replace(/_/g, " ")}
                        </Text>
                      </VStack>
                      <Button
                        size="sm"
                        colorPalette="violet"
                        variant="outline"
                        onClick={() => handleStart(target)}
                        disabled={busyUserId !== null}
                        loading={busyUserId === target._id}
                        flexShrink={0}
                        aria-label={`View as ${name}`}
                      >
                        View as
                      </Button>
                    </HStack>
                  );
                })
              )}
            </VStack>
          </VStack>
        </Box>
      )}
    </VStack>
  );
}

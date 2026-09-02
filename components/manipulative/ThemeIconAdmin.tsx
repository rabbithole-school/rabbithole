"use client";

/**
 * Generative charm-layer override surface (staff). Lists the
 * `manipulativeThemeIcons` cache — every label an activity has themed with,
 * plus its generated art — and gives a curator Regenerate / Hide / Clear per
 * label. Auto-live model: an icon is shown the moment it's `ready`; this panel
 * is the OVERRIDE, not a pre-approval gate (see the design doc + CLAUDE.md's
 * "curator, not a per-item gate"). Reads are open; the writes are teacher-gated
 * server-side, so the action buttons only render for staff.
 *
 * Mounted in the Manipulative Library lens' staff "Theme assets" section (Math
 * Skills studio → Manipulatives). Renders nothing until at least one label has
 * been generated.
 */
import { Badge, Box, Button, Flex, Heading, Image, Text } from "@chakra-ui/react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { isTeacherRole, type Role } from "@/convex/lib/roles";
import { useCurrentUser } from "@/hooks/useCurrentUser";

export function ThemeIconAdmin() {
  const rows = useQuery(api.manipulativeThemeIcons.listAll, {});
  const regenerate = useMutation(api.manipulativeThemeIcons.regenerate);
  const setHidden = useMutation(api.manipulativeThemeIcons.setHidden);
  const clear = useMutation(api.manipulativeThemeIcons.clear);
  const { user } = useCurrentUser();
  const isStaff = isTeacherRole(user?.role as Role | undefined);

  if (!rows || rows.length === 0) return null;

  return (
    <Box mt={{ base: 8, md: 12 }}>
      <Flex align="baseline" gap={3} wrap="wrap">
        <Heading size="lg" color="brand.primary">
          Generative theme icons
        </Heading>
        <Badge colorPalette="purple" borderRadius="999px" px={2}>
          Charm layer
        </Badge>
      </Flex>
      <Text mt={1} mb={4} color="fg.muted" fontSize="14px" maxW="780px">
        Every noun a manipulative has themed its fill with, generated once and
        shared across activities. Icons go live the moment they&apos;re ready;
        {isStaff ? " use" : " staff can use"} Regenerate / Hide / Clear to
        override a label.
      </Text>
      <Flex wrap="wrap" gap={4}>
        {rows.map((r) => (
          <Box
            key={r._id}
            borderWidth="1px"
            borderColor="border"
            borderRadius="12px"
            p={3}
            w="150px"
            bg="bg.panel"
          >
            <Flex
              align="center"
              justify="center"
              h="72px"
              bg="bg.subtle"
              borderRadius="8px"
              // a checker-ish neutral so a transparent PNG reads
              backgroundImage="linear-gradient(45deg,#0001 25%,transparent 25%,transparent 75%,#0001 75%),linear-gradient(45deg,#0001 25%,transparent 25%,transparent 75%,#0001 75%)"
              backgroundSize="12px 12px"
              backgroundPosition="0 0,6px 6px"
            >
              {r.url ? (
                <Image
                  src={r.url}
                  alt={r.displayLabel}
                  maxH="64px"
                  maxW="64px"
                  opacity={r.hidden ? 0.35 : 1}
                />
              ) : (
                <Text fontSize="11px" color="fg.muted">
                  {r.status}
                </Text>
              )}
            </Flex>
            <Text mt={2} fontSize="13px" fontWeight="600" lineClamp={1}>
              {r.displayLabel}
            </Text>
            <Flex gap={1} mt={1} align="center">
              <Badge
                size="sm"
                colorPalette={
                  r.hidden
                    ? "gray"
                    : r.status === "ready"
                      ? "green"
                      : r.status === "failed"
                        ? "red"
                        : "yellow"
                }
              >
                {r.hidden ? "hidden" : r.status}
              </Badge>
            </Flex>
            {isStaff && (
              <Flex gap={1} mt={2} wrap="wrap">
                <Button
                  size="2xs"
                  variant="outline"
                  onClick={() => regenerate({ label: r.label }).catch(() => {})}
                >
                  Regenerate
                </Button>
                <Button
                  size="2xs"
                  variant="outline"
                  onClick={() =>
                    setHidden({ label: r.label, hidden: !r.hidden }).catch(
                      () => {},
                    )
                  }
                >
                  {r.hidden ? "Show" : "Hide"}
                </Button>
                <Button
                  size="2xs"
                  variant="outline"
                  colorPalette="red"
                  onClick={() => clear({ label: r.label }).catch(() => {})}
                >
                  Clear
                </Button>
              </Flex>
            )}
          </Box>
        ))}
      </Flex>
    </Box>
  );
}

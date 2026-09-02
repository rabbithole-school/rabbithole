"use client";

import { useEffect, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { Box, HStack, IconButton, Text, VStack } from "@chakra-ui/react";
import Link from "next/link";
import { Copy, Check, Trash, Plugs } from "@phosphor-icons/react";
import { api } from "@/convex/_generated/api";
import { formatRelative } from "@/lib/relativeTime";

/**
 * Remote MCP connector UI. The full connect experience — instructions for
 * Claude and ChatGPT, the connector URL, and the active-connection list — now
 * lives on the dedicated `/connect` page (app/connect/page.tsx), because the
 * ChatGPT explanation does not fit the narrow Account Details column.
 *
 * This module exports the reusable pieces the page composes, plus a compact
 * summary row (`McpConnections`) that Account Details shows in place of the old
 * inline UI: a link to `/connect` and a plain-language active-connection count.
 */

/**
 * The connector URL in a copyable row. `${origin}/api/mcp`, derived from the
 * live origin so it's correct on dev/worktree ports and prod alike.
 *
 * minW=0 on the flex items is load-bearing: without it their automatic minimum
 * size is their min-content width, which the long connector URL blows past —
 * overflowing the container, which clips, so the copy reads as cut off.
 */
export function McpConnectorUrl() {
  const [connectorUrl, setConnectorUrl] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // window is absent during SSR; derive the URL after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- client-only origin, deferred past SSR
    setConnectorUrl(`${window.location.origin}/api/mcp`);
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(connectorUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked — the URL is still visible to select manually.
    }
  };

  return (
    <HStack
      gap={2}
      minW={0}
      borderWidth="1px"
      borderColor="gray.200"
      borderRadius="lg"
      px={3}
      py={2}
    >
      <Text
        flex={1}
        fontFamily="mono"
        fontSize="sm"
        color="charcoal.500"
        truncate
      >
        {connectorUrl || "…"}
      </Text>
      <IconButton
        aria-label="Copy connector URL"
        size="xs"
        variant="ghost"
        color={copied ? "green.500" : "charcoal.300"}
        _hover={{ color: "violet.500", bg: "violet.50" }}
        disabled={!connectorUrl}
        onClick={handleCopy}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
    </HStack>
  );
}

/**
 * The caller's active MCP connections, each revocable.
 */
export function McpConnectionsList() {
  const sessions = useQuery(api.mcpOauth.listMySessions);
  const revoke = useMutation(api.mcpOauth.revokeMySession);

  return (
    <Box>
      <Text
        fontSize="2xs"
        fontFamily="heading"
        fontWeight="700"
        color="charcoal.400"
        textTransform="uppercase"
        letterSpacing="0.05em"
        mb={2}
      >
        Active connections
      </Text>
      {sessions === undefined ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          Loading…
        </Text>
      ) : sessions.length === 0 ? (
        <Text fontFamily="body" fontSize="sm" color="charcoal.400">
          No connections yet.
        </Text>
      ) : (
        <VStack align="stretch" gap={2}>
          {sessions.map((s) => (
            <HStack
              key={s._id}
              justify="space-between"
              borderWidth="1px"
              borderColor="gray.200"
              borderRadius="lg"
              px={4}
              py={3}
            >
              <HStack gap={3} minW={0}>
                <Plugs size={18} color="var(--chakra-colors-violet-500)" />
                <Box minW={0}>
                  <Text fontFamily="body" fontWeight="500" truncate>
                    {s.clientName ?? "Claude"}
                  </Text>
                  <Text
                    fontFamily="body"
                    fontSize="xs"
                    color="charcoal.400"
                  >
                    Connected {formatRelative(s.createdAt)} · last used{" "}
                    {formatRelative(s.lastSeenAt)}
                  </Text>
                </Box>
              </HStack>
              <IconButton
                aria-label="Revoke connection"
                size="xs"
                variant="ghost"
                color="charcoal.300"
                _hover={{ color: "red.500", bg: "red.50" }}
                onClick={() => revoke({ id: s._id })}
              >
                <Trash size={14} />
              </IconButton>
            </HStack>
          ))}
        </VStack>
      )}
    </Box>
  );
}

/**
 * The compact Account Details row: a link to the dedicated /connect page plus a
 * plain-language active-connection count (nothing extra when there are none).
 */
export function McpConnections() {
  const sessions = useQuery(api.mcpOauth.listMySessions);
  const count = sessions?.length ?? 0;

  return (
    <VStack align="stretch" gap={1} flex={1} minW={0}>
      <Link href="/connect" style={{ textDecoration: "none" }}>
        <Text
          fontFamily="body"
          fontSize="sm"
          color="violet.500"
          _hover={{ color: "violet.600", textDecoration: "underline" }}
        >
          Connect Claude or ChatGPT to Rabbithole
        </Text>
      </Link>
      {count > 0 && (
        <Text fontFamily="body" fontSize="xs" color="charcoal.400">
          {count === 1 ? "1 active connection" : `${count} active connections`}
        </Text>
      )}
    </VStack>
  );
}

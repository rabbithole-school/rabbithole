"use client";

import { useState } from "react";
import { Box, Button, Flex, Input, Text, VStack } from "@chakra-ui/react";

type Status =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

export function TutorKeyForm() {
  const [key, setKey] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const save = async () => {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/tutor-key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (res.ok) {
        setKey("");
        setStatus({ kind: "saved" });
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setStatus({
        kind: "error",
        message: body?.error ?? "Saving the key failed. Try again.",
      });
    } catch {
      setStatus({ kind: "error", message: "Saving the key failed. Try again." });
    }
  };

  return (
    <Flex minH="100dvh" bg="gray.50" p={6}>
      <VStack gap={4} maxW="440px" w="full" m="auto" align="stretch">
        <Text fontFamily="heading" fontSize="xl" fontWeight="700" color="navy.500">
          Add the tutor&apos;s Anthropic key
        </Text>
        <Text fontFamily="body" fontSize="sm" color="charcoal.500">
          The tutor runs on Claude, from Anthropic. Paste an API key from
          console.anthropic.com. Rabbithole checks it with Anthropic, then saves
          it to the Rabbithole running on this computer.
        </Text>
        {status.kind === "saved" ? (
          <Box bg="white" borderWidth="1px" borderColor="gray.200" borderRadius="lg" p={4}>
            <Text fontFamily="body" fontSize="sm" color="charcoal.600">
              Saved. Go back to the chat and tap Try again.
            </Text>
          </Box>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim() && status.kind !== "saving") void save();
            }}
          >
            <VStack gap={3} align="stretch">
              <label>
                <Text fontFamily="heading" fontSize="sm" fontWeight="600" mb={1}>
                  Anthropic API key
                </Text>
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  placeholder="sk-ant-…"
                  bg="white"
                />
              </label>
              {status.kind === "error" && (
                <Text fontFamily="body" fontSize="sm" color="red.600">
                  {status.message}
                </Text>
              )}
              <Button
                type="submit"
                colorPalette="violet"
                loading={status.kind === "saving"}
                disabled={!key.trim()}
              >
                Check and save
              </Button>
            </VStack>
          </form>
        )}
      </VStack>
    </Flex>
  );
}

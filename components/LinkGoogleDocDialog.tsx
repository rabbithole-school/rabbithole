"use client";

import { useState, useEffect } from "react";
import {
  Box,
  Button,
  Input,
  Text,
  VStack,
  Dialog,
  Portal,
  Spinner,
} from "@chakra-ui/react";
import { StyledDialogContent } from "@/components/ui/StyledDialogContent";

// Linking a Google Doc gets the same explicit Type choice as writing or
// uploading — so "type" (what it is) stays orthogonal to "format" (a linked
// Doc). A linked Doc is teacher-authored, so it's limited to the same kinds as
// a written document.
export type GoogleDocKind = "teacher_report" | "observation" | "other";

const KINDS: { value: GoogleDocKind; label: string }[] = [
  { value: "teacher_report", label: "Teacher Report" },
  { value: "observation", label: "Observation" },
  { value: "other", label: "Other" },
];

export interface PickedGoogleDoc {
  id: string;
  name?: string;
  url?: string;
  mimeType?: string;
}

export function LinkGoogleDocDialog({
  picked,
  onClose,
  onConfirm,
}: {
  /** The just-picked Drive doc, or null when the dialog is closed. */
  picked: PickedGoogleDoc | null;
  onClose: () => void;
  onConfirm: (args: { title: string; kind: GoogleDocKind }) => Promise<void>;
}) {
  const open = picked !== null;
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<GoogleDocKind>("teacher_report");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (picked) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setTitle(picked.name?.trim() || "Linked Google Doc");
      setKind("teacher_report");
      setSaving(false);
      /* eslint-enable react-hooks/set-state-in-effect */
    }
  }, [picked]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onConfirm({ title: title.trim() || "Linked Google Doc", kind });
      onClose();
    } catch (err) {
      console.error("link Google Doc failed:", err);
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => !e.open && !saving && onClose()}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <StyledDialogContent maxW="md">
            <Dialog.Header px={6} pt={5} pb={2}>
              <Dialog.Title fontFamily="heading" fontSize="lg" color="navy.500">
                Link a Google Doc
              </Dialog.Title>
            </Dialog.Header>
            <Dialog.Body px={6} py={3}>
              <VStack gap={3} align="stretch">
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Type
                  </Text>
                  <select
                    value={kind}
                    onChange={(e) => setKind(e.target.value as GoogleDocKind)}
                    disabled={saving}
                    style={{
                      padding: "6px 8px",
                      borderRadius: "6px",
                      border: "1px solid #e2e8f0",
                      fontSize: "14px",
                      fontFamily: "inherit",
                      width: "100%",
                      background: "#f7fafc",
                    }}
                  >
                    {KINDS.map((k) => (
                      <option key={k.value} value={k.value}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </Box>
                <Box>
                  <Text fontSize="xs" color="charcoal.500" mb={1} fontFamily="heading">
                    Title
                  </Text>
                  <Input
                    size="sm"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    disabled={saving}
                    bg="gray.50"
                    fontFamily="heading"
                  />
                </Box>
                <Text fontSize="xs" color="charcoal.400" fontFamily="body">
                  Link only — the doc&apos;s contents aren&apos;t stored or read by
                  the tutor.
                </Text>
              </VStack>
            </Dialog.Body>
            <Dialog.Footer px={6} pb={5} pt={2} gap={2}>
              <Button
                size="sm"
                variant="ghost"
                fontFamily="heading"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                bg="violet.500"
                color="white"
                _hover={{ bg: "violet.600" }}
                fontFamily="heading"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? (
                  <>
                    <Spinner size="xs" mr={2} /> Linking…
                  </>
                ) : (
                  "Link"
                )}
              </Button>
            </Dialog.Footer>
          </StyledDialogContent>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

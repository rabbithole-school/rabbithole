"use client";

import { useRef, useState, type ReactNode } from "react";
import { IconButton, Menu } from "@chakra-ui/react";
import { Camera, PencilSimple, Plus, Upload } from "@phosphor-icons/react";
import { CameraCaptureDialog } from "@/components/CameraCaptureDialog";
import { SketchDialog } from "@/components/SketchDialog";
import { COMPOSER_ATTACH_TRIGGER_STYLE } from "@/components/ui/composerAttachTrigger";
import type { PendingImage } from "@/hooks/usePendingImage";

/**
 * The "+" attachment control shared by every scholar chat-style composer — the
 * tutor chat (SessionInterface) and the practice "talk me through it" chat
 * (PracticeSession). Owns the three ways to stage an image (Take Photo → shared
 * CameraCaptureDialog, Quick Sketch → shared SketchDialog, Upload File → hidden
 * file input) so the getUserMedia / canvas / file-picker wiring lives in exactly
 * one place. Each source resolves to a { file, preview } which is handed back via
 * `onPick`; the caller owns staging + upload (see `usePendingImage`).
 *
 * `children` renders as extra trailing menu items (e.g. the chat's Time Limit).
 */
export function ComposerAttachMenu({
  onPick,
  disabled = false,
  overlayPosition = "absolute",
  triggerAriaLabel = "Add attachment",
  children,
}: {
  onPick: (img: PendingImage) => void;
  disabled?: boolean;
  overlayPosition?: "absolute" | "fixed";
  triggerAriaLabel?: string;
  children?: ReactNode;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [showSketch, setShowSketch] = useState(false);

  const stageFile = (file: File) => onPick({ file, preview: URL.createObjectURL(file) });

  return (
    <>
      {/* Hidden file input for "Upload File" */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && file.type.startsWith("image/")) stageFile(file);
          e.target.value = ""; // reset so the same file can be re-selected
        }}
      />

      {showSketch && (
        <SketchDialog
          onAttach={(file, preview) => onPick({ file, preview })}
          onClose={() => setShowSketch(false)}
        />
      )}

      <CameraCaptureDialog
        open={showCamera}
        onClose={() => setShowCamera(false)}
        onCapture={(file) => stageFile(file)}
        overlayPosition={overlayPosition}
      />

      <Menu.Root positioning={{ placement: "top" }}>
        <Menu.Trigger asChild>
          <IconButton
            aria-label={triggerAriaLabel}
            {...COMPOSER_ATTACH_TRIGGER_STYLE}
            size="md"
            disabled={disabled}
          >
            <Plus />
          </IconButton>
        </Menu.Trigger>
        <Menu.Positioner>
          <Menu.Content minW="160px">
            <Menu.Item value="camera" cursor="pointer" onClick={() => setShowCamera(true)}>
              <Camera />
              Take Photo
            </Menu.Item>
            <Menu.Item value="sketch" cursor="pointer" onClick={() => setShowSketch(true)}>
              <PencilSimple />
              Quick Sketch
            </Menu.Item>
            <Menu.Item value="upload" cursor="pointer" onClick={() => fileInputRef.current?.click()}>
              <Upload />
              Upload File
            </Menu.Item>
            {children}
          </Menu.Content>
        </Menu.Positioner>
      </Menu.Root>
    </>
  );
}

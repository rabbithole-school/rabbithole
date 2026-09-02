"use client";

import { useEffect, useRef, useState } from "react";
import { Box, Button, Flex, HStack, IconButton } from "@chakra-ui/react";
import { X } from "@phosphor-icons/react";

const COLORS = ["#222656", "#ad60bf", "#e05d5d", "#2f9e6e", "#f0a93b"];

/**
 * Reusable finger/Apple-Pencil canvas. Each caller routes the captured PNG
 * through its existing image pipeline (tutor attachment, slide asset, etc.).
 * Plain overlay (not an Ark Dialog), immune to nested body-lock pitfalls.
 */
export function SketchDialog({
  onAttach,
  onClose,
  submitLabel = "Attach sketch",
}: {
  onAttach: (file: File, preview: string) => void;
  onClose: () => void;
  submitLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const [color, setColor] = useState(COLORS[0]);
  const colorRef = useRef(color);
  // eslint-disable-next-line react-hooks/refs -- keep latest color for the canvas pointer handlers without re-binding them
  colorRef.current = color;
  const [hasInk, setHasInk] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, rect.width, rect.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const pos = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      drawingRef.current = true;
      canvas.setPointerCapture(e.pointerId);
      const p = pos(e);
      ctx.strokeStyle = colorRef.current;
      // Pencil pressure broadens the stroke a touch; fingers get 3px.
      ctx.lineWidth = e.pointerType === "pen" ? 2 + e.pressure * 3 : 3;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      setHasInk(true);
    };
    const move = (e: PointerEvent) => {
      if (!drawingRef.current) return;
      const p = pos(e);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    };
    const up = () => {
      drawingRef.current = false;
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    return () => {
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", up);
    };
  }, []);

  const clear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setHasInk(false);
  };

  const attach = () => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `sketch-${Date.now()}.png`, { type: "image/png" });
      onAttach(file, URL.createObjectURL(file));
      onClose();
    }, "image/png");
  };

  return (
    <Flex position="fixed" inset={0} zIndex={15000} bg="blackAlpha.700" align="center" justify="center" p={4}>
      <Flex flexDir="column" bg="white" borderRadius="2xl" overflow="hidden" w="full" maxW="700px" h="80%" maxH="600px" shadow="2xl">
        <Flex px={4} py={2.5} align="center" justify="space-between" borderBottom="1px solid" borderColor="gray.100">
          <HStack gap={2}>
            {COLORS.map((c) => (
              <Box
                key={c}
                as="button"
                w="26px"
                h="26px"
                borderRadius="full"
                bg={c}
                borderWidth={color === c ? "3px" : "1px"}
                borderColor={color === c ? "violet.300" : "gray.200"}
                onClick={() => setColor(c)}
                aria-label={`Pen color ${c}`}
              />
            ))}
            <Button size="xs" variant="ghost" color="charcoal.400" fontFamily="heading" onClick={clear} disabled={!hasInk}>
              Clear
            </Button>
          </HStack>
          <IconButton aria-label="Close sketch" size="sm" variant="ghost" color="charcoal.400" onClick={onClose}>
            <X />
          </IconButton>
        </Flex>
        <Box flex={1} minH={0}>
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: "100%", touchAction: "none", display: "block", cursor: "crosshair" }}
          />
        </Box>
        <Flex px={4} py={3} justify="flex-end" gap={3} borderTop="1px solid" borderColor="gray.100">
          <Button size="sm" variant="ghost" fontFamily="heading" color="charcoal.400" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" bg="violet.500" color="white" _hover={{ bg: "violet.600" }} fontFamily="heading" disabled={!hasInk} onClick={attach}>
            {submitLabel}
          </Button>
        </Flex>
      </Flex>
    </Flex>
  );
}

"use client";

/**
 * The one rubric-rating control used everywhere a 1–7 PCM "band" is set (the
 * four dimension ratings + the Course Performance Rating). A Chakra v3 Slider
 * (step 1, 1–7) with numbered marks and the band descriptor underneath, so the
 * band semantics (higher number = secure in the band, lower = just entered)
 * read the same in every place. DRY — never hand-roll a row of number buttons.
 */
import { useState } from "react";
import { Box, HStack, Slider, Text } from "@chakra-ui/react";
import { bandForRating } from "@/convex/lib/pcm";

const MARKS = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ value: v, label: String(v) }));

export function RubricSlider({
  value,
  onChange,
  label,
  blurb,
  disabled = false,
}: {
  /** 1–7, or undefined when not yet rated. */
  value?: number;
  onChange: (next: number) => void;
  label?: string;
  blurb?: string;
  disabled?: boolean;
}) {
  // Local thumb position for smooth dragging; committed to the caller on release.
  const [local, setLocal] = useState<number | undefined>(value);
  const [committedValue, setCommittedValue] = useState(value);
  if (committedValue !== value) {
    setCommittedValue(value);
    setLocal(value);
  }

  const shown = local ?? 4; // neutral resting spot when unrated
  const rated = local !== undefined;
  const band = rated ? bandForRating(shown) : null;

  return (
    <Box>
      {label && (
        <HStack justify="space-between" mb={2} align="baseline">
          <Text fontFamily="heading" fontWeight="700" fontSize="sm" color="navy.600">
            {label}
          </Text>
          {blurb && (
            <Text fontSize="xs" color="charcoal.300" fontFamily="body">
              {blurb}
            </Text>
          )}
        </HStack>
      )}
      <Slider.Root
        min={1}
        max={7}
        step={1}
        size="md"
        colorPalette="violet"
        disabled={disabled}
        value={[shown]}
        onValueChange={(d) => setLocal(d.value[0])}
        onValueChangeEnd={(d) => onChange(d.value[0])}
        opacity={rated ? 1 : 0.65}
      >
        <Slider.Control>
          <Slider.Track>
            <Slider.Range />
          </Slider.Track>
          <Slider.Thumb index={0}>
            <Slider.HiddenInput />
          </Slider.Thumb>
          <Slider.MarkerGroup>
            {MARKS.map((m) => (
              <Slider.Marker key={m.value} value={m.value}>
                <Slider.MarkerIndicator />
                <Text fontSize="xs" color="charcoal.400" mt={1} fontFamily="heading">
                  {m.label}
                </Text>
              </Slider.Marker>
            ))}
          </Slider.MarkerGroup>
        </Slider.Control>
      </Slider.Root>
      <Text fontSize="xs" color="charcoal.400" mt={6}>
        {band
          ? `${band.band} — ${band.posture === "secure" ? "secure in the band" : "just entered the band"}`
          : "Not yet rated — drag to set."}
      </Text>
    </Box>
  );
}

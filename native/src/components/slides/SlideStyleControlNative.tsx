/**
 * SlideStyleControlNative — the one contextual style control the native editor
 * shows at the end of its toolbar. It has two shapes driven by props, but stays
 * a SINGLE component so the two surfaces never fork:
 *
 *  • Text selected → "Text style": an "Aa" glyph + a dot showing the text's
 *    color. Its popover holds a Size row (Small/Medium/Large) on top and the
 *    text-color swatches below. Picking a size keeps the popover OPEN (so a
 *    scholar can then pick a color); picking a color closes it.
 *  • Nothing selected → "Slide background": a dot showing the slide background.
 *    Its popover is swatches only.
 *
 * Sizes/palettes/copy come from the shared `slidesScene` module so web + native
 * cannot drift.
 */
import { useCallback, useRef, useState } from "react";
import {
  Dimensions,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Modal } from "@/components/FreezableModal";

import { fonts, useColors } from "@/theme";

type Swatch = { label: string; value: string };
type SizeOption = { label: string; fontSize: number };

const PANEL_WIDTH = 232;
const COLUMNS = 4;
const CELL = 52; // ≥ 44pt hit target per swatch
const SIZE_ROW_HEIGHT = 74; // "Size" label + the segmented control
const SECTION_LABEL_HEIGHT = 22;
const SCREEN_MARGIN = 12;
const ANCHOR_GAP = 8;

export function SlideStyleControlNative({
  controlLabel,
  swatchNoun,
  glyph,
  currentColor,
  colors,
  onSelectColor,
  sizes,
  currentSize,
  onSelectSize,
  sizeLabel,
  colorLabel,
}: {
  /** Accessibility label + purpose of the trigger, e.g. "Text style". */
  controlLabel: string;
  /** Swatch label suffix, e.g. "text" → "Navy text" / "background". */
  swatchNoun: string;
  /** Optional leading glyph on the trigger, e.g. "Aa" for the text control. */
  glyph?: string;
  currentColor: string;
  colors: readonly Swatch[];
  onSelectColor: (value: string) => void;
  /** When present, the popover gains a Size row above the color swatches. */
  sizes?: readonly SizeOption[];
  currentSize?: number;
  onSelectSize?: (fontSize: number) => void;
  sizeLabel?: string;
  colorLabel?: string;
}) {
  const c = useColors();
  const anchorRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const rows = Math.ceil(colors.length / COLUMNS);
  const panelHeight =
    rows * CELL +
    16 +
    (sizes ? SIZE_ROW_HEIGHT + SECTION_LABEL_HEIGHT : 0);

  const show = useCallback(() => {
    anchorRef.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return;
      const { width: screenW, height: screenH } = Dimensions.get("window");
      const left = clamp(
        x + width / 2 - PANEL_WIDTH / 2,
        SCREEN_MARGIN,
        screenW - PANEL_WIDTH - SCREEN_MARGIN,
      );
      const below = y + height + ANCHOR_GAP;
      const top =
        below + panelHeight + SCREEN_MARGIN <= screenH
          ? below
          : Math.max(SCREEN_MARGIN, y - panelHeight - ANCHOR_GAP);
      setPos({ left, top });
      setOpen(true);
    });
  }, [panelHeight]);

  const pickColor = useCallback(
    (value: string) => {
      // Re-picking the current color must not spend an undo step on a no-op.
      if (value.toLowerCase() !== currentColor.toLowerCase()) onSelectColor(value);
      setOpen(false);
    },
    [onSelectColor, currentColor],
  );

  return (
    <>
      <View ref={anchorRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={controlLabel}
          accessibilityHint="Opens style options"
          hitSlop={8}
          onPress={show}
          style={({ pressed }) => [
            styles.trigger,
            { borderColor: c.border, opacity: pressed ? 0.65 : 1 },
          ]}
        >
          {glyph ? (
            <Text style={[styles.triggerGlyph, { fontFamily: fonts.semibold, color: c.fg }]}>
              {glyph}
            </Text>
          ) : null}
          <View
            style={[
              styles.triggerSwatch,
              { backgroundColor: currentColor, borderColor: c.border },
            ]}
          />
          <Text style={{ fontFamily: fonts.medium, color: c.fg }}>{controlLabel}</Text>
        </Pressable>
      </View>

      {open && (
        <Modal
          visible
          transparent
          animationType="fade"
          supportedOrientations={["landscape", "landscape-left", "landscape-right"]}
          onRequestClose={() => setOpen(false)}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)}>
            {pos && (
              <Pressable
                onPress={() => {}}
                style={[
                  styles.panel,
                  {
                    left: pos.left,
                    top: pos.top,
                    width: PANEL_WIDTH,
                    backgroundColor: c.bg,
                    borderColor: c.border,
                  },
                ]}
              >
                {sizes && onSelectSize ? (
                  <View style={styles.section}>
                    <Text style={[styles.sectionLabel, { fontFamily: fonts.semibold, color: c.fgMuted }]}>
                      {sizeLabel}
                    </Text>
                    <View style={[styles.sizeControl, { borderColor: c.border }]}>
                      {sizes.map(({ label, fontSize }, optionIndex) => {
                        const selected = currentSize === fontSize;
                        return (
                          <Pressable
                            key={fontSize}
                            accessibilityRole="button"
                            accessibilityState={{ selected }}
                            accessibilityLabel={`${label} text`}
                            onPress={() => {
                              if (!selected) onSelectSize(fontSize);
                            }}
                            style={({ pressed }) => [
                              styles.sizeButton,
                              optionIndex > 0 && { borderLeftWidth: StyleSheet.hairlineWidth },
                              {
                                borderLeftColor: c.border,
                                backgroundColor: selected ? c.cyanSubtle : "transparent",
                                opacity: pressed ? 0.65 : 1,
                              },
                            ]}
                          >
                            <Text style={[styles.sizeButtonLabel, { fontFamily: fonts.medium, color: c.fg }]}>
                              {label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                ) : null}
                {sizes ? (
                  <Text style={[styles.sectionLabel, { fontFamily: fonts.semibold, color: c.fgMuted }]}>
                    {colorLabel}
                  </Text>
                ) : null}
                <View style={styles.swatchGrid}>
                  {colors.map(({ label, value }) => {
                    const selected = value.toLowerCase() === currentColor.toLowerCase();
                    return (
                      <Pressable
                        key={value}
                        accessibilityRole="button"
                        accessibilityState={{ selected }}
                        accessibilityLabel={`${label} ${swatchNoun}`}
                        onPress={() => pickColor(value)}
                        style={styles.swatchCell}
                      >
                        <View
                          style={[
                            styles.swatchRing,
                            selected && { borderColor: c.cyan },
                          ]}
                        >
                          <View
                            style={[
                              styles.swatch,
                              { backgroundColor: value, borderColor: c.border },
                            ]}
                          />
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </Pressable>
            )}
          </Pressable>
        </Modal>
      )}
    </>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const styles = StyleSheet.create({
  trigger: {
    minWidth: 44,
    minHeight: 34,
    borderWidth: 1,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: 6,
    paddingHorizontal: 10,
  },
  triggerGlyph: { fontSize: 15 },
  triggerSwatch: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  panel: {
    position: "absolute",
    padding: 8,
    borderWidth: 1,
    borderRadius: 12,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
  },
  section: { marginBottom: 4 },
  sectionLabel: {
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    paddingHorizontal: 4,
    paddingBottom: 4,
  },
  sizeControl: {
    minHeight: 40,
    flexDirection: "row",
    borderWidth: 1,
    borderRadius: 8,
    overflow: "hidden",
  },
  sizeButton: {
    flex: 1,
    minHeight: 40,
    paddingHorizontal: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  sizeButtonLabel: { fontSize: 13 },
  swatchGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  swatchCell: {
    width: 52,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  swatchRing: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
  },
});

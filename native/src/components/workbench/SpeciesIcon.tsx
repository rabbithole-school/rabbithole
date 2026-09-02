/**
 * Charm-art plumbing for the native Workbench — the twin of the web
 * `components/workbench/SpeciesIcons.tsx`.
 *
 *  · `SpeciesIconResolvers` warms every Species slot's icon without breaking the
 *    rules-of-hooks (one `useSimulatorSpeciesIcon` call per child, so the parent's hook
 *    count never varies with slot count), reporting a `Record<label, url>` map up.
 *  · `SpeciesIconImage` paints a resolved icon (hosted URL → exact web pixels via
 *    expo-image) or, while it warms / on failure, a plain colored dot — never a
 *    gray blank (the plan's whole point, §7.4).
 */

import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import { Image } from "expo-image";

import { useSimulatorSpeciesIcon } from "./useSimulatorSpeciesIcon";

function SpeciesIconLoader({
  templateId,
  label,
  onResolve,
}: {
  templateId: string;
  label: string;
  onResolve: (label: string, url: string | undefined) => void;
}) {
  const url = useSimulatorSpeciesIcon(templateId, label);
  useEffect(() => {
    onResolve(label, url);
  }, [label, url, onResolve]);
  return null;
}

export function SpeciesIconResolvers({
  templateId,
  labels,
  onResolve,
}: {
  templateId: string;
  labels: readonly string[];
  onResolve: (label: string, url: string | undefined) => void;
}) {
  return (
    <>
      {labels.map((label) => (
        <SpeciesIconLoader key={label} templateId={templateId} label={label} onResolve={onResolve} />
      ))}
    </>
  );
}

export function SpeciesIconImage({
  icon,
  color,
  size,
}: {
  icon: string | undefined;
  color: string;
  size: number;
}) {
  if (icon) {
    return (
      <Image
        source={{ uri: icon }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        contentFit="contain"
        transition={200}
        alt=""
        aria-hidden
      />
    );
  }
  return (
    <View style={[styles.dot, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]} />
  );
}

const styles = StyleSheet.create({
  dot: {},
});

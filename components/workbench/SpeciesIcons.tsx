"use client";

/**
 * Resolves charm art for every Species slot without breaking the rules-of-hooks
 * (one `useSimulatorSpeciesIcon` call lives in its own child component, so the parent's
 * hook count never varies with slot count). The parent gets a
 * `Record<speciesLabel, iconUrl>` map to paint SpeciesCards and automata.
 */

import { memo, useEffect } from "react";

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

export const SpeciesIconResolvers = memo(function SpeciesIconResolvers({
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
        <SpeciesIconLoader
          key={label}
          templateId={templateId}
          label={label}
          onResolve={onResolve}
        />
      ))}
    </>
  );
});

"use client";

import { useEffect } from "react";

type PreferredFont = "andika" | "opendyslexic" | undefined;

const FONT_VALUES: Record<Exclude<PreferredFont, undefined>, string> = {
  andika: "'Andika', sans-serif",
  opendyslexic: "'OpenDyslexic', sans-serif",
};

export function useScholarFont(preferredFont: PreferredFont, isRemoteMode: boolean) {
  useEffect(() => {
    if (isRemoteMode) return;
    const value = preferredFont ? FONT_VALUES[preferredFont] : undefined;
    if (!value) return;
    const root = document.documentElement;
    root.style.setProperty("--chakra-fonts-body", value);
    root.style.setProperty("--chakra-fonts-heading", value);
    return () => {
      root.style.removeProperty("--chakra-fonts-body");
      root.style.removeProperty("--chakra-fonts-heading");
    };
  }, [preferredFont, isRemoteMode]);
}

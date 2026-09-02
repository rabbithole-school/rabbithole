import { Cube, LinkSimple, Target, Plant } from "@phosphor-icons/react";

export const STRAND_CONFIG = {
  core: { label: "Core", color: "orange", icon: Cube },
  connections: { label: "Connections", color: "blue", icon: LinkSimple },
  practice: { label: "Practice", color: "green", icon: Target },
  identity: { label: "Identity", color: "purple", icon: Plant },
} as const;

export type Strand = keyof typeof STRAND_CONFIG;

export const STRAND_ORDER: Strand[] = ["core", "connections", "practice", "identity"];

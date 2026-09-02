/**
 * Canonical knowledge-node source classification shared by graph lanes.
 *
 * Sky sources are registry-owned concepts, tree sources are procedural or
 * curated skills, and world is the durable far end of a story bridge. All
 * three participate in the atlas projection.
 */

export const SKY_SOURCES = ["standard", "seed", "mastery"] as const;
export const TREE_SOURCES = ["practice", "curated"] as const;
export const WORLD_SOURCES = ["world"] as const;
export const ATLAS_SOURCES = [
  ...SKY_SOURCES,
  ...TREE_SOURCES,
  ...WORLD_SOURCES,
] as const;

const SKY_SOURCE_SET = new Set<string>(SKY_SOURCES);
const TREE_SOURCE_SET = new Set<string>(TREE_SOURCES);
const WORLD_SOURCE_SET = new Set<string>(WORLD_SOURCES);
const ATLAS_SOURCE_SET = new Set<string>(ATLAS_SOURCES);

export function isSkySource(source?: string | null): boolean {
  return source !== undefined && source !== null && SKY_SOURCE_SET.has(source);
}

export function isTreeSource(source?: string | null): boolean {
  return source !== undefined && source !== null && TREE_SOURCE_SET.has(source);
}

export function isWorldSource(source?: string | null): boolean {
  return source !== undefined && source !== null && WORLD_SOURCE_SET.has(source);
}

export function isAtlasSource(source?: string | null): boolean {
  return source !== undefined && source !== null && ATLAS_SOURCE_SET.has(source);
}

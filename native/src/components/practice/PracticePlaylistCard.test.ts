import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: () => null,
  ScrollView: () => null,
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: () => null,
  View: () => null,
}));
vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: false }),
  useMutation: () => vi.fn(),
  useQuery: () => undefined,
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: () => Promise.resolve() }));
vi.mock("@/lib/convex", () => ({ api: {} }));
vi.mock("@/components/HomeSection", () => ({ HomeSection: () => null }));
// Stubbed like every other UI import here: the real Skeleton pulls in
// react-native-reanimated for `useReducedMotion`, and reanimated's ESM entry
// uses a directory import Vitest's resolver rejects. This suite only exercises
// the pure `pendingHighlightMatch` helper, so the loading placeholder is noise.
vi.mock("@/components/ui/Skeleton", () => ({ Skeleton: () => null }));
vi.mock("./PlaylistTileIcons", () => ({
  CheckpointFlagIcon: () => null,
  PLAYLIST_TILE_ICONS: {},
}));
vi.mock("./DomainSwitcherSheet", () => ({
  ChevronDownIcon: () => null,
  DomainSwitcherSheet: () => null,
}));
vi.mock("@/theme", () => ({
  fonts: {},
  useColors: () => ({}),
}));
vi.mock("@/hooks/useInstitutionDay", () => ({
  useInstitutionDay: () => undefined,
}));

import { pendingHighlightMatch } from "./PracticePlaylistCard";

describe("PracticePlaylistCard pending highlight", () => {
  it("does not apply a delayed match after a manual chooser selection consumes it", () => {
    const fraction = { domain: "fraction-arithmetic" };
    const probability = { domain: "probability" };
    const highlightDomain = "probability";

    expect(pendingHighlightMatch(highlightDomain, null, [fraction])).toBeUndefined();

    // Any manual domain, strand, check-in, or Stretch selection stores this
    // pending value before its requested tile reaches the subscription.
    const consumedByManualChoice = highlightDomain;
    expect(
      pendingHighlightMatch(highlightDomain, consumedByManualChoice, [fraction, probability]),
    ).toBeUndefined();

    // Without that manual interaction, the same late result still auto-selects.
    expect(pendingHighlightMatch(highlightDomain, null, [fraction, probability])).toBe(probability);
  });
});

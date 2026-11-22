import { ViewToggle } from "@/components/ui/ViewToggle";

export type SlidesViewMode = "grid" | "slide";

const SLIDES_VIEWS = [
  { value: "grid", label: "Grid" },
  { value: "slide", label: "Slide" },
] as const;

export function SlidesViewToggleNative({
  value,
  onChange,
}: {
  value: SlidesViewMode;
  onChange: (value: SlidesViewMode) => void;
}) {
  return <ViewToggle options={SLIDES_VIEWS} value={value} onChange={onChange} />;
}

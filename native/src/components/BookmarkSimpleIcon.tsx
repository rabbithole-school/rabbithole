import Svg, { Path } from "react-native-svg";

export function BookmarkSimpleIcon({
  size = 20,
  color,
  filled = false,
}: {
  size?: number;
  color: string;
  filled?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 256 256" accessible={false}>
      <Path
        d="M216 32H80a16 16 0 0 0-16 16v168a8 8 0 0 0 12.24 6.78L148 177.31l71.76 45.47A8 8 0 0 0 232 216V48a16 16 0 0 0-16-16Z"
        fill={filled ? color : "none"}
        stroke={color}
        strokeWidth={filled ? 0 : 16}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

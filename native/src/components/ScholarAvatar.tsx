import { Image } from "expo-image";
import { useState } from "react";
import { Text, View } from "react-native";

import { fonts, palette, useColors } from "@/theme";

export function ScholarAvatar({
  name,
  image,
  size,
}: {
  name: string;
  image: string | null;
  size: number;
}) {
  const colors = useColors();
  // expo-image draws nothing when a photo fails to load (an expired Google
  // photo URL, an unreachable host, no network), which left a blank circle.
  // Remember which URL failed and fall back to initials; a new URL retries.
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("");

  if (image && image !== failedImage) {
    return (
      <Image
        source={{ uri: image }}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        contentFit="cover"
        alt={`${name}'s profile photo`}
        onError={() => setFailedImage(image)}
      />
    );
  }

  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: palette.violet[500],
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text
        style={{
          color: colors.white,
          fontFamily: fonts.bold,
          fontSize: size * 0.4,
        }}
      >
        {initials}
      </Text>
    </View>
  );
}

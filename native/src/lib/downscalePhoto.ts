import { FilterMode, ImageFormat, MipmapMode, Skia } from "@shopify/react-native-skia";
import { cacheDirectory, EncodingType, writeAsStringAsync } from "expo-file-system/legacy";

import {
  decodedSideways,
  DOWNSCALED_JPEG_QUALITY,
  downscaleTarget,
} from "../../vendor/shared/imageDownscale";

export type PickedPhoto = {
  uri: string;
  mimeType: string;
  /** The size expo-image-picker reports, which is the size as displayed. */
  width?: number;
  height?: number;
};

/**
 * Shrink a picked photo to the long edge the tutor model can actually use
 * (`MODEL_IMAGE_MAX_EDGE_PX`) before it is uploaded. Returns the photo to
 * upload: a new JPEG (or PNG, for a PNG) in the cache directory, or the
 * original when it already fits.
 *
 * Skia rather than expo-image-manipulator: Skia is already compiled into the
 * dev client and the fleet build, so this ships as JS alone, with no new native
 * module and no dev-client rebuild.
 *
 * Orientation: expo-image-picker re-encodes a JPEG with its rotation already
 * applied to the pixels, so there is no EXIF orientation left to honour. As a
 * guard against ever baking a photo in sideways, a decode whose orientation
 * disagrees with the picker's reported size is uploaded untouched.
 *
 * Metadata: Skia's encoder writes no EXIF, so a resized photo carries no
 * location data.
 *
 * Never loses the photo: any failure logs and returns the original.
 */
export async function downscalePhotoForUpload(photo: PickedPhoto): Promise<PickedPhoto> {
  // An animated GIF would flatten to one frame.
  if (photo.mimeType === "image/gif") return photo;
  try {
    const data = await Skia.Data.fromURI(photo.uri);
    const image = Skia.Image.MakeImageFromEncoded(data);
    if (!image) {
      console.warn("[image] downscale: couldn't decode, uploading the original");
      return photo;
    }
    const decoded = { width: image.width(), height: image.height() };
    if (
      photo.width &&
      photo.height &&
      decodedSideways(decoded, { width: photo.width, height: photo.height })
    ) {
      console.warn("[image] downscale: decode is sideways, uploading the original");
      return photo;
    }
    const target = downscaleTarget(decoded);
    if (!target) return photo;

    const surface = Skia.Surface.Make(target.width, target.height);
    if (!surface) {
      console.warn("[image] downscale: no surface, uploading the original");
      return photo;
    }
    surface
      .getCanvas()
      .drawImageRectOptions(
        image,
        Skia.XYWHRect(0, 0, decoded.width, decoded.height),
        Skia.XYWHRect(0, 0, target.width, target.height),
        FilterMode.Linear,
        MipmapMode.Linear,
      );
    surface.flush();
    const isPng = photo.mimeType === "image/png";
    const base64 = surface
      .makeImageSnapshot()
      .encodeToBase64(
        isPng ? ImageFormat.PNG : ImageFormat.JPEG,
        Math.round(DOWNSCALED_JPEG_QUALITY * 100),
      );
    if (!base64) throw new Error("encode returned nothing");
    if (!cacheDirectory) throw new Error("no cache directory");

    const uri =
      `${cacheDirectory}photo-${Date.now()}-` +
      `${Math.random().toString(36).slice(2)}.${isPng ? "png" : "jpg"}`;
    await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
    return {
      uri,
      mimeType: isPng ? "image/png" : "image/jpeg",
      width: target.width,
      height: target.height,
    };
  } catch (error) {
    console.warn("[image] downscale failed, uploading the original", error);
    return photo;
  }
}

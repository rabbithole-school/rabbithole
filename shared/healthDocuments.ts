export const HEALTH_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
export const HEALTH_DOCUMENT_MAX_IMAGE_PAGES = 20;
export const HEALTH_DOCUMENT_ACCEPT =
  "application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png";
export const HEALTH_DOCUMENT_CAMERA_ACCEPT = "image/jpeg,image/png";

export const healthDocumentContentTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
] as const;

export type HealthDocumentContentType =
  (typeof healthDocumentContentTypes)[number];

export type HealthDocumentFileDescriptor = {
  name: string;
  type: string;
  size: number;
};

export function validateHealthDocumentFile(
  file: HealthDocumentFileDescriptor,
): string | null {
  if (file.size <= 0) return "Choose a non-empty file.";
  if (file.size > HEALTH_DOCUMENT_MAX_BYTES) {
    return "File must be 10 MB or smaller.";
  }
  if (
    !healthDocumentContentTypes.includes(
      file.type as HealthDocumentContentType,
    )
  ) {
    return "Choose a PDF, JPEG, or PNG file.";
  }
  const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const validExtension =
    (file.type === "application/pdf" && extension === "pdf") ||
    (file.type === "image/jpeg" &&
      (extension === "jpg" || extension === "jpeg")) ||
    (file.type === "image/png" && extension === "png");
  return validExtension
    ? null
    : "The filename extension must match the selected file type.";
}

export function safeHealthDocumentFileName(value: string): string {
  const baseName = value.split(/[\\/]/).at(-1)?.trim() ?? "";
  return baseName.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
}

export type HealthDocumentSelectionSource = "camera" | "file";

export type HealthDocumentSelectionResult<
  FileLike extends HealthDocumentFileDescriptor,
> = {
  files: readonly FileLike[];
  error: string | null;
  changed: boolean;
};

function isImage(file: HealthDocumentFileDescriptor): boolean {
  return file.type === "image/jpeg" || file.type === "image/png";
}

export function selectHealthDocumentFiles<
  FileLike extends HealthDocumentFileDescriptor,
>(
  current: readonly FileLike[],
  incoming: readonly FileLike[],
  source: HealthDocumentSelectionSource,
): HealthDocumentSelectionResult<FileLike> {
  if (incoming.length === 0) {
    return { files: current, error: null, changed: false };
  }
  if (source === "camera" && incoming.length !== 1) {
    return {
      files: current,
      error: "Take one photo at a time.",
      changed: false,
    };
  }

  for (const file of incoming) {
    const error = validateHealthDocumentFile(file);
    if (error) return { files: current, error, changed: false };
    if (source === "camera" && !isImage(file)) {
      return {
        files: current,
        error: "Take a photo in JPEG or PNG format.",
        changed: false,
      };
    }
  }

  if (source === "camera" && current.some((file) => !isImage(file))) {
    return {
      files: current,
      error: "Remove the selected PDF before adding photographed pages.",
      changed: false,
    };
  }

  const next = source === "camera" ? [...current, ...incoming] : [...incoming];
  const hasPdf = next.some((file) => file.type === "application/pdf");
  if (hasPdf && next.length > 1) {
    return {
      files: current,
      error: "Choose one PDF or one or more JPEG or PNG images.",
      changed: false,
    };
  }
  if (next.length > HEALTH_DOCUMENT_MAX_IMAGE_PAGES) {
    return {
      files: current,
      error: `Choose no more than ${HEALTH_DOCUMENT_MAX_IMAGE_PAGES} image pages.`,
      changed: false,
    };
  }
  if (
    next.length > 1 &&
    next.reduce((total, file) => total + file.size, 0) >
      HEALTH_DOCUMENT_MAX_BYTES
  ) {
    return {
      files: current,
      error: "Combined image pages must be 10 MB or smaller.",
      changed: false,
    };
  }

  return { files: next, error: null, changed: true };
}

export function removeHealthDocumentFile<
  FileLike extends HealthDocumentFileDescriptor,
>(files: readonly FileLike[], index: number): readonly FileLike[] {
  return files.filter((_, fileIndex) => fileIndex !== index);
}

// Parse a Google Drive folder ID out of whatever an admin pastes into the
// drive-sync connect field. People paste the whole address-bar URL far more
// often than the bare ID, so accept both (and a couple of URL shapes) instead
// of silently trying to register a garbage "folderId".
//
// Recognized inputs:
//   1tgK5CjC6AtUOe3N-WIzUMPNY4w1kKW0u                         (bare id)
//   https://drive.google.com/drive/folders/<id>              (folder view)
//   https://drive.google.com/drive/u/0/folders/<id>?usp=...  (account-scoped)
//   https://drive.google.com/open?id=<id>                    (open link)

/** Drive resource ids are URL-safe base64-ish tokens, always ≥ 10 chars. */
const ID_RE = /^[a-zA-Z0-9_-]{10,}$/;

/**
 * Extract a Drive folder ID from a pasted string, or null if none is found.
 * Trims surrounding whitespace; tolerant of full URLs and query strings.
 */
export function extractDriveFolderId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // A bare id (no scheme, no slashes) — accept as-is if it looks like an id.
  if (!raw.includes("/") && !raw.includes("?")) {
    return ID_RE.test(raw) ? raw : null;
  }

  // …/folders/<id>[/…|?…] — the common "open the folder, copy the URL" case.
  const folders = raw.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folders) return folders[1];

  // open?id=<id> or any ?id=/&id=<id> form.
  const idParam = raw.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (idParam) return idParam[1];

  return null;
}

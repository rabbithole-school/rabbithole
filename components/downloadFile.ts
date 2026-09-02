// Client-side "save this in-memory payload as a file" helper.
//
// The Blob + object-URL + click + revoke idiom was inlined four times (the
// parents directory, the devices page, and the forms dashboard). Two of those
// copies revoked the object URL SYNCHRONOUSLY after
// .click(), which can race the browser's download start; deferring the revoke
// by a tick is the version that does not. One copy, correct.
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

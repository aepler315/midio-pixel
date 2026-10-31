/** Android's older Chromium directory chooser could not select folders (and
 *  Chrome 131 could crash). WebViews also depend on their host implementing
 *  folder selection. Use their ordinary multi-file picker instead; its files
 *  are still usable in the library for this visit. */
export function folderPickerMode({ userAgent = '' } = {}) {
  const ua = String(userAgent);
  if (!/\bAndroid\b/i.test(ua)) return 'directory';
  if (/;\s*wv\s*[;)]/i.test(ua)) return 'files';
  const chrome = /(?:Chrome|Chromium)\/(\d+)/i.exec(ua);
  return !chrome || Number(chrome[1]) < 132 ? 'files' : 'directory';
}

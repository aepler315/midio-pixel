/** Keep native File methods in the host's live realm. A File wrapper owned by
 * an unloaded iframe can leave arrayBuffer() pending forever. Blob parts share
 * their immutable bytes, so this does not re-encode or duplicate the song. */
export function retainHistorySource(source) {
  if (source?.kind !== 'audio-files') return source ? { ...source } : null;
  return { ...source, files: [...source.files].map(file => new File([file], file.name, { type: file.type, lastModified: file.lastModified })) };
}

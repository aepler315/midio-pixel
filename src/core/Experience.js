export const EXPERIENCE_KEY = 'midio-pixel:experience:v1';
export function resolveExperience(value) { return value === 'trio' ? 'trio' : 'landscape'; }
export function readExperience(storage, search = '') {
  try {
    const query = new URLSearchParams(search);
    return resolveExperience(query.has('experience') ? query.get('experience') : storage?.getItem(EXPERIENCE_KEY));
  } catch { return 'landscape'; }
}
export function writeExperience(storage, value) {
  try { storage?.setItem(EXPERIENCE_KEY, resolveExperience(value)); } catch { /* blocked storage keeps this session's choice */ }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { hash } from './io.mjs';
export async function verifiedImage(dir, frame) {
  assert.ok(typeof frame.png === 'string' && /^[a-z0-9-]+\.png$/.test(frame.png), 'unsafe frame path');
  const bytes = await fs.readFile(path.join(dir, frame.png));
  assert.equal(hash(bytes), frame.sha256, `PNG checksum mismatch: ${frame.id}`);
  const image = PNG.sync.read(bytes, { checkCRC: true });
  assert.ok(image.width === frame.width && image.height === frame.height, 'PNG dimensions disagree with evidence');
  return image;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { folderPickerMode } from '../src/library/FolderPickerMode.js';

test('older Android Chromium and Android WebViews use the working multi-file chooser', () => {
  assert.equal(folderPickerMode({ userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/110.0.0.0 Mobile Safari/537.36' }), 'files');
  assert.equal(folderPickerMode({ userAgent: 'Mozilla/5.0 (Linux; Android 13; wv) AppleWebKit/537.36 Chrome/145.0.0.0 Mobile Safari/537.36' }), 'files');
});

test('desktop and modern Android Chromium retain the directory chooser', () => {
  assert.equal(folderPickerMode({ userAgent: 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/132.0.0.0 Mobile Safari/537.36' }), 'directory');
  assert.equal(folderPickerMode({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/110.0.0.0 Safari/537.36' }), 'directory');
});

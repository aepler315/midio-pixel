import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { writePlexPublicConfig } from './write-plex-public-config.mjs';

const REQUIRED = ['index.html', 'src/main.js', 'soundfonts'];

function overlaps(a, b) {
  const rel = path.relative(a, b);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..');
}

async function canonicalPath(target) {
  const missing = [];
  let cursor = target;
  for (;;) {
    try {
      const real = await fs.realpath(cursor);
      return path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return target;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// These paths and import references positively identify a Range-enabled tree,
// including a partial copy with missing metadata. Check source and output.
const RANGE_FOOTPRINT = [
  'src/vendor/range', 'src/world/alpine/RangePresentation.js',
  'src/world/alpine/RangeScene.js', 'src/world/terrain/sceneCatalogData.js',
  'src/assets/range/v2',
];

async function exists(target) {
  try { await fs.lstat(target); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function hasRangeReference(directory) {
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory() && await hasRangeReference(target)) return true;
    if (entry.isFile() && /\.m?js$/.test(entry.name)
      && /vendor\/range\/|RangePresentation|sceneCatalogData/.test(await fs.readFile(target, 'utf8'))) return true;
  }
  return false;
}

async function hasRangeFootprint(root) {
  for (const relative of RANGE_FOOTPRINT) if (await exists(path.join(root, relative))) return true;
  return hasRangeReference(path.join(root, 'src'));
}

// Public renderer subset used by the Range v2 modules.
const RANGE_RUNTIME_EXPORTS = [
  'WebGLRenderer', 'WebGLRenderTarget', 'DepthTexture', 'Scene', 'Group',
  'Mesh', 'InstancedMesh', 'Points', 'LineSegments', 'PerspectiveCamera',
  'OrthographicCamera', 'BufferGeometry', 'BufferAttribute', 'InstancedBufferGeometry', 'InstancedBufferAttribute',
  'Float32BufferAttribute', 'Uint32BufferAttribute', 'ShaderMaterial', 'RawShaderMaterial', 'MeshBasicMaterial',
  'DataTexture', 'Texture', 'CanvasTexture', 'Color', 'Vector2',
  'Vector3', 'Vector4', 'Matrix4', 'Matrix3', 'Quaternion',
  'Box3', 'Sphere', 'Frustum', 'GLSL3', 'RGBAFormat',
  'RedFormat', 'RGFormat', 'UnsignedByteType', 'FloatType', 'HalfFloatType',
  'UnsignedIntType', 'LinearFilter', 'LinearMipmapLinearFilter', 'NearestFilter', 'RepeatWrapping',
  'ClampToEdgeWrapping', 'MirroredRepeatWrapping', 'SRGBColorSpace', 'LinearSRGBColorSpace', 'NoColorSpace',
  'FrontSide', 'BackSide', 'DoubleSide', 'NoBlending', 'NormalBlending',
  'AdditiveBlending', 'CustomBlending', 'OneFactor', 'ZeroFactor', 'OneMinusSrcAlphaFactor',
  'SrcAlphaFactor', 'AddEquation', 'LessEqualDepth', 'EqualDepth', 'AlwaysDepth',
  'NoToneMapping', 'DynamicDrawUsage', 'REVISION',
];

function validateRuntimeMetadata(runtime) {
  const fail = detail => { throw new Error(`unsupported Range runtime.json metadata: ${detail}`); };
  // The committed contract is unversioned, with tool versions and file records.
  // Unknown versioned schemas must be reviewed rather than accepted implicitly.
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)
    || Object.hasOwn(runtime, 'schema') || Object.hasOwn(runtime, 'schemaVersion')
    || Object.hasOwn(runtime, 'version')) fail('schema');
  for (const key of ['three', 'esbuild']) {
    if (typeof runtime[key] !== 'string' || !/^\d+\.\d+\.\d+$/.test(runtime[key])) fail(key);
  }
  if (!runtime.files || typeof runtime.files !== 'object' || Array.isArray(runtime.files)) fail('files must be an object');
  for (const name of ['three-range.module.js', 'LICENSE-three.txt']) {
    if (!Object.hasOwn(runtime.files, name)) fail(`missing files.${name}`);
  }
  for (const [name, record] of Object.entries(runtime.files)) {
    if (path.basename(name) !== name || name === '.' || name === '..' || name.includes('\\')
      || !record || !Number.isSafeInteger(record.bytes) || record.bytes <= 0
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(record.sha256)) fail(`files.${name}`);
  }
}

/**
 * Range v2 delivery checks on a staged tree: the local renderer bundle must
 * be exactly what tools/build-range-runtime.mjs builds from the locked
 * dependencies (rebuilt here when they are installed), and every view in
 * the runtime scene catalog must ship its real terrain manifest and payload
 * with the hashes the catalog and manifest declare -- no LFS pointers, no
 * unresolved slots. Skipped for trees that carry no Range v2 runtime.
 */
/** A gzip payload must match its compressed pin and, once decoded, its
 *  decoded pin: the runtime checks both, so a stage that checked only the
 *  first could ship a package every client then refuses. */
async function verifyPinnedPayload(label, dir, pin) {
  const compressed = await fs.readFile(path.join(dir, pin.url));
  if (compressed.byteLength !== pin.byteLength || sha256(compressed) !== pin.sha256) {
    throw new Error(`${label} does not match its manifest`);
  }
  let decoded;
  try { decoded = gunzipSync(compressed); } catch (error) {
    throw new Error(`${label} does not decode: ${error.message}`, { cause: error });
  }
  if (decoded.byteLength !== pin.decodedByteLength || sha256(decoded) !== pin.decodedSha256) {
    throw new Error(`${label} decoded bytes do not match decodedByteLength/decodedSha256`);
  }
}

export async function verifyRangeRuntime(sourceDir, outputDir) {
  const vendor = path.join(outputDir, 'src', 'vendor', 'range');
  let runtime;
  try { runtime = JSON.parse(await fs.readFile(path.join(vendor, 'runtime.json'), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT' && !await hasRangeFootprint(sourceDir) && !await hasRangeFootprint(outputDir)) return { checked: false };
    throw new Error(`Range runtime requires readable, parseable runtime.json: ${error.message}`, { cause: error });
  }
  validateRuntimeMetadata(runtime);
  for (const [name, want] of Object.entries(runtime.files)) {
    const buf = await fs.readFile(path.join(vendor, name));
    if (buf.byteLength !== want.bytes || sha256(buf) !== want.sha256) throw new Error(`staged src/vendor/range/${name} does not match runtime.json`);
  }
  let runtimeModule;
  try {
    runtimeModule = await import(`${pathToFileURL(path.join(vendor, 'three-range.module.js')).href}?stage=${randomUUID()}`);
  } catch (error) {
    throw new Error(`Range runtime bundle cannot be loaded for required exports: ${error.message}`, { cause: error });
  }
  const classNames = new Set(RANGE_RUNTIME_EXPORTS.slice(0, RANGE_RUNTIME_EXPORTS.indexOf('GLSL3')));
  const missingExports = RANGE_RUNTIME_EXPORTS.filter(name => !Object.hasOwn(runtimeModule, name)
    || runtimeModule[name] === undefined || (classNames.has(name) && typeof runtimeModule[name] !== 'function'));
  if (missingExports.length) throw new Error(`Range runtime bundle is missing required exports: ${missingExports.join(', ')}`);

  // Rebuild the bundle from the installed Three.js and compare it with the
  // committed one. Only a checkout without dependencies skips this (it
  // cannot build); any build failure or mismatch fails staging.
  let rebuilt = false;
  let installed = true;
  try { await fs.access(path.join(sourceDir, 'node_modules', 'three', 'package.json')); } catch { installed = false; }
  if (installed) {
    const { buildRangeRuntime } = await import(pathToFileURL(path.join(sourceDir, 'tools', 'build-range-runtime.mjs')).href);
    const { code } = await buildRangeRuntime();
    if (sha256(code) !== runtime.files['three-range.module.js'].sha256) {
      throw new Error('committed Range runtime bundle is stale; run node tools/build-range-runtime.mjs');
    }
    rebuilt = true;
  }
  const catalogPath = path.join(outputDir, 'src', 'world', 'terrain', 'sceneCatalogData.js');
  const views = [];
  // A Range-enabled build (runtime.json exists) imports the catalog in its
  // module graph: a missing catalog is a broken site, not a skipped check.
  let catalog;
  try { ({ default: catalog } = await import(`${pathToFileURL(catalogPath).href}?stage=${randomUUID()}`)); } catch (err) {
    throw new Error(`Range runtime is staged but its scene catalog cannot be loaded: ${err.message}`, { cause: err });
  }
  {
    const root = path.join(outputDir, 'src', 'assets', 'range', 'v2');
    for (const view of catalog.views) {
      const manifestBuf = await fs.readFile(path.join(root, view.terrainManifestUrl));
      if (manifestBuf.subarray(0, 40).toString().startsWith('version https://git-lfs')) throw new Error(`${view.id} manifest is an LFS pointer`);
      if (view.terrainManifestSha256 && sha256(manifestBuf) !== view.terrainManifestSha256) throw new Error(`${view.id} manifest hash differs from the catalog`);
      const manifest = JSON.parse(manifestBuf.toString('utf8'));
      // The same identity gate the runtime applies (RangeAssets.js).
      if (manifest.viewId !== (view.terrainSourceId || view.id)) {
        throw new Error(`${view.id} manifest is for ${manifest.viewId}, not ${view.terrainSourceId || view.id}`);
      }
      await verifyPinnedPayload(`${view.id} terrain payload`, path.join(root, path.dirname(view.terrainManifestUrl)), manifest.payload);
      // A tour view also ships its pinned camera-tour package; the runtime
      // loads it with expectManifestSha256 and terrainViewId: view.id.
      if (view.tourManifestUrl) {
        const tourBuf = await fs.readFile(path.join(root, view.tourManifestUrl));
        if (sha256(tourBuf) !== view.tourManifestSha256) throw new Error(`${view.id} tour manifest hash differs from the catalog`);
        const tour = JSON.parse(tourBuf.toString('utf8'));
        if (tour.terrainViewId !== view.id) throw new Error(`${view.id} tour is for terrain ${tour.terrainViewId}`);
        await verifyPinnedPayload(`${view.id} tour payload`, path.join(root, path.dirname(view.tourManifestUrl)), tour.payload);
      }
      // The view's material pack and every data texture it names.
      const matBuf = await fs.readFile(path.join(root, view.materialManifestUrl));
      if (view.materialManifestSha256 && sha256(matBuf) !== view.materialManifestSha256) throw new Error(`${view.id} material manifest hash differs from the catalog`);
      const mat = JSON.parse(matBuf.toString('utf8'));
      for (const t of Object.values(mat.textures || {})) {
        const tex = await fs.readFile(path.join(root, path.dirname(view.materialManifestUrl), t.url));
        if (tex.byteLength !== t.bytes || sha256(tex) !== t.sha256) throw new Error(`${view.id} material texture ${t.id} does not match its pack`);
      }
      views.push(view.id);
    }
  }
  return { checked: true, rebuilt, views };
}

export async function assertStagePaths(sourceDir, outputDir) {
  const source = path.resolve(sourceDir);
  const output = path.resolve(outputDir);
  const [canonicalSource, canonicalOutput] = await Promise.all([
    canonicalPath(source), canonicalPath(output),
  ]);
  if (overlaps(canonicalOutput, canonicalSource)) {
    throw new Error('Stage output must be separate from the source directory.');
  }
  // In-tree staging is intentionally limited to the repository's dedicated
  // artifact directory. Accepting an arbitrary descendant (notably `src` or
  // `soundfonts`) makes the cleanup below a source-code deletion primitive.
  if (overlaps(canonicalSource, canonicalOutput)
    && path.relative(canonicalSource, canonicalOutput) !== '_site') {
    throw new Error('Stage output inside the source must be its dedicated _site directory.');
  }
  return { source, output };
}

/** The commit a staged site was built from: given by the publisher, else
 *  the source checkout's HEAD, else unknown (a copied tree). */
function sourceCommit(source, commit) {
  if (commit) return commit;
  // An inherited GIT_DIR (Git exports it to hooks) would name the outer
  // repository's HEAD for a copied tree; ask only the tree itself.
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name];
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export async function stageSite(sourceDir, outputDir, { commit = null, ref = null } = {}) {
  const { source, output } = await assertStagePaths(sourceDir, outputDir);
  for (const required of REQUIRED) {
    try { await fs.access(path.join(source, required)); }
    catch { throw new Error(`Missing required runtime input: ${required}`); }
  }

  await fs.rm(output, { recursive: true, force: true });
  await fs.mkdir(output, { recursive: true });
  await Promise.all([
    fs.copyFile(path.join(source, 'index.html'), path.join(output, 'index.html')),
    // The custom domain, and the licence and attribution notices that must
    // travel with the published code and data.
    ...['CNAME', 'LICENSE', 'NOTICE'].map(name => exists(path.join(source, name)).then(present => present
      ? fs.copyFile(path.join(source, name), path.join(output, name)) : undefined)),
    fs.cp(path.join(source, 'src'), path.join(output, 'src'), { recursive: true }),
    fs.cp(path.join(source, 'soundfonts'), path.join(output, 'soundfonts'), { recursive: true }),
    fs.writeFile(path.join(output, '.nojekyll'), ''),
  ]);
  await writePlexPublicConfig(path.join(output, 'src/config/plex.json'), {
    apiBase: process.env.MIDIO_PLEX_PUBLIC_API_BASE || '',
  });
  await verifyRangeRuntime(source, output);
  // What is live: https://supermaudio.com/version.json names the commit.
  await fs.writeFile(path.join(output, 'version.json'),
    `${JSON.stringify({ commit: sourceCommit(source, commit), ref })}\n`);
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const source = process.argv[2] || '.';
  const output = process.argv[3] || '_site';
  stageSite(source, output).then((dir) => console.log(`Staged site at ${dir}`)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

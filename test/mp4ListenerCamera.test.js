import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { RangeUserCamera } from '../src/world/alpine/RangeCamera.js';
import { normalizeCameraStudioSettings } from '../src/world/alpine/CameraStudio.js';
import { VideoExportSession, waitForExport } from '../src/ui/VideoExportSession.js';

const main = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
function source(name) {
  const start = main.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  return main.slice(start, main.indexOf('\n}\n', start) + 3);
}

// Run the production export transaction and arming function. Renderer/codec
// boundaries are replaced; the listener camera and export session are real.
for (const outcome of ['complete', 'cancelled', 'error']) {
  test(`MP4 ${outcome} preserves an off-centre, partially eased listener zoom`, async () => {
    const camera = new RangeUserCamera({ now: () => 100 });
    camera.zoomAt(2, 0.4, -0.3);
    camera.sample(0);
    camera.zoomAt(1.3, -0.2, 0.1);
    const framing = () => ({ target: { ...camera.target }, current: { ...camera.current }, userScale: camera.userScale });
    const before = framing();
    const element = () => ({ hidden: false, classList: { contains: () => true, add() {} }, click() {} });
    const session = new VideoExportSession();
    let exported = false, restored = false;
    const context = vm.createContext({
      videoExportSession: session, reelSaver: { busy: false }, snapshotBusy: false,
      bulkExportArmed: false, bulkExportSize: null, bulkPresentation: null,
      lastAudioBuffer: { duration: 12 }, lastTimelineData: { worldId: 'range' }, loadGen: 1,
      videoStatus: {}, videoDownload: element(), videoDownloadUrl: null,
      videoOutputSettings: () => ({ width: 640, height: 360, fps: 30 }),
      cameraStudioSettings: normalizeCameraStudioSettings({ enabled: true }), normalizeCameraStudioSettings,
      effectivePresentation: () => ({}), renderQualityLevel: () => 0, generalQuality: 'high',
      mp4ExportFileName: () => 'test.mp4', sessionSongName: () => 'test', lastSongName: 'test',
      window: {}, continuousPlayback: { cancel() {} }, waitForExport, DOMException,
      estimateMp4ExportBytes: () => 1, MAX_MP4_BUFFER_BYTES: 512 * 1024 * 1024,
      checkMp4ExportSupport: async () => {}, fullAnalysisPending: null,
      captureTourTerrainState: () => null, lastStartExtra: {}, lastSongSeed: 315,
      cameraRun: null, activeCameraSchedule: null, currentCameraTourMode: () => 'off',
      paused: true, running: true, audioEngine: { nowMs: 5000, ctx: { state: 'suspended', suspend: async () => {} }, master: { gain: { value: 1 } } },
      loaderEl: element(), hudEl: element(), rangeNavigationEl: element(), renderer: { hudInFrame: false },
      rangePresentation: null, renderReadyPromise: Promise.resolve(), syncKeepAwake() {}, syncCameraStudio() {}, updatePauseButtonUI() {},
      cameraScheduleKey: () => 'test', evenExportSize: ({ w, h }) => ({ w, h }),
      resolvePresentation: value => value, resolveDisplayPrefs: ({ saved }) => saved,
      perfGovernor: null, perfStartLevel: 0, lastFitDiagnostic: null, canvas: { width: 1280, height: 720 },
      conductor: { durationMs: 12000 }, sim: {}, rangeUserCamera: camera,
      startTimeline(data, options) {
        // The same boundary used by startTimeline for new/replayed songs.
        if (!options.keepUserCamera) camera.reset();
        context.bulkExportArmed = !!options.exportMode;
        context.sim = { songSeed: 315, worldId: data.worldId };
        if (options.exportMode) Object.assign(context.canvas, { width: options.exportSize.w, height: options.exportSize.h });
        else restored = true;
      },
      endReelRender() { context.bulkExportArmed = false; },
      exportMp4: async (options) => {
        exported = true;
        assert.deepEqual(framing(), before, 'arming export must not erase the listener camera');
        if (outcome === 'cancelled') { session.cancel(); await waitForExport(Promise.resolve(), options.signal); }
        if (outcome === 'error') throw Error('encoder failed');
        return { width: 640, height: 360, fps: 30, frames: 360, bytes: 100 };
      },
      formatBytes: () => '100 B', console,
    });
    vm.runInContext(source('beginBulkExport') + '\nasync ' + source('renderSongMp4'), context);
    await context.renderSongMp4();
    assert.equal(exported, true);
    assert.equal(restored, true, context.videoStatus.textContent);
    assert.equal(session.state.phase, outcome, context.videoStatus.textContent);
    assert.deepEqual(framing(), before);
  });
}

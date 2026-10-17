/** The checkbox is a request. Activity comes from the presentation that
 *  actually selected a prepared tour view for the current song's frame. */
export function rangeTourControlState(range, { running = false, worldKind = null, paused = false } = {}) {
  const result = (state, text, reason = null) => ({ state, text, reason });
  if (range?.tourMode !== 'tetons') return result('off', 'Off');
  if (!running) return result('ready', 'Ready — start a song in The Range.');
  if (worldKind !== 'alpine') return result('unavailable', 'Unavailable — choose The Range to use this tour.', 'world-not-alpine');

  const preparation = range.tourPreparation || {};
  const reason = preparation.state === 'failed' ? preparation.reason : range.fallbackReason;
  const unavailable = preparation.state === 'failed' || range.runtime === 'failed'
    || /^(context-lost|budget:|unknown-view:)/.test(reason || '')
    || (reason && !['not-started', 'runtime-loading', 'preparing', 'no-frame-inputs'].includes(reason));
  if (unavailable) {
    let detail;
    if (/context-lost/.test(reason || '')) detail = 'graphics context lost; waiting to recover.';
    else if (/budget|memory|room|reservation/i.test(reason || '')) detail = 'not enough graphics memory; try Economy quality.';
    else if (/WebGL2/i.test(reason || '')) detail = 'WebGL2 is unavailable in this browser.';
    else if (/runtime-unavailable/.test(reason || '')) detail = 'graphics files could not load; try reloading.';
    else if (/HTTP \d+/.test(reason || '')) detail = `tour files could not load (${reason.match(/HTTP \d+/)[0]}).`;
    else if (/hash|decode|manifest/i.test(reason || '')) detail = 'tour files could not be read; try reloading.';
    else if (/unknown-view|not available in this version/.test(reason || '')) detail = 'the Teton tour is missing from this version.';
    else detail = reason || 'the Teton scenery could not load.';
    return result('unavailable', `Unavailable — ${detail}`, reason);
  }
  if (range.active && range.runtimeReady && range.viewId === 'teton-range-tour' && preparation.state === 'ready') {
    if (preparation.refinement?.state === 'held'
      && preparation.requestedReducedMotion !== preparation.effectiveReducedMotion) {
      return result('active', 'Active — motion change unavailable; try restarting the song.', preparation.refinement.reason);
    }
    return result('active', preparation.reducedMotion ? 'Active — reduced motion.' : 'Active');
  }
  if (paused && preparation.state === 'ready') return result('ready', 'Ready — resume playback to start the tour.');
  if (preparation.state === 'loading') return result('loading', 'Loading tour files…');
  if (preparation.state === 'planning') return result('loading', 'Loading — planning the flight for this song…');
  return result('loading', 'Loading scenery…');
}

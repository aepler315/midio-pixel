/** One cancellable handoff from a completed song to the next selection. */
export class ContinuousPlayback {
  constructor({ now = () => Date.now(), setTimer = (callback, delay) => setTimeout(callback, delay), clearTimer = timer => clearTimeout(timer),
    onChange = () => {}, delayMs = 5000 } = {}) {
    Object.assign(this, { now, setTimer, clearTimer, onChange, delayMs });
    this.current = null;
    this.timer = null;
    this.snapshot = { phase: 'idle', remainingSeconds: 0, message: '' };
  }

  isCurrent(ticket) { return !!ticket && this.current === ticket && !ticket.signal.aborted; }

  _publish(phase, message = '', remainingSeconds = 0) {
    this.snapshot = { phase, message, remainingSeconds };
    this.onChange(this.snapshot);
  }

  cancel(message = '') {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.current?.controller.abort();
    this.current = null;
    this._publish('idle', message);
  }

  schedule({ ready = null, start }) {
    this.cancel();
    const controller = new AbortController(), ticket = { controller, signal: controller.signal };
    this.current = ticket;
    this._publish('finalizing', 'Finishing the recording…');
    Promise.resolve(ready).then(() => {
      if (!this.isCurrent(ticket)) return;
      const deadline = this.now() + this.delayMs;
      const tick = () => {
        if (!this.isCurrent(ticket)) return;
        const left = Math.max(0, deadline - this.now());
        if (left > 0) {
          this._publish('countdown', '', Math.ceil(left / 1000));
          this.timer = this.setTimer(tick, Math.min(1000, left));
          return;
        }
        this.timer = null;
        this._publish('loading', 'Preparing the next song…');
        Promise.resolve().then(() => this.isCurrent(ticket) ? start(ticket) : null).then(result => {
          if (this.isCurrent(ticket)) { this.current = null; this._publish('idle', result?.message || ''); }
        }, error => { if (this.isCurrent(ticket)) this.cancel(error?.message || 'Could not play the next song.'); });
      };
      tick();
    }, error => {
      if (this.isCurrent(ticket)) this.cancel('Continuous play stopped: ' + (error?.message || 'recording could not finish.'));
    });
    return ticket;
  }
}

import { execFile } from 'node:child_process';

/** Own this review's signals and resources, including resources whose startup
 * finishes after cancellation. Never exit before the caller saves its report. */
export class ReviewRunOwner {
  constructor(signals = process) {
    this.signals = signals;
    this.abort = new AbortController();
    this.resources = [];
    this.handlers = new Map();
    this.error = null;
    this.closing = false;
    for (const signal of ['SIGINT', 'SIGTERM']) {
      const handler = () => {
        if (this.error) return;
        this.error = Object.assign(new Error(`Review interrupted by ${signal}`), {
          code: 'REVIEW_CANCELLED', signal, exitCode: signal === 'SIGINT' ? 130 : 143,
        });
        this.abort.abort(this.error);
        for (const close of this.resources.toReversed()) close();
      };
      this.handlers.set(signal, handler);
      signals.on(signal, handler);
    }
  }
  check() { if (this.error) throw this.error; }
  own(dispose) {
    let pending;
    const close = () => {
      if (!pending) {
        pending = Promise.resolve().then(dispose);
        // Signal handlers initiate closure; close() below collects failures.
        pending.catch(() => {});
      }
      return pending;
    };
    this.resources.push(close);
    if (this.error || this.closing) close();
  }
  async execFile(command, args, options = {}) {
    this.check();
    try {
      const output = await new Promise((resolve, reject) => {
        const child = execFile(command, args, { ...options, windowsHide: true, signal: this.abort.signal },
          (error, stdout) => error ? reject(error) : resolve(stdout));
        const closed = new Promise(done => child.once('close', done));
        this.own(() => {
          if (child.exitCode === null && !child.killed) child.kill();
          return closed;
        });
      });
      this.check();
      return output;
    } catch (error) { throw this.error || error; }
  }
  async close() {
    this.closing = true;
    try {
      const results = await Promise.allSettled(this.resources.toReversed().map(close => close()));
      return results.filter(result => result.status === 'rejected').map(result => String(result.reason?.message || result.reason));
    } finally {
      for (const [signal, handler] of this.handlers) this.signals.off(signal, handler);
    }
  }
}

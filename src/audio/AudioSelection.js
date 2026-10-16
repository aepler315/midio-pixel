/** One owner for every pending file, URL and library selection. */
export function createAudioSelection() {
  let current = null;
  let serial = 0;
  return {
    begin(source) {
      current?.controller.abort();
      const controller = new AbortController();
      const ticket = Object.freeze({ id: ++serial, source, signal: controller.signal });
      current = { ticket, controller };
      return ticket;
    },
    isCurrent(ticket) {
      return !!ticket && current?.ticket === ticket && !ticket.signal.aborted;
    },
    cancel(ticket = null) {
      if (ticket && current?.ticket !== ticket) return;
      current?.controller.abort();
      current = null;
    },
  };
}

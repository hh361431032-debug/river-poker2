let source = null;
const listeners = new Set();

function ensureSource() {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  source.addEventListener("change", event => {
    for (const listener of listeners) {
      try { listener(event); } catch {}
    }
  });
  source.addEventListener("error", () => {
    if (!listeners.size && source) {
      source.close();
      source = null;
    }
  });
}

export function subscribeLocalEvents(listener) {
  listeners.add(listener);
  ensureSource();
  return () => {
    listeners.delete(listener);
    if (!listeners.size && source) {
      source.close();
      source = null;
    }
  };
}

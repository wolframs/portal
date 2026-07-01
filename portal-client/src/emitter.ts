/** Minimal typed event emitter (no `any`, no Node EventEmitter dependency). */
export class TypedEmitter<Events extends Record<string, (...args: never[]) => void>> {
  private listeners = new Map<keyof Events, Set<(...args: never[]) => void>>();

  on<K extends keyof Events>(event: K, fn: Events[K]): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(fn as (...args: never[]) => void);
    return () => this.off(event, fn);
  }

  off<K extends keyof Events>(event: K, fn: Events[K]): void {
    this.listeners.get(event)?.delete(fn as (...args: never[]) => void);
  }

  emit<K extends keyof Events>(event: K, ...args: Parameters<Events[K]>): void {
    // Snapshot listeners (a handler may add/remove during dispatch) and isolate
    // failures: one throwing listener must not skip the others or propagate to
    // emit()'s caller (e.g. the reconnect scheduler in onClose).
    for (const fn of [...(this.listeners.get(event) ?? [])]) {
      try {
        (fn as (...a: Parameters<Events[K]>) => void)(...args);
      } catch (err) {
        console.error(`[portal-client] listener for "${String(event)}" threw:`, err);
      }
    }
  }
}

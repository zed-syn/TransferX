/**
 * @module events/EventBus
 *
 * Concrete implementation of IEventBus.
 *
 * Design decisions:
 *
 * 1. SYNCHRONOUS DISPATCH:
 *    Handlers are called synchronously in subscription order.
 *    This is intentional: it keeps execution order predictable and avoids
 *    async handler issues (unhandled rejections, ordering hazards).
 *    If a handler needs to do async work, it should start (but not await)
 *    the async operation inside the handler.
 *
 * 2. STRUCTURAL COPY ON DISPATCH:
 *    The handlers array is copied before iteration so that a handler calling
 *    off() or on() during dispatch does not corrupt the current dispatch.
 *
 * 3. TYPED OVERLOAD:
 *    on<T>(type, handler) narrows the handler signature to the specific event
 *    subtype, giving callers full type inference without casting.
 *    The internal store uses a Map<string, Set<Function>> to avoid type
 *    gymnastics in the implementation body.
 *
 * 4. NO MEMORY LEAKS:
 *    on() returns an unsubscribe function. Callers that hold the result can
 *    clean up without needing a reference to the bus instance.
 *    clear() removes all listeners, useful for tests.
 */

import type {
  IEventBus,
  TransferEvent,
  EventHandler,
} from "../types/events.js";

// Using Function as the internal store type to avoid complex conditional types.
// The public on/off methods are fully typed.
type AnyHandler = (event: TransferEvent) => void;

export class EventBus implements IEventBus {
  /** type → Set of handlers registered for that event type. */
  private readonly _handlers = new Map<string, Set<AnyHandler>>();

  on<T extends TransferEvent["type"]>(
    type: T,
    handler: EventHandler<Extract<TransferEvent, { type: T }>>,
  ): () => void {
    let set = this._handlers.get(type);
    if (!set) {
      set = new Set();
      this._handlers.set(type, set);
    }
    set.add(handler as AnyHandler);
    return () => this.off(type, handler);
  }

  off<T extends TransferEvent["type"]>(
    type: T,
    handler: EventHandler<Extract<TransferEvent, { type: T }>>,
  ): void {
    this._handlers.get(type)?.delete(handler as AnyHandler);
  }

  emit(event: TransferEvent): void {
    const set = this._handlers.get(event.type);
    if (!set || set.size === 0) return;
    // Snapshot before dispatch — allows handlers to add/remove listeners safely.
    const snapshot = [...set];
    for (const handler of snapshot) {
      try {
        handler(event);
      } catch (err) {
        // A throwing consumer handler must NEVER crash the engine.
        // Emit a structured log event so the error is still observable.
        // Guard against infinite recursion: do not re-emit for 'log' events.
        if (event.type !== "log") {
          try {
            this.emit({
              type: "log",
              level: "error",
              message: `EventBus: handler for "${event.type}" threw an unhandled error`,
              context: { error: String(err) },
            });
          } catch {
            // If even the log-event handler throws, swallow silently.
          }
        }
      }
    }
  }

  /** Remove all listeners. Useful for test cleanup. */
  clear(): void {
    this._handlers.clear();
  }

  /** Number of handlers registered for a specific event type. */
  listenerCount(type: TransferEvent["type"]): number {
    return this._handlers.get(type)?.size ?? 0;
  }
}

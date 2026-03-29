/**
 * @module EventBus
 *
 * Typed publish/subscribe bus for download lifecycle events.
 * Synchronous dispatch — handlers run in registration order.
 * Handler errors are swallowed and logged so one bad handler
 * never blocks other handlers or the engine itself.
 */

import type {
  DownloadEventMap,
  DownloadEventType,
  DownloadEventHandler,
} from "./types.js";

type HandlerSet = Map<DownloadEventType, Set<DownloadEventHandler<any>>>;

export class DownloadEventBus {
  private readonly _handlers: HandlerSet = new Map();

  on<K extends DownloadEventType>(
    event: K,
    handler: DownloadEventHandler<K>,
  ): this {
    let set = this._handlers.get(event);
    if (!set) {
      set = new Set();
      this._handlers.set(event, set);
    }
    set.add(handler as DownloadEventHandler<any>);
    return this;
  }

  off<K extends DownloadEventType>(
    event: K,
    handler: DownloadEventHandler<K>,
  ): this {
    this._handlers.get(event)?.delete(handler as DownloadEventHandler<any>);
    return this;
  }

  emit<K extends DownloadEventType>(
    event: K,
    payload: DownloadEventMap[K],
  ): void {
    const set = this._handlers.get(event);
    if (!set) return;
    for (const h of set) {
      try {
        h(payload);
      } catch {
        /* swallow — never block the engine */
      }
    }
  }

  clear(event?: DownloadEventType): void {
    if (event) {
      this._handlers.get(event)?.clear();
    } else {
      this._handlers.clear();
    }
  }
}

import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { Timer } from "./internal";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Event = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = any;
type Callback = (...args: Result[]) => void;
type Unlisten = () => void;

export interface WaitEventOptions {
  // `timeout` specifies the number of milliseconds waiting for the event to be
  // notified. If the event is not notified within `timeout`, the wait will be
  // aborted and the underlying promise will be rejected with a TimeoutError.
  // the default value is `5000`.
  timeout?: number;

  // An AbortSignal. If this option is set, the wait will be canceled by calling
  // abort() on the AbortSignal.
  signal?: AbortSignal;
}

export interface IListenable {
  addListener(event: Event, callback: Callback): void;
  deleteListener(event: Event, callback: Callback): void;
  waitEvent(
    event: Event,
    options?: WaitEventOptions,
  ): AbortablePromise<Result[]>;
  clear(): void;
  listeners(): Map<Event, Callback[]>;
  notify(event: Event, ...args: Result[]): void;
}

export class Listenable implements IListenable {
  private _listeners: Map<Event, Callback[]>;

  constructor() {
    this._listeners = new Map();
  }

  listeners(): Map<Event, Callback[]> {
    return this._listeners;
  }

  addListener(event: Event, callback: Callback): Unlisten {
    let callbacks = this._listeners.get(event);
    if (typeof callbacks === "undefined") {
      callbacks = [];
      this._listeners.set(event, callbacks);
    }
    const index = callbacks.findIndex((callback0) => {
      return callback === callback0;
    });
    if (index === -1) {
      callbacks.push(callback);
    }
    return () => {
      this.deleteListener(event, callback);
    };
  }

  deleteListener(event: Event, callback: Callback): void {
    const callbacks = this._listeners.get(event);
    if (typeof callbacks === "undefined") {
      return;
    }
    const index = callbacks.findIndex((callback0) => {
      return callback === callback0;
    });
    if (index === -1) {
      return;
    }
    callbacks.splice(index, 1);
    if (callbacks.length <= 0) {
      this._listeners.delete(event);
    }
  }

  waitEvent(
    event: Event,
    options: WaitEventOptions = {},
  ): AbortablePromise<Result[]> {
    let { timeout, signal } = options;
    if (typeof timeout === "undefined") {
      timeout = 5000;
    }
    let timer: Timer;
    return new AbortablePromise<Result[]>((resolve, reject) => {
      const unlisten = this.addListener(event, (...args: Result[]) => {
        unlisten();
        resolve(args);
      });
      timer = setTimeout(() => {
        unlisten();
        reject(new Error(`Timeout to wait: event: ${event}`));
      }, timeout);
    }, signal)
      .then((value) => {
        clearTimeout(timer as number);
        return value;
      })
      .catch((reason: any) => {
        clearTimeout(timer as number);
        throw reason;
      });
  }

  clear(): void {
    this._listeners.clear();
  }

  notify(event: Event, ...args: Result[]): void {
    const callbacks = this._listeners.get(event);
    if (typeof callbacks === "undefined") {
      return;
    }
    const callback2 = [...callbacks];
    callback2.forEach((callback) => {
      try {
        callback(...args);
      } catch (e: any) {
        console.error(`Failed to notify: reason: ${e.stack}`);
      }
    });
  }
}

export default Listenable;

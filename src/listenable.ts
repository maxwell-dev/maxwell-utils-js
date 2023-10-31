// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Event = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = any;
type Callback = (...args: Result[]) => void;
type UnListen = () => void;

export interface IListenable {
  addListener(event: Event, callback: Callback): void;
  deleteListener(event: Event, callback: Callback): void;
  clear(): void;
  listeners(): Map<Event, Callback[]>;
  notify(event: Event, ...args: Result[]): void;
}

export class Listenable implements IListenable {
  private _listeners: Map<Event, Callback[]>;

  constructor() {
    this._listeners = new Map();
  }

  addListener(event: Event, callback: Callback): UnListen {
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

  clear(): void {
    this._listeners.clear();
  }

  listeners(): Map<Event, Callback[]> {
    return this._listeners;
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

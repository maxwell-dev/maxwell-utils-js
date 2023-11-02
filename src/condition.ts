import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { Timer, TimeoutError } from "./internal";

type Cond = () => boolean;
type Watier<T> = [(target: T) => void, (reason?: unknown) => void];

export class Condition<T> {
  private _target: T;
  private _cond: Cond;
  private _waiters: Map<number, Watier<T>>;
  private _waiterId: number;

  constructor(target: T, cond: Cond) {
    this._target = target;
    this._cond = cond;
    this._waiters = new Map();
    this._waiterId = 0;
  }

  wait(timeout = 5000, msg?: string): AbortablePromise<T> {
    if (this._cond()) {
      return AbortablePromise.resolve(this._target);
    }
    const waiterId = this._nextWaiterId();
    let timer: Timer;
    return new AbortablePromise<T>((resolve, reject) => {
      this._waiters.set(waiterId, [resolve, reject]);
      timer = setTimeout(() => {
        if (typeof msg === "undefined") {
          msg = `Timeout to wait: waiter: ${waiterId}`;
        } else {
          msg = JSON.stringify(msg).substring(0, 100);
        }
        reject(new TimeoutError(msg));
      }, timeout);
    })
      .then((value) => {
        clearTimeout(timer as number);
        this._waiters.delete(waiterId);
        return value;
      })
      .catch((reason) => {
        clearTimeout(timer as number);
        this._waiters.delete(waiterId);
        throw reason;
      });
  }

  notify(): void {
    this._waiters.forEach((waiter) => {
      waiter[0](this._target);
    });
    this.clear();
  }

  throw(reason: unknown): void {
    this._waiters.forEach((waiter) => {
      waiter[1](reason);
    });
    this.clear();
  }

  clear(): void {
    this._waiters = new Map();
  }

  private _nextWaiterId() {
    return this._waiterId++;
  }
}

export default Condition;

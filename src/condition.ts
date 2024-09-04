import { AbortablePromise, TimeoutError } from "@xuchaoqian/abortable-promise";
import { Timer, AsyncOperationOptions } from "./internal";

type Cond = () => boolean;
type Watier<T> = [(target: T) => void, (reason?: unknown) => void];

let ID_SEED = 0;

export class Condition<T> {
  private _id: number = ++ID_SEED;
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

  /**
   * Waits for the condition to be true.
   *
   * @param {AsyncOperationOptions} [options] - Options for the wait operation.
   * @param {number} [options.timeout] - specifies the number of milliseconds waiting for the condition to become true. If the condition does not become true within `timeout`, the wait will be aborted and the underlying promise will be rejected with a TimeoutError. default is `5000` milliseconds.
   * @param {AbortSignal} [options.signal] - An AbortSignal that can be used to cancel the wait operation.
   * @returns {AbortablePromise<T>} A promise that resolves when the condition is true.
   */
  wait(options: AsyncOperationOptions = {}): AbortablePromise<T> {
    if (this._cond()) {
      return AbortablePromise.resolve(this._target);
    }

    const waiterId = this._nextWaiterId();
    let { timeout, signal } = options;
    if (typeof timeout === "undefined") {
      timeout = 5000;
    }
    const msg = `Timeout to wait: waiter: c${this._id}w${waiterId}`;

    let timer: Timer;
    return new AbortablePromise<T>((resolve, reject) => {
      this._waiters.set(waiterId, [resolve, reject]);
      timer = setTimeout(() => {
        reject(new TimeoutError(msg));
      }, timeout);
    }, signal)
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

  private _nextWaiterId(): number {
    return ++this._waiterId;
  }
}

export default Condition;

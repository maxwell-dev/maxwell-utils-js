import { Timer, TimeoutError } from "./internal";

type Cond = () => boolean;
type Watier = [() => void, (reason?: unknown) => void];

export class Condition {
  private _cond: Cond;
  private _waiters: Map<number, Watier>;
  private _waiterId: number;

  constructor(cond: Cond) {
    this._cond = cond;
    this._waiters = new Map();
    this._waiterId = 0;
  }

  async wait(timeout = 5000, msg?: string): Promise<void> {
    if (this._cond()) {
      return Promise.resolve();
    }

    let timer: Timer;
    const waiterId = this._nextWaiterId();
    return Promise.race([
      new Promise<void>((resolve, reject) => {
        this._waiters.set(waiterId, [resolve, reject]);
      }),
      new Promise<void>((_, reject) => {
        if (typeof msg === "undefined") {
          msg = `Timeout to wait: waiter: ${waiterId}`;
        } else {
          msg = JSON.stringify(msg).substring(0, 100);
        }
        timer = setTimeout(() => reject(new TimeoutError(msg)), timeout);
      }),
    ])
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
      waiter[0]();
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

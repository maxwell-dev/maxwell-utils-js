"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Condition = void 0;
const abortable_promise_1 = require("@xuchaoqian/abortable-promise");
const internal_1 = require("./internal");
class Condition {
    constructor(target, cond) {
        this._target = target;
        this._cond = cond;
        this._waiters = new Map();
        this._waiterId = 0;
    }
    wait(timeout = 5000, msg) {
        if (this._cond()) {
            return abortable_promise_1.AbortablePromise.resolve(this._target);
        }
        const waiterId = this._nextWaiterId();
        let timer;
        return new abortable_promise_1.AbortablePromise((resolve, reject) => {
            this._waiters.set(waiterId, [resolve, reject]);
            timer = setTimeout(() => {
                if (typeof msg === "undefined") {
                    msg = `Timeout to wait: waiter: ${waiterId}`;
                }
                else {
                    msg = JSON.stringify(msg).substring(0, 100);
                }
                reject(new internal_1.TimeoutError(msg));
            }, timeout);
        })
            .then((value) => {
            clearTimeout(timer);
            this._waiters.delete(waiterId);
            return value;
        })
            .catch((reason) => {
            clearTimeout(timer);
            this._waiters.delete(waiterId);
            throw reason;
        });
    }
    notify() {
        this._waiters.forEach((waiter) => {
            waiter[0](this._target);
        });
        this.clear();
    }
    throw(reason) {
        this._waiters.forEach((waiter) => {
            waiter[1](reason);
        });
        this.clear();
    }
    clear() {
        this._waiters = new Map();
    }
    _nextWaiterId() {
        return this._waiterId++;
    }
}
exports.Condition = Condition;
exports.default = Condition;
//# sourceMappingURL=condition.js.map
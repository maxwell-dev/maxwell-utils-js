import { AbortablePromise } from "@xuchaoqian/abortable-promise";
type Cond = () => boolean;
export declare class Condition<T> {
    private _target;
    private _cond;
    private _waiters;
    private _waiterId;
    constructor(target: T, cond: Cond);
    wait(timeout?: number, msg?: string): AbortablePromise<T>;
    notify(): void;
    throw(reason: unknown): void;
    clear(): void;
    private _nextWaiterId;
}
export default Condition;

import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { AsyncOperationOptions } from "./internal";
type Cond = () => boolean;
export declare class Condition<T> {
    private _id;
    private _target;
    private _cond;
    private _waiters;
    private _waiterId;
    constructor(target: T, cond: Cond);
    wait(options?: AsyncOperationOptions): AbortablePromise<T>;
    notify(): void;
    throw(reason: unknown): void;
    clear(): void;
    private _nextWaiterId;
}
export default Condition;

type Cond = () => boolean;
export declare class Condition {
    private _cond;
    private _waiters;
    private _waiterId;
    constructor(cond: Cond);
    wait(timeout?: number, msg?: string): Promise<void>;
    notify(): void;
    throw(reason: unknown): void;
    clear(): void;
    private _nextWaiterId;
}
export default Condition;

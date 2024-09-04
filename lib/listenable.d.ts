import { AbortablePromise } from "@xuchaoqian/abortable-promise";
type Event = any;
type Result = any;
type Callback = (...args: Result[]) => void;
type Unlisten = () => void;
export interface WaitEventOptions {
    timeout?: number;
    signal?: AbortSignal;
}
export interface IListenable {
    addListener(event: Event, callback: Callback): void;
    deleteListener(event: Event, callback: Callback): void;
    waitEvent(event: Event, options?: WaitEventOptions): AbortablePromise<Result[]>;
    clear(): void;
    listeners(): Map<Event, Callback[]>;
    notify(event: Event, ...args: Result[]): void;
}
export declare class Listenable implements IListenable {
    private _listeners;
    constructor();
    listeners(): Map<Event, Callback[]>;
    addListener(event: Event, callback: Callback): Unlisten;
    deleteListener(event: Event, callback: Callback): void;
    waitEvent(event: Event, options?: WaitEventOptions): AbortablePromise<Result[]>;
    clear(): void;
    notify(event: Event, ...args: Result[]): void;
}
export default Listenable;

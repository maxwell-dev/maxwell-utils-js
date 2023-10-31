type Event = any;
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
export declare class Listenable implements IListenable {
    private _listeners;
    constructor();
    addListener(event: Event, callback: Callback): UnListen;
    deleteListener(event: Event, callback: Callback): void;
    clear(): void;
    listeners(): Map<Event, Callback[]>;
    notify(event: Event, ...args: Result[]): void;
}
export default Listenable;

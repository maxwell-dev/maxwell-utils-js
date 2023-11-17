import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { ProtocolMsg, Listenable, IListenable } from "./internal";
export interface IOptions {
    reconnectDelay?: number;
    heartbeatInterval?: number;
    roundTimeout?: number;
    retryRouteCount?: number;
    sslEnabled?: boolean;
    roundDebugEnabled?: boolean;
}
export declare class Options implements IOptions {
    readonly reconnectDelay: number;
    readonly heartbeatInterval: number;
    readonly roundTimeout: number;
    readonly retryRouteCount: number;
    readonly sslEnabled: boolean;
    readonly roundDebugEnabled: boolean;
    constructor(options?: IOptions);
}
export declare enum Event {
    ON_CONNECTING = 100,
    ON_CONNECTED = 101,
    ON_DISCONNECTING = 102,
    ON_DISCONNECTED = 103,
    ON_CORRUPTED = 104
}
export interface IEventHandler {
    onConnecting(connection: IConnection, ...rest: any[]): void;
    onConnected(connection: IConnection, ...rest: any[]): void;
    onDisconnecting(connection: IConnection, ...rest: any[]): void;
    onDisconnected(connection: IConnection, ...rest: any[]): void;
    onCorrupted(connection: IConnection, ...rest: any[]): void;
}
export interface IConnection extends IListenable {
    close(): void;
    endpoint(): string | undefined;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<IConnection>;
    request(msg: ProtocolMsg, timeout?: number): AbortablePromise<ProtocolMsg>;
    send(msg: ProtocolMsg): void;
}
export declare class Connection extends Listenable implements IConnection {
    private _id;
    private _endpoint;
    private _options;
    private _eventHandler;
    private _shouldRun;
    private _heartbeatTimer;
    private _reconnectTimer;
    private _sentAt;
    private _lastRef;
    private _attachments;
    private _condition;
    private _websocket;
    constructor(endpoint: string, options: Options, eventHandler?: IEventHandler);
    close(): void;
    id(): number;
    endpoint(): string;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<Connection>;
    request(msg: ProtocolMsg, timeout?: number): AbortablePromise<ProtocolMsg>;
    send(msg: ProtocolMsg): void;
    private _onOpen;
    private _onClose;
    private _onMsg;
    private _onError;
    private _openWebsocket;
    private _closeWebsocket;
    private _connect;
    private _disconnect;
    private _reconnect;
    private _stopReconnect;
    private _repeatSendHeartbeat;
    private _stopRepeatSendHeartbeat;
    private _sendHeartbeat;
    private _hasSentHeartbeat;
    private _createPingReq;
    private _newRef;
    private _buildUrl;
    private _deleteAttachment;
    private _now;
}
type PickEndpoint = () => AbortablePromise<string>;
export declare class MultiAltEndpointsConnection extends Listenable implements IConnection, IEventHandler {
    private _pickEndpoint;
    private _options;
    private _eventHandler;
    private _shouldRun;
    private _connectTask;
    private _reconnectTimer;
    private _condition;
    private _connection;
    constructor(pickEndpoint: PickEndpoint, options: Options, eventHandler?: IEventHandler);
    close(): void;
    endpoint(): string | undefined;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<MultiAltEndpointsConnection>;
    request(msg: any, timeout?: number | undefined): AbortablePromise<ProtocolMsg>;
    send(msg: any): void;
    onConnecting(connection: Connection): void;
    onConnected(connection: Connection): void;
    onDisconnecting(connection: Connection): void;
    onDisconnected(connection: Connection): void;
    onCorrupted(connection: Connection): void;
    private _connect;
    private _reconnect;
    private _stopReconnect;
}
export default Connection;

import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { Listenable, IListenable } from "./internal";
export interface Options {
    reconnectDelay?: number;
    heartbeatInterval?: number;
    roundTimeout?: number;
    unhealthyTimeout?: number;
    idleTimeout?: number;
    sslEnabled?: boolean;
    roundLogEnabled?: boolean;
}
export declare function defaultOptions(options?: Options): Required<Options>;
export declare enum Event {
    ON_CONNECTING = 100,
    ON_CONNECTED = 101,
    ON_DISCONNECTING = 102,
    ON_DISCONNECTED = 103,
    ON_CORRUPTED = 104,
    ON_UNHEALTHY_TIMEOUT = 105,
    ON_IDLE_TIMEOUT = 106
}
export interface IEventHandler {
    onConnecting?(connection: IConnection, ...rest: any[]): void;
    onConnected?(connection: IConnection, ...rest: any[]): void;
    onDisconnecting?(connection: IConnection, ...rest: any[]): void;
    onDisconnected?(connection: IConnection, ...rest: any[]): void;
    onCorrupted?(connection: IConnection, ...rest: any[]): void;
    onUnhealthyTimeout?(connection: IConnection, ...rest: any[]): void;
    onIdleTimeout?(connection: IConnection, ...rest: any[]): void;
}
export declare class DefaultEventHandler implements IEventHandler {
}
export type ProtocolMsg = any;
export interface Identity {
    id(): number;
    name(): string;
}
export interface IConnection extends IListenable, Identity {
    close(): void;
    closeAndWait(): AbortablePromise<void>;
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
    private _checkStatusTimer;
    private _reconnectTimer;
    private _sentAt;
    private _sendNonePingAt;
    private _receivedAt;
    private _isHealthy;
    private _lastRef;
    private _attachments;
    private _condition;
    private _websocket;
    constructor(endpoint: string, options: Required<Options>, eventHandler?: IEventHandler);
    close(): void;
    closeAndWait(): AbortablePromise<void>;
    id(): number;
    name(): string;
    endpoint(): string;
    isHealthy(): boolean;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<Connection>;
    request(msg: ProtocolMsg, timeout?: number): AbortablePromise<ProtocolMsg>;
    send(msg: ProtocolMsg): void;
    private _onMsg;
    private _onOpen;
    private _onClose;
    private _onError;
    private _openWebsocket;
    private _closeWebsocket;
    private _connect;
    private _disconnect;
    private _reconnect;
    private _stopReconnect;
    private _repeatHeartbeat;
    private _stopRepeatHeartbeat;
    private _calcDelayForNextHeartbeat;
    private _sendHeartbeat;
    private _repeatCheckStatus;
    private _stopRepeatCheckStatus;
    private _checkUnhealthyTimeout;
    private _checkIdleTimeout;
    private _hasReceivedBeforeUnhealthyTimeout;
    private _hasSentNonePingBeforeIdleTimeout;
    private _calcIntervalForCheckStatus;
    private _createPingReq;
    private _newRef;
    private _buildUrl;
    private _deleteAttachment;
}
type PickEndpoint = () => AbortablePromise<string>;
export declare class MultiAltEndpointsConnection extends Listenable implements IConnection, IEventHandler {
    private _id;
    private _pickEndpoint;
    private _options;
    private _eventHandler;
    private _shouldRun;
    private _connectTask;
    private _reconnectTimer;
    private _condition;
    private _connection;
    constructor(pickEndpoint: PickEndpoint, options: Required<Options>, eventHandler?: IEventHandler);
    close(): void;
    closeAndWait(): AbortablePromise<void>;
    id(): number;
    name(): string;
    endpoint(): string | undefined;
    isHealthy(): boolean;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<MultiAltEndpointsConnection>;
    request(msg: any, timeout?: number | undefined): AbortablePromise<ProtocolMsg>;
    send(msg: any): void;
    onConnecting(connection: Connection, ...rest: any[]): void;
    onConnected(connection: Connection, ...rest: any[]): void;
    onDisconnecting(connection: Connection, ...rest: any[]): void;
    onDisconnected(connection: Connection, ...rest: any[]): void;
    onCorrupted(connection: Connection, ...rest: any[]): void;
    onUnhealthyTimeout(connection: Connection, ...rest: any[]): void;
    onIdleTimeout(connection: Connection, ...rest: any[]): void;
    private _connect;
    private _reconnect;
    private _stopReconnect;
}
export type PoolOptions = {
    minPoolSize?: number;
    maxPoolSize?: number;
} & Options;
export declare function defaultPoolOptions(options?: PoolOptions): Required<PoolOptions>;
export declare class ConnectionPool extends Listenable implements IEventHandler, Identity {
    private _id;
    private _pickEndpoint;
    private _options;
    private _eventHandler;
    private _connections;
    private _indexSeed;
    constructor(pickEndpoint: PickEndpoint, options: Required<PoolOptions>, eventHandler?: IEventHandler);
    close(): void;
    closeAndWait(): AbortablePromise<void>;
    id(): number;
    name(): string;
    size(): number;
    waitAllOpen(timeout?: number): AbortablePromise<ConnectionPool>;
    getConnection(): MultiAltEndpointsConnection;
    onConnecting(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onConnected(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onDisconnecting(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onDisconnected(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onCorrupted(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onUnhealthyTimeout(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onIdleTimeout(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    _createConnection(): MultiAltEndpointsConnection;
    _tryDropConnection(connection: MultiAltEndpointsConnection): void;
    _nextIndex(): number;
}
export {};

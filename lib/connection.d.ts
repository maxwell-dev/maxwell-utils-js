import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { Listenable, IListenable } from "./internal";
export interface ConnectionOptions {
    reconnectDelay?: number;
    heartbeatInterval?: number;
    roundTimeout?: number;
    unhealthyTimeout?: number;
    idleTimeout?: number;
    sslEnabled?: boolean;
    roundLogEnabled?: boolean;
}
export declare function makeConnectionOptions(options?: ConnectionOptions): Required<ConnectionOptions>;
export declare enum Event {
    ON_CONNECTING = 100,
    ON_CONNECTED = 101,
    ON_DISCONNECTING = 102,
    ON_DISCONNECTED = 103,
    ON_CORRUPTED = 104,
    ON_BECAME_UNHEALTHY = 105,
    ON_BECAME_HEALTHY = 106,
    ON_BECAME_IDLE = 107,
    ON_BECAME_ACTIVE = 108
}
export interface IEventHandler {
    onConnecting?(connection: IConnection, ...rest: any[]): void;
    onConnected?(connection: IConnection, ...rest: any[]): void;
    onDisconnecting?(connection: IConnection, ...rest: any[]): void;
    onDisconnected?(connection: IConnection, ...rest: any[]): void;
    onCorrupted?(connection: IConnection, ...rest: any[]): void;
    onBecameUnhealthy?(connection: IConnection, ...rest: any[]): void;
    onBecameHealthy?(connection: IConnection, ...rest: any[]): void;
    onBecameIdle?(connection: IConnection, ...rest: any[]): void;
    onBecameActive?(connection: IConnection, ...rest: any[]): void;
}
export declare class DefaultEventHandler implements IEventHandler {
}
export type ProtocolMsg = any;
export interface Identity {
    id(): number;
    name(): string;
}
export interface IConnection extends IListenable, Identity {
    endpoint(): string | undefined;
    isHealthy(): boolean;
    isOpen(): boolean;
    isClosed(): boolean;
    waitOpen(timeout?: number): AbortablePromise<IConnection>;
    close(): void;
    closeAndWait(): AbortablePromise<IConnection>;
    request(msg: ProtocolMsg, timeout?: number): AbortablePromise<ProtocolMsg>;
    send(msg: ProtocolMsg): void;
}
export declare class Connection extends Listenable implements IConnection {
    private _id;
    private _endpoint;
    private _options;
    private _eventHandler;
    private _shouldRun;
    private _reconnectTimer;
    private _heartbeatTimer;
    private _checkStatusTimer;
    private _sentAt;
    private _sendNonePingAt;
    private _receivedAt;
    private _isHealthy;
    private _isIdle;
    private _lastRef;
    private _attachments;
    private _openCondition;
    private _closedCondition;
    private _isDisconnected;
    private _websocket;
    constructor(endpoint: string, options: Required<ConnectionOptions>, eventHandler?: IEventHandler);
    id(): number;
    name(): string;
    endpoint(): string;
    isHealthy(): boolean;
    isIdle(): boolean;
    isClosed(): boolean;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<Connection>;
    close(): void;
    closeAndWait(): AbortablePromise<Connection>;
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
    private _openCondition;
    private _closedCondition;
    private _isDisconnected;
    private _connection;
    constructor(pickEndpoint: PickEndpoint, options: Required<ConnectionOptions>, eventHandler?: IEventHandler);
    id(): number;
    name(): string;
    endpoint(): string | undefined;
    isHealthy(): boolean;
    isOpen(): boolean;
    waitOpen(timeout?: number): AbortablePromise<MultiAltEndpointsConnection>;
    isClosed(): boolean;
    close(): void;
    closeAndWait(timeout?: number): AbortablePromise<MultiAltEndpointsConnection>;
    request(msg: any, timeout?: number | undefined): AbortablePromise<ProtocolMsg>;
    send(msg: any): void;
    onConnecting(connection: Connection, ...rest: any[]): void;
    onConnected(connection: Connection, ...rest: any[]): void;
    onDisconnecting(connection: Connection, ...rest: any[]): void;
    onDisconnected(connection: Connection, ...rest: any[]): void;
    onCorrupted(connection: Connection, ...rest: any[]): void;
    onBecameUnhealthy(connection: Connection, ...rest: any[]): void;
    onBecameHealthy(connection: IConnection, ...rest: any[]): void;
    onBecameActive(connection: Connection, ...rest: any[]): void;
    onBecameIdle(connection: Connection, ...rest: any[]): void;
    private _connect;
    private _reconnect;
    private _stopReconnect;
}
export type ConnectionPoolOptions = {
    minPoolSize?: number;
    maxPoolSize?: number;
} & ConnectionOptions;
export declare function makeConnectionPoolOptions(options?: ConnectionPoolOptions): Required<ConnectionPoolOptions>;
export declare class ConnectionPool extends Listenable implements IEventHandler, Identity {
    private _id;
    private _pickEndpoint;
    private _options;
    private _eventHandler;
    private _shouldRun;
    private _allConnections;
    private _healthyConnections;
    private _closingConnections;
    private _healthyIndexSeed;
    constructor(pickEndpoint: PickEndpoint, options: Required<ConnectionPoolOptions>, eventHandler?: IEventHandler);
    id(): number;
    name(): string;
    size(): number;
    waitAllOpen(timeout?: number): AbortablePromise<ConnectionPool>;
    close(): void;
    closeAndWait(timeout?: number): AbortablePromise<ConnectionPool>;
    getConnection(): MultiAltEndpointsConnection;
    onConnecting(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onConnected(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onDisconnecting(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onDisconnected(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onCorrupted(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onBecameUnhealthy(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onBecameHealthy(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onBecameIdle(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    onBecameActive(connection: MultiAltEndpointsConnection, ...rest: any[]): void;
    private _createConnection;
    private _addFreshConnection;
    private _updateConnectionHealth;
    private _dropConnection;
    private _nextHealthyIndex;
}
export {};

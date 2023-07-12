import { ProtocolMsg, Listenable, PromisePlus } from "./internal";
export declare enum Event {
    ON_CONNECTING = 100,
    ON_CONNECTED = 101,
    ON_DISCONNECTING = 102,
    ON_DISCONNECTED = 103,
    ON_MESSAGE = 104,
    ON_ERROR = 1
}
export declare enum Code {
    FAILED_TO_ENCODE = 1,
    FAILED_TO_SEND = 2,
    FAILED_TO_DECODE = 3,
    FAILED_TO_RECEIVE = 4,
    FAILED_TO_CONNECT = 5,
    UNKNOWN_ERROR = 6
}
export interface IOptions {
    reconnectDelay?: number;
    heartbeatInterval?: number;
    defaultRoundTimeout?: number;
    retryRouteCount?: number;
    sslEnabled?: boolean;
    debugRoundEnabled?: boolean;
}
export declare class Options implements IOptions {
    readonly reconnectDelay: number;
    readonly heartbeatInterval: number;
    readonly defaultRoundTimeout: number;
    readonly retryRouteCount: number;
    readonly sslEnabled: boolean;
    readonly debugRoundEnabled: boolean;
    constructor(options?: IOptions);
}
export declare class Connection extends Listenable {
    private _endpoints;
    private _options;
    private _currentEndpointIndex;
    private _shouldRun;
    private _heartbeatTimer;
    private _reconnectTimer;
    private _sentAt;
    private _lastRef;
    private _attachments;
    private _condition;
    private _websocket;
    constructor(endpoints: string[], options: Options);
    close(): void;
    isOpen(): boolean;
    waitOpen(): Promise<void>;
    request(msg: ProtocolMsg, timeout?: number): PromisePlus;
    send(msg: ProtocolMsg): void;
    private _onOpen;
    private _onClose;
    private _onMsg;
    private _onError;
    private _connect;
    private _disconnect;
    private _reconnect;
    private _stopReconnect;
    private _repeatSendHeartbeat;
    private _stopSendHeartbeat;
    private _sendHeartbeat;
    private _hasSentHeartbeat;
    private _createPingReq;
    private _newRef;
    private _now;
    private _nextEndpoint;
    private _currentEndpoint;
    private _buildUrl;
    private _deleteAttachment;
}
export default Connection;

import { AbortablePromise, AbortError } from "@xuchaoqian/abortable-promise";
import { msg_types, encode_msg, decode_msg } from "maxwell-protocol";
import {
  Timer,
  Condition,
  Listenable,
  IListenable,
  TimeoutError,
  now,
} from "./internal";

const WebSocketImpl =
  typeof WebSocket !== "undefined" ? WebSocket : require("ws");

export interface ConnectionOptions {
  reconnectDelay?: number;
  heartbeatInterval?: number;
  roundTimeout?: number;
  unhealthyTimeout?: number;
  idleTimeout?: number;
  sslEnabled?: boolean;
  roundLogEnabled?: boolean;
}

export function makeConnectionOptions(
  options?: ConnectionOptions,
): Required<ConnectionOptions> {
  if (typeof options === "undefined") {
    options = {};
  }
  return {
    reconnectDelay: options.reconnectDelay ?? 3000,
    heartbeatInterval: options.heartbeatInterval ?? 10000,
    roundTimeout: options.roundTimeout ?? 15000,
    unhealthyTimeout: options.unhealthyTimeout ?? 22500,
    idleTimeout: options.idleTimeout ?? 30000,
    sslEnabled: options.sslEnabled ?? false,
    roundLogEnabled: options.roundLogEnabled ?? false,
  };
}

export enum Event {
  ON_CONNECTING = 100,
  ON_CONNECTED = 101,
  ON_DISCONNECTING = 102,
  ON_DISCONNECTED = 103,
  ON_CORRUPTED = 104,
  ON_BECAME_UNHEALTHY = 105,
  ON_BECAME_HEALTHY = 106,
  ON_BECAME_IDLE = 107,
  ON_BECAME_ACTIVE = 108,
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

export class DefaultEventHandler implements IEventHandler {}

export interface RequestOptions {
  // `timeout` specifies the number of milliseconds before the request times out.
  // If the request takes longer than `timeout`, the request will be aborted.
  // default is `ConnectionOptions.roundTimeout`
  timeout?: number;

  // An AbortSignal or AbortController. If this option is set, the request can be
  // canceled by calling abort() on the corresponding AbortController.
  signalOrController?: AbortSignal | AbortController;
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
  request(
    msg: ProtocolMsg,
    options?: RequestOptions,
  ): AbortablePromise<ProtocolMsg>;
  send(msg: ProtocolMsg): void;
}

// [resolve, reject]
type Attachment = [(value: ProtocolMsg) => void, (reason?: Error) => void];

enum ReadyState {
  CONNECTING = 0,
  OPEN = 1,
  CLOSING = 2,
  CLOSED = 3,
}

function tryWith(identity: Identity, callback: () => void) {
  try {
    callback();
  } catch (reason: any) {
    console.error(
      `<${identity.name()}>Failed to execute: reason: %o`,
      reason.message ?? reason,
    );
  }
}

let ID_SEED = 0;

export class Connection extends Listenable implements IConnection {
  private _id: number = ++ID_SEED;
  private _endpoint: string;
  private _options: Required<ConnectionOptions>;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _reconnectTimer: Timer | null;
  private _heartbeatTimer: Timer | null;
  private _checkStatusTimer: Timer | null;
  private _sentAt: number;
  private _sendNonePingAt: number;
  private _receivedAt: number;
  private _isHealthy: boolean;
  private _isIdle: boolean;
  private _lastRef: number;
  private _attachments: Map<number, Attachment>;
  private _openCondition: Condition<Connection>;
  private _closedCondition: Condition<Connection>;
  private _readyState: ReadyState;
  private _websocket: typeof WebSocketImpl | null;
  //===========================================
  // APIs
  //===========================================
  constructor(
    endpoint: string,
    options: Required<ConnectionOptions>,
    eventHandler: IEventHandler = new DefaultEventHandler(),
  ) {
    super();
    this._endpoint = endpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._shouldRun = true;
    this._reconnectTimer = null;
    this._heartbeatTimer = null;
    this._checkStatusTimer = null;
    this._sentAt = 0;
    this._sendNonePingAt = 0;
    this._receivedAt = 0;
    this._isHealthy = true;
    this._isIdle = false;
    this._lastRef = 0;
    this._attachments = new Map();
    this._openCondition = new Condition<Connection>(this, () => {
      return this.isOpen();
    });
    this._closedCondition = new Condition<Connection>(this, () => {
      return this.isClosed();
    });
    this._readyState = ReadyState.CONNECTING;
    this._websocket = null;
    this._connect();
  }

  id(): number {
    return this._id;
  }

  name(): string {
    return `c${this._id}`;
  }

  endpoint(): string {
    return this._endpoint;
  }

  isHealthy(): boolean {
    return this._isHealthy;
  }

  isIdle(): boolean {
    return this._isIdle;
  }

  isOpen(): boolean {
    return (
      this._websocket !== null && this._websocket.readyState === ReadyState.OPEN
    );
  }

  isClosed(): boolean {
    return !this._shouldRun && this._readyState === ReadyState.CLOSED;
  }

  waitOpen(timeout?: number): AbortablePromise<Connection> {
    return this._openCondition.wait(timeout);
  }

  close(): void {
    if (!this._shouldRun) {
      return;
    }
    this._shouldRun = false;
    this._openCondition.clear();
    this._stopReconnect();
    this._stopRepeatCheckStatus();
    this._stopRepeatHeartbeat();
    this._disconnect();
    this._attachments.clear();
  }

  closeAndWait(): AbortablePromise<Connection> {
    this.close();
    return this._closedCondition.wait().then(() => {
      super.clear();
      return this;
    });
  }

  request(
    msg: ProtocolMsg,
    options: RequestOptions = {},
  ): AbortablePromise<ProtocolMsg> {
    let { timeout, signalOrController } = options;
    if (typeof timeout === "undefined") {
      timeout = this._options.roundTimeout;
    }

    const ref = this._newRef();
    msg.ref = ref;

    let timer: Timer;
    const promise = new AbortablePromise((resolve, reject) => {
      this._attachments.set(ref, [resolve, reject]);
      timer = setTimeout(() => {
        reject(new TimeoutError(JSON.stringify(msg).substring(0, 100)));
      }, timeout);
    }, signalOrController)
      .then((value: any) => {
        this._deleteAttachment(ref);
        clearTimeout(timer as number);
        return value;
      })
      .catch((reason: any) => {
        this._deleteAttachment(ref);
        clearTimeout(timer as number);
        throw reason;
      });

    try {
      this.send(msg);
    } catch (reason: any) {
      promise.abort(new AbortError(reason));
    }

    return promise;
  }

  send(msg: ProtocolMsg): void {
    const nowMs = now();
    this._sentAt = nowMs;
    if (msg.constructor !== msg_types.ping_rep_t) {
      this._sendNonePingAt = nowMs;
    }

    if (this._options.roundLogEnabled) {
      console.debug(
        `<${this.name()}>Sending msg: [${msg.constructor.name}]%s %o`,
        JSON.stringify(msg).substring(0, 100),
        msg,
      );
    }

    let encodedMsg: any;
    try {
      encodedMsg = encode_msg(msg);
    } catch (reason: any) {
      console.error(
        `<${this.name()}>Failed to encode msg: reason: %o`,
        reason.message ?? reason,
      );
      throw new Error(`Failed to encode msg: reason: ${reason.message}`);
    }

    if (this._websocket == null) {
      console.error(
        `<${this.name()}>Failed to send msg: reason: connection lost`,
      );
      throw new Error("Failed to send msg: reason: connection lost");
    }
    try {
      this._websocket.send(encodedMsg);
    } catch (reason: any) {
      console.error(
        `<${this.name()}>Failed to send msg: reason: %o`,
        reason.message ?? reason,
      );
      throw new Error(`Failed to send msg: reason: ${reason.message}`);
    }
  }

  //===========================================
  // websocket callbacks
  //===========================================

  private _onMsg(event: any): void {
    this._receivedAt = now();

    let msg: ProtocolMsg;

    try {
      msg = decode_msg(event.data);
    } catch (reason: any) {
      console.error(
        `<${this.name()}>Failed to decode msg: reason: %o, msg: %o`,
        reason.message ?? reason,
        event.data,
      );
      return;
    }

    const msgType = msg.constructor;

    if (msgType === msg_types.ping_rep_t) {
      // do nothing
    } else {
      if (this._options.roundLogEnabled) {
        console.debug(
          `<${this.name()}>Received msg: [${msgType.name}]%s %o`,
          `${JSON.stringify(msg).substring(0, 100)}`,
          msg,
        );
      }

      const ref = msg.ref;

      const attachment = this._attachments.get(ref);
      if (typeof attachment === "undefined") {
        if (this._options.roundLogEnabled) {
          console.debug(
            `<${this.name()}>The reply's peer request was lost: ref: ${ref}`,
          );
        }
        return;
      }

      if (
        msgType === msg_types.error_rep_t ||
        msgType === msg_types.error2_rep_t
      ) {
        attachment[1](new Error(`code: ${msg.code}, desc: ${msg.desc}`));
      } else {
        attachment[0](msg);
      }
    }
  }

  private _onOpen(): void {
    console.info(
      `<${this.name()}>Connection connected: endpoint: ${this._endpoint}`,
    );
    const nowMs = now();
    this._sentAt = nowMs;
    this._sendNonePingAt = nowMs;
    this._receivedAt = nowMs;
    this._repeatHeartbeat();
    this._repeatCheckStatus();
    this._readyState = ReadyState.OPEN;
    this._openCondition.notify();
    tryWith(this, () => this._eventHandler.onConnected?.(this));
    this.notify(Event.ON_CONNECTED, this);
  }

  private _onClose(): void {
    console.info(
      `<${this.name()}>Connection disconnected: endpoint: ${this._endpoint}`,
    );
    this._stopRepeatHeartbeat();
    this._stopRepeatCheckStatus();
    this._readyState = ReadyState.CLOSED;
    if (!this._shouldRun) {
      this._closedCondition.notify();
    }
    tryWith(this, () => this._eventHandler.onDisconnected?.(this));
    this.notify(Event.ON_DISCONNECTED, this);
    this._reconnect();
  }

  private _onError(reason: any): void {
    console.error(
      `<${this.name()}>Connection corrupted: endpoint: ${this._endpoint}, error: %o`,
      reason.message ?? reason,
    );
    tryWith(this, () => this._eventHandler.onCorrupted?.(this));
    this.notify(Event.ON_CORRUPTED, this);
  }

  //===========================================
  // internal functions
  //===========================================

  private _openWebsocket(): typeof WebSocketImpl {
    const websocket = new WebSocketImpl(this._buildUrl());
    websocket.binaryType = "arraybuffer";
    websocket.onmessage = this._onMsg.bind(this);
    websocket.onopen = this._onOpen.bind(this);
    websocket.onclose = this._onClose.bind(this);
    websocket.onerror = this._onError.bind(this);
    return websocket;
  }

  private _closeWebsocket(): void {
    if (this._websocket !== null) {
      this._websocket.close();
      this._websocket = null;
    }
  }

  private _connect(): void {
    console.info(`<${this.name()}>Connecting: endpoint: ${this._endpoint}`);
    this._websocket = this._openWebsocket();
    Promise.resolve().then(() => {
      tryWith(this, () => this._eventHandler.onConnecting?.(this));
      this.notify(Event.ON_CONNECTING, this);
    });
  }

  private _disconnect(): void {
    console.info(`<${this.name()}>Disconnecting: endpoint: ${this._endpoint}`);
    tryWith(this, () => this._eventHandler.onDisconnecting?.(this));
    this.notify(Event.ON_DISCONNECTING, this);
    this._closeWebsocket();
  }

  private _reconnect(delay = this._options.reconnectDelay): void {
    if (!this._shouldRun) {
      return;
    }
    this._closeWebsocket();
    this._stopReconnect();
    this._reconnectTimer = setTimeout(this._connect.bind(this), delay);
  }

  private _stopReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer as number);
      this._reconnectTimer = null;
    }
  }

  // This function will repeatedly execute at random intervals
  // between 1 and heartbeatInterval seconds.
  private _repeatHeartbeat(): void {
    if (!this._shouldRun) {
      return;
    }
    const nowMs = now();
    let duration = this._calcDelayForNextHeartbeat(nowMs);
    if (duration <= 1000) {
      // Send heartbeat immediately if the delay less than 1s,
      // Here use 1s but not 0s to avoid busy loop.
      this._sendHeartbeat();
      // Reset duration to heartbeat interval.
      duration = this._options.heartbeatInterval;
    }
    this._stopRepeatHeartbeat();
    this._heartbeatTimer = setTimeout(
      this._repeatHeartbeat.bind(this),
      duration,
    );
  }

  private _stopRepeatHeartbeat(): void {
    if (this._heartbeatTimer !== null) {
      clearTimeout(this._heartbeatTimer as number);
      this._heartbeatTimer = null;
    }
  }

  private _calcDelayForNextHeartbeat(nowMs: number): number {
    return this._sentAt + this._options.heartbeatInterval - nowMs;
  }

  private _sendHeartbeat(): void {
    try {
      this.send(this._createPingReq());
    } catch (reason: any) {
      console.debug(
        `<${this.name()}>Failed to send heartbeat: reason: ${reason.message}`,
      );
    }
  }

  private _repeatCheckStatus(): void {
    if (!this._shouldRun) {
      return;
    }
    this._stopRepeatCheckStatus();
    this._checkStatusTimer = setInterval(() => {
      const nowMs = now();
      this._checkUnhealthyTimeout(nowMs);
      this._checkIdleTimeout(nowMs);
    }, this._calcIntervalForCheckStatus());
  }

  private _stopRepeatCheckStatus(): void {
    if (this._checkStatusTimer !== null) {
      clearInterval(this._checkStatusTimer as number);
      this._checkStatusTimer = null;
    }
  }

  private _checkUnhealthyTimeout(nowMs: number): void {
    if (this._hasReceivedBeforeUnhealthyTimeout(nowMs)) {
      if (!this._isHealthy) {
        this._isHealthy = true;
        console.info(
          `<${this.name()}>Connection became healthy: endpoint: %s`,
          this._endpoint,
        );
        tryWith(this, () => this._eventHandler.onBecameHealthy?.(this));
        this.notify(Event.ON_BECAME_HEALTHY, this);
      }
    } else {
      if (this._isHealthy) {
        this._isHealthy = false;
        console.info(
          `<${this.name()}>Connection became unhealthy: endpoint: %s`,
          this._endpoint,
        );
        tryWith(this, () => this._eventHandler.onBecameUnhealthy?.(this));
        this.notify(Event.ON_BECAME_UNHEALTHY, this);
      }
    }
  }

  private _checkIdleTimeout(nowMs: number): void {
    if (this._hasSentNonePingBeforeIdleTimeout(nowMs)) {
      if (this._isIdle) {
        this._isIdle = false;
        console.info(
          `<${this.name()}>Connection became active: endpoint: %s`,
          this._endpoint,
        );
        tryWith(this, () => this._eventHandler.onBecameActive?.(this));
        this.notify(Event.ON_BECAME_ACTIVE, this);
      }
    } else {
      if (!this._isIdle) {
        this._isIdle = true;
        console.info(
          `<${this.name()}>Connection became idle: endpoint: %s`,
          this._endpoint,
        );
        tryWith(this, () => this._eventHandler.onBecameIdle?.(this));
        this.notify(Event.ON_BECAME_IDLE, this);
      }
    }
  }

  private _hasReceivedBeforeUnhealthyTimeout(nowMs: number): boolean {
    return nowMs - this._receivedAt < this._options.unhealthyTimeout;
  }

  private _hasSentNonePingBeforeIdleTimeout(nowMs: number): boolean {
    return nowMs - this._sendNonePingAt < this._options.idleTimeout;
  }

  private _calcIntervalForCheckStatus(): number {
    return Math.floor(
      Math.min(this._options.unhealthyTimeout, this._options.idleTimeout) / 2,
    );
  }

  private _createPingReq(): typeof msg_types.ping_req_t.prototype {
    return new msg_types.ping_req_t({});
  }

  private _newRef(): number {
    if (this._lastRef > 100000000) {
      this._lastRef = 1;
    }
    return ++this._lastRef;
  }

  private _buildUrl(): string {
    if (this._options.sslEnabled) {
      return `wss://${this._endpoint}/$ws`;
    } else {
      return `ws://${this._endpoint}/$ws`;
    }
  }

  private _deleteAttachment(ref: number): void {
    this._attachments.delete(ref);
  }
}

type PickEndpoint = () => AbortablePromise<string>;

export class MultiAltEndpointsConnection
  extends Listenable
  implements IConnection, IEventHandler
{
  private _id: number = ++ID_SEED;
  private _pickEndpoint: PickEndpoint;
  private _options: Required<ConnectionOptions>;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _connectTask: AbortablePromise<void> | null;
  private _reconnectTimer: Timer | null;
  private _openCondition: Condition<MultiAltEndpointsConnection>;
  private _closedCondition: Condition<MultiAltEndpointsConnection>;
  private _readyState: ReadyState;
  private _connection: Connection | null;

  //===========================================
  // APIs
  //===========================================

  constructor(
    pickEndpoint: PickEndpoint,
    options: Required<ConnectionOptions>,
    eventHandler: IEventHandler = new DefaultEventHandler(),
  ) {
    super();
    this._pickEndpoint = pickEndpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._shouldRun = true;
    this._connectTask = null;
    this._reconnectTimer = null;
    this._openCondition = new Condition<MultiAltEndpointsConnection>(
      this,
      () => {
        return this.isOpen();
      },
    );
    this._closedCondition = new Condition<MultiAltEndpointsConnection>(
      this,
      () => {
        return this.isClosed();
      },
    );
    this._readyState = ReadyState.CONNECTING;
    this._connection = null;
    this._connect();
  }

  id(): number {
    return this._id;
  }

  name(): string {
    return `m${this._id}c${this._connection?.id() ?? "?"}`;
  }

  endpoint(): string | undefined {
    return this._connection?.endpoint();
  }

  isHealthy(): boolean {
    return this._connection !== null && this._connection.isHealthy();
  }

  isOpen(): boolean {
    return this._connection !== null && this._connection.isOpen();
  }

  waitOpen(timeout?: number): AbortablePromise<MultiAltEndpointsConnection> {
    return this._openCondition.wait(timeout);
  }

  isClosed(): boolean {
    return !this._shouldRun && this._readyState === ReadyState.CLOSED;
  }

  close(): void {
    if (!this._shouldRun) {
      return;
    }
    this._shouldRun = false;
    this._stopReconnect();
    this._connectTask?.abort(new AbortError());
    this._openCondition.clear();
    this._connection?.close();
  }

  closeAndWait(
    timeout?: number,
  ): AbortablePromise<MultiAltEndpointsConnection> {
    this.close();
    return this._closedCondition.wait(timeout).then(() => {
      super.clear();
      return this;
    });
  }

  request(
    msg: any,
    options: RequestOptions = {},
  ): AbortablePromise<ProtocolMsg> {
    if (this._connection === null) {
      return AbortablePromise.reject(
        new Error("Failed to request: reason: connection lost"),
      );
    }
    return this._connection.request(msg, options);
  }

  send(msg: any): void {
    if (this._connection === null) {
      throw new Error("Failed to send msg: reason: connection lost");
    }
    this._connection.send(msg);
  }

  //===========================================
  // IEventHandler implementation
  //===========================================

  onConnecting(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onConnecting?.(this, connection, ...rest),
    );
    this.notify(Event.ON_CONNECTING, this, connection, ...rest);
  }

  onConnected(connection: Connection, ...rest: any[]): void {
    this._readyState = ReadyState.OPEN;
    console.debug(
      `<${this.name()}>Connection was opened, notify waiters: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
    );
    this._openCondition.notify();
    tryWith(this, () =>
      this._eventHandler.onConnected?.(this, connection, ...rest),
    );
    this.notify(Event.ON_CONNECTED, this, connection, ...rest);
  }

  onDisconnecting(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onDisconnecting?.(this, connection, ...rest),
    );
    this.notify(Event.ON_DISCONNECTING, this, connection, ...rest);
  }

  onDisconnected(connection: Connection, ...rest: any[]): void {
    this._readyState = ReadyState.CLOSED;
    if (!this._shouldRun) {
      console.debug(
        `<${this.name()}>Connection was closed, notify waiters: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
      );
      this._closedCondition.notify();
    }
    tryWith(this, () =>
      this._eventHandler.onDisconnected?.(this, connection, ...rest),
    );
    this.notify(Event.ON_DISCONNECTED, this, connection, ...rest);
    this._reconnect();
  }

  onCorrupted(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onCorrupted?.(this, connection, ...rest),
    );
    this.notify(Event.ON_CORRUPTED, this, connection, ...rest);
  }

  onBecameUnhealthy(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onBecameUnhealthy?.(this, connection, ...rest),
    );
    this.notify(Event.ON_BECAME_UNHEALTHY, this, connection, ...rest);
  }

  onBecameHealthy(connection: IConnection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onBecameHealthy?.(this, connection, ...rest),
    );
    this.notify(Event.ON_BECAME_HEALTHY, this, connection, ...rest);
  }

  onBecameActive(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onBecameActive?.(this, connection, ...rest),
    );
    this.notify(Event.ON_BECAME_ACTIVE, this, connection, ...rest);
  }

  onBecameIdle(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onBecameIdle?.(this, connection, ...rest),
    );
    this.notify(Event.ON_BECAME_IDLE, this, connection, ...rest);
  }

  //===========================================
  // internal functions
  //===========================================

  private _connect(): void {
    this._connectTask = this._pickEndpoint()
      .then((endpiont) => {
        if (!this._shouldRun) {
          return;
        }
        this._connection = new Connection(endpiont, this._options, this);
      })
      .catch((reason: any) => {
        console.error(
          `<${this.name()}>Failed to pick endpoint: reason: ${reason}`,
        );
        this._readyState = ReadyState.CLOSED;
        if (!this._shouldRun) {
          this._closedCondition.notify();
        }
        this._reconnect();
      });
  }

  private _reconnect(delay = this._options.reconnectDelay): void {
    if (!this._shouldRun) {
      return;
    }
    this._connection?.close();
    this._stopReconnect();
    this._reconnectTimer = setTimeout(this._connect.bind(this), delay);
  }

  private _stopReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer as number);
      this._reconnectTimer = null;
    }
  }
}

export type ConnectionPoolOptions = {
  minPoolSize?: number;
  maxPoolSize?: number;
} & ConnectionOptions;

export function makeConnectionPoolOptions(
  options?: ConnectionPoolOptions,
): Required<ConnectionPoolOptions> {
  if (typeof options === "undefined") {
    options = {};
  }
  return {
    minPoolSize: options.minPoolSize ?? 1,
    maxPoolSize: options.maxPoolSize ?? 3,
    ...makeConnectionOptions(options),
  };
}

export class ConnectionPool
  extends Listenable
  implements IEventHandler, Identity
{
  private _id: number = ++ID_SEED;
  private _pickEndpoint: PickEndpoint;
  private _options: Required<ConnectionPoolOptions>;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _allConnections: MultiAltEndpointsConnection[];
  private _healthyConnections: MultiAltEndpointsConnection[];
  private _closingConnections: Map<number, MultiAltEndpointsConnection>;
  private _healthyIndexSeed: number;

  //===========================================
  // APIs
  //===========================================

  constructor(
    pickEndpoint: PickEndpoint,
    options: Required<ConnectionPoolOptions>,
    eventHandler: IEventHandler = new DefaultEventHandler(),
  ) {
    super();
    this._pickEndpoint = pickEndpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._shouldRun = true;
    this._allConnections = [];
    this._healthyConnections = [];
    this._closingConnections = new Map<number, MultiAltEndpointsConnection>();
    this._healthyIndexSeed = 0;

    for (let i = 0; i < this._options.minPoolSize; i++) {
      this._addFreshConnection(this._createConnection());
    }
  }

  id(): number {
    return this._id;
  }

  name(): string {
    return `p${this._id}`;
  }

  size(): number {
    return this._allConnections.length;
  }

  waitAllOpen(timeout?: number): AbortablePromise<ConnectionPool> {
    const promises = this._allConnections.map((connection) =>
      connection.waitOpen(timeout),
    );
    return AbortablePromise.all(promises).then(() => this);
  }

  close(): void {
    if (!this._shouldRun) {
      return;
    }
    this._shouldRun = false;
    for (const connection of this._allConnections) {
      connection.close();
    }
    this._allConnections = [];
    this._healthyConnections = [];
    this._closingConnections.clear();
  }

  closeAndWait(timeout?: number): AbortablePromise<ConnectionPool> {
    if (!this._shouldRun) {
      return AbortablePromise.resolve(this);
    }
    this._shouldRun = false;

    for (const connection of this._allConnections) {
      this._closingConnections.set(connection.id(), connection);
    }
    const promises = [];
    for (const connection of this._closingConnections.values()) {
      promises.push(connection.closeAndWait(timeout));
    }
    return AbortablePromise.all(promises).then(() => {
      this._allConnections = [];
      this._healthyConnections = [];
      this._closingConnections.clear();
      super.clear();
      return this;
    });
  }

  getConnection(): MultiAltEndpointsConnection {
    if (this._healthyConnections.length > 0) {
      return this._healthyConnections[this._nextHealthyIndex()];
    }

    if (this._allConnections.length < this._options.maxPoolSize) {
      const connection = this._createConnection();
      this._addFreshConnection(connection);
      return connection;
    }

    // If no healthy connections and at max size, return any connection
    return this._allConnections[
      Math.floor(Math.random() * this._allConnections.length)
    ];
  }

  //===========================================
  // IEventHandler implementation
  //===========================================

  onConnecting(connection: MultiAltEndpointsConnection, ...rest: any[]): void {
    tryWith(connection, () =>
      this._eventHandler.onConnecting?.(connection, ...rest),
    );
    this.notify(Event.ON_CONNECTING, connection, ...rest);
  }

  onConnected(connection: MultiAltEndpointsConnection, ...rest: any[]): void {
    tryWith(connection, () =>
      this._eventHandler.onConnected?.(connection, ...rest),
    );
    this.notify(Event.ON_CONNECTED, connection, ...rest);
  }

  onDisconnecting(
    connection: MultiAltEndpointsConnection,
    ...rest: any[]
  ): void {
    tryWith(connection, () =>
      this._eventHandler.onDisconnecting?.(connection, ...rest),
    );
    this.notify(Event.ON_DISCONNECTING, connection, ...rest);
  }

  onDisconnected(
    connection: MultiAltEndpointsConnection,
    ...rest: any[]
  ): void {
    if (connection.isClosed()) {
      console.debug(
        `<${this.name()}>Connection was closed, will drop it: name: ${connection.name()},endpoint: ${connection.endpoint()}`,
      );
      this._dropConnection(connection);
    }
    tryWith(connection, () =>
      this._eventHandler.onDisconnected?.(connection, ...rest),
    );
    this.notify(Event.ON_DISCONNECTED, connection, ...rest);
  }

  onCorrupted(connection: MultiAltEndpointsConnection, ...rest: any[]): void {
    tryWith(connection, () =>
      this._eventHandler.onCorrupted?.(connection, ...rest),
    );
    this.notify(Event.ON_CORRUPTED, connection, ...rest);
  }

  onBecameUnhealthy(
    connection: MultiAltEndpointsConnection,
    ...rest: any[]
  ): void {
    console.debug(
      `<${this.name()}>Connection became unhealthy, updating health: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
    );
    this._updateConnectionHealth(connection);
    tryWith(connection, () =>
      this._eventHandler.onBecameUnhealthy?.(connection, ...rest),
    );
    this.notify(Event.ON_BECAME_UNHEALTHY, connection, ...rest);
  }

  onBecameHealthy(
    connection: MultiAltEndpointsConnection,
    ...rest: any[]
  ): void {
    console.debug(
      `<${this.name()}>Connection became healthy, updating health: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
    );
    this._updateConnectionHealth(connection);
    tryWith(connection, () =>
      this._eventHandler.onBecameHealthy?.(connection, ...rest),
    );
  }

  onBecameIdle(connection: MultiAltEndpointsConnection, ...rest: any[]): void {
    console.debug(
      `<${this.name()}>Connection became idle, will drop it: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
    );
    this._dropConnection(connection);
    tryWith(connection, () =>
      this._eventHandler.onBecameIdle?.(connection, ...rest),
    );
    this.notify(Event.ON_BECAME_IDLE, connection, ...rest);
  }

  onBecameActive(
    connection: MultiAltEndpointsConnection,
    ...rest: any[]
  ): void {
    tryWith(connection, () =>
      this._eventHandler.onBecameActive?.(connection, ...rest),
    );
    this.notify(Event.ON_BECAME_ACTIVE, connection, ...rest);
  }

  //===========================================
  // internal functions
  //===========================================

  private _createConnection(): MultiAltEndpointsConnection {
    return new MultiAltEndpointsConnection(
      this._pickEndpoint,
      this._options,
      this,
    );
  }

  private _addFreshConnection(connection: MultiAltEndpointsConnection): void {
    this._allConnections.push(connection);
    this._healthyConnections.push(connection);
  }

  private _updateConnectionHealth(
    connection: MultiAltEndpointsConnection,
  ): void {
    const isHealthy = connection.isHealthy();
    const healthyIndex = this._healthyConnections.indexOf(connection);

    if (isHealthy && healthyIndex === -1) {
      this._healthyConnections.push(connection);
    } else if (!isHealthy && healthyIndex !== -1) {
      this._healthyConnections.splice(healthyIndex, 1);
    }
  }

  private _dropConnection(connection: MultiAltEndpointsConnection): void {
    if (!this._shouldRun) {
      console.debug(
        `<${this.name()}>Dropping connection, but pool is closing, just ignore it: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
      );
      return;
    }

    console.debug(
      `<${this.name()}>Dropping connection: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
    );

    const oldPoolSize = this._allConnections.length;
    const allIndex = this._allConnections.indexOf(connection);
    if (allIndex > -1) {
      this._allConnections.splice(allIndex, 1);
    }
    const healthyIndex = this._healthyConnections.indexOf(connection);
    if (healthyIndex > -1) {
      this._healthyConnections.splice(healthyIndex, 1);
    }

    const newPoolSize = this._allConnections.length;
    if (newPoolSize < oldPoolSize) {
      console.info(
        `<${this.name()}>Connection removed from pool: old pool size: ${oldPoolSize}, new pool size: ${newPoolSize}, name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
      );
    } else {
      console.debug(
        `<${this.name()}>No such connection in pool, maybe already removed: name: ${connection.name()}, endpoint: ${connection.endpoint()}`,
      );
    }

    if (connection.isClosed()) {
      this._closingConnections.delete(connection.id());
    } else {
      this._closingConnections.set(connection.id(), connection);
      connection.close();
    }

    const minPoolSize = this._options.minPoolSize;
    if (this._allConnections.length < minPoolSize) {
      console.info(
        `<${this.name()}>Creating connections, since the pool size(${this._allConnections.length}) is less than min pool size(${minPoolSize}).`,
      );
      for (let i = 0; i < minPoolSize - this._allConnections.length; i++) {
        this._addFreshConnection(this._createConnection());
      }
    }
  }

  private _nextHealthyIndex(): number {
    if (this._healthyIndexSeed >= this._healthyConnections.length - 1) {
      this._healthyIndexSeed = 0;
    } else {
      ++this._healthyIndexSeed;
    }
    return this._healthyIndexSeed;
  }
}

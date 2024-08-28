import { AbortablePromise } from "@xuchaoqian/abortable-promise";
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

export interface Options {
  reconnectDelay?: number;
  heartbeatInterval?: number;
  roundTimeout?: number;
  unhealthyTimeout?: number;
  idleTimeout?: number;
  sslEnabled?: boolean;
  roundLogEnabled?: boolean;
}

export function defaultOptions(options?: Options): Required<Options> {
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
  ON_UNHEALTHY_TIMEOUT = 105,
  ON_IDLE_TIMEOUT = 106,
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

export class DefaultEventHandler implements IEventHandler {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

// [resolve, reject]
type Attachment = [(value: ProtocolMsg) => void, (reason?: Error) => void];

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
  private _options: Required<Options>;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _heartbeatTimer: Timer | null;
  private _checkStatusTimer: Timer | null;
  private _reconnectTimer: Timer | null;
  private _sentAt: number;
  private _sendNonePingAt: number;
  private _receivedAt: number;
  private _isHealthy: boolean;
  private _lastRef: number;
  private _attachments: Map<number, Attachment>;
  private _condition: Condition<Connection>;
  private _websocket: WebSocket | null;

  //===========================================
  // APIs
  //===========================================
  constructor(
    endpoint: string,
    options: Required<Options>,
    eventHandler: IEventHandler = new DefaultEventHandler(),
  ) {
    super();
    this._endpoint = endpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._shouldRun = true;
    this._heartbeatTimer = null;
    this._checkStatusTimer = null;
    this._reconnectTimer = null;
    this._sentAt = 0;
    this._sendNonePingAt = 0;
    this._receivedAt = 0;
    this._isHealthy = true;
    this._lastRef = 0;
    this._attachments = new Map();
    this._condition = new Condition<Connection>(this, () => {
      return this.isOpen();
    });
    this._websocket = null;
    this._connect();
  }

  close(): void {
    if (!this._shouldRun) {
      return;
    }
    this._shouldRun = false;
    this._condition.clear();
    this._stopReconnect();
    this._stopRepeatCheckStatus();
    this._stopRepeatHeartbeat();
    this._disconnect();
    this._attachments.clear();
  }

  closeAndWait(): AbortablePromise<void> {
    if (!this.isOpen()) {
      this.close();
      return AbortablePromise.resolve();
    }
    const closed = new AbortablePromise<void>((resolve) => {
      const unlisten = this.addListener(Event.ON_DISCONNECTED, () => {
        resolve();
        unlisten();
      });
      const unlisten2 = this.addListener(Event.ON_CORRUPTED, () => {
        resolve();
        unlisten2();
      });
    });
    this.close();
    return closed;
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

  isOpen(): boolean {
    return this._websocket !== null && this._websocket.readyState === 1;
  }

  waitOpen(timeout?: number): AbortablePromise<Connection> {
    return this._condition.wait(timeout);
  }

  request(msg: ProtocolMsg, timeout?: number): AbortablePromise<ProtocolMsg> {
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
    })
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
      promise.abort(reason);
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

  private _onMsg(event: any) {
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

  private _onOpen() {
    console.info(
      `<${this.name()}>Connection connected: endpoint: ${this._endpoint}`,
    );
    const nowMs = now();
    this._sentAt = nowMs;
    this._sendNonePingAt = nowMs;
    this._receivedAt = nowMs;
    this._repeatHeartbeat();
    this._repeatCheckStatus();
    this._condition.notify();
    tryWith(this, () => this._eventHandler.onConnected?.(this));
    this.notify(Event.ON_CONNECTED, this);
  }

  private _onClose() {
    console.info(
      `<${this.name()}>Connection disconnected: endpoint: ${this._endpoint}`,
    );
    this._stopRepeatHeartbeat();
    this._stopRepeatCheckStatus();
    tryWith(this, () => this._eventHandler.onDisconnected?.(this));
    this.notify(Event.ON_DISCONNECTED, this);
    this._reconnect();
  }

  private _onError(reason: any) {
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

  private _openWebsocket() {
    const websocket = new WebSocketImpl(this._buildUrl());
    websocket.binaryType = "arraybuffer";
    websocket.onmessage = this._onMsg.bind(this);
    websocket.onopen = this._onOpen.bind(this);
    websocket.onclose = this._onClose.bind(this);
    websocket.onerror = this._onError.bind(this);
    return websocket;
  }

  private _closeWebsocket() {
    if (this._websocket !== null) {
      this._websocket.close();
      this._websocket = null;
    }
  }

  private _connect() {
    console.info(`<${this.name()}>Connecting: endpoint: ${this._endpoint}`);
    tryWith(this, () => this._eventHandler.onConnecting?.(this));
    this.notify(Event.ON_CONNECTING, this);
    this._websocket = this._openWebsocket();
  }

  private _disconnect() {
    console.info(`<${this.name()}>Disconnecting: endpoint: ${this._endpoint}`);
    tryWith(this, () => this._eventHandler.onDisconnecting?.(this));
    this.notify(Event.ON_DISCONNECTING, this);
    this._closeWebsocket();
  }

  private _reconnect(delay = this._options.reconnectDelay) {
    if (!this._shouldRun) {
      return;
    }
    this._closeWebsocket();
    this._stopReconnect();
    this._reconnectTimer = setTimeout(this._connect.bind(this), delay);
  }

  private _stopReconnect() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer as number);
      this._reconnectTimer = null;
    }
  }

  // This function will repeatedly execute at random intervals
  // between 1 and heartbeatInterval seconds.
  private _repeatHeartbeat() {
    if (!this._shouldRun) {
      return;
    }
    const nowMs = now();
    let duration = this._calcDelayForNextHeartbeat(nowMs);
    if (duration <= 1000) {
      console.debug(`<${this.name()}>Sending heartbeat`);
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

  private _stopRepeatHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearTimeout(this._heartbeatTimer as number);
      this._heartbeatTimer = null;
    }
  }

  private _calcDelayForNextHeartbeat(nowMs: number) {
    return this._sentAt + this._options.heartbeatInterval - nowMs;
  }

  private _sendHeartbeat() {
    try {
      this.send(this._createPingReq());
    } catch (reason: any) {
      console.debug(
        `<${this.name()}>Failed to send heartbeat: reason: ${reason.message}`,
      );
    }
  }

  private _repeatCheckStatus() {
    if (!this._shouldRun) {
      return;
    }
    this._stopRepeatCheckStatus();
    this._checkStatusTimer = setInterval(() => {
      console.debug(`<${this.name()}>check status`);
      const nowMs = now();
      this._checkUnhealthyTimeout(nowMs);
      this._checkIdleTimeout(nowMs);
    }, this._calcIntervalForCheckStatus());
  }

  private _stopRepeatCheckStatus() {
    if (this._checkStatusTimer !== null) {
      clearInterval(this._checkStatusTimer as number);
      this._checkStatusTimer = null;
    }
  }

  private _checkUnhealthyTimeout(nowMs: number) {
    if (this._hasReceivedBeforeUnhealthyTimeout(nowMs)) {
      this._isHealthy = true;
    } else {
      this._isHealthy = false;
      console.warn(
        `<${this.name()}>Connection became unhealthy: endpoint: %s`,
        this._endpoint,
      );
      tryWith(this, () => this._eventHandler.onUnhealthyTimeout?.(this));
      this.notify(Event.ON_UNHEALTHY_TIMEOUT, this);
    }
  }

  private _checkIdleTimeout(nowMs: number) {
    if (!this._hasSentNonePingBeforeIdleTimeout(nowMs)) {
      console.info(
        `<${this.name()}>Connection became idle: endpoint: %s`,
        this._endpoint,
      );
      tryWith(this, () => this._eventHandler.onIdleTimeout?.(this));
      this.notify(Event.ON_IDLE_TIMEOUT, this);
    }
  }

  private _hasReceivedBeforeUnhealthyTimeout(nowMs: number) {
    return nowMs - this._receivedAt < this._options.unhealthyTimeout;
  }

  private _hasSentNonePingBeforeIdleTimeout(nowMs: number) {
    return nowMs - this._sendNonePingAt < this._options.idleTimeout;
  }

  private _calcIntervalForCheckStatus() {
    return Math.floor(
      Math.min(this._options.heartbeatInterval, this._options.idleTimeout) / 2,
    );
  }

  private _createPingReq() {
    return new msg_types.ping_req_t({});
  }

  private _newRef() {
    if (this._lastRef > 100000000) {
      this._lastRef = 1;
    }
    return ++this._lastRef;
  }

  private _buildUrl() {
    if (this._options.sslEnabled) {
      return `wss://${this._endpoint}/$ws`;
    } else {
      return `ws://${this._endpoint}/$ws`;
    }
  }

  private _deleteAttachment(ref: number) {
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
  private _options: Required<Options>;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _connectTask: AbortablePromise<void> | null;
  private _reconnectTimer: Timer | null;
  private _condition: Condition<MultiAltEndpointsConnection>;
  private _connection: Connection | null;

  //===========================================
  // APIs
  //===========================================

  constructor(
    pickEndpoint: PickEndpoint,
    options: Required<Options>,
    eventHandler: IEventHandler = new DefaultEventHandler(),
  ) {
    super();
    this._pickEndpoint = pickEndpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._shouldRun = true;
    this._connectTask = null;
    this._reconnectTimer = null;
    this._condition = new Condition<MultiAltEndpointsConnection>(this, () => {
      return this.isOpen();
    });
    this._connection = null;
    this._connect();
  }

  close(): void {
    if (!this._shouldRun) {
      return;
    }
    this._shouldRun = false;
    this._stopReconnect();
    this._connectTask?.abort();
    this._condition.clear();
    this._connection?.close();
  }

  closeAndWait(): AbortablePromise<void> {
    if (!this.isOpen()) {
      this.close();
      return AbortablePromise.resolve();
    }
    const closed = new AbortablePromise<void>((resolve) => {
      const unlisten = this.addListener(Event.ON_DISCONNECTED, () => {
        resolve();
        unlisten();
      });
      const unlisten2 = this.addListener(Event.ON_CORRUPTED, () => {
        resolve();
        unlisten2();
      });
    });
    this.close();
    return closed;
  }

  id(): number {
    return this._id;
  }

  name(): string {
    return `m${this._id}c${this._connection?.id() ?? 0}`;
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
    return this._condition.wait(timeout);
  }

  request(
    msg: any,
    timeout?: number | undefined,
  ): AbortablePromise<ProtocolMsg> {
    if (this._connection === null) {
      return AbortablePromise.reject(
        new Error("Failed to request: reason: connection lost"),
      );
    }
    return this._connection.request(msg, timeout);
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
    this._condition.notify();
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

  onUnhealthyTimeout(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onUnhealthyTimeout?.(this, connection, ...rest),
    );
    this.notify(Event.ON_UNHEALTHY_TIMEOUT, this, connection, ...rest);
  }

  onIdleTimeout(connection: Connection, ...rest: any[]): void {
    tryWith(this, () =>
      this._eventHandler.onIdleTimeout?.(this, connection, ...rest),
    );
    this.notify(Event.ON_IDLE_TIMEOUT, this, connection, ...rest);
  }

  //===========================================
  // internal functions
  //===========================================

  private _connect() {
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
        this._reconnect();
      });
  }

  private _reconnect(delay = this._options.reconnectDelay) {
    if (!this._shouldRun) {
      return;
    }
    this._connection?.close();
    this._stopReconnect();
    this._reconnectTimer = setTimeout(this._connect.bind(this), delay);
  }

  private _stopReconnect() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer as number);
      this._reconnectTimer = null;
    }
  }
}

export type PoolOptions = {
  minPoolSize?: number;
  maxPoolSize?: number;
} & Options;

export function defaultPoolOptions(
  options?: PoolOptions,
): Required<PoolOptions> {
  if (typeof options === "undefined") {
    options = {};
  }
  return {
    minPoolSize: options.minPoolSize ?? 1,
    maxPoolSize: options.maxPoolSize ?? 5,
    ...defaultOptions(options),
  };
}

export class ConnectionPool
  extends Listenable
  implements IEventHandler, Identity
{
  private _id: number = ++ID_SEED;
  private _pickEndpoint: PickEndpoint;
  private _options: Required<PoolOptions>;
  private _eventHandler: IEventHandler;
  private _connections: MultiAltEndpointsConnection[];
  private _indexSeed: number;

  //===========================================
  // APIs
  //===========================================

  constructor(
    pickEndpoint: PickEndpoint,
    options: Required<PoolOptions>,
    eventHandler: IEventHandler = new DefaultEventHandler(),
  ) {
    super();
    this._pickEndpoint = pickEndpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._connections = [];
    this._indexSeed = 0;

    for (let i = 0; i < this._options.minPoolSize; i++) {
      this._connections.push(this._createConnection());
    }
  }

  close(): void {
    for (const connection of this._connections) {
      connection.close();
    }
    this._connections = [];
  }

  closeAndWait(): AbortablePromise<void> {
    const promises = this._connections.map((connection) =>
      connection.closeAndWait(),
    );
    return AbortablePromise.all(promises).then(() => {});
  }

  id(): number {
    return this._id;
  }

  name(): string {
    return `p${this._id}`;
  }

  size(): number {
    return this._connections.length;
  }

  waitAllOpen(timeout?: number): AbortablePromise<ConnectionPool> {
    const promises = this._connections.map((connection) =>
      connection.waitOpen(timeout),
    );
    return AbortablePromise.all(promises).then(() => this);
  }

  getConnection(): MultiAltEndpointsConnection {
    const index = this._nextIndex();
    const len = this._connections.length;
    for (let i = index; i < len; i++) {
      if (this._connections[i].isHealthy()) {
        return this._connections[i];
      }
    }
    for (let i = 0; i < index; i++) {
      if (this._connections[i].isHealthy()) {
        return this._connections[i];
      }
    }

    if (len < this._options.maxPoolSize) {
      const connection = this._createConnection();
      this._connections.push(connection);
      return connection;
    }

    return this._connections[index];
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
    tryWith(connection, () =>
      this._eventHandler.onDisconnected?.(connection, ...rest),
    );
    this.notify(Event.ON_DISCONNECTED, connection, ...rest);
  }

  onCorrupted(connection: MultiAltEndpointsConnection, ...rest: any[]): void {
    this._tryDropConnection(connection as MultiAltEndpointsConnection);
    tryWith(connection, () =>
      this._eventHandler.onCorrupted?.(connection, ...rest),
    );
    this.notify(Event.ON_CORRUPTED, connection, ...rest);
  }

  onUnhealthyTimeout(
    connection: MultiAltEndpointsConnection,
    ...rest: any[]
  ): void {
    tryWith(connection, () =>
      this._eventHandler.onUnhealthyTimeout?.(connection, ...rest),
    );
    this.notify(Event.ON_UNHEALTHY_TIMEOUT, connection, ...rest);
  }

  onIdleTimeout(connection: MultiAltEndpointsConnection, ...rest: any[]): void {
    this._tryDropConnection(connection as MultiAltEndpointsConnection);
    tryWith(connection, () =>
      this._eventHandler.onIdleTimeout?.(connection, ...rest),
    );
    this.notify(Event.ON_IDLE_TIMEOUT, connection, ...rest);
  }

  //===========================================
  // internal functions
  //===========================================

  _createConnection(): MultiAltEndpointsConnection {
    return new MultiAltEndpointsConnection(
      this._pickEndpoint,
      this._options,
      this,
    );
  }

  _tryDropConnection(connection: MultiAltEndpointsConnection): void {
    const oldPoolSize = this._connections.length;
    const minPoolSize = this._options.minPoolSize;
    if (oldPoolSize <= minPoolSize) {
      console.info(
        `<${this.name()}>No need to drop connection, since the pool size is already at min size: ${minPoolSize}`,
      );
      return;
    }
    const index = this._connections.indexOf(connection);
    if (index > -1) {
      this._connections.splice(index, 1);
    }

    const newPoolSize = this._connections.length;
    console.info(
      `<${this.name()}>Dropping connection: name: ${connection.name()}, old pool size: ${oldPoolSize}, new pool size: ${newPoolSize}, endpoint: ${connection.endpoint()}`,
    );
    connection.close();
  }

  _nextIndex(): number {
    if (this._indexSeed >= this._connections.length - 1) {
      this._indexSeed = 0;
    } else {
      ++this._indexSeed;
    }
    return this._indexSeed;
  }
}

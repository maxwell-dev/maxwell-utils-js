import { AbortablePromise } from "@xuchaoqian/abortable-promise";
import { msg_types, encode_msg, decode_msg } from "maxwell-protocol";
import {
  ProtocolMsg,
  Timer,
  Condition,
  Listenable,
  IListenable,
  TimeoutError,
} from "./internal";

const WebSocketImpl =
  typeof WebSocket !== "undefined" ? WebSocket : require("ws");

export interface IOptions {
  reconnectDelay?: number;
  heartbeatInterval?: number;
  roundTimeout?: number;
  retryRouteCount?: number;
  sslEnabled?: boolean;
  roundDebugEnabled?: boolean;
}

export class Options implements IOptions {
  readonly reconnectDelay: number;
  readonly heartbeatInterval: number;
  readonly roundTimeout: number;
  readonly retryRouteCount: number;
  readonly sslEnabled: boolean;
  readonly roundDebugEnabled: boolean;

  constructor(options?: IOptions) {
    if (typeof options === "undefined") {
      options = {};
    }
    if (typeof options.reconnectDelay === "undefined") {
      this.reconnectDelay = 3000;
    } else {
      this.reconnectDelay = options.reconnectDelay;
    }
    if (typeof options.heartbeatInterval === "undefined") {
      this.heartbeatInterval = 10000;
    } else {
      this.heartbeatInterval = options.heartbeatInterval;
    }
    if (typeof options.roundTimeout === "undefined") {
      this.roundTimeout = 15000;
    } else {
      this.roundTimeout = options.roundTimeout;
    }
    if (typeof options.retryRouteCount === "undefined") {
      this.retryRouteCount = 0;
    } else {
      this.retryRouteCount = options.retryRouteCount;
    }
    if (typeof options.sslEnabled === "undefined") {
      this.sslEnabled = false;
    } else {
      this.sslEnabled = options.sslEnabled;
    }
    if (typeof options.roundDebugEnabled === "undefined") {
      this.roundDebugEnabled = false;
    } else {
      this.roundDebugEnabled = options.roundDebugEnabled;
    }
  }
}

export enum Event {
  ON_CONNECTING = 100,
  ON_CONNECTED = 101,
  ON_DISCONNECTING = 102,
  ON_DISCONNECTED = 103,
  ON_CORRUPTED = 104,
}

export interface IEventHandler {
  onConnecting(connection: IConnection, ...rest: any[]): void;
  onConnected(connection: IConnection, ...rest: any[]): void;
  onDisconnecting(connection: IConnection, ...rest: any[]): void;
  onDisconnected(connection: IConnection, ...rest: any[]): void;
  onCorrupted(connection: IConnection, ...rest: any[]): void;
}

class DefaultEventHandler implements IEventHandler {
  onConnecting(): void {}
  onConnected(): void {}
  onDisconnecting(): void {}
  onDisconnected(): void {}
  onCorrupted(): void {}
}

// [resolve, reject, msg, retryRouteCount, timer|null]
type Attachment = [
  (value: ProtocolMsg) => void,
  (reason?: Error) => void,
  ProtocolMsg,
  number,
  Timer | null,
];

export interface IConnection extends IListenable {
  close(): void;
  endpoint(): string | undefined;
  isOpen(): boolean;
  waitOpen(timeout?: number): AbortablePromise<IConnection>;
  request(msg: ProtocolMsg, timeout?: number): AbortablePromise<ProtocolMsg>;
  send(msg: ProtocolMsg): void;
}

let ID_SEED = 0;

export class Connection extends Listenable implements IConnection {
  private _id: number = ID_SEED++;
  private _endpoint: string;
  private _options: Options;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _heartbeatTimer: Timer | null;
  private _reconnectTimer: Timer | null;
  private _receivedAt: number;
  private _lastRef: number;
  private _attachments: Map<number, Attachment>;
  private _condition: Condition<Connection>;
  private _websocket: WebSocket | null;

  //===========================================
  // APIs
  //===========================================
  constructor(
    endpoint: string,
    options: Options,
    eventHandler: IEventHandler = new DefaultEventHandler()
  ) {
    super();
    this._endpoint = endpoint;
    this._options = options;
    this._eventHandler = eventHandler;
    this._shouldRun = true;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._receivedAt = Connection._now();
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
    this._disconnect();
    this._attachments.clear();
  }

  id(): number {
    return this._id;
  }

  endpoint(): string {
    return this._endpoint;
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
      this._attachments.set(ref, [resolve, reject, msg, 0, null]);
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
    if (this._options.roundDebugEnabled) {
      const limitedMsg = JSON.stringify(msg).substring(0, 100);
      console.debug(`Sending msg: [${msg.constructor.name}]${limitedMsg}`);
    }

    let encodedMsg;
    try {
      encodedMsg = encode_msg(msg);
    } catch (reason: any) {
      const errorMsg = `Failed to encode msg: reason: ${reason.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    if (this._websocket == null) {
      const errorMsg = `Failed to send msg: reason: connection lost`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
    try {
      this._websocket.send(encodedMsg);
    } catch (reason: any) {
      const errorMsg = `Failed to send msg: reason: ${reason.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  //===========================================
  // websocket callbacks
  //===========================================
  private _onOpen() {
    console.info(
      `Connection connected: id: ${this._id}, endpoint: ${this._endpoint}`
    );
    this._keepAlive();
    this._condition.notify();
    tryWith(() => this._eventHandler.onConnected(this));
    this.notify(Event.ON_CONNECTED, this);
  }

  private _onClose() {
    console.info(
      `Connection disconnected: id: ${this._id}, endpoint: ${this._endpoint}`
    );
    this._stopKeepAlive();
    tryWith(() => this._eventHandler.onDisconnected(this));
    this.notify(Event.ON_DISCONNECTED, this);
    this._reconnect();
  }

  // eslint-disable-next-line
  private _onMsg(event: any) {
    this._receivedAt = Connection._now();

    let msg: ProtocolMsg;

    try {
      msg = decode_msg(event.data);
    } catch (reason: any) {
      console.error(
        `Failed to decode msg: reason: ${reason.message}, msg: %o`,
        event.data
      );
      return;
    }

    const msgType = msg.constructor;

    if (msgType === msg_types.ping_rep_t) {
      // do nothing
    } else {
      if (this._options.roundDebugEnabled) {
        console.debug(
          `Received msg: [${msgType.name}]` +
            `${JSON.stringify(msg).substring(0, 100)}`
        );
      }

      const ref = msg.ref;

      const attachment = this._attachments.get(ref);
      if (typeof attachment === "undefined") {
        console.debug(`The reply's peer request was lost: ref: ${ref}`);
        return;
      }

      if (
        msgType === msg_types.error_rep_t ||
        msgType === msg_types.error2_rep_t
      ) {
        if (
          this._options.retryRouteCount > 0 &&
          msg.desc.includes("frontend_not_found") &&
          attachment[3] < this._options.retryRouteCount
        ) {
          attachment[4] = setTimeout(() => {
            this.send(attachment[2]);
          }, 500 * ++attachment[3]);
        } else {
          try {
            attachment[1](new Error(`code: ${msg.code}, desc: ${msg.desc}`));
          } finally {
            this._deleteAttachment(ref);
          }
        }
      } else {
        try {
          attachment[0](msg);
        } finally {
          this._deleteAttachment(ref);
        }
      }
    }
  }

  private _onError(e: any) {
    console.error(
      `Connection corrupted: id: ${this._id}, endpoint: ${this._endpoint}, error: ${e.message}`
    );
    tryWith(() => this._eventHandler.onCorrupted(this));
    this.notify(Event.ON_CORRUPTED, this);
  }

  //===========================================
  // internal functions
  //===========================================

  private _openWebsocket() {
    const websocket = new WebSocketImpl(this._buildUrl());
    websocket.binaryType = "arraybuffer";
    websocket.onopen = this._onOpen.bind(this);
    websocket.onclose = this._onClose.bind(this);
    websocket.onmessage = this._onMsg.bind(this);
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
    console.info(`Connecting: id: ${this._id}, endpoint: ${this._endpoint}`);
    tryWith(() => this._eventHandler.onConnecting(this));
    this.notify(Event.ON_CONNECTING, this);
    this._websocket = this._openWebsocket();
  }

  private _disconnect() {
    console.info(`Disconnecting: id: ${this._id}, endpoint: ${this._endpoint}`);
    tryWith(() => this._eventHandler.onDisconnecting(this));
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

  private _keepAlive() {
    if (!this._shouldRun) {
      return;
    }
    this._stopKeepAlive();
    this._heartbeatTimer = setInterval(
      this._closeOrSendHeartbeat.bind(this),
      this._options.heartbeatInterval
    );
  }

  private _stopKeepAlive() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer as number);
      this._heartbeatTimer = null;
    }
  }

  private _closeOrSendHeartbeat() {
    if (this._isConnectionBroken()) {
      console.warn(
        `Connection broken: id: ${this._id}, endpoint: ${this._endpoint}`
      );
      this._closeWebsocket();
      return;
    }
    try {
      this.send(this._createPingReq());
    } catch (reason: any) {
      console.debug(`Failed to send heartbeat: reason: ${reason.message}`);
    }
  }

  private _isConnectionBroken() {
    return (
      Connection._now() - this._receivedAt >=
      this._options.heartbeatInterval * 1.5
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
    const attachments = this._attachments.get(ref);
    if (typeof attachments === "undefined") {
      return;
    }
    if (attachments[4] !== null) {
      clearTimeout(attachments[4] as number);
    }
    this._attachments.delete(ref);
  }

  private static _now() {
    return new Date().getTime();
  }
}

type PickEndpoint = () => AbortablePromise<string>;

export class MultiAltEndpointsConnection
  extends Listenable
  implements IConnection, IEventHandler
{
  private _pickEndpoint: PickEndpoint;
  private _options: Options;
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
    options: Options,
    eventHandler: IEventHandler = new DefaultEventHandler()
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

  endpoint(): string | undefined {
    return this._connection?.endpoint();
  }

  isOpen(): boolean {
    return this._connection !== null && this._connection.isOpen();
  }

  waitOpen(timeout?: number): AbortablePromise<MultiAltEndpointsConnection> {
    return this._condition.wait(timeout);
  }

  request(
    msg: any,
    timeout?: number | undefined
  ): AbortablePromise<ProtocolMsg> {
    return this._connection!.request(msg, timeout);
  }

  send(msg: any): void {
    return this._connection!.send(msg);
  }

  //===========================================
  // IEventHandler implementation
  //===========================================

  onConnecting(connection: Connection): void {
    tryWith(() => this._eventHandler.onConnecting(this, connection));
    this.notify(Event.ON_CONNECTING, this, connection);
  }

  onConnected(connection: Connection): void {
    this._condition.notify();
    tryWith(() => this._eventHandler.onConnected(this, connection));
    this.notify(Event.ON_CONNECTED, this, connection);
  }

  onDisconnecting(connection: Connection): void {
    tryWith(() => this._eventHandler.onDisconnecting(this, connection));
    this.notify(Event.ON_DISCONNECTING, this, connection);
  }

  onDisconnected(connection: Connection): void {
    tryWith(() => this._eventHandler.onDisconnected(this, connection));
    this.notify(Event.ON_DISCONNECTED, this, connection);
    this._reconnect();
  }

  onCorrupted(connection: Connection): void {
    tryWith(() => this._eventHandler.onCorrupted(this, connection));
    this.notify(Event.ON_CORRUPTED, this, connection);
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
        console.error(`Failed to pick endpoint: reason: ${reason}`);
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

function tryWith(callback: () => void) {
  try {
    callback();
  } catch (reason: any) {
    console.error(`Failed to execute: reason: ${reason.message}`);
  }
}

export default Connection;

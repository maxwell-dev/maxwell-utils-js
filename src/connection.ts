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
  defaultRoundTimeout?: number;
  retryRouteCount?: number;
  sslEnabled?: boolean;
  debugRoundEnabled?: boolean;
}

export class Options implements IOptions {
  readonly reconnectDelay: number;
  readonly heartbeatInterval: number;
  readonly defaultRoundTimeout: number;
  readonly retryRouteCount: number;
  readonly sslEnabled: boolean;
  readonly debugRoundEnabled: boolean;

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
    if (typeof options.defaultRoundTimeout === "undefined") {
      this.defaultRoundTimeout = 15000;
    } else {
      this.defaultRoundTimeout = options.defaultRoundTimeout;
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
    if (typeof options.debugRoundEnabled === "undefined") {
      this.debugRoundEnabled = false;
    } else {
      this.debugRoundEnabled = options.debugRoundEnabled;
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

export class Connection extends Listenable implements IConnection {
  private _endpoint: string;
  private _options: Options;
  private _eventHandler: IEventHandler;
  private _shouldRun: boolean;
  private _heartbeatTimer: Timer | null;
  private _reconnectTimer: Timer | null;
  private _sentAt: number;
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
    this._sentAt = 0;
    this._lastRef = 0;
    this._attachments = new Map();
    this._condition = new Condition<Connection>(this, () => {
      return this.isOpen();
    });
    this._websocket = null;
    this._connect();
  }

  close(): void {
    this._shouldRun = false;
    this._condition.clear();
    this._stopReconnect();
    this._disconnect();
    this._attachments.clear();
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
      timeout = this._options.defaultRoundTimeout;
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
      .then((value) => {
        this._deleteAttachment(ref);
        clearTimeout(timer as number);
        return value;
      })
      .catch((reason) => {
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
    if (this._options.debugRoundEnabled) {
      const limitedMsg = JSON.stringify(msg).substring(0, 100);
      console.debug(`Sending msg: [${msg.constructor.name}]${limitedMsg}`);
    }

    let encodedMsg;
    try {
      encodedMsg = encode_msg(msg);
    } catch (e: any) {
      const errorMsg = `Failed to encode msg: reason: ${e.message}`;
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
      this._sentAt = this._now();
    } catch (e: any) {
      const errorMsg = `Failed to send msg: reason: ${e.message}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  //===========================================
  // websocket callbacks
  //===========================================
  private _onOpen() {
    console.log(`Connection connected: endpoint: ${this._endpoint}`);
    this._repeatSendHeartbeat();
    this._condition.notify();
    this._eventHandler.onConnected(this);
    this.notify(Event.ON_CONNECTED, this);
  }

  private _onClose() {
    if (!process.env.RUN_IN_JEST) {
      console.log(`Connection disconnected: endpoint: ${this._endpoint}`);
    }
    this._stopRepeatSendHeartbeat();
    this._eventHandler.onDisconnected(this);
    this.notify(Event.ON_DISCONNECTED, this);
    this._reconnect();
  }

  // eslint-disable-next-line
  private _onMsg(event: any) {
    let msg: ProtocolMsg;

    try {
      msg = decode_msg(event.data);
    } catch (e: any) {
      console.error(`Failed to decode msg: reason: ${e.message}`);
      return;
    }

    const msgType = msg.constructor;

    if (msgType === msg_types.ping_rep_t) {
      // do nothing
    } else {
      if (this._options.debugRoundEnabled) {
        console.debug(
          `Received msg: [${msgType.name}]` +
            `${JSON.stringify(msg).substring(0, 100)}`
        );
      }

      const ref = msg.ref;

      const attachment = this._attachments.get(ref);
      if (typeof attachment === "undefined") {
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
      `Connection corrupted: endpoint: ${this._endpoint}, error: ${e.message}`
    );
    this._eventHandler.onCorrupted(this);
    this.notify(Event.ON_CORRUPTED, this);
  }

  //===========================================
  // internal functions
  //===========================================

  private _connect() {
    console.log(`Connecting: endpoint: ${this._endpoint}`);
    this._eventHandler.onConnecting(this);
    this.notify(Event.ON_CONNECTING, this);
    const websocket = new WebSocketImpl(this._buildUrl());
    websocket.binaryType = "arraybuffer";
    websocket.onopen = this._onOpen.bind(this);
    websocket.onclose = this._onClose.bind(this);
    websocket.onmessage = this._onMsg.bind(this);
    websocket.onerror = this._onError.bind(this);
    this._websocket = websocket;
  }

  private _disconnect() {
    console.log(`Disconnecting: endpoint: ${this._endpoint}`);
    this._eventHandler.onDisconnecting(this);
    this.notify(Event.ON_DISCONNECTING, this);
    if (this._websocket !== null) {
      this._websocket.close();
      this._websocket = null;
    }
  }

  private _reconnect() {
    if (!this._shouldRun) {
      return;
    }
    this._stopReconnect();
    this._reconnectTimer = setTimeout(
      this._connect.bind(this),
      this._options.reconnectDelay
    );
  }

  private _stopReconnect() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer as number);
      this._reconnectTimer = null;
    }
  }

  private _repeatSendHeartbeat() {
    if (!this._shouldRun) {
      return;
    }
    this._stopRepeatSendHeartbeat();
    this._heartbeatTimer = setInterval(
      this._sendHeartbeat.bind(this),
      this._options.heartbeatInterval
    );
  }

  private _stopRepeatSendHeartbeat() {
    if (this._heartbeatTimer !== null) {
      clearInterval(this._heartbeatTimer as number);
      this._heartbeatTimer = null;
    }
  }

  private _sendHeartbeat() {
    if (this.isOpen() && !this._hasSentHeartbeat()) {
      this.send(this._createPingReq());
    }
  }

  private _hasSentHeartbeat() {
    return this._now() - this._sentAt < this._options.heartbeatInterval;
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

  private _now() {
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

  onConnecting(connection: IConnection): void {
    this._eventHandler.onConnecting(this, connection);
    this.notify(Event.ON_CONNECTING, this, connection);
  }

  onConnected(connection: IConnection): void {
    this._condition.notify();
    this._eventHandler.onConnected(this, connection);
    this.notify(Event.ON_CONNECTED, this, connection);
  }

  onDisconnecting(connection: IConnection): void {
    this._eventHandler.onDisconnecting(this, connection);
    this.notify(Event.ON_DISCONNECTING, this, connection);
  }

  onDisconnected(connection: IConnection): void {
    this._eventHandler.onDisconnected(this, connection);
    this.notify(Event.ON_DISCONNECTED, this, connection);
  }

  onCorrupted(connection: IConnection): void {
    this._reconnect();
    this._eventHandler.onCorrupted(this, connection);
    this.notify(Event.ON_CORRUPTED, this, connection);
  }

  //===========================================
  // internal functions
  //===========================================

  private _connect() {
    this._connectTask = this._pickEndpoint()
      .then((endpiont) => {
        const oldConnection = this._connection;
        this._connection = new Connection(endpiont, this._options, this);
        oldConnection?.close();
      })
      .catch((reason) => {
        console.error(`Failed to pick endpoint: ${reason.stack}`);
        this._reconnect();
      });
  }

  private _reconnect() {
    if (!this._shouldRun) {
      return;
    }
    this._stopReconnect();
    this._reconnectTimer = setTimeout(
      this._connect.bind(this),
      this._options.reconnectDelay
    );
  }

  private _stopReconnect() {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer as number);
      this._reconnectTimer = null;
    }
  }
}

export default Connection;

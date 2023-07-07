import { msg_types, encode_msg, decode_msg } from "maxwell-protocol";
import { Timer, Condition, Listenable, PromisePlus } from "./internal";

const WebSocketImpl =
  typeof WebSocket !== "undefined" ? WebSocket : require("ws");

export enum Event {
  ON_CONNECTING = 100,
  ON_CONNECTED = 101,
  ON_DISCONNECTING = 102,
  ON_DISCONNECTED = 103,
  ON_MESSAGE = 104,
  ON_ERROR = 1,
}

export enum Code {
  FAILED_TO_ENCODE = 1,
  FAILED_TO_SEND = 2,
  FAILED_TO_DECODE = 3,
  FAILED_TO_RECEIVE = 4,
  FAILED_TO_CONNECT = 5,
  UNKNOWN_ERROR = 6,
}

export interface IOptions {
  reconnectDelay?: number;

  heartbeatInterval?: number;

  defaultRoundTimeout?: number;

  retryRouteCount?: number;

  sslEnabled?: boolean;

  debugRoundEnabled?: boolean;
}

class Options implements IOptions {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ProtocolMsg = any;

// [resolve, reject, msg, retryRouteCount, timer|null]
type Attachment = [
  (value: ProtocolMsg) => void,
  (reason?: Error) => void,
  ProtocolMsg,
  number,
  Timer | null
];

export class Connection extends Listenable {
  private _endpoint: string;
  private _options: Options;
  private _shouldRun: boolean;
  private _heartbeatTimer: Timer | null;
  private _reconnectTimer: Timer | null;
  private _sentAt: number;
  private _lastRef: number;
  private _attachments: Map<number, Attachment>;
  private _condition: Condition;
  private _websocket: WebSocket | null;

  //===========================================
  // APIs
  //===========================================
  constructor(endpoint: string, options: IOptions) {
    super();

    this._endpoint = endpoint;
    this._options = new Options(options);

    this._shouldRun = true;
    this._heartbeatTimer = null;
    this._reconnectTimer = null;
    this._sentAt = 0;
    this._lastRef = 0;
    this._attachments = new Map();
    this._condition = new Condition(() => {
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

  isOpen(): boolean {
    return this._websocket !== null && this._websocket.readyState === 1;
  }

  async waitUntilOpen(): Promise<void> {
    await this._condition.wait();
  }

  getEndpoint(): string {
    return this._endpoint;
  }

  request(msg: ProtocolMsg, timeout?: number): PromisePlus {
    const ref = this._newRef();

    msg.ref = ref;

    if (typeof timeout === "undefined") {
      timeout = this._options.defaultRoundTimeout;
    }

    const pp = new PromisePlus(
      (resolve, reject) => {
        this._attachments.set(ref, [resolve, reject, msg, 0, null]);
      },
      timeout,
      msg
    ).catch((reason) => {
      this._deleteAttachment(ref);
      throw reason;
    });

    try {
      this.send(msg);
    } catch (reason: any) {
      this._deleteAttachment(ref);
      throw reason;
    }

    return pp.then((result) => result);
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
      const errorMsg = `Failed to encode msg: reason: ${e.stack}`;
      console.error(errorMsg);
      this.notify(Event.ON_ERROR, Code.FAILED_TO_ENCODE);
      throw new Error(errorMsg);
    }

    if (this._websocket == null) {
      const errorMsg = `Failed to send msg: reason: connection lost`;
      console.error(errorMsg);
      this.notify(Event.ON_ERROR, Code.FAILED_TO_SEND);
      throw new Error(errorMsg);
    }
    try {
      this._websocket.send(encodedMsg);
      this._sentAt = this._now();
    } catch (e: any) {
      const errorMsg = `Failed to send msg: reason: ${e.stack}`;
      console.error(errorMsg);
      this.notify(Event.ON_ERROR, Code.FAILED_TO_SEND);
      throw new Error(errorMsg);
    }
  }

  //===========================================
  // websocket callbacks
  //===========================================
  private _onOpen() {
    this._repeatSendHeartbeat();
    console.log(`Connection connected: endpoint: ${this._endpoint}`);
    this._condition.notify();
    this.notify(Event.ON_CONNECTED);
  }

  private _onClose() {
    this._stopSendHeartbeat();
    if (this._shouldRun) {
      this._reconnect();
    }
    console.log(`Connection disconnected: endpoint: ${this._endpoint}`);
    this.notify(Event.ON_DISCONNECTED);
  }

  // eslint-disable-next-line
  private _onMsg(event: any) {
    let msg: ProtocolMsg;

    try {
      msg = decode_msg(event.data);
    } catch (e: any) {
      console.error(`Failed to decode msg: reason: ${e.stack}`);
      this.notify(Event.ON_ERROR, Code.FAILED_TO_DECODE);
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
      `Failed to connect: endpoint: ${this._endpoint}, error: ${e.message}`
    );
    this.notify(Event.ON_ERROR, Code.FAILED_TO_CONNECT);
  }

  //===========================================
  // internal functions
  //===========================================

  private _connect() {
    console.log(`Connecting: endpoint: ${this._endpoint}`);
    this.notify(Event.ON_CONNECTING);
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
    this.notify(Event.ON_DISCONNECTING);
    if (this._websocket !== null) {
      this._websocket.close();
      this._websocket = null;
    }
  }

  private _reconnect() {
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
    this._heartbeatTimer = setInterval(
      this._sendHeartbeat.bind(this),
      this._options.heartbeatInterval
    );
  }

  private _stopSendHeartbeat() {
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

  private _now() {
    return new Date().getTime();
  }

  private _buildUrl() {
    if (this._options.sslEnabled) {
      return `wss://${this._endpoint}/ws`;
    } else {
      return `ws://${this._endpoint}/ws`;
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
}

export default Connection;

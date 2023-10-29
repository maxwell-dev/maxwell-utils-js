"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Connection = exports.Options = exports.ErrorCode = exports.Event = void 0;
const maxwell_protocol_1 = require("maxwell-protocol");
const internal_1 = require("./internal");
const WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : require("ws");
var Event;
(function (Event) {
    Event[Event["ON_CONNECTING"] = 100] = "ON_CONNECTING";
    Event[Event["ON_CONNECTED"] = 101] = "ON_CONNECTED";
    Event[Event["ON_DISCONNECTING"] = 102] = "ON_DISCONNECTING";
    Event[Event["ON_DISCONNECTED"] = 103] = "ON_DISCONNECTED";
    Event[Event["ON_MESSAGE"] = 104] = "ON_MESSAGE";
    Event[Event["ON_ERROR"] = 1] = "ON_ERROR";
})(Event || (exports.Event = Event = {}));
var ErrorCode;
(function (ErrorCode) {
    ErrorCode[ErrorCode["FAILED_TO_ENCODE"] = 1] = "FAILED_TO_ENCODE";
    ErrorCode[ErrorCode["FAILED_TO_SEND"] = 2] = "FAILED_TO_SEND";
    ErrorCode[ErrorCode["FAILED_TO_DECODE"] = 3] = "FAILED_TO_DECODE";
    ErrorCode[ErrorCode["FAILED_TO_RECEIVE"] = 4] = "FAILED_TO_RECEIVE";
    ErrorCode[ErrorCode["FAILED_TO_CONNECT"] = 5] = "FAILED_TO_CONNECT";
    ErrorCode[ErrorCode["UNKNOWN_ERROR"] = 6] = "UNKNOWN_ERROR";
})(ErrorCode || (exports.ErrorCode = ErrorCode = {}));
class Options {
    constructor(options) {
        if (typeof options === "undefined") {
            options = {};
        }
        if (typeof options.reconnectDelay === "undefined") {
            this.reconnectDelay = 3000;
        }
        else {
            this.reconnectDelay = options.reconnectDelay;
        }
        if (typeof options.heartbeatInterval === "undefined") {
            this.heartbeatInterval = 10000;
        }
        else {
            this.heartbeatInterval = options.heartbeatInterval;
        }
        if (typeof options.defaultRoundTimeout === "undefined") {
            this.defaultRoundTimeout = 15000;
        }
        else {
            this.defaultRoundTimeout = options.defaultRoundTimeout;
        }
        if (typeof options.retryRouteCount === "undefined") {
            this.retryRouteCount = 0;
        }
        else {
            this.retryRouteCount = options.retryRouteCount;
        }
        if (typeof options.sslEnabled === "undefined") {
            this.sslEnabled = false;
        }
        else {
            this.sslEnabled = options.sslEnabled;
        }
        if (typeof options.debugRoundEnabled === "undefined") {
            this.debugRoundEnabled = false;
        }
        else {
            this.debugRoundEnabled = options.debugRoundEnabled;
        }
    }
}
exports.Options = Options;
class Connection extends internal_1.Listenable {
    constructor(endpoint, options) {
        super();
        this._endpoint = endpoint;
        this._options = options;
        this._shouldRun = true;
        this._heartbeatTimer = null;
        this._reconnectTimer = null;
        this._sentAt = 0;
        this._lastRef = 0;
        this._attachments = new Map();
        this._condition = new internal_1.Condition(() => {
            return this.isOpen();
        });
        this._websocket = null;
        this._connect();
    }
    close() {
        this._shouldRun = false;
        this._condition.clear();
        this._stopReconnect();
        this._disconnect();
        this._attachments.clear();
    }
    isOpen() {
        return this._websocket !== null && this._websocket.readyState === 1;
    }
    async waitOpen() {
        await this._condition.wait();
    }
    endpoint() {
        return this._endpoint;
    }
    request(msg, timeout) {
        const ref = this._newRef();
        msg.ref = ref;
        if (typeof timeout === "undefined") {
            timeout = this._options.defaultRoundTimeout;
        }
        const pp = new internal_1.PromisePlus((resolve, reject) => {
            this._attachments.set(ref, [resolve, reject, msg, 0, null]);
        }, timeout, msg).catch((reason) => {
            this._deleteAttachment(ref);
            throw reason;
        });
        try {
            this.send(msg);
        }
        catch (reason) {
            this._deleteAttachment(ref);
            throw reason;
        }
        return pp.then((result) => result);
    }
    send(msg) {
        if (this._options.debugRoundEnabled) {
            const limitedMsg = JSON.stringify(msg).substring(0, 100);
            console.debug(`Sending msg: [${msg.constructor.name}]${limitedMsg}`);
        }
        let encodedMsg;
        try {
            encodedMsg = (0, maxwell_protocol_1.encode_msg)(msg);
        }
        catch (e) {
            const errorMsg = `Failed to encode msg: reason: ${e.stack}`;
            console.error(errorMsg);
            this.notify(Event.ON_ERROR, this, ErrorCode.FAILED_TO_ENCODE);
            throw new Error(errorMsg);
        }
        if (this._websocket == null) {
            const errorMsg = `Failed to send msg: reason: connection lost`;
            console.error(errorMsg);
            this.notify(Event.ON_ERROR, this, ErrorCode.FAILED_TO_SEND);
            throw new Error(errorMsg);
        }
        try {
            this._websocket.send(encodedMsg);
            this._sentAt = this._now();
        }
        catch (e) {
            const errorMsg = `Failed to send msg: reason: ${e.stack}`;
            console.error(errorMsg);
            this.notify(Event.ON_ERROR, this, ErrorCode.FAILED_TO_SEND);
            throw new Error(errorMsg);
        }
    }
    _onOpen() {
        console.log(`Connection connected: endpoint: ${this._endpoint}`);
        this._repeatSendHeartbeat();
        this._condition.notify();
        this.notify(Event.ON_CONNECTED, this);
    }
    _onClose() {
        console.log(`Connection disconnected: endpoint: ${this._endpoint}`);
        this._stopSendHeartbeat();
        this.notify(Event.ON_DISCONNECTED, this);
        if (this._shouldRun) {
            this._reconnect();
        }
    }
    _onMsg(event) {
        let msg;
        try {
            msg = (0, maxwell_protocol_1.decode_msg)(event.data);
        }
        catch (e) {
            console.error(`Failed to decode msg: reason: ${e.stack}`);
            this.notify(Event.ON_ERROR, this, ErrorCode.FAILED_TO_DECODE);
            return;
        }
        const msgType = msg.constructor;
        if (msgType === maxwell_protocol_1.msg_types.ping_rep_t) {
        }
        else {
            if (this._options.debugRoundEnabled) {
                console.debug(`Received msg: [${msgType.name}]` +
                    `${JSON.stringify(msg).substring(0, 100)}`);
            }
            const ref = msg.ref;
            const attachment = this._attachments.get(ref);
            if (typeof attachment === "undefined") {
                return;
            }
            if (msgType === maxwell_protocol_1.msg_types.error_rep_t ||
                msgType === maxwell_protocol_1.msg_types.error2_rep_t) {
                if (this._options.retryRouteCount > 0 &&
                    msg.desc.includes("frontend_not_found") &&
                    attachment[3] < this._options.retryRouteCount) {
                    attachment[4] = setTimeout(() => {
                        this.send(attachment[2]);
                    }, 500 * ++attachment[3]);
                }
                else {
                    try {
                        attachment[1](new Error(`code: ${msg.code}, desc: ${msg.desc}`));
                    }
                    finally {
                        this._deleteAttachment(ref);
                    }
                }
            }
            else {
                try {
                    attachment[0](msg);
                }
                finally {
                    this._deleteAttachment(ref);
                }
            }
        }
    }
    _onError(e) {
        console.error(`Failed to connect: endpoint: ${this._endpoint}, error: ${e.message}`);
        this.notify(Event.ON_ERROR, ErrorCode.FAILED_TO_CONNECT);
    }
    _connect() {
        console.log(`Connecting: endpoint: ${this._endpoint}`);
        this.notify(Event.ON_CONNECTING, this);
        const websocket = new WebSocketImpl(this._buildUrl());
        websocket.binaryType = "arraybuffer";
        websocket.onopen = this._onOpen.bind(this);
        websocket.onclose = this._onClose.bind(this);
        websocket.onmessage = this._onMsg.bind(this);
        websocket.onerror = this._onError.bind(this);
        this._websocket = websocket;
    }
    _disconnect() {
        console.log(`Disconnecting: endpoint: ${this._endpoint}`);
        this.notify(Event.ON_DISCONNECTING, this);
        if (this._websocket !== null) {
            this._websocket.close();
            this._websocket = null;
        }
    }
    _reconnect() {
        this._reconnectTimer = setTimeout(this._connect.bind(this), this._options.reconnectDelay);
    }
    _stopReconnect() {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
    _repeatSendHeartbeat() {
        this._heartbeatTimer = setInterval(this._sendHeartbeat.bind(this), this._options.heartbeatInterval);
    }
    _stopSendHeartbeat() {
        if (this._heartbeatTimer !== null) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }
    _sendHeartbeat() {
        if (this.isOpen() && !this._hasSentHeartbeat()) {
            this.send(this._createPingReq());
        }
    }
    _hasSentHeartbeat() {
        return this._now() - this._sentAt < this._options.heartbeatInterval;
    }
    _createPingReq() {
        return new maxwell_protocol_1.msg_types.ping_req_t({});
    }
    _newRef() {
        if (this._lastRef > 100000000) {
            this._lastRef = 1;
        }
        return ++this._lastRef;
    }
    _now() {
        return new Date().getTime();
    }
    _buildUrl() {
        if (this._options.sslEnabled) {
            return `wss://${this._endpoint}/$ws`;
        }
        else {
            return `ws://${this._endpoint}/$ws`;
        }
    }
    _deleteAttachment(ref) {
        const attachments = this._attachments.get(ref);
        if (typeof attachments === "undefined") {
            return;
        }
        if (attachments[4] !== null) {
            clearTimeout(attachments[4]);
        }
        this._attachments.delete(ref);
    }
}
exports.Connection = Connection;
exports.default = Connection;
//# sourceMappingURL=connection.js.map
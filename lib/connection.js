"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAltEndpointsConnection = exports.Connection = exports.Event = exports.Options = void 0;
const abortable_promise_1 = require("@xuchaoqian/abortable-promise");
const maxwell_protocol_1 = require("maxwell-protocol");
const internal_1 = require("./internal");
const WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : require("ws");
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
        if (typeof options.roundTimeout === "undefined") {
            this.roundTimeout = 15000;
        }
        else {
            this.roundTimeout = options.roundTimeout;
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
        if (typeof options.roundDebugEnabled === "undefined") {
            this.roundDebugEnabled = false;
        }
        else {
            this.roundDebugEnabled = options.roundDebugEnabled;
        }
    }
}
exports.Options = Options;
var Event;
(function (Event) {
    Event[Event["ON_CONNECTING"] = 100] = "ON_CONNECTING";
    Event[Event["ON_CONNECTED"] = 101] = "ON_CONNECTED";
    Event[Event["ON_DISCONNECTING"] = 102] = "ON_DISCONNECTING";
    Event[Event["ON_DISCONNECTED"] = 103] = "ON_DISCONNECTED";
    Event[Event["ON_CORRUPTED"] = 104] = "ON_CORRUPTED";
})(Event || (exports.Event = Event = {}));
class DefaultEventHandler {
    onConnecting() { }
    onConnected() { }
    onDisconnecting() { }
    onDisconnected() { }
    onCorrupted() { }
}
let ID_SEED = 0;
class Connection extends internal_1.Listenable {
    constructor(endpoint, options, eventHandler = new DefaultEventHandler()) {
        super();
        this._id = ID_SEED++;
        this._endpoint = endpoint;
        this._options = options;
        this._eventHandler = eventHandler;
        this._shouldRun = true;
        this._heartbeatTimer = null;
        this._reconnectTimer = null;
        this._receivedAt = 0;
        this._lastRef = 0;
        this._attachments = new Map();
        this._condition = new internal_1.Condition(this, () => {
            return this.isOpen();
        });
        this._websocket = null;
        this._connect();
    }
    close() {
        if (!this._shouldRun) {
            return;
        }
        this._shouldRun = false;
        this._condition.clear();
        this._stopReconnect();
        this._disconnect();
        this._attachments.clear();
    }
    id() {
        return this._id;
    }
    endpoint() {
        return this._endpoint;
    }
    isOpen() {
        return this._websocket !== null && this._websocket.readyState === 1;
    }
    waitOpen(timeout) {
        return this._condition.wait(timeout);
    }
    request(msg, timeout) {
        if (typeof timeout === "undefined") {
            timeout = this._options.roundTimeout;
        }
        const ref = this._newRef();
        msg.ref = ref;
        let timer;
        const promise = new abortable_promise_1.AbortablePromise((resolve, reject) => {
            this._attachments.set(ref, [resolve, reject, msg, 0, null]);
            timer = setTimeout(() => {
                reject(new internal_1.TimeoutError(JSON.stringify(msg).substring(0, 100)));
            }, timeout);
        })
            .then((value) => {
            this._deleteAttachment(ref);
            clearTimeout(timer);
            return value;
        })
            .catch((reason) => {
            this._deleteAttachment(ref);
            clearTimeout(timer);
            throw reason;
        });
        try {
            this.send(msg);
        }
        catch (reason) {
            promise.abort(reason);
        }
        return promise;
    }
    send(msg) {
        if (this._options.roundDebugEnabled) {
            const limitedMsg = JSON.stringify(msg).substring(0, 100);
            console.debug(`Sending msg: [${msg.constructor.name}]${limitedMsg}`);
        }
        let encodedMsg;
        try {
            encodedMsg = (0, maxwell_protocol_1.encode_msg)(msg);
        }
        catch (reason) {
            console.error(`Failed to encode msg: reason: %o`, reason.message ?? reason);
            throw new Error(`Failed to encode msg: reason: ${reason.message}`);
        }
        if (this._websocket == null) {
            const errorMsg = `Failed to send msg: reason: connection lost`;
            console.error(errorMsg);
            throw new Error(errorMsg);
        }
        try {
            this._websocket.send(encodedMsg);
        }
        catch (reason) {
            console.error(`Failed to send msg: reason: %o`, reason.message ?? reason);
            throw new Error(`Failed to send msg: reason: ${reason.message}`);
        }
    }
    _onOpen() {
        console.info(`Connection connected: id: ${this._id}, endpoint: ${this._endpoint}`);
        this._receivedAt = Connection._now();
        this._keepAlive();
        this._condition.notify();
        tryWith(() => this._eventHandler.onConnected(this));
        this.notify(Event.ON_CONNECTED, this);
    }
    _onClose() {
        console.info(`Connection disconnected: id: ${this._id}, endpoint: ${this._endpoint}`);
        this._stopKeepAlive();
        tryWith(() => this._eventHandler.onDisconnected(this));
        this.notify(Event.ON_DISCONNECTED, this);
        this._reconnect();
    }
    _onMsg(event) {
        this._receivedAt = Connection._now();
        let msg;
        try {
            msg = (0, maxwell_protocol_1.decode_msg)(event.data);
        }
        catch (reason) {
            console.error(`Failed to decode msg: reason: %o, msg: %o`, reason.message ?? reason, event.data);
            return;
        }
        const msgType = msg.constructor;
        if (msgType === maxwell_protocol_1.msg_types.ping_rep_t) {
        }
        else {
            if (this._options.roundDebugEnabled) {
                console.debug(`Received msg: [${msgType.name}]` +
                    `${JSON.stringify(msg).substring(0, 100)}`);
            }
            const ref = msg.ref;
            const attachment = this._attachments.get(ref);
            if (typeof attachment === "undefined") {
                if (this._options.roundDebugEnabled) {
                    console.debug(`The reply's peer request was lost: ref: ${ref}`);
                }
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
        console.error(`Connection corrupted: id: ${this._id}, endpoint: ${this._endpoint}, error: %o`, e.message ?? e);
        tryWith(() => this._eventHandler.onCorrupted(this));
        this.notify(Event.ON_CORRUPTED, this);
    }
    _openWebsocket() {
        const websocket = new WebSocketImpl(this._buildUrl());
        websocket.binaryType = "arraybuffer";
        websocket.onopen = this._onOpen.bind(this);
        websocket.onclose = this._onClose.bind(this);
        websocket.onmessage = this._onMsg.bind(this);
        websocket.onerror = this._onError.bind(this);
        return websocket;
    }
    _closeWebsocket() {
        if (this._websocket !== null) {
            this._websocket.close();
            this._websocket = null;
        }
    }
    _connect() {
        console.info(`Connecting: id: ${this._id}, endpoint: ${this._endpoint}`);
        tryWith(() => this._eventHandler.onConnecting(this));
        this.notify(Event.ON_CONNECTING, this);
        this._websocket = this._openWebsocket();
    }
    _disconnect() {
        console.info(`Disconnecting: id: ${this._id}, endpoint: ${this._endpoint}`);
        tryWith(() => this._eventHandler.onDisconnecting(this));
        this.notify(Event.ON_DISCONNECTING, this);
        this._closeWebsocket();
    }
    _reconnect(delay = this._options.reconnectDelay) {
        if (!this._shouldRun) {
            return;
        }
        this._closeWebsocket();
        this._stopReconnect();
        this._reconnectTimer = setTimeout(this._connect.bind(this), delay);
    }
    _stopReconnect() {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
    _keepAlive() {
        if (!this._shouldRun) {
            return;
        }
        this._stopKeepAlive();
        this._heartbeatTimer = setInterval(this._closeOrSendHeartbeat.bind(this), this._options.heartbeatInterval);
    }
    _stopKeepAlive() {
        if (this._heartbeatTimer !== null) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }
    _closeOrSendHeartbeat() {
        if (this._isConnectionBroken()) {
            console.warn(`Connection broken: id: ${this._id}, endpoint: ${this._endpoint}`);
            this._closeWebsocket();
            return;
        }
        try {
            this.send(this._createPingReq());
        }
        catch (reason) {
            console.debug(`Failed to send heartbeat: reason: ${reason.message}`);
        }
    }
    _isConnectionBroken() {
        return (Connection._now() - this._receivedAt >=
            this._options.heartbeatInterval * 1.5);
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
    static _now() {
        return new Date().getTime();
    }
}
exports.Connection = Connection;
class MultiAltEndpointsConnection extends internal_1.Listenable {
    constructor(pickEndpoint, options, eventHandler = new DefaultEventHandler()) {
        super();
        this._pickEndpoint = pickEndpoint;
        this._options = options;
        this._eventHandler = eventHandler;
        this._shouldRun = true;
        this._connectTask = null;
        this._reconnectTimer = null;
        this._condition = new internal_1.Condition(this, () => {
            return this.isOpen();
        });
        this._connection = null;
        this._connect();
    }
    close() {
        if (!this._shouldRun) {
            return;
        }
        this._shouldRun = false;
        this._stopReconnect();
        this._connectTask?.abort();
        this._condition.clear();
        this._connection?.close();
    }
    endpoint() {
        return this._connection?.endpoint();
    }
    isOpen() {
        return this._connection !== null && this._connection.isOpen();
    }
    waitOpen(timeout) {
        return this._condition.wait(timeout);
    }
    request(msg, timeout) {
        return this._connection.request(msg, timeout);
    }
    send(msg) {
        return this._connection.send(msg);
    }
    onConnecting(connection) {
        tryWith(() => this._eventHandler.onConnecting(this, connection));
        this.notify(Event.ON_CONNECTING, this, connection);
    }
    onConnected(connection) {
        this._condition.notify();
        tryWith(() => this._eventHandler.onConnected(this, connection));
        this.notify(Event.ON_CONNECTED, this, connection);
    }
    onDisconnecting(connection) {
        tryWith(() => this._eventHandler.onDisconnecting(this, connection));
        this.notify(Event.ON_DISCONNECTING, this, connection);
    }
    onDisconnected(connection) {
        tryWith(() => this._eventHandler.onDisconnected(this, connection));
        this.notify(Event.ON_DISCONNECTED, this, connection);
        this._reconnect();
    }
    onCorrupted(connection) {
        tryWith(() => this._eventHandler.onCorrupted(this, connection));
        this.notify(Event.ON_CORRUPTED, this, connection);
    }
    _connect() {
        this._connectTask = this._pickEndpoint()
            .then((endpiont) => {
            if (!this._shouldRun) {
                return;
            }
            this._connection = new Connection(endpiont, this._options, this);
        })
            .catch((reason) => {
            console.error(`Failed to pick endpoint: reason: ${reason}`);
            this._reconnect();
        });
    }
    _reconnect(delay = this._options.reconnectDelay) {
        if (!this._shouldRun) {
            return;
        }
        this._connection?.close();
        this._stopReconnect();
        this._reconnectTimer = setTimeout(this._connect.bind(this), delay);
    }
    _stopReconnect() {
        if (this._reconnectTimer !== null) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }
}
exports.MultiAltEndpointsConnection = MultiAltEndpointsConnection;
function tryWith(callback) {
    try {
        callback();
    }
    catch (reason) {
        console.error(`Failed to execute: reason: %o`, reason.message ?? reason);
    }
}
exports.default = Connection;
//# sourceMappingURL=connection.js.map
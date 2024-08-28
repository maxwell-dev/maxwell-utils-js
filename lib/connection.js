"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionPool = exports.MultiAltEndpointsConnection = exports.Connection = exports.DefaultEventHandler = exports.Event = void 0;
exports.defaultOptions = defaultOptions;
exports.defaultPoolOptions = defaultPoolOptions;
const abortable_promise_1 = require("@xuchaoqian/abortable-promise");
const maxwell_protocol_1 = require("maxwell-protocol");
const internal_1 = require("./internal");
const WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : require("ws");
function defaultOptions(options) {
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
var Event;
(function (Event) {
    Event[Event["ON_CONNECTING"] = 100] = "ON_CONNECTING";
    Event[Event["ON_CONNECTED"] = 101] = "ON_CONNECTED";
    Event[Event["ON_DISCONNECTING"] = 102] = "ON_DISCONNECTING";
    Event[Event["ON_DISCONNECTED"] = 103] = "ON_DISCONNECTED";
    Event[Event["ON_CORRUPTED"] = 104] = "ON_CORRUPTED";
    Event[Event["ON_UNHEALTHY_TIMEOUT"] = 105] = "ON_UNHEALTHY_TIMEOUT";
    Event[Event["ON_IDLE_TIMEOUT"] = 106] = "ON_IDLE_TIMEOUT";
})(Event || (exports.Event = Event = {}));
class DefaultEventHandler {
}
exports.DefaultEventHandler = DefaultEventHandler;
function tryWith(identity, callback) {
    try {
        callback();
    }
    catch (reason) {
        console.error(`<${identity.name()}>Failed to execute: reason: %o`, reason.message ?? reason);
    }
}
let ID_SEED = 0;
class Connection extends internal_1.Listenable {
    constructor(endpoint, options, eventHandler = new DefaultEventHandler()) {
        super();
        this._id = ++ID_SEED;
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
        this._stopRepeatCheckStatus();
        this._stopRepeatHeartbeat();
        this._disconnect();
        this._attachments.clear();
    }
    closeAndWait() {
        if (!this.isOpen()) {
            this.close();
            return abortable_promise_1.AbortablePromise.resolve();
        }
        const closed = new abortable_promise_1.AbortablePromise((resolve) => {
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
    id() {
        return this._id;
    }
    name() {
        return `c${this._id}`;
    }
    endpoint() {
        return this._endpoint;
    }
    isHealthy() {
        return this._isHealthy;
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
            this._attachments.set(ref, [resolve, reject]);
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
        const nowMs = (0, internal_1.now)();
        this._sentAt = nowMs;
        if (msg.constructor !== maxwell_protocol_1.msg_types.ping_rep_t) {
            this._sendNonePingAt = nowMs;
        }
        if (this._options.roundLogEnabled) {
            console.debug(`<${this.name()}>Sending msg: [${msg.constructor.name}]%s %o`, JSON.stringify(msg).substring(0, 100), msg);
        }
        let encodedMsg;
        try {
            encodedMsg = (0, maxwell_protocol_1.encode_msg)(msg);
        }
        catch (reason) {
            console.error(`<${this.name()}>Failed to encode msg: reason: %o`, reason.message ?? reason);
            throw new Error(`Failed to encode msg: reason: ${reason.message}`);
        }
        if (this._websocket == null) {
            console.error(`<${this.name()}>Failed to send msg: reason: connection lost`);
            throw new Error("Failed to send msg: reason: connection lost");
        }
        try {
            this._websocket.send(encodedMsg);
        }
        catch (reason) {
            console.error(`<${this.name()}>Failed to send msg: reason: %o`, reason.message ?? reason);
            throw new Error(`Failed to send msg: reason: ${reason.message}`);
        }
    }
    _onMsg(event) {
        this._receivedAt = (0, internal_1.now)();
        let msg;
        try {
            msg = (0, maxwell_protocol_1.decode_msg)(event.data);
        }
        catch (reason) {
            console.error(`<${this.name()}>Failed to decode msg: reason: %o, msg: %o`, reason.message ?? reason, event.data);
            return;
        }
        const msgType = msg.constructor;
        if (msgType === maxwell_protocol_1.msg_types.ping_rep_t) {
        }
        else {
            if (this._options.roundLogEnabled) {
                console.debug(`<${this.name()}>Received msg: [${msgType.name}]%s %o`, `${JSON.stringify(msg).substring(0, 100)}`, msg);
            }
            const ref = msg.ref;
            const attachment = this._attachments.get(ref);
            if (typeof attachment === "undefined") {
                if (this._options.roundLogEnabled) {
                    console.debug(`<${this.name()}>The reply's peer request was lost: ref: ${ref}`);
                }
                return;
            }
            if (msgType === maxwell_protocol_1.msg_types.error_rep_t ||
                msgType === maxwell_protocol_1.msg_types.error2_rep_t) {
                attachment[1](new Error(`code: ${msg.code}, desc: ${msg.desc}`));
            }
            else {
                attachment[0](msg);
            }
        }
    }
    _onOpen() {
        console.info(`<${this.name()}>Connection connected: endpoint: ${this._endpoint}`);
        const nowMs = (0, internal_1.now)();
        this._sentAt = nowMs;
        this._sendNonePingAt = nowMs;
        this._receivedAt = nowMs;
        this._repeatHeartbeat();
        this._repeatCheckStatus();
        this._condition.notify();
        tryWith(this, () => this._eventHandler.onConnected?.(this));
        this.notify(Event.ON_CONNECTED, this);
    }
    _onClose() {
        console.info(`<${this.name()}>Connection disconnected: endpoint: ${this._endpoint}`);
        this._stopRepeatHeartbeat();
        this._stopRepeatCheckStatus();
        tryWith(this, () => this._eventHandler.onDisconnected?.(this));
        this.notify(Event.ON_DISCONNECTED, this);
        this._reconnect();
    }
    _onError(reason) {
        console.error(`<${this.name()}>Connection corrupted: endpoint: ${this._endpoint}, error: %o`, reason.message ?? reason);
        tryWith(this, () => this._eventHandler.onCorrupted?.(this));
        this.notify(Event.ON_CORRUPTED, this);
    }
    _openWebsocket() {
        const websocket = new WebSocketImpl(this._buildUrl());
        websocket.binaryType = "arraybuffer";
        websocket.onmessage = this._onMsg.bind(this);
        websocket.onopen = this._onOpen.bind(this);
        websocket.onclose = this._onClose.bind(this);
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
        console.info(`<${this.name()}>Connecting: endpoint: ${this._endpoint}`);
        tryWith(this, () => this._eventHandler.onConnecting?.(this));
        this.notify(Event.ON_CONNECTING, this);
        this._websocket = this._openWebsocket();
    }
    _disconnect() {
        console.info(`<${this.name()}>Disconnecting: endpoint: ${this._endpoint}`);
        tryWith(this, () => this._eventHandler.onDisconnecting?.(this));
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
    _repeatHeartbeat() {
        if (!this._shouldRun) {
            return;
        }
        const nowMs = (0, internal_1.now)();
        let duration = this._calcDelayForNextHeartbeat(nowMs);
        if (duration <= 1000) {
            console.debug(`<${this.name()}>Sending heartbeat`);
            this._sendHeartbeat();
            duration = this._options.heartbeatInterval;
        }
        this._stopRepeatHeartbeat();
        this._heartbeatTimer = setTimeout(this._repeatHeartbeat.bind(this), duration);
    }
    _stopRepeatHeartbeat() {
        if (this._heartbeatTimer !== null) {
            clearTimeout(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
    }
    _calcDelayForNextHeartbeat(nowMs) {
        return this._sentAt + this._options.heartbeatInterval - nowMs;
    }
    _sendHeartbeat() {
        try {
            this.send(this._createPingReq());
        }
        catch (reason) {
            console.debug(`<${this.name()}>Failed to send heartbeat: reason: ${reason.message}`);
        }
    }
    _repeatCheckStatus() {
        if (!this._shouldRun) {
            return;
        }
        this._stopRepeatCheckStatus();
        this._checkStatusTimer = setInterval(() => {
            console.debug(`<${this.name()}>check status`);
            const nowMs = (0, internal_1.now)();
            this._checkUnhealthyTimeout(nowMs);
            this._checkIdleTimeout(nowMs);
        }, this._calcIntervalForCheckStatus());
    }
    _stopRepeatCheckStatus() {
        if (this._checkStatusTimer !== null) {
            clearInterval(this._checkStatusTimer);
            this._checkStatusTimer = null;
        }
    }
    _checkUnhealthyTimeout(nowMs) {
        if (this._hasReceivedBeforeUnhealthyTimeout(nowMs)) {
            this._isHealthy = true;
        }
        else {
            this._isHealthy = false;
            console.warn(`<${this.name()}>Connection became unhealthy: endpoint: %s`, this._endpoint);
            tryWith(this, () => this._eventHandler.onUnhealthyTimeout?.(this));
            this.notify(Event.ON_UNHEALTHY_TIMEOUT, this);
        }
    }
    _checkIdleTimeout(nowMs) {
        if (!this._hasSentNonePingBeforeIdleTimeout(nowMs)) {
            console.info(`<${this.name()}>Connection became idle: endpoint: %s`, this._endpoint);
            tryWith(this, () => this._eventHandler.onIdleTimeout?.(this));
            this.notify(Event.ON_IDLE_TIMEOUT, this);
        }
    }
    _hasReceivedBeforeUnhealthyTimeout(nowMs) {
        return nowMs - this._receivedAt < this._options.unhealthyTimeout;
    }
    _hasSentNonePingBeforeIdleTimeout(nowMs) {
        return nowMs - this._sendNonePingAt < this._options.idleTimeout;
    }
    _calcIntervalForCheckStatus() {
        return Math.floor(Math.min(this._options.heartbeatInterval, this._options.idleTimeout) / 2);
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
        this._attachments.delete(ref);
    }
}
exports.Connection = Connection;
class MultiAltEndpointsConnection extends internal_1.Listenable {
    constructor(pickEndpoint, options, eventHandler = new DefaultEventHandler()) {
        super();
        this._id = ++ID_SEED;
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
    closeAndWait() {
        if (!this.isOpen()) {
            this.close();
            return abortable_promise_1.AbortablePromise.resolve();
        }
        const closed = new abortable_promise_1.AbortablePromise((resolve) => {
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
    id() {
        return this._id;
    }
    name() {
        return `m${this._id}c${this._connection?.id() ?? 0}`;
    }
    endpoint() {
        return this._connection?.endpoint();
    }
    isHealthy() {
        return this._connection !== null && this._connection.isHealthy();
    }
    isOpen() {
        return this._connection !== null && this._connection.isOpen();
    }
    waitOpen(timeout) {
        return this._condition.wait(timeout);
    }
    request(msg, timeout) {
        if (this._connection === null) {
            return abortable_promise_1.AbortablePromise.reject(new Error("Failed to request: reason: connection lost"));
        }
        return this._connection.request(msg, timeout);
    }
    send(msg) {
        if (this._connection === null) {
            throw new Error("Failed to send msg: reason: connection lost");
        }
        this._connection.send(msg);
    }
    onConnecting(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onConnecting?.(this, connection, ...rest));
        this.notify(Event.ON_CONNECTING, this, connection, ...rest);
    }
    onConnected(connection, ...rest) {
        this._condition.notify();
        tryWith(this, () => this._eventHandler.onConnected?.(this, connection, ...rest));
        this.notify(Event.ON_CONNECTED, this, connection, ...rest);
    }
    onDisconnecting(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onDisconnecting?.(this, connection, ...rest));
        this.notify(Event.ON_DISCONNECTING, this, connection, ...rest);
    }
    onDisconnected(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onDisconnected?.(this, connection, ...rest));
        this.notify(Event.ON_DISCONNECTED, this, connection, ...rest);
        this._reconnect();
    }
    onCorrupted(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onCorrupted?.(this, connection, ...rest));
        this.notify(Event.ON_CORRUPTED, this, connection, ...rest);
    }
    onUnhealthyTimeout(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onUnhealthyTimeout?.(this, connection, ...rest));
        this.notify(Event.ON_UNHEALTHY_TIMEOUT, this, connection, ...rest);
    }
    onIdleTimeout(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onIdleTimeout?.(this, connection, ...rest));
        this.notify(Event.ON_IDLE_TIMEOUT, this, connection, ...rest);
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
            console.error(`<${this.name()}>Failed to pick endpoint: reason: ${reason}`);
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
function defaultPoolOptions(options) {
    if (typeof options === "undefined") {
        options = {};
    }
    return {
        minPoolSize: options.minPoolSize ?? 1,
        maxPoolSize: options.maxPoolSize ?? 5,
        ...defaultOptions(options),
    };
}
class ConnectionPool extends internal_1.Listenable {
    constructor(pickEndpoint, options, eventHandler = new DefaultEventHandler()) {
        super();
        this._id = ++ID_SEED;
        this._pickEndpoint = pickEndpoint;
        this._options = options;
        this._eventHandler = eventHandler;
        this._connections = [];
        this._indexSeed = 0;
        for (let i = 0; i < this._options.minPoolSize; i++) {
            this._connections.push(this._createConnection());
        }
    }
    close() {
        for (const connection of this._connections) {
            connection.close();
        }
        this._connections = [];
    }
    closeAndWait() {
        const promises = this._connections.map((connection) => connection.closeAndWait());
        return abortable_promise_1.AbortablePromise.all(promises).then(() => { });
    }
    id() {
        return this._id;
    }
    name() {
        return `p${this._id}`;
    }
    size() {
        return this._connections.length;
    }
    waitAllOpen(timeout) {
        const promises = this._connections.map((connection) => connection.waitOpen(timeout));
        return abortable_promise_1.AbortablePromise.all(promises).then(() => this);
    }
    getConnection() {
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
    onConnecting(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onConnecting?.(connection, ...rest));
        this.notify(Event.ON_CONNECTING, connection, ...rest);
    }
    onConnected(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onConnected?.(connection, ...rest));
        this.notify(Event.ON_CONNECTED, connection, ...rest);
    }
    onDisconnecting(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onDisconnecting?.(connection, ...rest));
        this.notify(Event.ON_DISCONNECTING, connection, ...rest);
    }
    onDisconnected(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onDisconnected?.(connection, ...rest));
        this.notify(Event.ON_DISCONNECTED, connection, ...rest);
    }
    onCorrupted(connection, ...rest) {
        this._tryDropConnection(connection);
        tryWith(connection, () => this._eventHandler.onCorrupted?.(connection, ...rest));
        this.notify(Event.ON_CORRUPTED, connection, ...rest);
    }
    onUnhealthyTimeout(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onUnhealthyTimeout?.(connection, ...rest));
        this.notify(Event.ON_UNHEALTHY_TIMEOUT, connection, ...rest);
    }
    onIdleTimeout(connection, ...rest) {
        this._tryDropConnection(connection);
        tryWith(connection, () => this._eventHandler.onIdleTimeout?.(connection, ...rest));
        this.notify(Event.ON_IDLE_TIMEOUT, connection, ...rest);
    }
    _createConnection() {
        return new MultiAltEndpointsConnection(this._pickEndpoint, this._options, this);
    }
    _tryDropConnection(connection) {
        const oldPoolSize = this._connections.length;
        const minPoolSize = this._options.minPoolSize;
        if (oldPoolSize <= minPoolSize) {
            console.info(`<${this.name()}>No need to drop connection, since the pool size is already at min size: ${minPoolSize}`);
            return;
        }
        const index = this._connections.indexOf(connection);
        if (index > -1) {
            this._connections.splice(index, 1);
        }
        const newPoolSize = this._connections.length;
        console.info(`<${this.name()}>Dropping connection: name: ${connection.name()}, old pool size: ${oldPoolSize}, new pool size: ${newPoolSize}, endpoint: ${connection.endpoint()}`);
        connection.close();
    }
    _nextIndex() {
        if (this._indexSeed >= this._connections.length - 1) {
            this._indexSeed = 0;
        }
        else {
            ++this._indexSeed;
        }
        return this._indexSeed;
    }
}
exports.ConnectionPool = ConnectionPool;
//# sourceMappingURL=connection.js.map
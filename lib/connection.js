"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConnectionPool = exports.MultiAltEndpointsConnection = exports.Connection = exports.DefaultEventHandler = exports.Event = void 0;
exports.buildConnectionOptions = buildConnectionOptions;
exports.buildConnectionPoolOptions = buildConnectionPoolOptions;
const abortable_promise_1 = require("@xuchaoqian/abortable-promise");
const maxwell_protocol_1 = require("maxwell-protocol");
const internal_1 = require("./internal");
const WebSocketImpl = typeof WebSocket !== "undefined" ? WebSocket : require("ws");
function buildConnectionOptions(options) {
    if (typeof options === "undefined") {
        options = {};
    }
    return {
        reconnectDelay: options.reconnectDelay ?? 3000,
        heartbeatInterval: options.heartbeatInterval ?? 10000,
        waitOpenTimeout: options.waitOpenTimeout ?? 5000,
        waitClosedTimeout: options.waitClosedTimeout ?? 5000,
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
    Event[Event["ON_BECAME_UNHEALTHY"] = 105] = "ON_BECAME_UNHEALTHY";
    Event[Event["ON_BECAME_HEALTHY"] = 106] = "ON_BECAME_HEALTHY";
    Event[Event["ON_BECAME_IDLE"] = 107] = "ON_BECAME_IDLE";
    Event[Event["ON_BECAME_ACTIVE"] = 108] = "ON_BECAME_ACTIVE";
})(Event || (exports.Event = Event = {}));
class DefaultEventHandler {
}
exports.DefaultEventHandler = DefaultEventHandler;
var ReadyState;
(function (ReadyState) {
    ReadyState[ReadyState["CONNECTING"] = 0] = "CONNECTING";
    ReadyState[ReadyState["OPEN"] = 1] = "OPEN";
    ReadyState[ReadyState["CLOSING"] = 2] = "CLOSING";
    ReadyState[ReadyState["CLOSED"] = 3] = "CLOSED";
})(ReadyState || (ReadyState = {}));
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
        this._openCondition = new internal_1.Condition(this, () => {
            return this.isOpen();
        });
        this._closedCondition = new internal_1.Condition(this, () => {
            return this.isClosed();
        });
        this._readyState = ReadyState.CONNECTING;
        this._websocket = null;
        this._connect();
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
    isIdle() {
        return this._isIdle;
    }
    isOpen() {
        return (this._websocket !== null && this._websocket.readyState === ReadyState.OPEN);
    }
    isClosed() {
        return !this._shouldRun && this._readyState === ReadyState.CLOSED;
    }
    waitOpen(options = {}) {
        if (typeof options.timeout === "undefined") {
            options = {
                timeout: this._options.waitOpenTimeout,
                signal: options.signal,
            };
        }
        return this._openCondition.wait(options);
    }
    close() {
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
    closeAndWait(options = {}) {
        this.close();
        if (typeof options.timeout === "undefined") {
            options = {
                timeout: this._options.waitClosedTimeout,
                signal: options.signal,
            };
        }
        return this._closedCondition.wait(options).then(() => {
            super.clear();
            return this;
        });
    }
    request(msg, options = {}) {
        let { timeout, signal } = options;
        if (typeof timeout === "undefined") {
            timeout = this._options.roundTimeout;
        }
        const ref = this._newRef();
        msg.ref = ref;
        let timer;
        const promise = new abortable_promise_1.AbortablePromise((resolve, reject) => {
            this._attachments.set(ref, [resolve, reject]);
            timer = setTimeout(() => {
                reject(new abortable_promise_1.TimeoutError(JSON.stringify(msg).substring(0, 100)));
            }, timeout);
        }, signal)
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
            promise.abort(new abortable_promise_1.AbortError(reason));
        }
        return promise;
    }
    send(msg) {
        const nowMs = (0, internal_1.nowInMilliseconds)();
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
        this._receivedAt = (0, internal_1.nowInMilliseconds)();
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
        const nowMs = (0, internal_1.nowInMilliseconds)();
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
    _onClose() {
        console.info(`<${this.name()}>Connection disconnected: endpoint: ${this._endpoint}`);
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
        this._websocket = this._openWebsocket();
        Promise.resolve().then(() => {
            tryWith(this, () => this._eventHandler.onConnecting?.(this));
            this.notify(Event.ON_CONNECTING, this);
        });
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
        const nowMs = (0, internal_1.nowInMilliseconds)();
        let duration = this._calcDelayForNextHeartbeat(nowMs);
        if (duration <= 1000) {
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
            const nowMs = (0, internal_1.nowInMilliseconds)();
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
            if (!this._isHealthy) {
                this._isHealthy = true;
                console.info(`<${this.name()}>Connection became healthy: endpoint: %s`, this._endpoint);
                tryWith(this, () => this._eventHandler.onBecameHealthy?.(this));
                this.notify(Event.ON_BECAME_HEALTHY, this);
            }
        }
        else {
            if (this._isHealthy) {
                this._isHealthy = false;
                console.info(`<${this.name()}>Connection became unhealthy: endpoint: %s`, this._endpoint);
                tryWith(this, () => this._eventHandler.onBecameUnhealthy?.(this));
                this.notify(Event.ON_BECAME_UNHEALTHY, this);
            }
        }
    }
    _checkIdleTimeout(nowMs) {
        if (this._hasSentNonePingBeforeIdleTimeout(nowMs)) {
            if (this._isIdle) {
                this._isIdle = false;
                console.info(`<${this.name()}>Connection became active: endpoint: %s`, this._endpoint);
                tryWith(this, () => this._eventHandler.onBecameActive?.(this));
                this.notify(Event.ON_BECAME_ACTIVE, this);
            }
        }
        else {
            if (!this._isIdle) {
                this._isIdle = true;
                console.info(`<${this.name()}>Connection became idle: endpoint: %s`, this._endpoint);
                tryWith(this, () => this._eventHandler.onBecameIdle?.(this));
                this.notify(Event.ON_BECAME_IDLE, this);
            }
        }
    }
    _hasReceivedBeforeUnhealthyTimeout(nowMs) {
        return nowMs - this._receivedAt < this._options.unhealthyTimeout;
    }
    _hasSentNonePingBeforeIdleTimeout(nowMs) {
        return nowMs - this._sendNonePingAt < this._options.idleTimeout;
    }
    _calcIntervalForCheckStatus() {
        return Math.floor(Math.min(this._options.unhealthyTimeout, this._options.idleTimeout) / 2);
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
        this._openCondition = new internal_1.Condition(this, () => {
            return this.isOpen();
        });
        this._closedCondition = new internal_1.Condition(this, () => {
            return this.isClosed();
        });
        this._readyState = ReadyState.CONNECTING;
        this._connection = null;
        this._connect();
    }
    id() {
        return this._id;
    }
    name() {
        return `m${this._id}c${this._connection?.id() ?? "?"}`;
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
    waitOpen(options = {}) {
        if (typeof options.timeout === "undefined") {
            options = {
                timeout: this._options.waitOpenTimeout,
                signal: options.signal,
            };
        }
        return this._openCondition.wait(options);
    }
    isClosed() {
        return !this._shouldRun && this._readyState === ReadyState.CLOSED;
    }
    close() {
        if (!this._shouldRun) {
            return;
        }
        this._shouldRun = false;
        this._stopReconnect();
        this._connectTask?.abort("hell0");
        this._openCondition.clear();
        this._connection?.close();
    }
    closeAndWait(options = {}) {
        this.close();
        if (typeof options.timeout === "undefined") {
            options = {
                timeout: this._options.waitClosedTimeout,
                signal: options.signal,
            };
        }
        return this._closedCondition.wait(options).then(() => {
            super.clear();
            return this;
        });
    }
    request(msg, options) {
        if (this._connection === null) {
            return abortable_promise_1.AbortablePromise.reject(new Error("Failed to request: reason: connection lost"));
        }
        return this._connection.request(msg, options);
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
        this._readyState = ReadyState.OPEN;
        console.debug(`<${this.name()}>Connection was opened, notify waiters: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
        this._openCondition.notify();
        tryWith(this, () => this._eventHandler.onConnected?.(this, connection, ...rest));
        this.notify(Event.ON_CONNECTED, this, connection, ...rest);
    }
    onDisconnecting(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onDisconnecting?.(this, connection, ...rest));
        this.notify(Event.ON_DISCONNECTING, this, connection, ...rest);
    }
    onDisconnected(connection, ...rest) {
        this._readyState = ReadyState.CLOSED;
        if (!this._shouldRun) {
            console.debug(`<${this.name()}>Connection was closed, notify waiters: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
            this._closedCondition.notify();
        }
        tryWith(this, () => this._eventHandler.onDisconnected?.(this, connection, ...rest));
        this.notify(Event.ON_DISCONNECTED, this, connection, ...rest);
        this._reconnect();
    }
    onCorrupted(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onCorrupted?.(this, connection, ...rest));
        this.notify(Event.ON_CORRUPTED, this, connection, ...rest);
    }
    onBecameUnhealthy(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onBecameUnhealthy?.(this, connection, ...rest));
        this.notify(Event.ON_BECAME_UNHEALTHY, this, connection, ...rest);
    }
    onBecameHealthy(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onBecameHealthy?.(this, connection, ...rest));
        this.notify(Event.ON_BECAME_HEALTHY, this, connection, ...rest);
    }
    onBecameActive(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onBecameActive?.(this, connection, ...rest));
        this.notify(Event.ON_BECAME_ACTIVE, this, connection, ...rest);
    }
    onBecameIdle(connection, ...rest) {
        tryWith(this, () => this._eventHandler.onBecameIdle?.(this, connection, ...rest));
        this.notify(Event.ON_BECAME_IDLE, this, connection, ...rest);
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
            this._readyState = ReadyState.CLOSED;
            if (!this._shouldRun) {
                this._closedCondition.notify();
            }
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
function buildConnectionPoolOptions(options) {
    if (typeof options === "undefined") {
        options = {};
    }
    return {
        minPoolSize: options.minPoolSize ?? 1,
        maxPoolSize: options.maxPoolSize ?? 3,
        ...buildConnectionOptions(options),
    };
}
class ConnectionPool extends internal_1.Listenable {
    constructor(pickEndpoint, options, eventHandler = new DefaultEventHandler()) {
        super();
        this._id = ++ID_SEED;
        this._pickEndpoint = pickEndpoint;
        this._options = options;
        this._eventHandler = eventHandler;
        this._shouldRun = true;
        this._allConnections = [];
        this._healthyConnections = [];
        this._closingConnections = new Map();
        this._healthyIndexSeed = 0;
        for (let i = 0; i < this._options.minPoolSize; i++) {
            this._addFreshConnection(this._createConnection());
        }
    }
    id() {
        return this._id;
    }
    name() {
        return `p${this._id}`;
    }
    size() {
        return this._allConnections.length;
    }
    waitAllOpen(options) {
        const promises = this._allConnections.map((connection) => connection.waitOpen(options));
        return abortable_promise_1.AbortablePromise.all(promises).then(() => this);
    }
    close() {
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
    closeAndWait(options) {
        if (!this._shouldRun) {
            return abortable_promise_1.AbortablePromise.resolve(this);
        }
        this._shouldRun = false;
        for (const connection of this._allConnections) {
            this._closingConnections.set(connection.id(), connection);
        }
        const promises = [];
        for (const connection of this._closingConnections.values()) {
            promises.push(connection.closeAndWait(options));
        }
        return abortable_promise_1.AbortablePromise.all(promises)
            .then(() => {
            this._allConnections = [];
            this._healthyConnections = [];
            this._closingConnections.clear();
            super.clear();
            return this;
        })
            .catch((reason) => {
            console.error(`<${this.name()}>Failed to close and wait for all connections: reason: ${reason}`);
            return this;
        });
    }
    getConnection() {
        if (this._healthyConnections.length > 0) {
            return this._healthyConnections[this._nextHealthyIndex()];
        }
        if (this._allConnections.length < this._options.maxPoolSize) {
            const connection = this._createConnection();
            this._addFreshConnection(connection);
            return connection;
        }
        return this._allConnections[Math.floor(Math.random() * this._allConnections.length)];
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
        if (connection.isClosed()) {
            console.debug(`<${this.name()}>Connection was closed, will drop it: name: ${connection.name()},endpoint: ${connection.endpoint()}`);
            this._dropConnection(connection);
        }
        tryWith(connection, () => this._eventHandler.onDisconnected?.(connection, ...rest));
        this.notify(Event.ON_DISCONNECTED, connection, ...rest);
    }
    onCorrupted(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onCorrupted?.(connection, ...rest));
        this.notify(Event.ON_CORRUPTED, connection, ...rest);
    }
    onBecameUnhealthy(connection, ...rest) {
        console.debug(`<${this.name()}>Connection became unhealthy, updating health: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
        this._updateConnectionHealth(connection);
        tryWith(connection, () => this._eventHandler.onBecameUnhealthy?.(connection, ...rest));
        this.notify(Event.ON_BECAME_UNHEALTHY, connection, ...rest);
    }
    onBecameHealthy(connection, ...rest) {
        console.debug(`<${this.name()}>Connection became healthy, updating health: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
        this._updateConnectionHealth(connection);
        tryWith(connection, () => this._eventHandler.onBecameHealthy?.(connection, ...rest));
    }
    onBecameIdle(connection, ...rest) {
        console.debug(`<${this.name()}>Connection became idle, will drop it: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
        this._dropConnection(connection);
        tryWith(connection, () => this._eventHandler.onBecameIdle?.(connection, ...rest));
        this.notify(Event.ON_BECAME_IDLE, connection, ...rest);
    }
    onBecameActive(connection, ...rest) {
        tryWith(connection, () => this._eventHandler.onBecameActive?.(connection, ...rest));
        this.notify(Event.ON_BECAME_ACTIVE, connection, ...rest);
    }
    _createConnection() {
        return new MultiAltEndpointsConnection(this._pickEndpoint, this._options, this);
    }
    _addFreshConnection(connection) {
        this._allConnections.push(connection);
        this._healthyConnections.push(connection);
    }
    _updateConnectionHealth(connection) {
        const isHealthy = connection.isHealthy();
        const healthyIndex = this._healthyConnections.indexOf(connection);
        if (isHealthy && healthyIndex === -1) {
            this._healthyConnections.push(connection);
        }
        else if (!isHealthy && healthyIndex !== -1) {
            this._healthyConnections.splice(healthyIndex, 1);
        }
    }
    _dropConnection(connection) {
        if (!this._shouldRun) {
            console.debug(`<${this.name()}>Dropping connection, but pool is closing, just ignore it: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
            return;
        }
        console.debug(`<${this.name()}>Dropping connection: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
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
            console.info(`<${this.name()}>Connection removed from pool: old pool size: ${oldPoolSize}, new pool size: ${newPoolSize}, name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
        }
        else {
            console.debug(`<${this.name()}>No such connection in pool, maybe already removed: name: ${connection.name()}, endpoint: ${connection.endpoint()}`);
        }
        if (connection.isClosed()) {
            this._closingConnections.delete(connection.id());
        }
        else {
            this._closingConnections.set(connection.id(), connection);
            connection.close();
        }
        const minPoolSize = this._options.minPoolSize;
        if (this._allConnections.length < minPoolSize) {
            console.info(`<${this.name()}>Creating connections, since the pool size(${this._allConnections.length}) is less than min pool size(${minPoolSize}).`);
            for (let i = 0; i < minPoolSize - this._allConnections.length; i++) {
                this._addFreshConnection(this._createConnection());
            }
        }
    }
    _nextHealthyIndex() {
        if (this._healthyIndexSeed >= this._healthyConnections.length - 1) {
            this._healthyIndexSeed = 0;
        }
        else {
            ++this._healthyIndexSeed;
        }
        return this._healthyIndexSeed;
    }
}
exports.ConnectionPool = ConnectionPool;
//# sourceMappingURL=connection.js.map
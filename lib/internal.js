"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiAltEndpointsConnection = exports.Connection = exports.defaultOptions = exports.DefaultEventHandler = exports.Event = exports.Listenable = exports.TimeoutError = exports.Condition = void 0;
const condition_1 = require("./condition");
Object.defineProperty(exports, "Condition", { enumerable: true, get: function () { return condition_1.Condition; } });
const timeout_error_1 = require("./timeout-error");
Object.defineProperty(exports, "TimeoutError", { enumerable: true, get: function () { return timeout_error_1.TimeoutError; } });
const listenable_1 = require("./listenable");
Object.defineProperty(exports, "Listenable", { enumerable: true, get: function () { return listenable_1.Listenable; } });
const connection_1 = require("./connection");
Object.defineProperty(exports, "Event", { enumerable: true, get: function () { return connection_1.Event; } });
Object.defineProperty(exports, "DefaultEventHandler", { enumerable: true, get: function () { return connection_1.DefaultEventHandler; } });
Object.defineProperty(exports, "defaultOptions", { enumerable: true, get: function () { return connection_1.defaultOptions; } });
Object.defineProperty(exports, "Connection", { enumerable: true, get: function () { return connection_1.Connection; } });
Object.defineProperty(exports, "MultiAltEndpointsConnection", { enumerable: true, get: function () { return connection_1.MultiAltEndpointsConnection; } });
//# sourceMappingURL=internal.js.map
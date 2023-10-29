"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Listenable = void 0;
class Listenable {
    constructor() {
        this._listeners = new Map();
    }
    addListener(event, callback) {
        let callbacks = this._listeners.get(event);
        if (typeof callbacks === "undefined") {
            callbacks = [];
            this._listeners.set(event, callbacks);
        }
        const index = callbacks.findIndex((callback0) => {
            return callback === callback0;
        });
        if (index === -1) {
            callbacks.push(callback);
        }
        return () => {
            this.deleteListener(event, callback);
        };
    }
    deleteListener(event, callback) {
        const callbacks = this._listeners.get(event);
        if (typeof callbacks === "undefined") {
            return;
        }
        const index = callbacks.findIndex((callback0) => {
            return callback === callback0;
        });
        if (index === -1) {
            return;
        }
        callbacks.splice(index, 1);
        if (callbacks.length <= 0) {
            this._listeners.delete(event);
        }
    }
    clear() {
        this._listeners.clear();
    }
    getListeners() {
        return this._listeners;
    }
    notify(event, ...args) {
        const callbacks = this._listeners.get(event);
        if (typeof callbacks === "undefined") {
            return;
        }
        const callback2 = [...callbacks];
        callback2.forEach((callback) => {
            try {
                callback(...args);
            }
            catch (e) {
                console.error(`Failed to notify: reason: ${e.stack}`);
            }
        });
    }
}
exports.Listenable = Listenable;
exports.default = Listenable;
//# sourceMappingURL=listenable.js.map
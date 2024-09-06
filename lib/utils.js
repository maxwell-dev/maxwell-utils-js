"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nowInSeconds = nowInSeconds;
exports.nowInMilliseconds = nowInMilliseconds;
exports.sleep = sleep;
function nowInSeconds() {
    return new Date().getTime() / 1000;
}
function nowInMilliseconds() {
    return new Date().getTime();
}
async function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
//# sourceMappingURL=utils.js.map
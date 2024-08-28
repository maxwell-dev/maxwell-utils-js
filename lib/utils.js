"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.now = now;
exports.sleep = sleep;
function now() {
    return new Date().getTime();
}
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=utils.js.map
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaskQueue = void 0;
class TaskQueue {
    constructor(options) {
        this.pending = [];
        this.active = 0;
        this.autostart = options.autostart;
        this._concurrency = options.concurrency;
    }
    get concurrency() {
        return this._concurrency;
    }
    set concurrency(value) {
        if (!Number.isInteger(value) || value < 1) {
            throw new TypeError("concurrency must be a positive integer");
        }
        this._concurrency = value;
        this.start();
    }
    push(task) {
        this.pending.push(task);
        if (this.autostart) {
            this.start();
        }
    }
    start() {
        while (this.active < this._concurrency && this.pending.length > 0) {
            const task = this.pending.shift();
            this.active += 1;
            Promise.resolve()
                .then(task)
                .finally(() => {
                this.active -= 1;
                this.start();
            });
        }
    }
}
exports.TaskQueue = TaskQueue;

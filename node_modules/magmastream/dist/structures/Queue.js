"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Queue = void 0;
const Utils_1 = require("./Utils");
/**
 * The player's queue, the `current` property is the currently playing track, think of the rest as the up-coming tracks.
 */
class Queue extends Array {
    /** The total duration of the queue. */
    get duration() {
        const current = this.current?.duration ?? 0;
        return this.reduce((acc, cur) => acc + (cur.duration || 0), current);
    }
    /** The total size of tracks in the queue including the current track. */
    get totalSize() {
        return this.length + (this.current ? 1 : 0);
    }
    /** The size of tracks in the queue. */
    get size() {
        return this.length;
    }
    /** The current track */
    current = null;
    /** The previous track */
    previous = null;
    /**
     * Adds a track to the queue.
     * @param track
     * @param [offset=null]
     */
    add(track, offset) {
        if (!Utils_1.TrackUtils.validate(track)) {
            throw new RangeError('Track must be a "Track" or "Track[]".');
        }
        if (!this.current) {
            if (Array.isArray(track)) {
                this.current = track.shift() || null;
                this.push(...track);
            }
            else {
                this.current = track;
            }
        }
        else {
            if (typeof offset !== "undefined" && typeof offset === "number") {
                if (isNaN(offset)) {
                    throw new RangeError("Offset must be a number.");
                }
                if (offset < 0 || offset > this.length) {
                    throw new RangeError(`Offset must be between 0 and ${this.length}.`);
                }
                if (Array.isArray(track)) {
                    this.splice(offset, 0, ...track);
                }
                else {
                    this.splice(offset, 0, track);
                }
            }
            else {
                if (Array.isArray(track)) {
                    this.push(...track);
                }
                else {
                    this.push(track);
                }
            }
        }
    }
    remove(startOrPosition = 0, end) {
        if (typeof end !== "undefined") {
            if (isNaN(Number(startOrPosition)) || isNaN(Number(end))) {
                throw new RangeError(`Missing "start" or "end" parameter.`);
            }
            if (startOrPosition >= end || startOrPosition >= this.length) {
                throw new RangeError("Invalid start or end values.");
            }
            return this.splice(startOrPosition, end - startOrPosition);
        }
        return this.splice(startOrPosition, 1);
    }
    /** Clears the queue. */
    clear() {
        this.splice(0);
    }
    /** Shuffles the queue. */
    shuffle() {
        for (let i = this.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this[i], this[j]] = [this[j], this[i]];
        }
    }
}
exports.Queue = Queue;

/*
 * Vendored from roughjs@4.6.6 (bin/math.js), MIT License: see ./LICENSE.
 * Copyright (c) 2019 Preet Shihn.
 * Changes from the published file: none.
 */
export function randomSeed() {
    return Math.floor(Math.random() * 2 ** 31);
}
export class Random {
    constructor(seed) {
        this.seed = seed;
    }
    next() {
        if (this.seed) {
            return ((2 ** 31 - 1) & (this.seed = Math.imul(48271, this.seed))) / 2 ** 31;
        }
        else {
            return Math.random();
        }
    }
}

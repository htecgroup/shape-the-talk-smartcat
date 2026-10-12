/*
 * Vendored from roughjs@4.6.6 (bin/fillers/filler.js), MIT License: see ../LICENSE.
 * Copyright (c) 2019 Preet Shihn.
 * Changes from the published file: the pattern fillers (hachure, zigzag,
 * cross-hatch, dots, dashed, zigzag-line) are stubbed out, so their files and
 * the hachure-fill dependency are not vendored. ShapeTheTalk only draws with
 * fillStyle 'solid', which never reaches getFiller. A pattern fill draws no
 * fill lines.
 */
const stub = {
    fillPolygons() {
        return { type: 'fillSketch', ops: [] };
    },
};
export function getFiller(o, helper) {
    return stub;
}

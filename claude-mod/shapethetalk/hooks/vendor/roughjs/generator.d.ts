/*
 * Types for the vendored roughjs@4.6.6 generator (MIT, see ./LICENSE): only
 * the part ShapeTheTalk uses, written for this mod (the published
 * bin/generator.d.ts pulls in core.d.ts and more).
 */
export type Point = [number, number];

export interface Options {
    seed?: number;
    roughness?: number;
    bowing?: number;
    stroke?: string;
    strokeWidth?: number;
    fill?: string;
    fillStyle?: string;
    strokeLineDash?: number[];
    disableMultiStroke?: boolean;
    disableMultiStrokeFill?: boolean;
    preserveVertices?: boolean;
}

export interface OpSet {
    type: 'path' | 'fillPath' | 'fillSketch';
    ops: { op: string; data: number[] }[];
}

export interface Drawable {
    shape: string;
    options: Options & { stroke: string; strokeWidth: number };
    sets: OpSet[];
}

export interface PathInfo {
    d: string;
    stroke: string;
    strokeWidth: number;
    fill?: string;
}

export declare class RoughGenerator {
    constructor(config?: { options?: Options });
    line(x1: number, y1: number, x2: number, y2: number, options?: Options): Drawable;
    polygon(points: Point[], options?: Options): Drawable;
    path(d: string, options?: Options): Drawable;
    opsToPath(drawing: OpSet, fixedDecimals?: number): string;
    toPaths(drawable: Drawable): PathInfo[];
}

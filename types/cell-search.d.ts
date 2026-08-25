// `gds-lens/cell-search` -- ranking and pathfinding over a design's cell tree.
//
// Both work on the hierarchy model the wasm parse hands back.

/** One node of the cell tree. */
export interface CellNode {
    name?: string;
    /** Child placements, by index into the same array. */
    references?: Array<{ cell: number }>;
    [key: string]: unknown;
}

/**
 * Indices of the cells whose name contains `query`, best first: exact match,
 * then prefix matches, then substring matches. Case-insensitive. Empty when
 * the query is blank or nothing matches.
 */
export function rankCellMatches(cells: CellNode[], query: string): number[];

/**
 * One path of cell indices from a top cell down to `target`, root first and
 * target last -- or `null` if no top cell reaches it.
 *
 * Depth-first, so it is *a* path rather than the shortest: a cell placed in
 * twenty places has twenty paths and none is more correct. Terminates on a
 * reference cycle, and stops descending at `maxDepth`.
 */
export function cellPathToTarget(
    cells: CellNode[],
    roots: number[],
    target: number,
    maxDepth: number,
): number[] | null;

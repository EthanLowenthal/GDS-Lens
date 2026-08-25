// `gds-lens/coord-parse` -- reading a coordinate a person typed.

/**
 * A coordinate pair in microns, or `null` if the text is not one.
 *
 * Tolerates the shapes coordinates actually arrive in: bare pairs, wrapped in
 * brackets, comma- or space-separated, and per-number units (`nm`, `um`, `mm`)
 * which are converted. Anything left over after the two numbers rejects the
 * whole string rather than being half-read.
 */
export function parseCoordinatePair(text: string): { x: number; y: number } | null;

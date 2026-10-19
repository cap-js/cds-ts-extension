'use strict';

/**
 * Minimal local model of the `@sap/cds` CSN (Core Schema Notation) shape.
 *
 * TEMPORARY: `@sap/cds` ships no usable types for the reflected model, so we
 * declare the exact fields this plugin reads rather than scattering `any`
 * across the analysis code. This is a stand-in — replace the interfaces below
 * with the official CSN types once `@sap/cds` exposes them, keeping the same
 * names (`CsnArtifact`, `CsnElement`, `CsnDefs`) so call sites don't change.
 *
 * The index signature covers CSN annotations (`@odata.foreignKey4`, etc.) and
 * any field we don't model explicitly.
 */

/**
 * @typedef {{ type?: string; target?: string; cardinality?: { max?: number | '*' }; elements?: Record<string, CsnElement>; doc?: string | { val?: string }; [annotation: string]: any }} CsnElement
 */

/**
 * @typedef {{ kind?: string; type?: string; elements?: Record<string, CsnElement>; doc?: string | { val?: string }; [annotation: string]: any }} CsnArtifact
 */

/** @typedef {Record<string, CsnArtifact>} CsnDefs */

/** CSN `doc`/annotation values may be a plain string or a `{ val }` wrapper.
 * @param {string | { val?: string } | undefined} v
 * @returns {string | undefined}
 */
const csnText = (v) => (typeof v === 'string' ? v : v?.val);

/** Narrow a raw CSN `kind` string to the completion-entry kinds we surface.
 * @param {string | undefined} kind
 * @returns {'entity' | 'view'}
 */
const csnEntryKind = (kind) => kind === 'view' ? 'view' : 'entity';

module.exports = { csnText, csnEntryKind };

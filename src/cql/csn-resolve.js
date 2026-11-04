'use strict';
/**
 * CSN semantic resolution — maps CDS types to TypeScript, resolves entity/view
 * sources and association paths against the compiled model (`defs`).
 * Self-contained: depends only on the CSN shims, no LSP or external deps.
 */

/** @typedef {import('../csn').CsnArtifact} CsnArtifact */
/** @typedef {import('../csn').CsnDefs} CsnDefs */
/** @typedef {import('../csn').CsnElement} CsnElement */
/** @typedef {import('./types').CqlSource} CqlSource */

/**
 * Maps a CDS built-in type name to a TypeScript type string.
 * @param {string | undefined} typeName
 * @returns {string}
 */
function cdsTypeToTs(typeName) {
    if (!typeName) return 'unknown';
    const short = typeName.replace(/^cds\./, '').replace(/^.*\./, '');
    switch (short) {
        case 'UUID':
        case 'String':
        case 'LargeString':
        case 'Binary':
        case 'LargeBinary':
        case 'Date':
        case 'DateTime':
        case 'Timestamp':
        case 'Time':
        case 'User':
            return 'string';
        case 'Boolean':
            return 'boolean';
        case 'Integer':
        case 'Integer16':
        case 'Int16':
        case 'Integer32':
        case 'Int32':
        case 'Double':
        case 'Float':
            return 'number';
        // Int64 and Decimal families are serialized as strings by CAP's default
        // `ieee754compatible` feature (and the OData wire format) to preserve
        // precision beyond the IEEE-754 double range, but are plain numbers when
        // that feature is off. The static type therefore cannot be a single
        // branch — it is a union the caller must handle. Confirmed against the
        // runtime in test/runtime (Int64/Decimal -> string under the cds-10 default).
        case 'Integer64':
        case 'Int64':
        case 'Decimal':
        case 'DecimalFloat':
            return 'string | number';
        default:
            return 'unknown';
    }
}

/**
 * Resolves a user-defined CDS type name to its primitive CDS base type by walking
 * the `defs` chain. Stops at built-in `cds.*` types or when the chain ends.
 * Returns the original `typeName` if no definition is found (caller maps to 'unknown').
 * @param {string | undefined} typeName
 * @param {CsnDefs} defs
 * @returns {string | undefined}
 */
function resolveBaseType(typeName, defs) {
    const seen = new Set();
    let current = typeName;
    while (current && !current.startsWith('cds.') && !seen.has(current)) {
        seen.add(current);
        const def = defs[current];
        if (!def) break;
        const next = def.type;
        if (!next || next === current) break;
        current = next;
    }
    return current;
}

const SOURCE_KINDS = new Set(['entity', 'view']);

/** True when an association/composition element's target cardinality is to-many
 *  (`cardinality.max` is `'*'` or a number > 1). To-one associations have no
 *  cardinality or `max === 1`.
 * @param {CsnElement} el
 * @returns {boolean}
 */
function isToMany(el) {
    const max = el?.cardinality?.max;
    return max === '*' || (typeof max === 'number' && max > 1);
}
/**
 * Returns the set of valid field names for an artifact: its own elements plus
 * the generated foreign-key columns for each managed association/composition
 * (`<assoc>_<key>`, e.g. association `flight` with key `ID` → `flight_ID`).
 * These FK columns are valid references but are not top-level elements in an
 * unresolved CSN view.
 * @param {CsnArtifact} artifact
 * @returns {Set<string>}
 */
function elementNamesWithForeignKeys(artifact) {
    const names = new Set(Object.keys(artifact.elements ?? {}));
    for (const [name, el] of Object.entries(artifact.elements ?? {})) {
        const keys = /** @type {Array<{ ref?: string[] }> | undefined} */ (/** @type {any} */ (el).keys);
        if (!keys) continue;
        for (const k of keys) {
            const ref = k.ref;
            if (ref && ref.length) names.add(`${name}_${ref.join('_')}`);
        }
    }
    return names;
}

/**
 * @param {CsnDefs} defs
 * @param {string} name
 * @param {string | undefined} prefix
 * @returns {{ fqn: string, artifact: CsnArtifact } | null}
 */
function resolveSource(defs, name, prefix) {
    // Draft shadow entities (`<Entity>.drafts`) are not materialised in the
    // compiled CSN — they are generated at runtime by the drafts feature. Strip
    // a trailing `.drafts` and resolve against the base entity, which carries
    // the same element set.
    const base = name.endsWith('.drafts') ? name.slice(0, -'.drafts'.length) : name;

    const key = prefix ? `${prefix}.${base}` : base;
    const artifact = defs[key];
    if (artifact?.kind && SOURCE_KINDS.has(artifact.kind)) return { fqn: key, artifact };
    // Also try fully-qualified lookup when name already includes a dot
    const byFqn = base.includes('.') ? defs[base] : undefined;
    if (byFqn?.kind && SOURCE_KINDS.has(byFqn.kind)) return { fqn: base, artifact: byFqn };
    return null;
}

/**
 * @param {CsnDefs} defs
 * @param {CqlSource[]} sources
 * @param {string | undefined} prefix
 * @returns {Array<{ ref: string, fqn: string, artifact: CsnArtifact }>}
 */
const GET_MODEL_SOURCES = (defs, sources, prefix) =>
    sources
        .map(({ entity, ref }) => {
            const r = resolveSource(defs, entity, prefix);
            return r ? { ref, fqn: r.fqn, artifact: r.artifact } : null;
        })
        .filter((s) => s !== null);

/**
 * Walk an association path through the model starting from startEntity.
 * e.g. startEntity='CatalogService.Books', path=['author', 'address']
 * returns the definition of the terminal entity (the one 'address' points to), or null.
 * @param {CsnDefs} defs
 * @param {string} startEntity
 * @param {string[]} path
 * @returns {CsnArtifact | null}
 */
function followAssocPath(defs, startEntity, path) {
    let current = defs[startEntity];
    if (!current) return null;
    for (const assocName of path) {
        const el = /** @type {import('../csn').CsnElement | undefined} */ (current.elements?.[assocName]);
        if (!el) return null;
        const fk = /** @type {import('../csn').CsnElement | undefined} */ (el['@odata.foreignKey4']);
        const targetName = /** @type {string | undefined} */ (el.target ?? fk?.target);
        if (!targetName) return null;
        current = defs[targetName];
        if (!current) return null;
    }
    return current;
}

module.exports = {
    cdsTypeToTs,
    resolveBaseType,
    SOURCE_KINDS,
    isToMany,
    elementNamesWithForeignKeys,
    resolveSource,
    GET_MODEL_SOURCES,
    followAssocPath,
};

'use strict';
/**
 * CQL structural parser — turns the token stream into a recursive ExpandColumn
 * tree (classic, postfix, and inline-dot expand projections).
 * Self-contained: no LSP or external dependencies.
 */

const { tokenizeCql } = require('./lexer');

/** @typedef {import('./types').CqlToken} CqlToken */
/** @typedef {import('./types').ExpandColumn} ExpandColumn */

/**
 * Parses the column list from a CQL query into a recursive ExpandColumn tree.
 *
 * CQL has two valid projection orderings (see
 * https://cap.cloud.sap/docs/cds/cql#expressions):
 *   Classic:  SELECT ID, title FROM Books
 *   Postfix:  SELECT FROM Books { ID, author { name } }   (SELECT-first, braces after FROM)
 *   Inline:   SELECT FROM Books { ID, author.{ name } }
 *
 * Note: `FROM Entity SELECT …` (FROM keyword before SELECT) is NOT valid CQL and
 * is intentionally not parsed — such a query yields [] (no columns).
 *
 * Returns null when the column list is SELECT * (caller uses all-fields fallback).
 * Returns [] when SELECT/FROM are absent.
 * @param {string} queryText
 * @returns {ExpandColumn[] | null}
 */
function parseCqlColumns(queryText) {
    const toks = tokenizeCql(queryText).filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
    const selectIdx = toks.findIndex((t) => t.kind === 'keyword' && t.value.toUpperCase() === 'SELECT');
    if (selectIdx < 0) return [];

    const fromIdx = toks.findIndex((t, i) => i > selectIdx && t.kind === 'keyword' && t.value.toUpperCase() === 'FROM');
    if (fromIdx < 0) return [];

    // Postfix style: SELECT immediately followed by FROM (nothing between them)
    if (fromIdx === selectIdx + 1) {
        // Skip past entity name(s) and aliases to find the opening brace
        let i = fromIdx + 1;
        // consume: Entity [AS alias | alias] [JOIN ...]
        /** @param {number} idx @returns {CqlToken} */
        const at = (idx) => /** @type {CqlToken} */ (toks[idx]);
        while (i < toks.length && !(at(i).kind === 'punctuation' && at(i).value === '{')) {
            i++;
        }
        if (i >= toks.length) return null; // no brace block
        i++; // step past '{'
        const [cols] = parseBraceBlock(toks, i);
        return cols;
    }

    // Classic style: columns between SELECT and FROM
    const colToks = toks.slice(selectIdx + 1, fromIdx);
    return parseClassicColumns(colToks);
}

/**
 * Parse a comma-separated flat column list (classic SELECT style).
 * Returns null if the list is just '*'.
 * @param {CqlToken[]} toks
 * @returns {ExpandColumn[] | null}
 */
/**
 * If the token at `toks[i]` opens a function-call argument list (a '('),
 * returns the index just past the matching ')' and the single field argument
 * (when the parens contain exactly one identifier, e.g. `max(ID)`). Otherwise
 * returns `{ end: i, arg: undefined }`. Handles nested parens.
 * @param {CqlToken[]} toks
 * @param {number} i index of the '(' (or any token)
 * @returns {{ end: number, arg: string | undefined }}
 */
function skipBalancedParens(toks, i) {
    const open = /** @type {CqlToken | undefined} */ (toks[i]);
    if (!open || open.kind !== 'punctuation' || open.value !== '(') return { end: i, arg: undefined };
    let depth = 0;
    let j = i;
    /** @type {string[]} */
    const idents = [];
    while (j < toks.length) {
        const t = /** @type {CqlToken} */ (toks[j]);
        if (t.kind === 'punctuation' && t.value === '(') depth++;
        else if (t.kind === 'punctuation' && t.value === ')') {
            depth--;
            if (depth === 0) {
                // When the parens contain exactly one identifier token (e.g.
                // `max(ID)` or `max(B.ID)`) we expose it as the argument so the
                // result type can be inferred from that field. A `*`, multiple
                // identifiers, or no identifier at all leaves arg undefined.
                const arg = idents.length === 1 ? idents[0] : undefined;
                return { end: j + 1, arg };
            }
        } else if (t.kind === 'identifier') idents.push(t.value);
        j++;
    }
    return { end: j, arg: undefined }; // unbalanced — consume to end
}

/**
 * Parse a comma-separated classic column list (SELECT a, b, c FROM …).
 * @param {CqlToken[]} toks
 * @returns {ExpandColumn[] | null}
 */
function parseClassicColumns(toks) {
    // Filter to non-whitespace/unknown (already filtered by caller, but be safe)
    const sig = toks.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
    if (sig.length === 0) return null;
    if (sig.length === 1 && /** @type {CqlToken} */ (sig[0]).kind === 'star') return null; // SELECT *

    const result = [];
    let i = 0;
    while (i < sig.length) {
        const tok = /** @type {CqlToken} */ (sig[i]);
        if (tok.kind === 'punctuation' && tok.value === ',') {
            i++;
            continue;
        }
        if (tok.kind === 'star') {
            return null;
        } // SELECT *, col — treat as *
        if (tok.kind !== 'identifier') {
            i++;
            continue;
        }

        const bareField = tok.value.includes('.') ? (tok.value.split('.').pop() ?? tok.value) : tok.value;
        i++;

        // Function call: `fn(args)` — consume the argument span and name the
        // column after the function (overridden by a trailing AS alias below).
        // Record the function name and single field argument for type inference.
        const field = bareField;
        /** @type {string | undefined} */
        let func;
        /** @type {string | undefined} */
        let arg;
        if (i < sig.length && /** @type {CqlToken} */ (sig[i]).kind === 'punctuation' && /** @type {CqlToken} */ (sig[i]).value === '(') {
            func = bareField.toLowerCase();
            const r = skipBalancedParens(sig, i);
            i = r.end;
            arg = r.arg;
        }
        let alias = field;

        // AS alias only — implicit-alias detection is unreliable without comma boundaries
        if (i < sig.length && /** @type {CqlToken} */ (sig[i]).kind === 'keyword' && /** @type {CqlToken} */ (sig[i]).value.toUpperCase() === 'AS') {
            i++; // skip AS
            if (i < sig.length && /** @type {CqlToken} */ (sig[i]).kind === 'identifier') {
                alias = /** @type {CqlToken} */ (sig[i]).value;
                i++;
            }
        }
        result.push(func ? { field, alias, func, arg } : { field, alias });
    }
    return result.length > 0 ? result : null;
}

/**
 * Parse a brace-delimited expand block starting just after the opening '{'.
 * Returns [columns, nextIndex] where nextIndex points past the closing '}'.
 * Returns null columns for a '*'-only block.
 * @param {CqlToken[]} toks
 * @param {number} start
 * @returns {[ExpandColumn[] | null, number]}
 */
function parseBraceBlock(toks, start) {
    const result = [];
    /** @param {number} idx @returns {CqlToken} */
    const at = (idx) => /** @type {CqlToken} */ (toks[idx]);
    let i = start;
    while (i < toks.length) {
        const tok = at(i);

        if (tok.kind === 'punctuation' && tok.value === '}') {
            return [result.length > 0 ? result : null, i + 1];
        }
        if (tok.kind === 'punctuation' && tok.value === ',') {
            i++;
            continue;
        }
        if (tok.kind === 'star') {
            // consume remaining until '}'
            while (i < toks.length && !(at(i).kind === 'punctuation' && at(i).value === '}')) i++;
            return [null, i + 1]; // * → all fields
        }
        if (tok.kind !== 'identifier') {
            i++;
            continue;
        }

        // Identifier may have a trailing dot (inline expand: `author.{`) or a table qualifier
        const rawVal = tok.value.endsWith('.') ? tok.value.slice(0, -1) : tok.value;
        const field = rawVal.includes('.') ? (rawVal.split('.').pop() ?? rawVal) : rawVal;
        // If the raw value ended with '.', the '{' is the very next token (no separate '.' token)
        const hasDot = tok.value.endsWith('.');
        let alias = field;
        i++;

        // Function call: `fn(args)` — consume the argument span. A function
        // column cannot be an expand and has no trailing dot, so handle it
        // before the expand/AS logic. The column is named after the function
        // unless a trailing AS alias overrides it below. Record func/arg for
        // type inference.
        if (!hasDot && i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'punctuation' && /** @type {CqlToken} */ (toks[i]).value === '(') {
            const func = field.toLowerCase();
            const r = skipBalancedParens(toks, i);
            i = r.end;
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'keyword' && /** @type {CqlToken} */ (toks[i]).value.toUpperCase() === 'AS') {
                i++; // skip AS
                if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'identifier') {
                    alias = /** @type {CqlToken} */ (toks[i]).value;
                    i++;
                }
            }
            result.push({ field, alias, func, arg: r.arg });
            continue;
        }

        // Check for expand: `field {`, `field.{` (inline expand), or `field as alias {`.
        // The tokenizer merges `identifier.` into a single identifier token ending with '.'.
        // A separate '.' token is filtered out before this function is called, so we only
        // need to handle the hasDot (trailing-dot identifier) case and the bare '{' case.
        //
        // Order matters: consume an optional `AS alias` FIRST, then look for a following
        // '{'. CQL allows an aliased association expand (`address as residence { … }`),
        // so alias-parsing must not short-circuit expand detection.
        let isExpand = false;
        if (hasDot) {
            // Trailing dot already consumed in identifier — next token should be '{'
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'punctuation' && /** @type {CqlToken} */ (toks[i]).value === '{') {
                i++; // skip '{'
                isExpand = true;
            }
        } else {
            // Optional `AS alias`
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'keyword' && /** @type {CqlToken} */ (toks[i]).value.toUpperCase() === 'AS') {
                i++; // skip AS
                if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'identifier') {
                    alias = /** @type {CqlToken} */ (toks[i]).value;
                    i++;
                }
            }
            // Expand block may follow either the bare field or the `AS alias`.
            if (i < toks.length && /** @type {CqlToken} */ (toks[i]).kind === 'punctuation' && /** @type {CqlToken} */ (toks[i]).value === '{') {
                i++; // skip '{'
                isExpand = true;
            }
        }

        if (isExpand) {
            const [nested, next] = parseBraceBlock(toks, i);
            i = next;
            result.push({ field, alias, expand: nested ?? [] });
        } else {
            result.push({ field, alias });
        }
    }
    return [result.length > 0 ? result : null, i];
}

module.exports = { parseCqlColumns, skipBalancedParens, parseClassicColumns, parseBraceBlock };

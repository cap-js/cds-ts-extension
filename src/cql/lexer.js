'use strict';
/**
 * CQL lexer — tokenizes a CQL query string into a flat token stream.
 * Self-contained: no LSP or external dependencies.
 */

/** @typedef {import('./types').CqlToken} CqlToken */
/** @typedef {import('./types').CqlTokenKind} CqlTokenKind */

const CQL_KEYWORDS = new Set([
    'SELECT',
    'ONE',
    'DISTINCT',
    'FROM',
    'WHERE',
    'JOIN',
    'ON',
    'AS',
    'INNER',
    'OUTER',
    'LEFT',
    'RIGHT',
    'FULL',
    'CROSS',
    'ORDER',
    'GROUP',
    'BY',
    'HAVING',
    'LIMIT',
    'OFFSET',
    'UNION',
    'EXCEPT',
    'INTERSECT',
    'INTO',
    'AND',
    'OR',
    'NOT',
    'IN',
    'IS',
    'NULL',
    'LIKE',
    'BETWEEN',
    'EXISTS',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'ASC',
    'DESC',
]);

/**
 * @param {string} query
 * @returns {CqlToken[]}
 */
function tokenizeCql(query) {
    /** @type {CqlToken[]} */
    const tokens = [];
    let pos = 0;
    const len = query.length;

    while (pos < len) {
        const ch = /** @type {string} */ (query[pos]);

        // Whitespace
        if (/\s/.test(ch)) {
            const start = pos;
            while (pos < len && /\s/.test(/** @type {string} */ (query[pos]))) pos++;
            tokens.push({
                kind: 'whitespace',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Line comment
        if (ch === '/' && query[pos + 1] === '/') {
            const start = pos;
            while (pos < len && /** @type {string} */ (query[pos]) !== '\n') pos++;
            tokens.push({
                kind: 'whitespace',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Block comment
        if (ch === '/' && query[pos + 1] === '*') {
            const start = pos;
            pos += 2;
            while (pos < len && !(query[pos] === '*' && query[pos + 1] === '/')) pos++;
            pos += 2;
            tokens.push({
                kind: 'whitespace',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // String literal
        if (ch === "'") {
            const start = pos++;
            while (pos < len && /** @type {string} */ (query[pos]) !== "'") {
                if (/** @type {string} */ (query[pos]) === '\\') pos++;
                pos++;
            }
            pos++;
            tokens.push({
                kind: 'string',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Quoted identifier
        if (ch === '"') {
            const start = pos++;
            while (pos < len && /** @type {string} */ (query[pos]) !== '"') pos++;
            pos++;
            tokens.push({
                kind: 'identifier',
                value: query.slice(start + 1, pos - 1),
                start,
                end: pos,
            });
            continue;
        }

        // Star (standalone)
        if (ch === '*') {
            tokens.push({ kind: 'star', value: '*', start: pos, end: pos + 1 });
            pos++;
            continue;
        }

        // Operators
        if (/[=<>!+\-/%]/.test(ch)) {
            const start = pos;
            if ((ch === '<' || ch === '>' || ch === '!') && query[pos + 1] === '=') pos++;

            if (ch === '<' && query[pos + 1] === '>') pos++;
            pos++;
            tokens.push({
                kind: 'operator',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Punctuation
        if (/[,;:()[\]{}]/.test(ch)) {
            tokens.push({
                kind: 'punctuation',
                value: ch,
                start: pos,
                end: pos + 1,
            });
            pos++;
            continue;
        }

        // Number
        if (/\d/.test(ch)) {
            const start = pos;
            while (pos < len && /[\d.]/.test(/** @type {string} */ (query[pos]))) pos++;
            tokens.push({
                kind: 'number',
                value: query.slice(start, pos),
                start,
                end: pos,
            });
            continue;
        }

        // Identifier or keyword (including dotted names like Books.title)
        if (/[a-zA-Z_$]/.test(ch)) {
            const start = pos;
            while (pos < len && /[a-zA-Z0-9_$.]/.test(/** @type {string} */ (query[pos]))) pos++;
            const value = query.slice(start, pos);
            const upper = value.toUpperCase();
            const kind = /** @type {'keyword' | 'identifier'} */ (CQL_KEYWORDS.has(upper) ? 'keyword' : 'identifier');
            tokens.push({ kind, value, start, end: pos });
            continue;
        }

        tokens.push({ kind: 'unknown', value: ch, start: pos, end: pos + 1 });
        pos++;
    }

    return tokens;
}

module.exports = { CQL_KEYWORDS, tokenizeCql };

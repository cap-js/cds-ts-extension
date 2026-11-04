'use strict';
/**
 * CQL tokenizer and query-analysis logic — re-export barrel.
 *
 * The implementation lives in `./cql/*` (lexer, parser, cursor-analysis,
 * csn-resolve, endpoints, diagnostic-codes), each a self-contained module with
 * no LSP or external dependencies. This barrel preserves the historical
 * `require('./CqlLogic')` surface so consumers and tests need no changes.
 */

const { CqlDiagnosticCode } = require('./cql/diagnostic-codes');
const { CQL_KEYWORDS, tokenizeCql } = require('./cql/lexer');
const { parseCqlColumns } = require('./cql/parser');
const { cdsTypeToTs, resolveBaseType } = require('./cql/csn-resolve');
const { getTokenContext, getCursorClause, extractSourceRelations } = require('./cql/cursor-analysis');
const { getSuggestions, validateCqlQuery } = require('./cql/endpoints');

/** @typedef {import('./cql/types').CqlTokenKind} CqlTokenKind */
/** @typedef {import('./cql/types').CqlToken} CqlToken */
/** @typedef {import('./cql/types').ResolvedColumn} ResolvedColumn */
/** @typedef {import('./cql/types').ExpandColumn} ExpandColumn */
/** @typedef {import('./cql/types').CompletionEntry} CompletionEntry */
/** @typedef {import('./cql/types').CqlDiagnostic} CqlDiagnostic */
/** @typedef {import('./cql/types').CqlDiagnosticCodeEnum} CqlDiagnosticCodeEnum */
/** @typedef {import('./cql/types').CqlSource} CqlSource */

module.exports = {
    CQL_KEYWORDS,
    CqlDiagnosticCode,
    tokenizeCql,
    parseCqlColumns,
    getTokenContext,
    getCursorClause,
    extractSourceRelations,
    cdsTypeToTs,
    resolveBaseType,
    getSuggestions,
    validateCqlQuery,
};

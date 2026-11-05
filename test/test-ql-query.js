'use strict';
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
    cdsTypeToTs,
    resolveBaseType,
    extractSourceRelations,
    getCursorClause,
    getTokenContext,
    getSuggestions,
    parseCqlColumns,
    tokenizeCql,
    validateCqlQuery,
    CqlDiagnosticCode,
} = require('../src/CqlLogic');
/** @typedef {import('../src/CqlLogic').CqlSource} CqlSource */
const {
    buildTypeString,
    buildTypeBody,
    resolveTypeExpr,
    collectCqlAssignments,
    extractTemplateText,
    fieldTokenAtOffset,
    findCdsQueryTemplate,
    offsetInTemplate,
    rewriteSnapshot,
    resolveToCdsQuery,
} = require('../src/CqlTypeRewriter');
const { getCqlCompletions, getCqlCompletionDetails } = require('../src/CqlCompletions');
const { getCqlHover } = require('../src/CqlHover');
const { getCqlDiagnostics } = require('../src/CqlDiagnostics');
const { serviceAnnotationFor } = require('../src/ServiceAnnotation');
const { readConfig, resolveQueryContext } = require('../src/QueryContext');
/** @typedef {import('../src/QueryContext').QueryContext} QueryContext */
/** @typedef {import('../src/QueryContext').RunWorker} RunWorker */
/** @typedef {import('../src/QueryContext').RunBatchWorker} RunBatchWorker */
/** @typedef {import('../src/QueryContext').WorkerResult} WorkerResult */
const { runWorkerMain, runBatchWorkerMain, _testOverrides: workerTestOverrides } = require('../src/cds-resolver-worker');
const TS = require('typescript');
const { join } = require('node:path');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function withCursor(template) {
    const cursor = template.indexOf('|');
    assert.ok(cursor !== -1, 'template must contain exactly one | marker');
    return { query: template.replace(/\|/g, ''), cursor };
}

/** Minimal CDS model definitions object for tests. */
function defs(entities) {
    const result = {};
    for (const [fqn, elements] of Object.entries(entities)) {
        const kind = fqn.includes('View') ? 'view' : 'entity';
        result[fqn] = {
            kind,
            elements: Object.fromEntries(Object.entries(elements).map(([name, type]) => [name, { type }])),
        };
    }
    return result;
}

function includesAll(arr, members) {
    for (const m of members) assert.ok(arr.includes(m), `expected "${m}" in [${arr.join(', ')}]`);
}

function excludes(arr, item) {
    assert.ok(!arr.includes(item), `expected "${item}" to not be in [${arr.join(', ')}]`);
}

// ---------------------------------------------------------------------------
// tokenizeCql
// ---------------------------------------------------------------------------

describe('tokenizeCql', () => {
    it('tokenizes a simple SELECT query', () => {
        const tokens = tokenizeCql('SELECT id FROM Books');
        const sig = tokens.filter((t) => t.kind !== 'whitespace').map((t) => `${t.kind}:${t.value}`);
        assert.deepEqual(sig, ['keyword:SELECT', 'identifier:id', 'keyword:FROM', 'identifier:Books']);
    });

    it('assigns correct offsets', () => {
        const tokens = tokenizeCql('SELECT id');
        const id = tokens.find((t) => t.value === 'id');
        assert.equal(id.start, 7);
        assert.equal(id.end, 9);
    });

    it('classifies keywords case-insensitively', () => {
        const tokens = tokenizeCql('select id from books');
        const kws = tokens.filter((t) => t.kind === 'keyword').map((t) => t.value);
        assert.deepEqual(kws, ['select', 'from']);
    });

    it('recognizes the `one` singularizer as a keyword', () => {
        const tokens = tokenizeCql('SELECT one ID FROM Books');
        const sig = tokens.filter((t) => t.kind !== 'whitespace').map((t) => `${t.kind}:${t.value}`);
        assert.deepEqual(sig, ['keyword:SELECT', 'keyword:one', 'identifier:ID', 'keyword:FROM', 'identifier:Books']);
    });

    it('handles SELECT *', () => {
        const tokens = tokenizeCql('SELECT * FROM Books');
        assert.ok(
            tokens.find((t) => t.kind === 'star'),
            'expected a star token',
        );
    });

    it('handles dotted path as single identifier token', () => {
        const tokens = tokenizeCql('CatalogService.Books');
        const sig = tokens.filter((t) => t.kind !== 'whitespace');
        assert.equal(sig.length, 1);
        assert.equal(sig[0].value, 'CatalogService.Books');
    });

    it('handles multi-char operators', () => {
        const tokens = tokenizeCql('a <> b != c <= d >= e');
        const ops = tokens.filter((t) => t.kind === 'operator').map((t) => t.value);
        assert.deepEqual(ops, ['<>', '!=', '<=', '>=']);
    });

    it('offset covers entire input', () => {
        const query = 'SELECT id, title FROM Books WHERE id > 1';
        const tokens = tokenizeCql(query);
        assert.equal(tokens[tokens.length - 1].end, query.length);
    });

    it('strips // line comments', () => {
        const tokens = tokenizeCql('SELECT id // pick id\nFROM Books');
        const sig = tokens.filter((t) => t.kind !== 'whitespace').map((t) => t.kind);
        assert.deepEqual(sig, ['keyword', 'identifier', 'keyword', 'identifier']);
    });

    it('strips block comments', () => {
        const tokens = tokenizeCql('SELECT /* all */ id FROM Books');
        const sig = tokens.filter((t) => t.kind !== 'whitespace').map((t) => `${t.kind}:${t.value}`);
        assert.deepEqual(sig, ['keyword:SELECT', 'identifier:id', 'keyword:FROM', 'identifier:Books']);
    });

    it('handles single-quoted string literals', () => {
        const tokens = tokenizeCql("SELECT id FROM Books WHERE title = 'Hello'");
        const str = tokens.find((t) => t.kind === 'string');
        assert.ok(str, 'expected a string token');
        assert.equal(str.value, "'Hello'");
    });

    it('handles escaped quote inside string literal', () => {
        const tokens = tokenizeCql("WHERE name = 'it\\'s'");
        const str = tokens.find((t) => t.kind === 'string');
        assert.ok(str, 'expected string token with escaped quote');
    });
});

// ---------------------------------------------------------------------------
// extractSourceRelations
// ---------------------------------------------------------------------------

describe('extractSourceRelations', () => {
    function sources(query) {
        const sig = tokenizeCql(query).filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
        return extractSourceRelations(sig);
    }

    it('returns entity name as both entity and ref when no alias', () => {
        const result = sources('SELECT id FROM Books');
        assert.equal(result.length, 1);
        assert.equal(result[0].entity, 'Books');
        assert.equal(result[0].ref, 'Books');
    });

    it('returns alias as ref with AS keyword', () => {
        const result = sources('SELECT B.id FROM Books AS B');
        assert.equal(result.length, 1);
        assert.equal(result[0].entity, 'Books');
        assert.equal(result[0].ref, 'B');
    });

    it('returns alias as ref with implicit alias (no AS)', () => {
        const result = sources('SELECT B.id FROM Books B');
        assert.equal(result.length, 1);
        assert.equal(result[0].entity, 'Books');
        assert.equal(result[0].ref, 'B');
    });

    it('handles qualified entity name with alias', () => {
        const result = sources('SELECT B.id FROM CatalogService.Books AS B');
        assert.equal(result[0].entity, 'CatalogService.Books');
        assert.equal(result[0].ref, 'B');
    });

    it('extracts multiple JOIN sources with aliases', () => {
        const result = sources('SELECT A.id FROM Authors AS A JOIN Books AS B ON A.id = B.authorId');
        assert.equal(result.length, 2);
        assert.equal(result[0].entity, 'Authors');
        assert.equal(result[0].ref, 'A');
        assert.equal(result[1].entity, 'Books');
        assert.equal(result[1].ref, 'B');
    });

    it('does not treat SELECT-clause identifiers as entities', () => {
        const result = sources('SELECT age, name FROM Authors AS A');
        assert.equal(result.length, 1);
        assert.equal(result[0].entity, 'Authors');
    });

    it('returns empty array when no FROM clause', () => {
        assert.deepEqual(sources('SELECT 1'), []);
    });

    it('ignores sources inside subqueries', () => {
        const result = sources('SELECT id FROM Books WHERE id IN (SELECT id FROM Authors)');
        assert.equal(result.length, 1);
        assert.equal(result[0].entity, 'Books');
    });

    it('handles entity followed immediately by punctuation (clears pendingEntity)', () => {
        // FROM Books, Authors — comma is a non-identifier non-keyword token; pendingEntity
        // is flushed with entity=ref when a punctuation follows the entity name
        const result = sources('FROM Books, Authors');
        const names = result.map((s) => s.entity);
        assert.ok(names.includes('Books'), 'Books must be in sources');
    });
});

// ---------------------------------------------------------------------------
// getCursorClause
// ---------------------------------------------------------------------------

describe('getCursorClause', () => {
    function clause(template) {
        const { query, cursor } = withCursor(template);
        return getCursorClause(tokenizeCql(query), cursor);
    }

    it('returns select-item when cursor is in SELECT list', () => {
        assert.equal(clause('SELECT id, |title FROM Books').kind, 'select-item');
    });

    it('select-item carries source entity and ref when FROM precedes cursor', () => {
        const result = clause('SELECT FROM Books WHERE |');
        assert.equal(result.kind, 'where-expr');
        const srcs = result.sources;
        assert.equal(srcs.length, 1);
        assert.equal(srcs[0].entity, 'Books');
        assert.equal(srcs[0].ref, 'Books');
    });

    it('select-item has empty sources when cursor is before FROM', () => {
        // getCursorClause only sees tokens before cursor — FROM not yet reached
        const result = clause('SELECT | FROM Books');
        assert.equal(result.kind, 'select-item');
        assert.equal(result.sources.length, 0);
    });

    it('where-expr with alias carries alias as ref', () => {
        const result = clause('SELECT ID FROM Books AS B WHERE |');
        assert.equal(result.kind, 'where-expr');
        const srcs = result.sources;
        assert.equal(srcs[0].ref, 'B');
        assert.equal(srcs[0].entity, 'Books');
    });

    it('returns from-source when cursor is after FROM', () => {
        assert.equal(clause('SELECT id FROM |').kind, 'from-source');
    });

    it('returns where-expr when cursor is in WHERE clause', () => {
        const result = clause('SELECT id FROM Books WHERE |');
        assert.equal(result.kind, 'where-expr');
        assert.equal(result.sources[0].entity, 'Books');
    });

    it('returns order-by for ORDER BY', () => {
        const result = clause('SELECT id FROM Books ORDER BY |');
        assert.equal(result.kind, 'order-by');
        assert.equal(result.sources[0].entity, 'Books');
    });

    it('returns from-source after JOIN keyword', () => {
        assert.equal(clause('SELECT * FROM Books JOIN |').kind, 'from-source');
    });

    it('returns unknown when no clause keyword precedes cursor', () => {
        assert.equal(clause('|').kind, 'unknown');
    });

    it('ignores clause keywords inside subqueries', () => {
        assert.equal(clause('SELECT | FROM Books WHERE id IN (SELECT id FROM Authors WHERE id > 1)').kind, 'select-item');
    });

    it('where-expr with implicit alias — entity used as ref (implicit alias not captured by getCursorClause)', () => {
        // getCursorClause does not resolve implicit aliases; entity name is used as ref
        // (implicit alias resolution is handled separately by extractSourceRelations)
        const result = clause('SELECT ID FROM Books B WHERE |');
        assert.equal(result.kind, 'where-expr');
        const srcs = result.sources;
        assert.equal(srcs[0].entity, 'Books');
        // implicit alias 'B' is not captured; entity name is used as self-ref
        assert.equal(srcs[0].ref, 'Books');
    });

    it('expandPath uses the association name inside a plain expand block', () => {
        const result = clause('SELECT FROM Authors { name, address { | } }');
        assert.equal(result.kind, 'select-item');
        assert.deepEqual(result.expandPath, ['address']);
    });

    it('expandPath uses the association name (not the alias) inside an aliased expand block', () => {
        // Regression: `address as residence { | }` must scope completions to the
        // association `address`, not the alias `residence`.
        const result = clause('SELECT FROM Authors { name, address as residence { | } }');
        assert.equal(result.kind, 'select-item');
        assert.deepEqual(result.expandPath, ['address']);
    });

    it('expandPath uses association names through nested aliased expands', () => {
        const result = clause('SELECT FROM Authors { address as residence { town as city { | } } }');
        assert.equal(result.kind, 'select-item');
        assert.deepEqual(result.expandPath, ['address', 'town']);
    });

    it('scalar AS alias inside a projection does not leak into sources or expandPath', () => {
        const result = clause('SELECT FROM Books { ID, title as t, | }');
        assert.equal(result.kind, 'select-item');
        assert.deepEqual(result.expandPath, []);
        const srcs = result.sources;
        assert.equal(srcs[0].entity, 'Books');
        assert.equal(srcs[0].ref, 'Books');
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — field completions
// ---------------------------------------------------------------------------

describe('getSuggestions — fields', () => {
    const model = defs({
        'Svc.Books': { ID: 'cds.UUID', title: 'cds.String' },
        'Svc.Authors': {
            ID: 'cds.UUID',
            name: 'cds.String',
            age: 'cds.Integer',
        },
    });

    it('suggests fields from FROM entity in SELECT clause', () => {
        const { query, cursor } = withCursor('SELECT | FROM Books');
        const items = getSuggestions(query, cursor, model, 'Svc');
        includesAll(
            items.map((i) => i.label),
            ['ID', 'title'],
        );
        // Field entries carry kind 'field'; keyword suggestions (DISTINCT/FROM) also
        // appear here and are asserted separately in the keywords block.
        assert.ok(items.filter((i) => i.kind !== 'keyword').every((i) => i.kind === 'field'));
    });

    it('suggests fields when cursor is before FROM', () => {
        const { query, cursor } = withCursor('SELECT | FROM Books');
        const items = getSuggestions(query, cursor, model, 'Svc');
        includesAll(
            items.map((i) => i.label),
            ['ID', 'title'],
        );
    });

    it('suggests fields in WHERE clause', () => {
        const { query, cursor } = withCursor('SELECT ID FROM Books WHERE |');
        includesAll(
            getSuggestions(query, cursor, model, 'Svc').map((i) => i.label),
            ['ID', 'title'],
        );
    });

    it('suggests fields in ORDER BY clause', () => {
        const { query, cursor } = withCursor('SELECT ID FROM Books ORDER BY |');
        includesAll(
            getSuggestions(query, cursor, model, 'Svc').map((i) => i.label),
            ['ID', 'title'],
        );
    });

    it('tags each field with its source entity FQN', () => {
        const { query, cursor } = withCursor('SELECT | FROM Books');
        const items = getSuggestions(query, cursor, model, 'Svc');
        assert.ok(
            items.filter((i) => i.kind === 'field').every((i) => i.entity === 'Svc.Books'),
            'all fields should be tagged with Svc.Books',
        );
    });

    it('suggests fields from all JOIN sources', () => {
        const { query, cursor } = withCursor('SELECT | FROM Books JOIN Authors ON Books.ID = Authors.ID');
        includesAll(
            getSuggestions(query, cursor, model, 'Svc').map((i) => i.label),
            ['title', 'name', 'age'],
        );
    });

    it('suggests fields when entity has alias', () => {
        const { query, cursor } = withCursor('SELECT | FROM Authors AS A');
        includesAll(
            getSuggestions(query, cursor, model, 'Svc').map((i) => i.label),
            ['ID', 'name', 'age'],
        );
    });

    it('suggests fields when entity has implicit alias (no AS)', () => {
        // "FROM Authors A" — A is an implicit alias without the AS keyword
        const { query, cursor } = withCursor('SELECT | FROM Authors A');
        includesAll(
            getSuggestions(query, cursor, model, 'Svc').map((i) => i.label),
            ['ID', 'name', 'age'],
        );
    });

    it('returns empty suggestions when entity has no elements', () => {
        // Entity exists but has no elements — getSuggestions must produce no field
        // suggestions (clause keywords like FROM/DISTINCT may still appear).
        const noElemModel = {
            'Svc.Books': { kind: 'entity' },
        };
        const { query, cursor } = withCursor('SELECT | FROM Books');
        const items = getSuggestions(query, cursor, noElemModel, 'Svc');
        assert.deepEqual(
            items.filter((i) => i.kind !== 'keyword'),
            [],
            'entity with no elements must produce no field suggestions',
        );
    });

    it('uses @description as doc when doc.val is absent', () => {
        // Element has @description but no doc property — getSuggestions must use @description
        const descModel = {
            'Svc.Books': {
                kind: 'entity',
                elements: {
                    title: {
                        type: 'cds.String',
                        '@description': { val: 'Book title' },
                    },
                },
            },
        };
        const { query, cursor } = withCursor('SELECT | FROM Books');
        const items = getSuggestions(query, cursor, descModel, 'Svc');
        const titleEntry = items.find((i) => i.label === 'title');
        assert.ok(titleEntry, 'title must be in suggestions');
        assert.equal(titleEntry.doc, 'Book title', '@description val must be used as doc');
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — keyword completions
// ---------------------------------------------------------------------------

describe('getSuggestions — keywords', () => {
    const model = defs({
        'Svc.Books': { ID: 'cds.UUID', title: 'cds.String' },
        'Svc.Authors': { ID: 'cds.UUID', name: 'cds.String' },
    });
    const kws = (template) => {
        const { query, cursor } = withCursor(template);
        return getSuggestions(query, cursor, model, 'Svc')
            .filter((i) => i.kind === 'keyword')
            .map((i) => i.label);
    };

    it('offers DISTINCT and FROM in the SELECT clause', () => {
        includesAll(kws('SELECT | FROM Books'), ['DISTINCT', 'FROM']);
        includesAll(kws('SELECT ID |'), ['DISTINCT', 'FROM']);
    });

    it('offers transition keywords after a named FROM source', () => {
        includesAll(kws('SELECT ID FROM Books |'), ['WHERE', 'ORDER BY', 'GROUP BY', 'HAVING', 'LIMIT', 'JOIN', 'LEFT JOIN', 'ON']);
    });

    it('offers no transition keywords right after a bare FROM (entities only)', () => {
        assert.deepEqual(kws('SELECT ID FROM |'), []);
    });

    it('offers boolean/predicate keywords in the WHERE clause', () => {
        includesAll(kws('SELECT ID FROM Books WHERE title = 1 |'), ['AND', 'OR', 'NOT', 'LIKE', 'IS']);
    });

    it('offers ASC/DESC in the ORDER BY clause', () => {
        includesAll(kws('SELECT ID FROM Books ORDER BY ID |'), ['ASC', 'DESC']);
    });

    it('offers no keywords inside a projection/expand block', () => {
        assert.deepEqual(kws('SELECT ID FROM Books { | }'), []);
        assert.deepEqual(kws('SELECT ID FROM Books { ID, | }'), []);
    });

    it('tags keyword entries with kind "keyword" and no entity', () => {
        const { query, cursor } = withCursor('SELECT ID |');
        const kw = getSuggestions(query, cursor, model, 'Svc').find((i) => i.label === 'FROM');
        assert.equal(kw.kind, 'keyword');
        assert.equal(kw.entity, undefined);
    });

    it('offers statement keywords at the start of an empty query', () => {
        const labels = getSuggestions('', 0, model, 'Svc').map((i) => i.label);
        includesAll(labels, ['SELECT', 'INSERT', 'UPDATE', 'UPSERT', 'DELETE']);
        assert.ok(
            getSuggestions('', 0, model, 'Svc').every((i) => i.kind === 'keyword'),
            'only keyword suggestions at empty-query start',
        );
    });

    it('offers statement keywords after leading whitespace', () => {
        includesAll(
            getSuggestions('   ', 3, model, 'Svc').map((i) => i.label),
            ['SELECT', 'UPDATE', 'DELETE'],
        );
    });

    it('offers statement keywords while typing the first word', () => {
        // Host (tsserver) filters by prefix; the plugin offers the full set.
        includesAll(
            getSuggestions('SE', 2, model, 'Svc').map((i) => i.label),
            ['SELECT', 'INSERT', 'UPDATE', 'UPSERT', 'DELETE'],
        );
    });

    it('does not offer statement keywords once a clause context exists', () => {
        const labels = kws('SELECT ID FROM Books |');
        excludes(labels, 'SELECT');
        excludes(labels, 'DELETE');
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — entity completions
// ---------------------------------------------------------------------------

describe('getSuggestions — entities', () => {
    const model = defs({
        'Svc.Authors': { ID: 'cds.UUID' },
        'Svc.Books': { ID: 'cds.UUID' },
        'Svc.BooksView': { ID: 'cds.UUID' },
        'Other.Books': { ID: 'cds.UUID' },
    });

    it('suggests local entity names for from-source', () => {
        const { query, cursor } = withCursor('SELECT id FROM |');
        const labels = getSuggestions(query, cursor, model, 'Svc').map((i) => i.label);
        includesAll(labels, ['Books', 'BooksView']);
        excludes(labels, 'Other.Books');
    });

    it('returns entity kind for entity', () => {
        const { query, cursor } = withCursor('SELECT id FROM |');
        const items = getSuggestions(query, cursor, model, 'Svc');
        assert.equal(items.find((i) => i.label === 'Books').kind, 'entity');
    });

    it('returns view kind for view', () => {
        const { query, cursor } = withCursor('SELECT id FROM |');
        const items = getSuggestions(query, cursor, model, 'Svc');
        assert.equal(items.find((i) => i.label === 'BooksView').kind, 'view');
    });

    it('suggests entities when cursor is mid-token after FROM', () => {
        // "SELECT x FROM Au|" — cursor inside partial identifier
        const query = 'SELECT x FROM Au';
        const cursor = query.length; // end of 'Au'
        const items = getSuggestions(query, cursor, model, 'Svc');
        includesAll(
            items.map((i) => i.label),
            ['Books', 'Authors'],
        );
    });

    it('returns full FQN labels when no prefix given', () => {
        const { query, cursor } = withCursor('SELECT id FROM |');
        includesAll(
            getSuggestions(query, cursor, model).map((i) => i.label),
            ['Svc.Books', 'Other.Books'],
        );
    });
});

// ---------------------------------------------------------------------------
// getTokenContext
// ---------------------------------------------------------------------------

describe('getTokenContext', () => {
    const model = defs({
        'Svc.Books': { ID: 'cds.UUID', title: 'cds.String' },
        'Svc.Authors': { ID: 'cds.UUID', name: 'cds.String' },
    });

    it('returns null when cursor is not on an identifier', () => {
        // cursor on the space between SELECT and id
        assert.equal(getTokenContext('SELECT id FROM Books', 6, model, 'Svc'), null);
    });

    it('identifies entity name directly after FROM', () => {
        const query = 'SELECT id FROM Books';
        const result = getTokenContext(query, query.indexOf('Books'), model, 'Svc');
        assert.equal(result?.kind, 'entity');
        assert.equal(result.fqn, 'Svc.Books');
    });

    it('identifies entity name after JOIN', () => {
        const query = 'SELECT id FROM Books JOIN Authors ON Books.ID = Authors.ID';
        const result = getTokenContext(query, query.indexOf('Authors'), model, 'Svc');
        assert.equal(result?.kind, 'entity');
        assert.equal(result.fqn, 'Svc.Authors');
    });

    it('identifies AS alias as alias kind', () => {
        const query = 'SELECT id FROM Books AS B';
        const offset = query.lastIndexOf('B'); // the alias, nothing else named B
        const result = getTokenContext(query, offset, model, 'Svc');
        assert.equal(result?.kind, 'alias');
    });

    it('identifies implicit alias as alias kind', () => {
        const query = 'SELECT B.id FROM Books B WHERE B.id = 1';
        const offset = 'SELECT B.id FROM Books '.length; // start of implicit alias 'B'
        const result = getTokenContext(query, offset, model, 'Svc');
        assert.equal(result?.kind, 'alias');
    });

    it('identifies field in SELECT list as field kind', () => {
        const query = 'SELECT id FROM Books';
        const result = getTokenContext(query, query.indexOf('id'), model, 'Svc');
        assert.equal(result?.kind, 'field');
    });

    it('identifies field in WHERE clause as field kind', () => {
        const query = 'SELECT id FROM Books WHERE title = 1';
        const result = getTokenContext(query, query.indexOf('title'), model, 'Svc');
        assert.equal(result?.kind, 'field');
    });

    it('returns entity kind with raw value as fqn for unresolved entity', () => {
        const query = 'SELECT id FROM Unknown';
        const result = getTokenContext(query, query.indexOf('Unknown'), model, 'Svc');
        assert.equal(result?.kind, 'entity');
        assert.equal(result.fqn, 'Unknown');
    });
});

// ---------------------------------------------------------------------------
// validateCqlQuery
// ---------------------------------------------------------------------------

describe('validateCqlQuery', () => {
    const model = defs({
        'Svc.Books': { ID: 'cds.UUID', title: 'cds.String' },
        'Svc.Authors': {
            ID: 'cds.UUID',
            name: 'cds.String',
            age: 'cds.Integer',
        },
    });

    it('returns no errors for a valid query', () => {
        assert.deepEqual(validateCqlQuery('SELECT ID, title FROM Books', model, 'Svc'), []);
    });

    it('returns no errors for SELECT *', () => {
        assert.deepEqual(validateCqlQuery('SELECT * FROM Books', model, 'Svc'), []);
    });

    it('accepts the `one` singularizer keyword before the column list', () => {
        assert.deepEqual(validateCqlQuery('SELECT one ID, title FROM Books', model, 'Svc'), []);
        assert.deepEqual(validateCqlQuery('SELECT ONE ID FROM Books', model, 'Svc'), []);
        assert.deepEqual(validateCqlQuery('SELECT one * FROM Books', model, 'Svc'), []);
    });

    it('still validates columns that follow the `one` keyword', () => {
        const errs = validateCqlQuery('SELECT one ghost FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('reports unknown entity', () => {
        const errs = validateCqlQuery('SELECT ID FROM NoSuchEntity', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('NoSuchEntity'));
    });

    it('unknown entity error spans the entity token', () => {
        const query = 'SELECT ID FROM NoSuchEntity';
        const errs = validateCqlQuery(query, model, 'Svc');
        assert.equal(query.slice(errs[0].start, errs[0].end), 'NoSuchEntity');
    });

    it('reports unknown field', () => {
        const errs = validateCqlQuery('SELECT ghost FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('unknown field error spans the field token', () => {
        const query = 'SELECT ghost FROM Books';
        const errs = validateCqlQuery(query, model, 'Svc');
        assert.equal(query.slice(errs[0].start, errs[0].end), 'ghost');
    });

    it('reports ambiguous field present in multiple JOIN sources', () => {
        const errs = validateCqlQuery('SELECT ID FROM Books JOIN Authors ON Books.ID = Authors.ID', model, 'Svc');
        assert.ok(
            errs.find((e) => e.message.includes('Ambiguous')),
            'expected ambiguity error for ID',
        );
    });

    it('no error for qualified reference with alias', () => {
        assert.deepEqual(validateCqlQuery('SELECT A.ID FROM Authors AS A', model, 'Svc'), []);
    });

    it('no error for qualified reference without alias', () => {
        assert.deepEqual(validateCqlQuery('SELECT Books.ID FROM Books', model, 'Svc'), []);
    });

    it('reports unknown source in qualified reference', () => {
        const errs = validateCqlQuery('SELECT Z.ID FROM Books', model, 'Svc');
        assert.ok(
            errs.find((e) => e.message.includes("Unknown source 'Z'")),
            'expected unknown source error',
        );
    });

    it('reports unknown field on qualified source', () => {
        const errs = validateCqlQuery('SELECT Books.ghost FROM Books', model, 'Svc');
        assert.ok(
            errs.find((e) => e.message.includes("Unknown field 'ghost'")),
            'expected unknown field error',
        );
    });

    it('respects prefix: uses annotation service for entity lookup', () => {
        assert.deepEqual(validateCqlQuery('SELECT ID FROM Books', model, 'Svc'), []);
        const errs = validateCqlQuery('SELECT ID FROM Books', model, 'WrongSvc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('Books'));
    });

    it('no error for aliased JOIN with unambiguous fields', () => {
        // Only Authors has 'name' and 'age', only Books has 'title' — unambiguous
        assert.deepEqual(validateCqlQuery('SELECT name, title FROM Authors AS A JOIN Books AS B ON A.ID = B.ID', model, 'Svc'), []);
    });

    it('alias appears in ambiguity error message', () => {
        const errs = validateCqlQuery('SELECT ID FROM Authors AS A JOIN Books AS B ON A.ID = B.ID', model, 'Svc');
        const e = errs.find((e) => e.message.includes('Ambiguous'));
        assert.ok(e, 'expected ambiguity error');
        assert.ok(e.message.includes('A'), 'alias A should appear in message');
        assert.ok(e.message.includes('B'), 'alias B should appear in message');
    });

    it('does not flag SELECT-clause field names as unknown entities', () => {
        // Regression: field names (age, name) must not be treated as FROM sources
        assert.deepEqual(validateCqlQuery('SELECT age, name FROM Authors AS A', model, 'Svc'), []);
    });

    it('reports error for field not on aliased entity', () => {
        const errs = validateCqlQuery('SELECT A.ghost FROM Authors AS A', model, 'Svc');
        assert.ok(errs.find((e) => e.message.includes("Unknown field 'ghost'")));
    });

    it('validates fields used in ORDER BY clause', () => {
        assert.deepEqual(validateCqlQuery('SELECT ID FROM Books ORDER BY ID', model, 'Svc'), []);
    });

    it('reports error for unknown field in ORDER BY clause', () => {
        const errs = validateCqlQuery('SELECT ID FROM Books ORDER BY ghost', model, 'Svc');
        assert.ok(errs.find((e) => e.message.includes("Unknown field 'ghost'")));
    });

    it('accepts implicit alias (no AS keyword)', () => {
        assert.deepEqual(validateCqlQuery('SELECT B.ID FROM Books B', model, 'Svc'), []);
    });

    it('resolves entity by FQN when name contains dot and no prefix supplied', () => {
        const fqnModel = {
            'Svc.Books': {
                kind: 'entity',
                elements: { ID: { type: 'cds.UUID' } },
            },
        };
        assert.deepEqual(validateCqlQuery('SELECT ID FROM Svc.Books', fqnModel, undefined), []);
    });

    it('ignores field references inside parenthesised subquery context', () => {
        // Parentheses increase depth; tokens inside must be skipped for validation
        assert.deepEqual(validateCqlQuery('SELECT ID FROM Books WHERE ID IN (SELECT 1)', model, 'Svc'), []);
    });

    it('does not flag an aggregate function name as an unknown field', () => {
        // Regression: `max` is a function, not a field — must not be flagged.
        assert.deepEqual(validateCqlQuery('SELECT max(ID) as ID FROM Books', model, 'Svc'), []);
    });

    it('accepts count(*) without flagging count or the star', () => {
        assert.deepEqual(validateCqlQuery('SELECT count(*) as n FROM Books', model, 'Svc'), []);
    });

    it('still validates the field argument of a function call', () => {
        const errs = validateCqlQuery('SELECT max(ghost) as x FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes("Unknown field 'ghost'"), 'expected the argument to be flagged');
        assert.equal('SELECT max(ghost) as x FROM Books'.slice(errs[0].start, errs[0].end), 'ghost');
    });

    it('accepts a function call alongside plain columns', () => {
        assert.deepEqual(validateCqlQuery('SELECT title, max(ID) as mx FROM Books', model, 'Svc'), []);
    });
});

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Synthesized managed-association foreign-key columns (`<assoc>_<key>`) are
// valid field references in SELECT, even though they are not top-level elements
// in the unresolved CSN.
// ---------------------------------------------------------------------------

describe('validateCqlQuery — synthesized FK columns', () => {
    const model = {
        'Svc.Books': {
            kind: 'entity',
            elements: {
                ID: { type: 'cds.UUID' },
                title: { type: 'cds.String' },
                author: { type: 'cds.Association', target: 'Svc.Authors', keys: [{ ref: ['ID'] }] },
            },
        },
        'Svc.Authors': {
            kind: 'entity',
            elements: { ID: { type: 'cds.UUID' }, name: { type: 'cds.String' } },
        },
    };

    it('accepts a bare synthesized FK column (author_ID)', () => {
        assert.deepEqual(validateCqlQuery('SELECT author_ID FROM Books', model, 'Svc'), []);
    });

    it('accepts a synthesized FK column alongside real fields', () => {
        assert.deepEqual(validateCqlQuery('SELECT ID, author_ID, title FROM Books', model, 'Svc'), []);
    });

    it('accepts an alias-qualified synthesized FK column (b.author_ID)', () => {
        assert.deepEqual(validateCqlQuery('SELECT b.author_ID FROM Books as b', model, 'Svc'), []);
    });

    it('still reports an FK-looking name with no backing association', () => {
        const errs = validateCqlQuery('SELECT ghost_ID FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownField);
    });
});

// ---------------------------------------------------------------------------
// Association-path references in SELECT columns — `assoc.field` navigates the
// association to its target entity (distinct from `alias.field` qualification).
// ---------------------------------------------------------------------------

describe('validateCqlQuery — association paths', () => {
    // Hand-built model with managed associations (element carries `target` + `keys`).
    const model = {
        'Svc.Books': {
            kind: 'entity',
            elements: {
                ID: { type: 'cds.UUID' },
                title: { type: 'cds.String' },
                author: { type: 'cds.Association', target: 'Svc.Authors', keys: [{ ref: ['ID'] }] },
            },
        },
        'Svc.Authors': {
            kind: 'entity',
            elements: {
                ID: { type: 'cds.UUID' },
                name: { type: 'cds.String' },
                address: { type: 'cds.Association', target: 'Svc.Addresses', keys: [{ ref: ['ID'] }] },
            },
        },
        'Svc.Addresses': {
            kind: 'entity',
            elements: {
                ID: { type: 'cds.UUID' },
                city: { type: 'cds.String' },
            },
        },
    };

    it('accepts a single-hop association path (author.name)', () => {
        assert.deepEqual(validateCqlQuery('SELECT author.name FROM Books', model, 'Svc'), []);
    });

    it('accepts a deep association path (author.address.city)', () => {
        assert.deepEqual(validateCqlQuery('SELECT author.address.city FROM Books', model, 'Svc'), []);
    });

    it('accepts a synthesized FK column as the terminal segment (author.ID → author_ID exists)', () => {
        // `author.ID` navigates the assoc to Authors and reads ID there.
        assert.deepEqual(validateCqlQuery('SELECT author.ID FROM Books', model, 'Svc'), []);
    });

    it('accepts source-qualified + association path together (b.author.name)', () => {
        assert.deepEqual(validateCqlQuery('SELECT b.author.name FROM Books as b', model, 'Svc'), []);
    });

    it('reports an unknown association as Unknown source', () => {
        const errs = validateCqlQuery('SELECT ghost.name FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownSource);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('reports an unknown terminal field on a valid association path', () => {
        const errs = validateCqlQuery('SELECT author.ghostField FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownField);
    });

    it('reports a mid-path non-association segment', () => {
        // `title` is a known scalar (not an association) so it cannot be navigated.
        // It is reported as an unknown field (the whole path is invalid), not an
        // unknown source — `title` itself exists on the entity.
        const errs = validateCqlQuery('SELECT title.whatever FROM Books', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownField);
    });

    it('still reports an unknown alias-qualified source', () => {
        const errs = validateCqlQuery('SELECT zz.ID FROM Books as b', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownSource);
    });
});

// ---------------------------------------------------------------------------
// Draft shadow entities (`<Entity>.drafts`) — not in the compiled CSN, so a
// trailing `.drafts` is stripped and resolved against the base entity.
// ---------------------------------------------------------------------------

describe('draft entities (.drafts suffix)', () => {
    const model = defs({
        'Svc.Books': { ID: 'cds.UUID', title: 'cds.String' },
    });
    const fqnModel = {
        'sap.capire.bookshop.Books': {
            kind: 'entity',
            elements: { ID: { type: 'cds.UUID' }, title: { type: 'cds.String' } },
        },
    };

    it('resolves a prefixed draft entity to its base (no diagnostics)', () => {
        assert.deepEqual(validateCqlQuery('SELECT ID FROM Books.drafts', model, 'Svc'), []);
    });

    it('resolves a fully-qualified draft entity to its base (no diagnostics)', () => {
        assert.deepEqual(validateCqlQuery('SELECT ID FROM sap.capire.bookshop.Books.drafts', fqnModel, undefined), []);
    });

    it('validates fields against the base entity for a draft query', () => {
        const errs = validateCqlQuery('SELECT ghost FROM Books.drafts', model, 'Svc');
        assert.ok(
            errs.find((e) => e.message.includes("Unknown field 'ghost'")),
            'expected the bad field to be flagged against the base entity',
        );
    });

    it('still flags a genuinely unknown entity carrying a .drafts suffix', () => {
        const errs = validateCqlQuery('SELECT ID FROM Nope.drafts', model, 'Svc');
        assert.ok(
            errs.find((e) => e.message.includes('Unknown entity')),
            'expected unknown-entity diagnostic',
        );
    });

    it('suggests base-entity fields inside a draft-entity query', () => {
        const { query, cursor } = withCursor('SELECT | FROM Books.drafts');
        const items = getSuggestions(query, cursor, model, 'Svc');
        includesAll(
            items.map((i) => i.label),
            ['ID', 'title'],
        );
    });
});

// ---------------------------------------------------------------------------
// validateCqlQuery — write statements (UPDATE / INSERT / UPSERT)
// ---------------------------------------------------------------------------

describe('validateCqlQuery — write statements', () => {
    const model = defs({
        'Svc.Books': { ID: 'cds.UUID', title: 'cds.String', stock: 'cds.Integer' },
    });

    // --- UPDATE ---
    it('accepts a valid UPDATE with SET and WHERE', () => {
        assert.deepEqual(validateCqlQuery("UPDATE Books SET title = 'x' WHERE ID = 1", model, 'Svc'), []);
    });

    it('reports unknown entity on UPDATE', () => {
        const errs = validateCqlQuery('UPDATE Nope SET title = 1', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownEntity);
        assert.ok(errs[0].message.includes('Nope'));
    });

    it('reports unknown field in SET target', () => {
        const q = 'UPDATE Books SET bogus = 1';
        const errs = validateCqlQuery(q, model, 'Svc');
        assert.equal(errs.length, 1);
        assert.equal(errs[0].code, CqlDiagnosticCode.UnknownField);
        assert.equal(q.slice(errs[0].start, errs[0].end), 'bogus');
    });

    it('reports unknown field in WHERE clause', () => {
        const errs = validateCqlQuery('UPDATE Books SET title = 1 WHERE bogus = 2', model, 'Svc');
        assert.ok(errs.find((e) => e.message.includes("Unknown field 'bogus'")));
    });

    it('does not flag SET right-hand-side values', () => {
        // `stock` is a valid field, but here it is used as a literal-ish RHS; the
        // target `title` is valid, so no diagnostics.
        assert.deepEqual(validateCqlQuery('UPDATE Books SET title = 1', model, 'Svc'), []);
    });

    it('accepts the SET object form', () => {
        assert.deepEqual(validateCqlQuery('UPDATE Books SET { title: 1 }', model, 'Svc'), []);
    });

    it('reports unknown field in SET object form', () => {
        const errs = validateCqlQuery('UPDATE Books SET { bogus: 1 }', model, 'Svc');
        assert.ok(errs.find((e) => e.message.includes("Unknown field 'bogus'")));
    });

    it('validates each target in a multi-assignment SET', () => {
        const errs = validateCqlQuery('UPDATE Books SET title = 1, bogus = 2', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes("Unknown field 'bogus'"));
    });

    it('resolves a .drafts UPDATE target to the base entity', () => {
        assert.deepEqual(validateCqlQuery('UPDATE Books.drafts SET title = 1', model, 'Svc'), []);
    });

    it('accepts a generated foreign-key column in WHERE (managed association)', () => {
        // `author` association with key `ID` generates a valid `author_ID` FK column.
        const assocModel = {
            'Svc.Books': {
                kind: 'entity',
                elements: {
                    ID: { type: 'cds.UUID' },
                    author: { type: 'cds.Association', target: 'Svc.Authors', keys: [{ ref: ['ID'] }] },
                },
            },
            'Svc.Authors': { kind: 'entity', elements: { ID: { type: 'cds.UUID' } } },
        };
        assert.deepEqual(validateCqlQuery('UPDATE Books SET ID = 1 WHERE author_ID = 2', assocModel, 'Svc'), []);
    });

    // --- INSERT / UPSERT ---
    it('accepts a valid INSERT column list', () => {
        assert.deepEqual(validateCqlQuery("INSERT INTO Books (ID, title) VALUES (1, 'x')", model, 'Svc'), []);
    });

    it('reports unknown column in INSERT column list', () => {
        const errs = validateCqlQuery('INSERT INTO Books (ID, bogus) VALUES (1, 2)', model, 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes("Unknown field 'bogus'"));
    });

    it('accepts the COLUMNS (...) form', () => {
        assert.deepEqual(validateCqlQuery('INSERT INTO Books COLUMNS (ID, title) VALUES (1, 2)', model, 'Svc'), []);
    });

    it('accepts the ENTRIES object form and flags bad keys', () => {
        assert.deepEqual(validateCqlQuery('INSERT INTO Books ENTRIES { ID: 1, title: 2 }', model, 'Svc'), []);
        const errs = validateCqlQuery('INSERT INTO Books ENTRIES { bogus: 1 }', model, 'Svc');
        assert.ok(errs.find((e) => e.message.includes("Unknown field 'bogus'")));
    });

    it('reports unknown entity on INSERT/UPSERT', () => {
        assert.ok(validateCqlQuery('INSERT INTO Nope (ID) VALUES (1)', model, 'Svc').find((e) => e.code === CqlDiagnosticCode.UnknownEntity));
        assert.ok(validateCqlQuery('UPSERT INTO Nope ENTRIES { ID: 1 }', model, 'Svc').find((e) => e.code === CqlDiagnosticCode.UnknownEntity));
    });

    it('never flags VALUES list contents as fields', () => {
        // `title` appears only inside VALUES, not the column list — must not flag.
        assert.deepEqual(validateCqlQuery('INSERT INTO Books (ID) VALUES (title)', model, 'Svc'), []);
    });

    // --- regression guards ---
    it('leaves SELECT aggregate validation unchanged', () => {
        assert.deepEqual(validateCqlQuery('SELECT max(ID) as ID FROM Books', model, 'Svc'), []);
    });

    it('leaves DELETE validation unchanged', () => {
        const errs = validateCqlQuery('DELETE FROM Books WHERE bogus = 1', model, 'Svc');
        assert.ok(errs.find((e) => e.message.includes("Unknown field 'bogus'")));
    });
});

// ---------------------------------------------------------------------------
// collectCqlAssignments
// ---------------------------------------------------------------------------

describe('collectCqlAssignments', () => {
    function parse(src) {
        const sf = TS.createSourceFile('test.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        return collectCqlAssignments(TS, sf);
    }

    it('detects a single non-awaited assignment', () => {
        const result = parse('const r = cds.ql`SELECT id FROM Books`');
        assert.equal(result.length, 1);
        assert.equal(result[0].varName, 'r');
        assert.equal(result[0].awaited, false);
    });

    it('detects a single awaited assignment', () => {
        const result = parse('const r = await cds.ql`SELECT id FROM Books`');
        assert.equal(result.length, 1);
        assert.equal(result[0].varName, 'r');
        assert.equal(result[0].awaited, true);
    });

    it('detects multiple assignments in one file', () => {
        const src = ['const q1 = cds.ql`SELECT id FROM Books`;', 'const q2 = await cds.ql`SELECT name FROM Authors`;'].join('\n');
        const result = parse(src);
        assert.equal(result.length, 2);
        assert.equal(result[0].varName, 'q1');
        assert.equal(result[0].awaited, false);
        assert.equal(result[1].varName, 'q2');
        assert.equal(result[1].awaited, true);
    });

    it('ignores non-cds.ql tagged templates', () => {
        const result = parse('const r = sql`SELECT id FROM Books`');
        assert.equal(result.length, 0);
    });

    it('ignores plain string assignments', () => {
        const result = parse("const r = 'SELECT id FROM Books'");
        assert.equal(result.length, 0);
    });

    it('captures varName correctly', () => {
        const result = parse('const myQueryResult = cds.ql`SELECT * FROM Books`');
        assert.equal(result[0].varName, 'myQueryResult');
    });

    it('detects array-destructured assignment', () => {
        const result = parse('const [first] = await cds.ql`SELECT id FROM Books`');
        assert.equal(result.length, 1);
        assert.equal(result[0].varName, '[destructured]');
        assert.equal(result[0].awaited, true);
    });

    it('detects multi-element array-destructured assignment', () => {
        const result = parse('const [r1, r2] = cds.ql`SELECT id FROM Books`');
        assert.equal(result.length, 1);
        assert.equal(result[0].varName, '[destructured]');
        assert.equal(result[0].awaited, false);
    });
});

// ---------------------------------------------------------------------------
// Helpers shared by the new test suites
// ---------------------------------------------------------------------------

/** Minimal ts.server.Logger stub. */
const NO_LOGGER = {
    close: () => {},
    hasLevel: () => false,
    loggingEnabled: () => false,
    perftrc: () => {},
    info: () => {},
    startGroup: () => {},
    endGroup: () => {},
    msg: () => {},
    getLogFileName: () => undefined,
};

/** A RunWorker that always returns empty completions (no CDS model needed). */
const EMPTY_WORKER = (_args, _logger) => ({ completions: [] });

/** A RunBatchWorker that always returns no fields. */
const EMPTY_BATCH_WORKER = (_root, _probes, _logger) => ({
    fields: {},
});

/** A RunBatchWorker that returns a fixed set of fields for every entity. */
const fieldsBatchWorker = (fields) => (_root, probes, _logger) => ({
    fields: Object.fromEntries(probes.map((p) => [p.entity, fields.map((f) => ({ ...f, kind: 'field' }))])),
});

/**
 * Returns a source string guaranteed to have enough budget for the rewrite cast.
 *
 * For TS files the cast `` `` as unknown as _qN `` must fit within the
 * template literal span (opening backtick → closing backtick). Budget =
 * query.length + 2 (the two backtick chars). Minimum cast =
 * "`` as unknown as _q0" = 22 chars, so we need query.length >= 20.
 *
 * For JS files the cast ` = (/**@type{_qN}*\/(0))` must fit within
 * `decl.name.end → decl.initializer.end`. We use SAFE_BUDGET=80 as before.
 */
function srcWithBudget(varName, query, awaited = false) {
    // TS budget: template span = query.length + 2 (backticks).
    // Cast "`` as unknown as _q0" = 22 chars → need query.length >= 20.
    const MinQueryLen = 22;
    const paddedQuery = query.length < MinQueryLen ? query + ' '.repeat(MinQueryLen - query.length) : query;
    return `const ${varName} = ${awaited ? 'await ' : ''}cds.ql\`${paddedQuery}\``;
}

/** A RunWorker stub that returns a fixed set of fields for any query. */
const fieldsWorker = (fields) => (_args, _logger) => ({
    completions: fields.map((f) => ({ ...f, kind: 'field' })),
});

/** A RunWorker stub that returns entities for FROM completions. */
const entitiesWorker = (entities) => (_args, _logger) => ({
    completions: entities.map((e) => ({ ...e, kind: 'entity' })),
});

/** A RunWorker stub that dispatches based on the query text argument. */
const dispatchWorker = (handler) => (args, _logger) => handler(args);

/** Parse source text into a TS source file. */
const parseTs = (src, fileName = 'test.ts') => TS.createSourceFile(fileName, src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);

/** Find the byte offset of the first occurrence of needle in src. */
function posOf(src, needle, occurrence = 0) {
    let idx = -1;
    for (let i = 0; i <= occurrence; i++) {
        idx = src.indexOf(needle, idx + 1);
        assert.ok(idx !== -1, `"${needle}" not found in source (occurrence ${i})`);
    }
    return idx;
}

/** Build a minimal QueryContext with a given source text and worker. */
function makeCtx(origText, worker = EMPTY_WORKER, projectRoot = '/proj', fileName = 'test.ts', batchWorker = undefined) {
    const origSf = parseTs(origText, fileName);
    // Hover now resolves the row type through the batch worker (same path as the
    // type rewriter). When no explicit batch worker is given, derive one from the
    // single-query `worker` stub so a `fieldsWorker([...])` transparently feeds both
    // paths: each probed entity gets the single worker's field completions.
    const derivedBatch = (root, probes, logger) => ({
        fields: Object.fromEntries(
            probes.map((p) => {
                const probeQuery = `SELECT  FROM ${p.entity} WHERE `;
                const r = worker([root, probeQuery, String(probeQuery.length), p.prefix], logger);
                return [p.entity, (r?.completions ?? []).filter((c) => c.kind === 'field')];
            }),
        ),
    });
    return {
        origText,
        origSf,
        projectRoot,
        logger: NO_LOGGER,
        runWorker: worker,
        runBatchWorker: batchWorker ?? derivedBatch,
    };
}

/** Call rewriteSnapshot with stub caches and worker. Returns rewritten string. */
function rewrite(src, batchWorker = EMPTY_BATCH_WORKER, fileName = 'test.ts') {
    const origSource = new Map();
    const cache = new Map();
    return rewriteSnapshot(fileName, src, TS, origSource, cache, EMPTY_WORKER, batchWorker, NO_LOGGER, '/proj', undefined);
}

// ---------------------------------------------------------------------------
// rewriteSnapshot — position contract
// ---------------------------------------------------------------------------

describe('rewriteSnapshot — position contract', () => {
    // ── length and newline preservation ────────────────────────────────────────
    //
    // The tsserver position contract only requires that byte offsets for positions
    // within the ORIGINAL content are the same in the rewritten snapshot.
    //
    // When the full type fits inline (budget ≥ cast length), the rewritten text
    // has the same length as the original — all positions are byte-identical.
    //
    // When the full type doesn't fit inline, a short alias is used in the
    // initializer and the full type is appended at the end of the file.
    // In that case the rewritten text is longer, but no bytes are inserted
    // within the original content — all lines 0..N are byte-identical.
    // ---------------------------------------------------------------------------

    it('rewrite appends a type alias and produces longer output', () => {
        // Always-alias: rewritten text is longer (tail alias appended)
        const src = srcWithBudget('r', 'SELECT id FROM Books', false);
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);
        assert.ok(rw.length > src.length, 'alias always appended → output is longer');
    });

    it('rewrite preserves the same number of newlines within the original content', () => {
        const src = ['// @cds-service Svc', srcWithBudget('r', 'SELECT id FROM Books', false)].join('\n');
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);
        // The original content section (before the appended tail) must have same newlines
        const origNewlines = (src.match(/\n/g) ?? []).length;
        const rwOrigSection = rw.slice(0, src.length);
        const rwNewlines = (rwOrigSection.match(/\n/g) ?? []).length;
        assert.equal(rwNewlines, origNewlines, 'no newlines added or removed within original content');
    });

    it('alias path: rewritten text is longer but original line count is preserved', () => {
        // Short query → budget too small for inline → alias path
        const src = '// @cds-service AdminService\nconst result = await cds.ql`SELECT ID, name FROM Books`\nconsole.log(result);';
        const worker = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.UUID' },
            { label: 'name', detail: 'cds.String' },
        ]);
        const rw = rewrite(src, worker);
        // Rewritten is longer (type alias appended)
        assert.ok(rw.length > src.length, 'alias path produces longer output');
        // But original lines 0..N are byte-identical → line 1 starts at same byte
        const origLine1Start = src.indexOf('\n') + 1;
        const rwLine1Start = rw.indexOf('\n') + 1;
        assert.equal(rwLine1Start, origLine1Start, 'original lines must start at same byte offsets');
    });

    it('multi-line template: rewritten snapshot has the same number of lines as the original', () => {
        // A multi-line cds.ql template literal spans several lines; the rewrite must
        // preserve every newline so VS Code line offsets stay correct.
        const src = [
            '// @cds-service AdminService',
            'const result = await cds.ql`',
            '        SELECT',
            '            ID, descr',
            '            title AS bookTitle',
            '            ,localized',
            '        FROM Books',
            '        WHERE ID = 42',
            '    `;',
        ].join('\n');
        const worker = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.UUID' },
            { label: 'descr', detail: 'cds.String' },
            { label: 'title', detail: 'cds.String' },
            { label: 'bookTitle', detail: 'cds.String' },
            { label: 'localized', detail: 'cds.Boolean' },
        ]);
        const rw = rewrite(src, worker);
        // The original content (before appended tail aliases) must have the same line count
        const origLines = src.split('\n').length;
        const rwOrigLines = rw.slice(0, src.length).split('\n').length;
        assert.equal(rwOrigLines, origLines, `original section must preserve line count (orig ${origLines}, got ${rwOrigLines})`);
    });

    it('multi-line template: line count is preserved and bytes after the span are unchanged', () => {
        const lines = ['// @cds-service AdminService', 'const result = await cds.ql`', '        SELECT ID, descr FROM Books', '    `;', 'console.log(result);'];
        const src = lines.join('\n');
        const worker = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.UUID' },
            { label: 'descr', detail: 'cds.String' },
        ]);
        const rw = rewrite(src, worker);

        // The rewritten snapshot is longer (alias appended), but the ORIGINAL content
        // section (first src.length bytes) must preserve the same line count.
        const origSection = rw.slice(0, src.length);
        assert.equal(origSection.split('\n').length, src.split('\n').length, 'line count must be preserved');

        // Bytes after decl.initializer.end are unchanged within the original content section.
        // The suffix 'console.log(result);' must appear verbatim at the same position.
        const suffixInOrig = src.lastIndexOf('console.log');
        assert.equal(rw.slice(suffixInOrig, src.length), src.slice(suffixInOrig), 'bytes after span must be unchanged');
    });

    it('preserves all bytes before the start of the declaration line', () => {
        // The rewrite starts at the beginning of the declaration's indentation
        // (position right after the last newline before `const`/`let`/`var`).
        // Any bytes on lines preceding the declaration are untouched.
        const before = 'import cds from "@sap/cds";\n';
        const src = before + 'const result = cds.ql`SELECT id FROM Books`';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);

        assert.equal(rw.slice(0, before.length), src.slice(0, before.length), 'bytes on lines before the declaration must be identical');
    });

    it('preserves all bytes after decl.initializer.end (within original content)', () => {
        // Suffix after the declaration must be unchanged in the original-content section
        const src = srcWithBudget('r', 'SELECT id FROM Books', false) + '; doSomething();';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);

        const sf = parseTs(src);
        const asns = collectCqlAssignments(TS, sf);
        const decl = asns[0].template.parent;
        const initEnd = decl.initializer.end;

        assert.equal(rw.slice(initEnd, src.length), src.slice(initEnd), 'bytes after decl.initializer.end must be identical within original content');
    });

    it('produces identity rewrite when worker returns no fields', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const rw = rewrite(src, EMPTY_BATCH_WORKER);
        assert.equal(rw, src, 'no fields → no rewrite → identical text');
    });

    it('produces identity rewrite when source has no cds.ql', () => {
        const src = 'const r = sql`SELECT id FROM books`';
        const rw = rewrite(src, EMPTY_BATCH_WORKER);
        assert.equal(rw, src);
    });

    // ── cast content ─────────────────────────────────────────────────────────

    it('ts file: rewritten template literal uses as-unknown-as cast syntax', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books');
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.ts');

        const sf = parseTs(src);
        const asns = collectCqlAssignments(TS, sf);
        const tpl = asns[0].template.template;

        // TS approach: template span replaced with `` `` as unknown as _qN ``
        assert.ok(rw.slice(tpl.pos, tpl.end).startsWith('`` as unknown as _q'), 'Expected backtick-cast as unknown as _qN, got: ' + JSON.stringify(rw.slice(tpl.pos, tpl.pos + 30)));
    });

    it('js file: rewritten initializer uses JSDoc @type cast syntax', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books');
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.js');

        const sf = parseTs(src);
        const asns = collectCqlAssignments(TS, sf);
        const decl = asns[0].template.parent;
        const nameEnd = decl.name.end;

        assert.ok(rw.slice(nameEnd).startsWith(' = (/**@type{'), `Expected JS JSDoc cast, got: ${JSON.stringify(rw.slice(nameEnd, nameEnd + 20))}`);
    });

    it('rewritten cast embeds the correct type for awaited query', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books', true);
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);
        // Type is always in the tail alias — check the tail, not the cast
        assert.ok(rw.includes('_q'), `expected alias reference in cast, got: ${rw}`);
        assert.ok(!rw.includes('Promise<'), `awaited should not have Promise< in tail alias, got: ${rw}`);
    });

    it('rewritten cast embeds Promise<...> for non-awaited query', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books', false);
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);
        assert.ok(rw.includes('Promise<'), `non-awaited should have Promise<, got: ${rw}`);
    });

    it('type reflects cdsTypeToTs mapping (UUID → string)', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books', false);
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);
        assert.ok(rw.includes('id:string'), `expected id:string in cast, got: ${rw}`);
    });

    it('type reflects multiple fields', () => {
        const src = srcWithBudget('r', 'SELECT id, title FROM Books', false);
        const worker = fieldsBatchWorker([
            { label: 'id', detail: 'cds.UUID' },
            { label: 'title', detail: 'cds.String' },
        ]);
        const rw = rewrite(src, worker);
        assert.ok(rw.includes('id:string'), 'expected id:string in cast');
        assert.ok(rw.includes('title:string'), 'expected title:string in cast');
    });

    // ── budget overflow ───────────────────────────────────────────────────────

    it('skips rewrite when even the alias cast does not fit in the budget', () => {
        // Extremely short source — budget smaller than the alias cast length (~26 chars)
        const src = 'const r=cds.ql`X`';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);
        // Budget is tiny (< alias cast length) → identity rewrite
        assert.equal(rw, src, 'budget too small → identity rewrite');
    });

    it('skips TS rewrite when alias cast does not fit budget (valid query, short template)', () => {
        // Template `SELECT id FROM B` = 16 chars → budget 18 < cast length 22 → skip
        const src = 'const r=cds.ql`SELECT id FROM B`';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.ts');
        assert.equal(rw, src, 'TS budget overflow → identity rewrite');
    });

    // ── multiple assignments ──────────────────────────────────────────────────

    it('array-destructured assignment is rewritten with the same array type', () => {
        const src = 'const [first] = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.ts');
        assert.ok(rw.includes('_q'), 'expected alias reference in rewritten source');
        assert.ok(rw.includes('{id:string}[]'), 'expected array row type (not element type)');
    });

    it('multi-element destructure is rewritten with the same array type', () => {
        const src = 'const [r1, r2] = await cds.ql`SELECT id FROM Books`;\nexport {};';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.ts');
        assert.ok(rw.includes('_q'), 'expected alias reference in rewritten source');
        assert.ok(rw.includes('{id:string}[]'), 'expected array row type');
    });

    it('rewrites multiple assignments, each gets its own alias', () => {
        const q1 = srcWithBudget('q1', 'SELECT id FROM Books', false);
        const q2 = srcWithBudget('q2', 'SELECT name FROM Authors', true);
        const src = [q1, q2].join('\n');
        const worker = fieldsBatchWorker([
            { label: 'id', detail: 'cds.UUID' },
            { label: 'name', detail: 'cds.String' },
        ]);
        const rw = rewrite(src, worker);
        // Two aliases appended
        const defs = rw.match(/type _q\d+=/g) ?? [];
        assert.equal(defs.length, 2, `expected 2 alias definitions, got: ${defs.join(', ')}`);
    });

    it('each assignment gets a unique alias name', () => {
        const src = ['const q1 = cds.ql`SELECT * FROM Books`;', 'const q2 = await cds.ql`SELECT * FROM Authors`;'].join('\n');
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);

        // Both assignments get aliased
        const aliasCount = (rw.match(/_q\d+/g) ?? []).length;
        assert.ok(aliasCount >= 2, `expected at least 2 alias references, got ${aliasCount} in:\n${rw}`);

        // Each alias definition must be unique
        const defs = rw.match(/type _q\d+=/g) ?? [];
        const uniqueDefs = new Set(defs);
        assert.equal(uniqueDefs.size, defs.length, `alias definitions must be unique: ${defs.join(', ')}`);
    });

    it('preserves bytes of all original lines when multiple assignments exist', () => {
        const src = ['const q1 = cds.ql`SELECT id FROM Books`;', 'const q2 = await cds.ql`SELECT name FROM Authors`;', 'export { q1, q2 };'].join('\n');
        const worker = fieldsBatchWorker([
            { label: 'id', detail: 'cds.UUID' },
            { label: 'name', detail: 'cds.String' },
        ]);
        const rw = rewrite(src, worker);
        // All original lines are preserved byte-for-byte except the initializer spans
        // (The 'export' line at the end must be unchanged)
        const lastOrigNewline = src.lastIndexOf('\n');
        const lastRwNewline = rw.indexOf('\n', lastOrigNewline); // may differ if alias appended
        // The 'export' line must appear unchanged in rw
        assert.ok(rw.includes('export { q1, q2 };'), 'export line must be unchanged in rewritten');
    });

    // ── multiple queries targeting different FROM clauses ─────────────────────

    it('multi-query: each query uses the fields of its own FROM entity', () => {
        // q1 queries Books, q2 queries Authors — batch worker dispatches on entity name
        const src = [srcWithBudget('q1', 'SELECT * FROM Books', false), srcWithBudget('q2', 'SELECT * FROM Authors', false)].join('\n');
        const worker = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    p.entity.includes('Books')
                        ? [
                              {
                                  label: 'title',
                                  detail: 'cds.String',
                                  kind: 'field',
                              },
                          ]
                        : [
                              {
                                  label: 'name',
                                  detail: 'cds.String',
                                  kind: 'field',
                              },
                          ],
                ]),
            ),
        });
        const rw = rewrite(src, worker);
        assert.ok(rw.includes('title:string'), `expected Books field 'title' in rewritten`);
        assert.ok(rw.includes('name:string'), `expected Authors field 'name' in rewritten`);
    });

    it('multi-query: alias names encode the declaration line number', () => {
        // Queries long enough so the template budget fits the cast (≥20 query chars needed).
        // Cast "`` as unknown as _q0" = 22 chars; template budget = query.length + 2.
        const manyFields = Array.from({ length: 5 }, (_, i) => ({
            label: `f${i}`,
            detail: 'cds.String',
        }));
        const src = [
            'const q1 = cds.ql`SELECT * FROM BookItems`;', // line 0, template=23 ≥ 22
            'const q2 = cds.ql`SELECT * FROM AuthorList`;', // line 1, template=23 ≥ 22
        ].join('\n');
        const worker = fieldsBatchWorker(manyFields);
        const rw = rewrite(src, worker);
        // Alias names must reflect line numbers (0 and 1)
        assert.ok(rw.includes('_q0'), `expected _q0 for line-0 declaration, got:\n${rw}`);
        assert.ok(rw.includes('_q1'), `expected _q1 for line-1 declaration, got:\n${rw}`);
    });

    it('multi-query: each query type is independent (Books type has no Authors fields)', () => {
        const src = [srcWithBudget('q1', 'SELECT * FROM Books', false), srcWithBudget('q2', 'SELECT * FROM Authors', false)].join('\n');
        const worker = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    p.entity.includes('Books')
                        ? [
                              {
                                  label: 'isbn',
                                  detail: 'cds.String',
                                  kind: 'field',
                              },
                          ]
                        : [
                              {
                                  label: 'awards',
                                  detail: 'cds.Integer',
                                  kind: 'field',
                              },
                          ],
                ]),
            ),
        });
        const rw = rewrite(src, worker);
        // isbn must appear in q1's cast but NOT in q2's cast
        assert.ok(rw.includes('isbn:string'), 'expected isbn from Books');
        assert.ok(rw.includes('awards:number'), 'expected awards from Authors');
        // Verify independence: the isbn cast appears before the awards cast
        assert.ok(rw.indexOf('isbn') < rw.indexOf('awards'), 'Books cast must precede Authors cast');
    });

    // ── caching ───────────────────────────────────────────────────────────────

    it('returns cached result for the same source text (worker not called twice)', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        let workerCallCount = 0;
        const countingWorker = (_root, probes, _logger) => {
            workerCallCount++;
            return {
                fields: Object.fromEntries(
                    probes.map((p) => [
                        p.entity,
                        [
                            {
                                label: 'id',
                                detail: 'cds.UUID',
                                kind: 'field',
                            },
                        ],
                    ]),
                ),
            };
        };
        const origSource = new Map();
        const cache = new Map();

        const rw1 = rewriteSnapshot('test.ts', src, TS, origSource, cache, EMPTY_WORKER, countingWorker, NO_LOGGER, '/proj', undefined);
        const callsAfterFirst = workerCallCount;
        const rw2 = rewriteSnapshot('test.ts', src, TS, origSource, cache, EMPTY_WORKER, countingWorker, NO_LOGGER, '/proj', undefined);

        assert.equal(rw1, rw2, 'cached result must be identical');
        assert.equal(workerCallCount, callsAfterFirst, 'worker must not be called on cache hit');
    });

    it('re-runs rewrite when source text changes', () => {
        const src1 = 'const r = cds.ql`SELECT id FROM Books`';
        const src2 = 'const r = cds.ql`SELECT title FROM Books`';
        const worker = fieldsBatchWorker([
            { label: 'id', detail: 'cds.UUID' },
            { label: 'title', detail: 'cds.String' },
        ]);
        const origSource = new Map();
        const cache = new Map();

        const rw1 = rewriteSnapshot('test.ts', src1, TS, origSource, cache, EMPTY_WORKER, worker, NO_LOGGER, '/proj', undefined);
        const rw2 = rewriteSnapshot('test.ts', src2, TS, origSource, cache, EMPTY_WORKER, worker, NO_LOGGER, '/proj', undefined);

        // Different sources produce different rewrites
        assert.notEqual(rw1, rw2, 'different source texts must produce different rewrites');
        // Template span is replaced with as-unknown-as cast
        assert.ok(rw1.includes('as unknown as'), 'rw1 must contain the cast');
        assert.ok(rw2.includes('as unknown as'), 'rw2 must contain the cast');
    });

    it('partial rewrite is not cached: retries when worker later returns fields', () => {
        // First call: worker returns fields for q1 but not q2 (model not loaded yet)
        // Second call: worker returns fields for both
        // Expected: second call produces full rewrite (q2 must not be stuck as unrewritten)
        const src = ['const q1 = cds.ql`SELECT id FROM Books                    `;', 'const q2 = cds.ql`SELECT name FROM Authors                `;'].join('\n');

        let callCount = 0;
        const partialThenFullWorker = (_root, probes, _logger) => {
            callCount++;
            const fields = {};
            for (const { entity } of probes) {
                // First two batch calls (first rewriteSnapshot): only Books resolves
                // Calls 3+ (second rewriteSnapshot): both resolve
                if (entity.includes('Books'))
                    fields[entity] = [
                        {
                            label: 'id',
                            detail: 'cds.UUID',
                            kind: 'field',
                        },
                    ];
                else if (callCount > 2)
                    fields[entity] = [
                        {
                            label: 'name',
                            detail: 'cds.String',
                            kind: 'field',
                        },
                    ];
                else fields[entity] = [];
            }
            return { fields };
        };

        const origSource = new Map();
        const cache = new Map();

        const rw1 = rewriteSnapshot('test.ts', src, TS, origSource, cache, EMPTY_WORKER, partialThenFullWorker, NO_LOGGER, '/proj', undefined);
        // q1 rewritten, q2 not (worker miss → not cached)
        assert.ok(rw1.includes('_q0'), 'first pass: q1 must be rewritten');
        assert.ok(!rw1.includes('_q1'), 'first pass: q2 must not be rewritten yet');

        const rw2 = rewriteSnapshot('test.ts', src, TS, origSource, cache, EMPTY_WORKER, partialThenFullWorker, NO_LOGGER, '/proj', undefined);
        // Second call must retry (was not cached) and now resolve q2 too
        assert.ok(rw2.includes('_q0'), 'second pass: q1 still rewritten');
        assert.ok(rw2.includes('_q1'), 'second pass: q2 must now be rewritten');
    });
});

// ---------------------------------------------------------------------------
// rewriteSnapshot — position identity (the core tsserver contract)
// ---------------------------------------------------------------------------

describe('rewriteSnapshot — position identity for template-internal positions', () => {
    /**
     * This test suite verifies the central invariant:
     *
     * rewriteSnapshot replaces `template.template.pos → template.template.end`
     * (just the template literal span) with a same-length string and optionally
     * appends type alias declarations after the end of the original file content.
     *
     * Key invariant: every line L that exists in the original file starts at the
     * same byte offset in the rewritten snapshot. In particular, any cursor
     * position (line L, char C) for L within the original content maps to the
     * same byte offset in both orig and rewritten — which is exactly what
     * tsserver uses when converting VS Code's line:character cursor.
     *
     * Bytes appended at the end of the file don't affect any original-line
     * offsets, so the position contract is preserved even for the alias path.
     */

    it('findCdsQueryTemplate finds template at SELECT offset (regardless of rewrite path)', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const selectPos = posOf(src, 'SELECT');
        // findCdsQueryTemplate uses origSf — the offset must work against original
        const origSf = parseTs(src);
        const template = findCdsQueryTemplate(TS, origSf, selectPos);
        assert.ok(template, `findCdsQueryTemplate should find template at offset ${selectPos}`);
    });

    it('findCdsQueryTemplate works at every position inside the template', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const origSf = parseTs(src);
        const asns = collectCqlAssignments(TS, origSf);
        const tpl = asns[0].template;
        const backtickPos = tpl.template.pos; // position of opening `
        const templateEnd = tpl.template.end; // position after closing `

        // Every position from backtick+1 to templateEnd-1 must find the template
        for (let pos = backtickPos + 1; pos < templateEnd; pos++) {
            const found = findCdsQueryTemplate(TS, origSf, pos);
            assert.ok(found, `findCdsQueryTemplate should find template at offset ${pos}`);
        }
    });

    it('offsetInTemplate returns 0 at the first character of the template text', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const origSf = parseTs(src);
        const asns = collectCqlAssignments(TS, origSf);
        const tpl = asns[0].template;

        // First character of template content is at pos+1 (skip backtick)
        const firstPos = tpl.template.pos + 1;
        const off = offsetInTemplate(TS, tpl, firstPos);
        assert.equal(off, 0, 'offset at first char of template content should be 0');
    });

    it('offsetInTemplate for FROM position returns correct query offset', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const origSf = parseTs(src);
        const asns = collectCqlAssignments(TS, origSf);
        const tpl = asns[0].template;

        const fromPosInSrc = posOf(src, 'FROM');
        const fromPosInQuery = posOf(query, 'FROM');

        const off = offsetInTemplate(TS, tpl, fromPosInSrc);
        assert.equal(off, fromPosInQuery, 'offsetInTemplate must match position within query string');
    });

    it('offsetInTemplate works for WHERE position', () => {
        const query = 'SELECT id FROM Books WHERE id > 1';
        const src = `const r = cds.ql\`${query}\``;
        const origSf = parseTs(src);
        const asns = collectCqlAssignments(TS, origSf);
        const tpl = asns[0].template;

        const wherePosInSrc = posOf(src, 'WHERE');
        const wherePosInQuery = posOf(query, 'WHERE');

        const off = offsetInTemplate(TS, tpl, wherePosInSrc);
        assert.equal(off, wherePosInQuery);
    });

    it('offsetInTemplate after rewrite is identical to before rewrite for same position', () => {
        // The critical invariant: positions inside the template are the same byte offsets
        // in both original and rewritten snapshot.
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);

        // Parse original to get the template positions
        const origSf = parseTs(src);
        const asns = collectCqlAssignments(TS, origSf);
        const tpl = asns[0].template;

        const fromPosInSrc = posOf(src, 'FROM');

        // In rewritten snapshot, byte fromPosInSrc is still within the replaced span,
        // but the OFFSET is the same. findCdsQueryTemplate on origSf at this offset works.
        const templateInOrig = findCdsQueryTemplate(TS, origSf, fromPosInSrc);
        assert.ok(templateInOrig, 'must find template in origSf at FROM position');

        const off = offsetInTemplate(TS, templateInOrig, fromPosInSrc);
        assert.equal(off, posOf(query, 'FROM'), 'query offset must match regardless of rewrite');
    });

    it('bytes outside the initializer span (before and after) are preserved', () => {
        const before = 'import cds from "@sap/cds";\n';
        const declSrc = srcWithBudget('r', 'SELECT id FROM Books', false);
        const after = ';\nconsole.log(r);';
        const src = before + declSrc + after;
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker);

        // 'before' is before the declaration — must be identical
        assert.equal(rw.slice(0, before.length), src.slice(0, before.length), 'bytes before declaration unchanged');

        // Bytes between initEnd and end of original content are unchanged
        const sf = parseTs(src);
        const asns = collectCqlAssignments(TS, sf);
        const decl2 = asns[0].template.parent;
        const initEnd = decl2.initializer.end;
        assert.equal(rw.slice(initEnd, src.length), src.slice(initEnd), 'bytes after initializer (within original content) unchanged');
    });

    it('original lines start at same byte offsets regardless of how many fields are selected', () => {
        const srcShort = ['// @cds-service AdminService', 'const r = await cds.ql`SELECT ID FROM Books`', 'doSomething(r);'].join('\n');
        const worker = fieldsBatchWorker([{ label: 'ID', detail: 'cds.UUID' }]);
        const rw = rewrite(srcShort, worker);

        // Line 0 starts at byte 0 in both
        const line0Len = srcShort.indexOf('\n');
        assert.equal(rw.indexOf('\n'), line0Len, 'line 0 length preserved');
        // Line 1 ends at the same byte
        const line1Start = line0Len + 1;
        const line1End = srcShort.indexOf('\n', line1Start);
        const rwLine1End = rw.indexOf('\n', line1Start);
        assert.equal(rwLine1End, line1End, 'line 1 length preserved');
        // Code after declaration is at same byte position
        assert.equal(rw.indexOf('doSomething'), srcShort.indexOf('doSomething'), 'code after declaration must start at same byte offset');
    });
});

// ---------------------------------------------------------------------------
// TypeScript type inference from rewritten snapshot
// ---------------------------------------------------------------------------

describe('rewriteSnapshot — TypeScript type inference', () => {
    /**
     * The rewritten TS variable gets a type annotation (`:_qN =`) right after the name.
     * For JS the rewritten initializer is a JSDoc cast `(\/**@type{_qN}*\/(0))`.
     * The full type lives in the appended tail alias `type _qN=...` / `@typedef`.
     * These helpers extract the alias name from the cast, then look up its definition.
     */

    function getAliasName(rewrittenSrc, varName, fileName = 'test.ts') {
        const sf = TS.createSourceFile(fileName, rewrittenSrc, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        let alias = '';
        function visit(node) {
            if (TS.isVariableDeclaration(node) && TS.isIdentifier(node.name) && node.name.text === varName) {
                const span = rewrittenSrc.slice(node.name.end, node.initializer?.end ?? node.end);
                // TS new strategy: `` `` as unknown as _qN `` inside the template span
                const mTsCast = span.match(/`` as unknown as (_q\d+)/);
                if (mTsCast) {
                    alias = mTsCast[1];
                    return;
                }
                // TS annotation (legacy): `:_qN =`
                const mAnnot = span.match(/:(_q\d+)/);
                if (mAnnot) {
                    alias = mAnnot[1];
                    return;
                }
                // TS cast (legacy fallback): `(0 as unknown as _qN)`
                const mTs = span.match(/0 as unknown as (_q\d+)/);
                if (mTs) {
                    alias = mTs[1];
                    return;
                }
                // JS: `(/**@type{_qN}*/(0))`
                const mJs = span.match(/@type\{(_q\d+)\}/);
                if (mJs) {
                    alias = mJs[1];
                    return;
                }
            }
            TS.forEachChild(node, visit);
        }
        visit(sf);
        return alias;
    }

    function getAliasType(rewrittenSrc, aliasName, fileName = 'test.ts') {
        // TS tail: `type _qN=...;`  (type body may contain `;` inside `{...}`)
        const mTs = rewrittenSrc.match(new RegExp(`type ${aliasName}=(.+);`));
        if (mTs) return mTs[1];
        // JS tail: `/**@typedef {T} _qN*/`
        const mJs = rewrittenSrc.match(new RegExp(`@typedef \\{(.+?)\\} ${aliasName}`));
        if (mJs) return mJs[1];
        return '';
    }

    function getInferredType(src, varName, worker, fileName = 'test.ts') {
        const rw = rewrite(src, worker, fileName);
        const alias = getAliasName(rw, varName, fileName);
        return alias ? getAliasType(rw, alias, fileName) : '';
    }

    it('ts: type annotation on variable uses alias identifier, not inline type', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books', false);
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.ts');
        const alias = getAliasName(rw, 'r', 'test.ts');
        assert.ok(alias.startsWith('_q'), `expected _q alias in annotation, got alias: ${alias}`);
    });

    it('js: cast in source uses alias identifier, not inline type', () => {
        const src = srcWithBudget('r', 'SELECT id FROM Books', false);
        const worker = fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, worker, 'test.js');
        const alias = getAliasName(rw, 'r', 'test.js');
        assert.ok(alias.startsWith('_q'), `expected _q alias in js cast, got alias: ${alias}`);
    });

    it('ts: non-awaited query alias expands to Promise<{...}[]>', () => {
        const typeStr = getInferredType(srcWithBudget('r', 'SELECT id FROM Books', false), 'r', fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]), 'test.ts');
        assert.ok(typeStr.startsWith('Promise<'), `expected Promise<, got: ${typeStr}`);
        assert.ok(typeStr.includes('id:string'), `expected id:string, got: ${typeStr}`);
    });

    it('ts: awaited query alias expands to {field:type}[]', () => {
        const typeStr = getInferredType(srcWithBudget('r', 'SELECT id FROM Books', true), 'r', fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]), 'test.ts');
        assert.ok(!typeStr.startsWith('Promise<'), `awaited must not have Promise<, got: ${typeStr}`);
        assert.ok(typeStr.includes('id:string'), `expected id:string, got: ${typeStr}`);
    });

    it('js: non-awaited query alias expands to Promise<{...}[]>', () => {
        const typeStr = getInferredType(srcWithBudget('r', 'SELECT id FROM Books', false), 'r', fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]), 'test.js');
        assert.ok(typeStr.startsWith('Promise<'), `expected Promise<, got: ${typeStr}`);
    });

    it('js: awaited query alias expands to {field:type}[]', () => {
        const typeStr = getInferredType(srcWithBudget('r', 'SELECT id FROM Books', true), 'r', fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]), 'test.js');
        assert.ok(!typeStr.startsWith('Promise<'), `awaited must not have Promise<, got: ${typeStr}`);
    });

    it('type respects SELECT columns (only listed columns appear, using aliases)', () => {
        const typeStr = getInferredType(
            srcWithBudget('r', 'SELECT id AS pk FROM Books', true),
            'r',
            fieldsBatchWorker([
                { label: 'id', detail: 'cds.UUID' },
                { label: 'title', detail: 'cds.String' },
            ]),
            'test.ts',
        );
        assert.ok(typeStr.includes('pk:string'), `expected pk:string (alias), got: ${typeStr}`);
        assert.ok(!typeStr.includes('title:string'), `title must not appear (not SELECTed), got: ${typeStr}`);
    });

    it('multi-line query: AS alias used as property name, raw field name excluded', () => {
        const src = [
            '// @cds-service AdminService',
            'const result = await cds.ql`',
            '    SELECT',
            '      ID, descr',
            '      title AS bookTitle',
            '      ,localized',
            '    FROM Books',
            '    WHERE ID = 42',
            '`;',
        ].join('\n');
        const worker = fieldsBatchWorker([
            { label: 'ID', detail: 'cds.UUID' },
            { label: 'descr', detail: 'cds.String' },
            { label: 'title', detail: 'cds.String' },
            { label: 'localized', detail: 'cds.Boolean' },
        ]);
        const typeStr = getInferredType(src, 'result', worker, 'test.ts');
        assert.ok(typeStr.includes('bookTitle:string'), `alias bookTitle must appear in type, got: ${typeStr}`);
        assert.ok(!typeStr.includes('title:string'), `raw field title must not appear (aliased), got: ${typeStr}`);
        assert.ok(typeStr.includes('descr:string'), `descr must appear in type, got: ${typeStr}`);
        assert.ok(typeStr.includes('localized:boolean'), `localized must appear in type, got: ${typeStr}`);
    });

    it('type for SELECT * includes all scalar fields', () => {
        const typeStr = getInferredType(
            srcWithBudget('r', 'SELECT * FROM Books', true),
            'r',
            fieldsBatchWorker([
                { label: 'id', detail: 'cds.UUID' },
                { label: 'title', detail: 'cds.String' },
            ]),
            'test.ts',
        );
        assert.ok(typeStr.includes('id:string'), `expected id:string, got: ${typeStr}`);
        assert.ok(typeStr.includes('title:string'), `expected title:string, got: ${typeStr}`);
    });

    it('associations are excluded from SELECT * type', () => {
        const typeStr = getInferredType(
            srcWithBudget('r', 'SELECT * FROM Books', true),
            'r',
            fieldsBatchWorker([
                { label: 'id', detail: 'cds.UUID' },
                { label: 'author', detail: 'cds.Association' },
            ]),
            'test.ts',
        );
        assert.ok(typeStr.includes('id:string'), 'expected id:string');
        assert.ok(!typeStr.includes('author'), 'association must be excluded from SELECT *');
    });

    it('compositions are excluded from SELECT * type', () => {
        const typeStr = getInferredType(
            srcWithBudget('r', 'SELECT * FROM Books', true),
            'r',
            fieldsBatchWorker([
                { label: 'id', detail: 'cds.UUID' },
                { label: 'items', detail: 'cds.Composition' },
            ]),
            'test.ts',
        );
        assert.ok(!typeStr.includes('items'), 'composition must be excluded from SELECT *');
    });

    it('expand block: association field produces nested type', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { ID, author { name } }                       `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'ID',
                                    detail: 'cds.Integer',
                                    kind: 'field',
                                },
                                {
                                    label: 'author',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Svc.Authors',
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Authors')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'name',
                                    detail: 'cds.String',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        assert.ok(typeStr.includes('author'), `expected author in type, got: ${typeStr}`);
        assert.ok(typeStr.includes('name'), `expected name in type, got: ${typeStr}`);
    });

    it('expand block: FQN target entity (contains dot) uses empty prefix in BFS probe', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { author { age } }                          `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'author',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Lib.Authors',
                                },
                            ],
                        ];
                    if (p.entity === 'Lib.Authors')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'age',
                                    detail: 'cds.Integer',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        assert.ok(typeStr.includes('author'), `expected author in type, got: ${typeStr}`);
        assert.ok(typeStr.includes('age'), `expected age in type, got: ${typeStr}`);
    });

    it('expand block with empty expand array produces {}[] for association without fields', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { ID, author { } }                          `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => [
                    p.entity,
                    [
                        {
                            label: 'ID',
                            detail: 'cds.Integer',
                            kind: 'field',
                        },
                        {
                            label: 'author',
                            detail: 'cds.Association',
                            kind: 'field',
                            target: 'Svc.Authors',
                        },
                    ],
                ]),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        // author {} → expand with no columns → buildTypeBody(null for empty) → all fields of Authors
        assert.ok(typeStr.includes('author'), `expected author in type, got: ${typeStr}`);
    });

    it('flat association column (no expand braces) produces implicit SELECT * expand type', () => {
        // genre selected flat without expand braces — has a target → treated as implicit expand
        const src = 'const r = await cds.ql`SELECT FROM Books { genre, ID }                               `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'genre',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Svc.Genres',
                                },
                                {
                                    label: 'ID',
                                    detail: 'cds.Integer',
                                    kind: 'field',
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Genres')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'name',
                                    detail: 'cds.String',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        assert.ok(typeStr.includes('genre'), `expected genre in type, got: ${typeStr}`);
        assert.ok(typeStr.includes('name'), `expected genre.name in type, got: ${typeStr}`);
        assert.ok(typeStr.includes('ID'), `expected ID in type, got: ${typeStr}`);
    });

    it('expand block: to-one association renders as a scalar object (no [])', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { author { age } }                          `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                // to-one: no toMany flag → scalar object
                                {
                                    label: 'author',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Svc.Authors',
                                    toMany: false,
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Authors')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'age',
                                    detail: 'cds.Integer',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        assert.ok(/author:\{age:number\}[^[]/.test(typeStr) || typeStr.includes('author:{age:number}}'), `to-one expand must be a scalar object, got: ${typeStr}`);
        assert.ok(!/author:\{age:number\}\[\]/.test(typeStr), `to-one expand must NOT be an array, got: ${typeStr}`);
    });

    it('expand block: to-many association renders as an array ([])', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { chapters { title } }                      `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'chapters',
                                    detail: 'cds.Composition',
                                    kind: 'field',
                                    target: 'Svc.Chapters',
                                    toMany: true,
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Chapters')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'title',
                                    detail: 'cds.String',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        assert.ok(/chapters:\{title:string\}\[\]/.test(typeStr), `to-many expand must be an array, got: ${typeStr}`);
    });

    it('expand block: to-one containing a to-many nests cardinality correctly', () => {
        // author (to-one) { books (to-many) { title } } → author:{books:{title:string}[]}
        const src = 'const r = await cds.ql`SELECT FROM Books { author { books { title } } }               `;\nexport {};';
        const batch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'author',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Svc.Authors',
                                    toMany: false,
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Authors')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'books',
                                    detail: 'cds.Composition',
                                    kind: 'field',
                                    target: 'Svc.Books2',
                                    toMany: true,
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Books2')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'title',
                                    detail: 'cds.String',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const typeStr = getInferredType(src, 'r', batch, 'test.ts');
        assert.ok(typeStr.includes('author:{books:{title:string}[]}'), `mixed cardinality must nest to-many inside to-one, got: ${typeStr}`);
        assert.ok(!/author:\{books:\{title:string\}\[\]\}\[\]/.test(typeStr), `outer to-one author must not become an array, got: ${typeStr}`);
    });
});

// ---------------------------------------------------------------------------
// getCqlCompletions — proxy simulation
// ---------------------------------------------------------------------------

describe('getCqlCompletions — proxy simulation', () => {
    it('returns null when cursor is not inside a cds.ql template', () => {
        const src = 'console.log("hello");';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'hello');
        const result = getCqlCompletions('test.ts', pos, ctx, TS);
        assert.equal(result, null);
    });

    it('returns null when worker returns no completions', () => {
        const src = 'const r = cds.ql`SELECT | FROM Books`'.replace(/\|/g, '');
        const pos = posOf(src, 'SELECT') + 7; // inside SELECT clause
        const ctx = makeCtx(src, EMPTY_WORKER);
        const result = getCqlCompletions('test.ts', pos, ctx, TS);
        assert.equal(result, null);
    });

    it('returns CompletionInfo when cursor is inside template and worker has fields', () => {
        const query = 'SELECT  FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        // Position right after "SELECT " inside the template
        const posInSrc = posOf(src, 'SELECT') + 7;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID', entity: 'Svc.Books' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected CompletionInfo');
        const names = result.entries.map((e) => e.name);
        assert.ok(names.includes('id'), `expected 'id' in completions, got: ${JSON.stringify(names)}`);
    });

    it('completion entries have correct kind for fields', () => {
        const query = 'SELECT  FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'SELECT') + 7;
        const worker = fieldsWorker([{ label: 'title', detail: 'cds.String' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result);
        const entry = result.entries[0];
        assert.equal(entry.kind, TS.ScriptElementKind.memberVariableElement);
    });

    it('completion entries include labelDetails for field type', () => {
        const query = 'SELECT  FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'SELECT') + 7;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result);
        assert.equal(result.entries[0].labelDetails?.detail, ': cds.UUID');
    });

    it('completions at WHERE position work correctly', () => {
        const query = 'SELECT id FROM Books WHERE ';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'WHERE') + 6; // after 'WHERE '
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected completions at WHERE position');
        assert.ok(result.entries.map((e) => e.name).includes('id'));
    });

    it('completions at FROM position return entity entries', () => {
        const query = 'SELECT id FROM ';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'FROM') + 5; // after 'FROM '
        const worker = entitiesWorker([{ label: 'Books', detail: 'Svc' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected completions at FROM position');
        assert.ok(result.entries.map((e) => e.name).includes('Books'));
    });

    it('isGlobalCompletion and isMemberCompletion are false', () => {
        const query = 'SELECT  FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'SELECT') + 7;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result);
        assert.equal(result.isGlobalCompletion, false);
        assert.equal(result.isMemberCompletion, false);
    });

    it('works correctly at position that comes from rewritten snapshot (byte identity)', () => {
        const query = 'SELECT  FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const rw = rewrite(src, fieldsBatchWorker([{ label: 'id', detail: 'cds.UUID' }]));

        const posInSrc = posOf(src, 'SELECT') + 7;

        assert.ok(posInSrc < rw.length, 'position must be valid in rewritten snapshot');

        const ctx = makeCtx(src, worker); // ctx uses original source text
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'completions must work with position from rewritten snapshot');
        assert.ok(result.entries.map((e) => e.name).includes('id'));
    });
});

// ---------------------------------------------------------------------------
// Model-unavailable error surfacing
// ---------------------------------------------------------------------------

describe('CQL error surfacing — model unavailable', () => {
    /** A RunWorker stub that always fails to load the model. */
    const errorWorker = (_args, _logger) => ({
        error: "cds.load failed: Can't find package module '@capire/xflights-data'",
    });

    it('getCqlCompletions returns null (no partial completions) when the worker reports an error', () => {
        const query = 'SELECT  FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'SELECT') + 7;
        const ctx = makeCtx(src, errorWorker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.equal(result, null);
    });

    it('getCqlDiagnostics emits a warning carrying the compile error instead of failing silently', () => {
        const query = 'SELECT * FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const ctx = makeCtx(src, errorWorker);
        const diags = getCqlDiagnostics(ctx, TS);
        assert.equal(diags.length, 1, 'expected exactly one diagnostic for the query');
        const d = diags[0];
        assert.equal(d.category, TS.DiagnosticCategory.Warning);
        assert.equal(d.source, 'cds');
        assert.match(String(d.messageText), /CQL features unavailable/);
        assert.match(String(d.messageText), /@capire\/xflights-data/);
        // Anchored inside the template (after the opening backtick), non-zero span.
        assert.ok(typeof d.start === 'number' && d.start > 0);
        assert.ok(typeof d.length === 'number' && d.length >= 1);
    });

    it('getCqlDiagnostics returns nothing when there is no cds.ql assignment (error path not reached)', () => {
        const src = 'const x = 1;';
        const ctx = makeCtx(src, errorWorker);
        assert.deepEqual(getCqlDiagnostics(ctx, TS), []);
    });
});

// ---------------------------------------------------------------------------
// getCqlHover — proxy simulation
// ---------------------------------------------------------------------------

describe('getCqlHover — proxy simulation', () => {
    it('returns null when cursor is not in a template or on a query variable', () => {
        const src = 'console.log("hello");';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const result = getCqlHover('test.ts', posOf(src, 'hello'), ctx, TS);
        assert.equal(result, null);
    });

    it('returns QuickInfo for cursor on a field name inside template', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'id'); // cursor on 'id' inside template

        const worker = dispatchWorker((args) => ({
            completions: [
                {
                    label: 'id',
                    detail: 'cds.UUID',
                    kind: 'field',
                    entity: 'Svc.Books',
                },
            ],
        }));
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected QuickInfo for field hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('cds field'), `expected "cds field" in display, got: ${text}`);
        assert.ok(text.includes('id'), `expected field name in display, got: ${text}`);
    });

    it('returns QuickInfo for cursor on entity name in FROM clause', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'Books');

        const worker = dispatchWorker((args) => ({
            completions: [
                {
                    label: 'id',
                    detail: 'cds.UUID',
                    kind: 'field',
                    entity: 'Svc.Books',
                },
            ],
        }));
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected QuickInfo for entity hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('cds entity'), `expected "cds entity" in display, got: ${text}`);
    });

    it('returns QuickInfo for cursor on result variable (Case 2)', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        // Position on 'r' in console.log(r)
        const posInSrc = src.lastIndexOf('r');

        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected QuickInfo for result variable hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        // awaited → Array<{...}>
        assert.ok(text.includes('id: string') || text.includes('id:string'), `expected id:string in type display, got: ${text}`);
    });

    it('non-awaited result variable hover shows Promise<...>', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\`;\nconsole.log(r);`;
        const posInSrc = src.lastIndexOf('r');

        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', posInSrc, ctx, TS);
        assert.ok(result);
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('Promise<'), `expected Promise< for non-awaited, got: ${text}`);
    });

    it('textSpan for field token points to correct offset in original source', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        // Compute offset of 'id' inside the template literal in the full source
        const backtickPos = posOf(src, '`');
        const idInQuery = posOf(query, 'id');
        const idInSrc = backtickPos + 1 + idInQuery;

        const worker = dispatchWorker((_args) => ({
            completions: [{ label: 'id', detail: 'cds.UUID', kind: 'field' }],
        }));
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', idInSrc, ctx, TS);
        assert.ok(result, 'expected hover result');
        // textSpan.start must point to 'id' in the original source
        assert.equal(src.slice(result.textSpan.start, result.textSpan.start + 2), 'id', `textSpan should point to 'id' in original source`);
    });

    it('entity hover with empty worker uses entity name as fqn fallback', () => {
        // Worker returns no completions — fqn falls back to tokenCtx.token.value
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Books');
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected hover result');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('Books'), 'fqn must fall back to entity token value');
    });

    it('entity hover with FQN entity name uses empty prefix for probe', () => {
        // Svc.Books includes a dot — probe prefix must be '' (not the service prefix)
        const src = 'const r = cds.ql`SELECT id FROM Svc.Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Svc.Books');
        const result = getCqlHover('test.ts', pos, ctx, TS);
        // Even with empty worker, result must show entity kind (entity token path)
        assert.ok(result, 'expected hover result for FQN entity');
    });

    it('field hover with non-SELECT template text uses fallback probeQuery', () => {
        // Query text inside template does not start with SELECT — triggers the fallback
        // probeQuery = `SELECT  FROM ${entity} WHERE `
        const src = 'const r = cds.ql`WHERE id = 1 FROM Books`';
        const worker = dispatchWorker((_args) => ({
            completions: [
                {
                    label: 'id',
                    detail: 'cds.UUID',
                    kind: 'field',
                    entity: 'Books',
                },
            ],
        }));
        const ctx = makeCtx(src, worker);
        const pos = posOf(src, 'id');
        // Just verify it doesn't throw and returns something (or null)
        assert.doesNotThrow(() => getCqlHover('test.ts', pos, ctx, TS));
    });

    // ── Case 3: binding element destructured from cds.ql result ──────────────

    it('hovering over binding element in const [{ID}] = await cds.ql`…` returns field type', () => {
        const src = 'const [{ID}] = await cds.ql`SELECT ID FROM Books`;\nexport {};';
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.Integer' }]);
        const ctx = makeCtx(src, worker);
        const pos = src.lastIndexOf('{ID}') + 1; // position of 'I' in {ID}
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected QuickInfo for destructured binding element');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('ID'), `hover must mention the field name 'ID', got: ${text}`);
        assert.ok(text.includes('number'), `hover must show field type 'number' (cds.Integer → number), got: ${text}`);
    });

    it('hovering over binding element in non-awaited const [{ID}] = cds.ql`…` returns field type', () => {
        const src = 'const [{ID}] = cds.ql`SELECT ID FROM Books`;\nexport {};';
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const pos = src.lastIndexOf('{ID}') + 1;
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected QuickInfo for non-awaited destructured binding element');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('ID'), `hover must mention 'ID', got: ${text}`);
        assert.ok(text.includes('string'), `hover must show string for cds.UUID, got: ${text}`);
    });

    it('hovering over binding element not from cds.ql returns null', () => {
        const src = 'const [{ID}] = someArray;\nexport {};';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = src.lastIndexOf('{ID}') + 1;
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.equal(result, null, 'must return null when array is not from cds.ql');
    });

    it('hovering over direct array binding const [fst] = await cds.ql`…` returns row type', () => {
        const src = 'const [fst] = await cds.ql`SELECT ID FROM Books                        `;\nexport {};';
        const worker = fieldsWorker([
            { label: 'ID', detail: 'cds.Integer' },
            { label: 'title', detail: 'cds.String' },
        ]);
        const ctx = makeCtx(src, worker);
        const pos = src.indexOf('[fst]') + 1;
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected QuickInfo for direct array binding element');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('fst'), `hover must show variable name 'fst', got: ${text}`);
        assert.ok(text.includes('ID') && text.includes('number'), `hover must show row type with ID:number, got: ${text}`);
    });

    it('hovering over array binding from cds.ql variable const [r1] = result returns row type', () => {
        const src = ['const result = await cds.ql`SELECT ID FROM Books                        `;', 'const [r1] = result;'].join('\n');
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.Integer' }]);
        const ctx = makeCtx(src, worker);
        const pos = src.indexOf('[r1]') + 1;
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected QuickInfo for array binding from cds.ql variable');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('r1'), `hover must show variable name 'r1', got: ${text}`);
        assert.ok(text.includes('ID') && text.includes('number'), `hover must show row type, got: ${text}`);
    });

    it('hovering over direct array binding nests expand columns (single-row type)', () => {
        const src = 'const [row] = await cds.ql`SELECT FROM Books { author { age } }`;\nexport {};';
        const expandBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'author',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Svc.Authors',
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Authors')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'age',
                                    detail: 'cds.Integer',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const ctx = makeCtx(src, EMPTY_WORKER, '/proj', 'test.ts', expandBatch);
        const pos = src.indexOf('[row]') + 1;
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected QuickInfo for array binding element');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('author') && text.includes('age'), `single-row hover must nest expand, got: ${text}`);
        assert.ok(!/author:\s*unknown/.test(text), `expand must not collapse to unknown, got: ${text}`);
    });

    it('hovering over property access result.at(0)?.field returns field type', () => {
        // Use non-optional property access to avoid QuestionDotToken ambiguity in position
        const src = 'const result = await cds.ql`SELECT ID FROM Books                        `;\nresult[0].ID;\nexport {};';
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.Integer' }]);
        const ctx = makeCtx(src, worker);
        // Position on 'ID' in result[0].ID
        const pos = src.lastIndexOf('.ID') + 1;
        const result2 = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result2, 'expected QuickInfo for property access on cds.ql result');
        const text = (result2.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('ID'), `hover must show 'ID', got: ${text}`);
        assert.ok(text.includes('number'), `hover must show number type for cds.Integer, got: ${text}`);
    });

    it('hovering over optional chain result.at(0)?.field returns field type', () => {
        const src = 'const result = await cds.ql`SELECT ID FROM Books                        `;\nresult.at(0)?.ID;\nexport {};';
        const worker = fieldsWorker([{ label: 'ID', detail: 'cds.Integer' }]);
        const ctx = makeCtx(src, worker);
        // Find the PropertyAccessExpression.name 'ID' start position in the property access
        const origSf = TS.createSourceFile('test.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        let idNamePos = -1;
        const findPae = (n) => {
            if (TS.isPropertyAccessExpression(n) && n.name.text === 'ID' && n.questionDotToken) {
                idNamePos = n.name.getStart(origSf);
            }
            TS.forEachChild(n, findPae);
        };
        findPae(origSf);
        assert.ok(idNamePos >= 0, 'should find ?. property access for ID');
        const result2 = getCqlHover('test.ts', idNamePos, ctx, TS);
        assert.ok(result2, 'expected QuickInfo for optional chain property access');
        const text = (result2.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('ID'), `hover must show 'ID', got: ${text}`);
        assert.ok(text.includes('number'), `hover must show number type, got: ${text}`);
    });
});

// ---------------------------------------------------------------------------
// getCqlDiagnostics — proxy simulation
// ---------------------------------------------------------------------------

describe('getCqlDiagnostics — proxy simulation', () => {
    it('returns empty array when worker reports no diagnostics', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const diag = getCqlDiagnostics(ctx, TS);
        assert.deepEqual(diag, []);
    });

    it('returns empty array when source has no cds.ql templates', () => {
        const src = 'console.log("hello");';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const diag = getCqlDiagnostics(ctx, TS);
        assert.deepEqual(diag, []);
    });

    it('returns diagnostics from worker with correct positions in original source', () => {
        const query = 'SELECT ghost FROM Books';
        const src = `const r = cds.ql\`${query}\``;

        // Worker reports 'ghost' as unknown at offset 7..12 in query
        const ghostStartInQuery = posOf(query, 'ghost');
        const ghostEndInQuery = ghostStartInQuery + 5;
        const diagnosticWorker = (args, _log) => ({
            diagnostics: [
                {
                    message: "Unknown field 'ghost'",
                    start: ghostStartInQuery,
                    end: ghostEndInQuery,
                    code: CqlDiagnosticCode.UnknownField,
                },
            ],
        });

        const ctx = makeCtx(src, diagnosticWorker);
        const diag = getCqlDiagnostics(ctx, TS);

        assert.equal(diag.length, 1);
        assert.ok(diag[0].messageText.toString().includes('ghost'));

        // Diagnostic position must point to 'ghost' in the original source
        const diagStart = diag[0].start;
        assert.equal(src.slice(diagStart, diagStart + 5), 'ghost', `diagnostic start must point to 'ghost' in original source, got: ${JSON.stringify(src.slice(diagStart, diagStart + 5))}`);
    });

    it('diagnostic length matches the token span', () => {
        const query = 'SELECT ghost FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const start = posOf(query, 'ghost');
        const end = start + 5;
        const worker = (_args, _log) => ({
            diagnostics: [
                {
                    message: "Unknown field 'ghost'",
                    start,
                    end,
                    code: CqlDiagnosticCode.UnknownField,
                },
            ],
        });

        const ctx = makeCtx(src, worker);
        const diag = getCqlDiagnostics(ctx, TS);
        assert.equal(diag[0].length, 5, 'diagnostic length must match token length');
    });

    it('diagnostic code reflects the error kind and source is "cds"', () => {
        const query = 'SELECT ghost FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const worker = (_args, _log) => ({
            diagnostics: [
                {
                    message: 'error',
                    start: 7,
                    end: 12,
                    code: CqlDiagnosticCode.UnknownField,
                },
            ],
        });
        const ctx = makeCtx(src, worker);
        const diag = getCqlDiagnostics(ctx, TS);
        assert.equal(diag[0].code, CqlDiagnosticCode.UnknownField);
        assert.equal(diag[0].source, 'cds');
    });

    it('diagnostics from multiple templates are all returned', () => {
        const src = ['const q1 = cds.ql`SELECT ghost FROM Books`;', 'const q2 = cds.ql`SELECT phantom FROM Authors`;'].join('\n');

        let callCount = 0;
        const worker = (_args, _log) => {
            callCount++;
            return {
                diagnostics: [
                    {
                        message: `error ${callCount}`,
                        start: 7,
                        end: 12,
                        code: CqlDiagnosticCode.UnknownField,
                    },
                ],
            };
        };

        const ctx = makeCtx(src, worker);
        const diag = getCqlDiagnostics(ctx, TS);
        assert.equal(diag.length, 2, 'should return diagnostics for both templates');
    });

    it('diagnostic position points to correct token even for second template on next line', () => {
        const q2 = 'SELECT phantom FROM Authors';
        const src = ['const q1 = cds.ql`SELECT id FROM Books`;', `const q2 = cds.ql\`${q2}\`;`].join('\n');

        const phantomInQ2 = posOf(q2, 'phantom');
        const worker = (args, _log) => {
            // Only return diagnostics for the second query (contains 'phantom')
            const queryArg = args[1] ?? '';
            if (!queryArg.includes('phantom')) return { diagnostics: [] };
            return {
                diagnostics: [
                    {
                        message: "Unknown field 'phantom'",
                        start: phantomInQ2,
                        end: phantomInQ2 + 7,
                        code: CqlDiagnosticCode.UnknownField,
                    },
                ],
            };
        };

        const ctx = makeCtx(src, worker);
        const diag = getCqlDiagnostics(ctx, TS);

        const phantomDiag = diag.find((d) => d.messageText.toString().includes('phantom'));
        assert.ok(phantomDiag, 'expected diagnostic for phantom');

        const diagStart = phantomDiag.start;
        assert.equal(src.slice(diagStart, diagStart + 7), 'phantom', `diagnostic should point to 'phantom' in original source`);
    });
});

// ---------------------------------------------------------------------------
// getCqlCompletionDetails — annotation insertion
// ---------------------------------------------------------------------------

describe('getCqlCompletionDetails — annotation insertion', () => {
    it('returns null when source does not start with "cds:"', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Books');
        const result = getCqlCompletionDetails('test.ts', pos, 'Books', 'ts:', ctx, TS);
        assert.equal(result, null);
    });

    it('returns null when cursor is not inside a template', () => {
        const src = 'console.log("hello");';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const result = getCqlCompletionDetails('test.ts', 0, 'Books', 'cds:Svc.Books', ctx, TS);
        assert.equal(result, null);
    });

    it('returns null when source FQN has no dot (no service prefix)', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Books');
        const result = getCqlCompletionDetails('test.ts', pos, 'Books', 'cds:Books', ctx, TS);
        assert.equal(result, null);
    });

    it('returns CompletionEntryDetails with a code action for annotation insertion', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Books');
        const result = getCqlCompletionDetails('test.ts', pos, 'Books', 'cds:Svc.Books', ctx, TS);
        assert.ok(result, 'expected CompletionEntryDetails');
        assert.ok(result.codeActions?.length, 'expected code actions');
    });

    it('code action inserts // @cds-service annotation before the statement', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Books');
        const result = getCqlCompletionDetails('test.ts', pos, 'Books', 'cds:Svc.Books', ctx, TS);
        assert.ok(result?.codeActions?.[0]);
        const change = result.codeActions[0].changes[0].textChanges[0];
        assert.ok(change.newText.includes('@cds-service Svc'), `expected @cds-service Svc in annotation, got: ${change.newText}`);
        // Insertion at start of line (length 0 = pure insertion)
        assert.equal(change.span.length, 0);
    });

    it('code action works for template nested inside a block (isVariableStatement break path)', () => {
        // The template is inside an if block so the while-loop walks past a VariableStatement
        // and breaks on it, rather than exiting naturally when parent === origSf.
        const src = 'if (true) {\n  const r = cds.ql`SELECT id FROM Books`;\n}';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'Books');
        const result = getCqlCompletionDetails('test.ts', pos, 'Books', 'cds:Svc.Books', ctx, TS);
        assert.ok(result, 'expected CompletionEntryDetails for nested template');
        assert.ok(result.codeActions?.length, 'expected code action for nested template');
        const change = result.codeActions[0].changes[0].textChanges[0];
        assert.ok(change.newText.includes('@cds-service Svc'), `expected annotation, got: ${change.newText}`);
    });
});

// ---------------------------------------------------------------------------
// serviceAnnotationFor
// ---------------------------------------------------------------------------

describe('serviceAnnotationFor', () => {
    function annotationFor(src) {
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        // find the first tagged template
        let tpl;
        function visit(n) {
            if (!tpl && TS.isTaggedTemplateExpression(n)) tpl = n;
            TS.forEachChild(n, visit);
        }
        visit(sf);
        assert.ok(tpl, 'no TaggedTemplateExpression found in source');
        return serviceAnnotationFor(TS, src, tpl, sf);
    }

    it('returns service name from // @cds-service <Name>', () => {
        const src = '// @cds-service MyService\nconst r = cds.ql`SELECT id FROM Books`';
        assert.equal(annotationFor(src), 'MyService');
    });

    it('returns service name from // @cds.service: <Name> (dot-colon variant)', () => {
        const src = '// @cds.service: OtherService\nconst r = cds.ql`SELECT id FROM Books`';
        assert.equal(annotationFor(src), 'OtherService');
    });

    it('returns undefined when no annotation is present', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        assert.equal(annotationFor(src), undefined);
    });

    it('returns undefined when annotation is two lines above (not immediately before)', () => {
        const src = '// @cds-service MyService\n\nconst r = cds.ql`SELECT id FROM Books`';
        assert.equal(annotationFor(src), undefined);
    });

    it('returns undefined when annotation comment is after the statement', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`\n// @cds-service MyService';
        assert.equal(annotationFor(src), undefined);
    });

    it('ignores trailing whitespace on annotation line', () => {
        const src = '// @cds-service TrimMe   \nconst r = cds.ql`SELECT id FROM Books`';
        assert.equal(annotationFor(src), 'TrimMe');
    });

    it('works with indented annotation and statement', () => {
        const src = 'function f() {\n  // @cds-service Inner\n  const r = cds.ql`SELECT id FROM Books`\n}';
        assert.equal(annotationFor(src), 'Inner');
    });
});

// ---------------------------------------------------------------------------
// readConfig
// ---------------------------------------------------------------------------

describe('readConfig', () => {
    function fakeRaw(config) {
        return config;
    }

    it('all features default to false when config is empty', () => {
        const cfg = readConfig(fakeRaw({}));
        assert.equal(cfg['cds.ql.completion'], false);
        assert.equal(cfg['cds.ql.hover'], false);
        assert.equal(cfg['cds.ql.diagnostics'], false);
        assert.equal(cfg['cds.ql.typeInference'], false);
    });

    it('all features default to false when config is undefined', () => {
        const cfg = readConfig({});
        assert.equal(cfg['cds.ql.completion'], false);
        assert.equal(cfg['cds.ql.hover'], false);
        assert.equal(cfg['cds.ql.diagnostics'], false);
        assert.equal(cfg['cds.ql.typeInference'], false);
    });

    it('setting a feature to true enables it, others remain false', () => {
        const cfg = readConfig(fakeRaw({ 'cds.ql.completion': true }));
        assert.equal(cfg['cds.ql.completion'], true);
        assert.equal(cfg['cds.ql.hover'], false);
        assert.equal(cfg['cds.ql.diagnostics'], false);
        assert.equal(cfg['cds.ql.typeInference'], false);
    });

    it('all four features can be enabled independently', () => {
        const cfg = readConfig(
            fakeRaw({
                'cds.ql.completion': true,
                'cds.ql.hover': true,
                'cds.ql.diagnostics': true,
                'cds.ql.typeInference': true,
            }),
        );
        assert.equal(cfg['cds.ql.completion'], true);
        assert.equal(cfg['cds.ql.hover'], true);
        assert.equal(cfg['cds.ql.diagnostics'], true);
        assert.equal(cfg['cds.ql.typeInference'], true);
    });

    it('setting a feature to false explicitly keeps it disabled', () => {
        const cfg = readConfig(fakeRaw({ 'cds.ql.hover': false }));
        assert.equal(cfg['cds.ql.hover'], false);
    });

    it('tolerates null/undefined config (all defaults, no throw)', () => {
        for (const raw of [null, undefined]) {
            const cfg = readConfig(raw);
            assert.equal(cfg['cds.ql.completion'], false);
            assert.equal(cfg['cds.ql.hover'], false);
            assert.equal(cfg['cds.ql.diagnostics'], false);
            assert.equal(cfg['cds.ql.typeInference'], false);
            assert.equal(cfg['cds.ql.debounceDelay'], 300);
        }
    });

    it('ignores an unknown schemaVersion tag and still applies known flags', () => {
        const cfg = readConfig(
            fakeRaw({
                schemaVersion: 1,
                'cds.ql.completion': true,
                'cds.ql.someFutureFlag': true,
            }),
        );
        assert.equal(cfg['cds.ql.completion'], true);
        assert.equal(cfg['cds.ql.hover'], false);
        // Unknown keys must not leak into the resolved config
        assert.equal(cfg['schemaVersion'], undefined);
        assert.equal(cfg['cds.ql.someFutureFlag'], undefined);
    });

    it('defaults debounceDelay when absent or non-numeric', () => {
        assert.equal(readConfig(fakeRaw({}))['cds.ql.debounceDelay'], 300);
        assert.equal(readConfig(fakeRaw({ 'cds.ql.debounceDelay': 'nope' }))['cds.ql.debounceDelay'], 300);
        assert.equal(readConfig(fakeRaw({ 'cds.ql.debounceDelay': 50 }))['cds.ql.debounceDelay'], 50);
    });
});

// ---------------------------------------------------------------------------
// resolveQueryContext
// ---------------------------------------------------------------------------

describe('resolveQueryContext', () => {
    function fakeInfo(origText, fileName) {
        return {
            config: {},
            project: {
                getScriptInfo: () => null, // no ScriptInfo — use originalSource map
            },
        };
    }

    it('returns null when file has no cds.ql', () => {
        const originalSource = new Map([['t.ts', 'console.log("hi");']]);
        const info = fakeInfo(undefined, 't.ts');
        const result = resolveQueryContext('t.ts', info, TS, originalSource, EMPTY_WORKER, EMPTY_BATCH_WORKER, NO_LOGGER, '/proj');
        assert.equal(result, null);
    });

    it('returns null when file is not in originalSource and scriptInfo is absent', () => {
        const originalSource = new Map();
        const info = fakeInfo(undefined, 't.ts');
        const result = resolveQueryContext('t.ts', info, TS, originalSource, EMPTY_WORKER, EMPTY_BATCH_WORKER, NO_LOGGER, '/proj');
        assert.equal(result, null);
    });

    it('returns QueryContext for a .ts file with cds.ql', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const originalSource = new Map([['t.ts', src]]);
        const info = fakeInfo(undefined, 't.ts');
        const ctx = resolveQueryContext('t.ts', info, TS, originalSource, EMPTY_WORKER, EMPTY_BATCH_WORKER, NO_LOGGER, '/proj');
        assert.ok(ctx, 'expected QueryContext');
        assert.equal(ctx.origText, src);
        assert.equal(ctx.projectRoot, '/proj');
        assert.equal(ctx.origSf.scriptKind, TS.ScriptKind.TS);
    });

    it('returns QueryContext with JS scriptKind for .js files', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const originalSource = new Map([['t.js', src]]);
        const info = fakeInfo(undefined, 't.js');
        const ctx = resolveQueryContext('t.js', info, TS, originalSource, EMPTY_WORKER, EMPTY_BATCH_WORKER, NO_LOGGER, '/proj');
        assert.ok(ctx, 'expected QueryContext for .js file');
        assert.equal(ctx.origSf.scriptKind, TS.ScriptKind.JS);
    });

    it('uses scriptInfo.__cdsOrigSnap when available', () => {
        const srcFromSnap = 'const r = cds.ql`SELECT id FROM Snap`';
        const snap = {
            getText: (_s, _e) => srcFromSnap,
            getLength: () => srcFromSnap.length,
        };
        const info = {
            config: {},
            project: {
                getScriptInfo: () => ({ __cdsOrigSnap: () => snap }),
            },
        };
        const originalSource = new Map(); // deliberately empty
        const ctx = resolveQueryContext('t.ts', info, TS, originalSource, EMPTY_WORKER, EMPTY_BATCH_WORKER, NO_LOGGER, '/proj');
        assert.ok(ctx, 'expected QueryContext from scriptInfo snap');
        assert.equal(ctx.origText, srcFromSnap);
    });
});

// ---------------------------------------------------------------------------
// resolveToCdsQuery — property-chain hover path
// ---------------------------------------------------------------------------

describe('resolveToCdsQuery — property chain', () => {
    it('cursor on .at(0) resolves to the cds.ql declaration', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nr.at(0);';
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        const pos = posOf(src, 'at');
        const resolved = resolveToCdsQuery(TS, sf, pos);
        assert.ok(resolved, 'expected resolveToCdsQuery to find template for .at access');
        const tplText = src.slice(resolved.template.pos, resolved.template.end);
        assert.ok(tplText.includes('Books'), 'resolved template must be the Books query');
        assert.equal(resolved.awaited, true);
    });

    it('cursor on chained property (.at(0)?.id) resolves to the declaration', () => {
        const src = 'const r = await cds.ql`SELECT id FROM Books`;\nr.at(0)?.id;';
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        const pos = posOf(src, 'id', 1); // second 'id' — the chained access, not inside template
        const resolved = resolveToCdsQuery(TS, sf, pos);
        assert.ok(resolved, 'expected resolution for chained property access');
    });

    it('cursor on identifier unrelated to cds.ql returns null', () => {
        const src = 'const foo = 42;\nfoo.toString();';
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        const resolved = resolveToCdsQuery(TS, sf, posOf(src, 'foo'));
        assert.equal(resolved, null);
    });

    it('non-awaited declaration is reported as non-awaited', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nr.then(x => x);';
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true, TS.ScriptKind.TS);
        const resolved = resolveToCdsQuery(TS, sf, posOf(src, 'then'));
        assert.ok(resolved, 'expected resolution');
        assert.equal(resolved.awaited, false);
    });
});

// ---------------------------------------------------------------------------
// getCqlHover — Case 2 SELECT-columns path
// ---------------------------------------------------------------------------

describe('getCqlHover — Case 2: SELECT column mapping', () => {
    it('hover on result var with SELECT columns shows only selected fields', () => {
        const query = 'SELECT id, title FROM Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        const worker = fieldsWorker([
            { label: 'id', detail: 'cds.UUID' },
            { label: 'title', detail: 'cds.String' },
            { label: 'descr', detail: 'cds.String' },
        ]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('id'), 'should include selected column id, got: ' + text);
        assert.ok(text.includes('title'), 'should include selected column title, got: ' + text);
        assert.ok(!text.includes('descr'), 'should NOT include unselected column descr, got: ' + text);
    });

    it('hover on result var with AS alias shows alias in type', () => {
        const query = 'SELECT title AS bookTitle FROM Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        const worker = fieldsWorker([{ label: 'title', detail: 'cds.String' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('bookTitle'), 'alias bookTitle must appear in type, got: ' + text);
        assert.ok(!text.includes(': title'), 'original field name title must not appear as property, got: ' + text);
    });

    it('hover on result var with SELECT * returns all non-association fields', () => {
        const query = 'SELECT * FROM Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        const worker = fieldsWorker([
            { label: 'id', detail: 'cds.UUID' },
            { label: 'title', detail: 'cds.String' },
            { label: 'author', detail: 'cds.Association' },
        ]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('id'), 'should include id, got: ' + text);
        assert.ok(text.includes('title'), 'should include title, got: ' + text);
        assert.ok(!text.includes('author'), 'should exclude association, got: ' + text);
    });

    it('hover returns "unknown" when no fields match selected columns', () => {
        const query = 'SELECT ghost FROM Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover even with no matching fields');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('unknown'), 'unresolved SELECT column must produce unknown type, got: ' + text);
    });

    it('hover on .at(0) access on result variable resolves type', () => {
        const src = 'const r = await cds.ql`SELECT * FROM Books`;\nr.at(0);';
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const pos = posOf(src, 'at');
        const result = getCqlHover('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected hover for .at access on result variable');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('id'), 'hover via .at() should show field type, got: ' + text);
    });

    it('hover on result var with FQN entity (dot in name) uses empty prefix', () => {
        const query = 'SELECT id FROM db.Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover for FQN entity');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('id'), 'should include id field, got: ' + text);
    });

    it('hover on result var when cursor node is not an identifier uses template span', () => {
        // Position on `cds` keyword — not an identifier in the TS AST sense that resolves to the var
        const query = 'SELECT id FROM Books';
        const src = `const r = await cds.ql\`${query}\`;\nconsole.log(r);`;
        const worker = fieldsWorker([{ label: 'id', detail: 'cds.UUID' }]);
        const ctx = makeCtx(src, worker);
        // Position on the template backtick itself (not an identifier node)
        const posOnTemplate = src.indexOf('`');
        const result = getCqlHover('test.ts', posOnTemplate, ctx, TS);
        // May return null or a result — the important thing is it doesn't throw
        assert.doesNotThrow(() => getCqlHover('test.ts', posOnTemplate, ctx, TS));
    });

    // A batch worker modelling a Books→author→Authors association chain, so hover
    // can resolve nested expand types the same way the type rewriter does.
    const expandBatch = (_root, probes, _logger) => ({
        fields: Object.fromEntries(
            probes.map((p) => {
                if (p.entity === 'Books')
                    return [
                        p.entity,
                        [
                            {
                                label: 'ID',
                                detail: 'cds.Integer',
                                kind: 'field',
                            },
                            {
                                label: 'title',
                                detail: 'cds.String',
                                kind: 'field',
                            },
                            {
                                label: 'author',
                                detail: 'cds.Association',
                                kind: 'field',
                                target: 'Svc.Authors',
                                toMany: false,
                            },
                        ],
                    ];
                if (p.entity === 'Svc.Authors')
                    return [
                        p.entity,
                        [
                            {
                                label: 'name',
                                detail: 'cds.String',
                                kind: 'field',
                            },
                            {
                                label: 'age',
                                detail: 'cds.Integer',
                                kind: 'field',
                            },
                        ],
                    ];
                return [p.entity, []];
            }),
        ),
    });

    it('hover on result var nests expand columns (author { age }) instead of unknown', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { author { age } }`;\nconsole.log(r);';
        const ctx = makeCtx(src, EMPTY_WORKER, '/proj', 'test.ts', expandBatch);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover for result variable');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('author'), `expected author in type, got: ${text}`);
        assert.ok(text.includes('age'), `expected nested age in type, got: ${text}`);
        assert.ok(!/author:\s*unknown/.test(text), `expand column must not collapse to unknown, got: ${text}`);
    });

    it('hover on result var renders a bare association column as an implicit SELECT * expand', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { author }`;\nconsole.log(r);';
        const ctx = makeCtx(src, EMPTY_WORKER, '/proj', 'test.ts', expandBatch);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('author'), `expected author in type, got: ${text}`);
        // implicit SELECT * over the target → its scalar fields appear
        assert.ok(text.includes('name') && text.includes('age'), `expected target fields name/age, got: ${text}`);
        assert.ok(!/author:\s*unknown/.test(text), `bare association must not be unknown, got: ${text}`);
    });

    it('hover on result var with only scalar columns still renders a flat row type', () => {
        const src = 'const r = await cds.ql`SELECT FROM Books { ID, title }`;\nconsole.log(r);';
        const ctx = makeCtx(src, EMPTY_WORKER, '/proj', 'test.ts', expandBatch);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('ID'), `expected ID, got: ${text}`);
        assert.ok(text.includes('title'), `expected title, got: ${text}`);
        assert.ok(!text.includes('unknown'), `scalar row must not be unknown, got: ${text}`);
    });

    it('hover respects association cardinality (to-one scalar vs to-many array)', () => {
        // author is to-one (scalar object); chapters is to-many (array).
        const cardinalityBatch = (_root, probes, _logger) => ({
            fields: Object.fromEntries(
                probes.map((p) => {
                    if (p.entity === 'Books')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'author',
                                    detail: 'cds.Association',
                                    kind: 'field',
                                    target: 'Svc.Authors',
                                    toMany: false,
                                },
                                {
                                    label: 'chapters',
                                    detail: 'cds.Composition',
                                    kind: 'field',
                                    target: 'Svc.Chapters',
                                    toMany: true,
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Authors')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'age',
                                    detail: 'cds.Integer',
                                    kind: 'field',
                                },
                            ],
                        ];
                    if (p.entity === 'Svc.Chapters')
                        return [
                            p.entity,
                            [
                                {
                                    label: 'title',
                                    detail: 'cds.String',
                                    kind: 'field',
                                },
                            ],
                        ];
                    return [p.entity, []];
                }),
            ),
        });
        const src = 'const r = await cds.ql`SELECT FROM Books { author { age }, chapters { title } }`;\nconsole.log(r);';
        const ctx = makeCtx(src, EMPTY_WORKER, '/proj', 'test.ts', cardinalityBatch);
        const result = getCqlHover('test.ts', src.lastIndexOf('r'), ctx, TS);
        assert.ok(result, 'expected hover');
        const text = (result.displayParts ?? []).map((p) => p.text).join('');
        assert.ok(text.includes('author:{age:number}'), `to-one must be scalar object, got: ${text}`);
        assert.ok(!/author:\{age:number\}\[\]/.test(text), `to-one must not be array, got: ${text}`);
        assert.ok(text.includes('chapters:{title:string}[]'), `to-many must be array, got: ${text}`);
    });
});

// ---------------------------------------------------------------------------
// cdsTypeToTs — full type mapping including default branch
// ---------------------------------------------------------------------------

describe('cdsTypeToTs — type mapping', () => {
    it('maps UUID to string', () => {
        assert.equal(cdsTypeToTs('cds.UUID'), 'string');
    });
    it('maps String to string', () => {
        assert.equal(cdsTypeToTs('cds.String'), 'string');
    });
    it('maps Boolean to boolean', () => {
        assert.equal(cdsTypeToTs('cds.Boolean'), 'boolean');
    });
    it('maps Integer to number', () => {
        assert.equal(cdsTypeToTs('cds.Integer'), 'number');
    });
    it('maps Decimal to the ieee754compatible union (string | number)', () => {
        assert.equal(cdsTypeToTs('cds.Decimal'), 'string | number');
        assert.equal(cdsTypeToTs('cds.DecimalFloat'), 'string | number');
    });
    it('maps Int64 family to the ieee754compatible union (string | number)', () => {
        assert.equal(cdsTypeToTs('cds.Int64'), 'string | number');
        assert.equal(cdsTypeToTs('cds.Integer64'), 'string | number');
    });
    it('maps small/32-bit integers to number', () => {
        assert.equal(cdsTypeToTs('cds.Int16'), 'number');
        assert.equal(cdsTypeToTs('cds.Int32'), 'number');
    });
    it('maps Double to number', () => {
        assert.equal(cdsTypeToTs('cds.Double'), 'number');
    });
    it('maps unrecognised type to unknown (default branch)', () => {
        assert.equal(cdsTypeToTs('cds.SomeNewType'), 'unknown');
        assert.equal(cdsTypeToTs(''), 'unknown');
        assert.equal(cdsTypeToTs('completely.made.up'), 'unknown');
    });
});

// ---------------------------------------------------------------------------
// resolveBaseType
// ---------------------------------------------------------------------------

describe('resolveBaseType', () => {
    it('returns built-in cds type unchanged', () => {
        assert.equal(resolveBaseType('cds.String', {}), 'cds.String');
    });

    it('resolves a user-defined type to its cds primitive', () => {
        const defs = { MyType: { type: 'cds.String' } };
        assert.equal(resolveBaseType('MyType', defs), 'cds.String');
    });

    it('resolves a chain of user-defined types', () => {
        const defs = {
            'Svc.Genre': { type: 'Svc.Name' },
            'Svc.Name': { type: 'cds.String' },
        };
        assert.equal(resolveBaseType('Svc.Genre', defs), 'cds.String');
    });

    it('returns undefined when type is undefined', () => {
        assert.equal(resolveBaseType(undefined, {}), undefined);
    });

    it('returns original type when not found in defs', () => {
        assert.equal(resolveBaseType('Unknown.Type', {}), 'Unknown.Type');
    });

    it('breaks cycles and returns last seen type', () => {
        const defs = { A: { type: 'B' }, B: { type: 'A' } };
        const result = resolveBaseType('A', defs);
        assert.ok(result === 'A' || result === 'B', `expected A or B, got ${result}`);
    });

    it('getSuggestions uses resolveBaseType for user-defined field types', () => {
        const defs = {
            'Svc.Books': {
                kind: 'entity',
                elements: {
                    genre: { type: 'Svc.Genre' },
                },
            },
            'Svc.Genre': { type: 'cds.String' },
        };
        const items = getSuggestions('SELECT | FROM Svc.Books', 7, defs, 'Svc');
        const genre = items.find((i) => i.label === 'genre');
        assert.ok(genre, 'genre field must appear in completions');
        assert.equal(genre?.detail, 'cds.String', `detail must be resolved primitive, got: ${genre?.detail}`);
    });
});

// ---------------------------------------------------------------------------
// buildTypeString
// ---------------------------------------------------------------------------

describe('buildTypeString', () => {
    it('returns unknown for empty field list', () => {
        assert.equal(buildTypeString([]), 'unknown');
    });

    it('ignores non-field entries when computing type', () => {
        const cols = [{ label: 'Books', kind: 'entity', detail: 'Svc.Books' }];
        assert.equal(buildTypeString(cols), 'unknown');
    });

    it('returns object type string for a single field', () => {
        const cols = [{ label: 'id', kind: 'field', detail: 'cds.UUID' }];
        assert.equal(buildTypeString(cols), '{ id: string }[]');
    });

    it('returns object type string for multiple fields', () => {
        const cols = [
            { label: 'id', kind: 'field', detail: 'cds.UUID' },
            { label: 'count', kind: 'field', detail: 'cds.Integer' },
        ];
        assert.equal(buildTypeString(cols), '{ id: string; count: number }[]');
    });
});

// ---------------------------------------------------------------------------
// buildTypeBody — function-call (aggregate) result types
// ---------------------------------------------------------------------------

describe('buildTypeBody — aggregate functions', () => {
    // fieldMap mirrors what the worker probe returns for an entity's elements
    const fieldMap = new Map([
        ['ID', { label: 'ID', kind: 'field', detail: 'cds.Integer' }],
        ['title', { label: 'title', kind: 'field', detail: 'cds.String' }],
        ['stock', { label: 'stock', kind: 'field', detail: 'cds.Integer' }],
    ]);

    it('infers number for count(*)', () => {
        const cols = parseCqlColumns('SELECT count(*) as n FROM Books');
        assert.equal(buildTypeBody(cols, fieldMap, {}), 'n:number');
    });

    it('infers the argument type for max/min/sum/avg', () => {
        const cols = parseCqlColumns('SELECT max(ID) as hi, avg(stock) as a, min(title) as lo FROM Books');
        assert.equal(buildTypeBody(cols, fieldMap, {}), 'hi:number;a:number;lo:string');
    });

    it('infers the argument type for a qualified aggregate argument', () => {
        // arg is `B.ID`; fieldMap is keyed by the bare label `ID`.
        const cols = parseCqlColumns('SELECT max(B.ID) as hi FROM Books AS B');
        assert.equal(buildTypeBody(cols, fieldMap, {}), 'hi:number');
    });

    it('falls back to unknown for an unrecognised function', () => {
        const cols = parseCqlColumns('SELECT weird(ID) as w FROM Books');
        assert.equal(buildTypeBody(cols, fieldMap, {}), 'w:unknown');
    });

    it('falls back to unknown when the aggregate argument is unresolvable', () => {
        const cols = parseCqlColumns('SELECT max(ghost) as x FROM Books');
        assert.equal(buildTypeBody(cols, fieldMap, {}), 'x:unknown');
    });

    it('mixes aggregate and plain columns', () => {
        const cols = parseCqlColumns('SELECT title, count(*) as n FROM Books');
        assert.equal(buildTypeBody(cols, fieldMap, {}), 'title:string;n:number');
    });
});

// ---------------------------------------------------------------------------
// resolveTypeExpr — write-statement result types (UPDATE/INSERT/UPSERT/DELETE)
// ---------------------------------------------------------------------------

describe('resolveTypeExpr — write statements', () => {
    // A worker stub that fails the test if called: write statements must be typed
    // purely from `typeof cds`, with no model probe.
    const noWorker = () => assert.fail('runBatchWorker must not be called for a write statement');
    const logger = { info() {}, error() {} };
    const expr = (q, awaited) => resolveTypeExpr(TS, q, undefined, awaited, '/proj', noWorker, logger);

    it('UPDATE (awaited) → number', () => {
        assert.equal(expr('UPDATE Books SET stock = 1 WHERE ID = 2', true), 'number');
    });

    it('UPDATE (non-awaited) → Promise<number>', () => {
        assert.equal(expr('UPDATE Books SET stock = 1', false), 'Promise<number>');
    });

    it('DELETE (awaited) → number', () => {
        assert.equal(expr('DELETE FROM Books WHERE ID = 1', true), 'number');
    });

    it('INSERT (awaited) → { affected: number }', () => {
        assert.equal(expr('INSERT INTO Books (ID) VALUES (1)', true), '{affected:number}');
    });

    it('UPSERT (awaited) → { affected: number }', () => {
        assert.equal(expr('UPSERT INTO Books ENTRIES { ID: 1 }', true), '{affected:number}');
    });

    it('INSERT (non-awaited) → Promise<{ affected: number }>', () => {
        assert.equal(expr('INSERT INTO Books (ID) VALUES (1)', false), 'Promise<{affected:number}>');
    });

    it('is case-insensitive and tolerates leading whitespace', () => {
        assert.equal(expr('  update Books SET stock = 1', true), 'number');
    });

    it('does not treat SELECT as a write statement (would call the worker)', () => {
        // With noWorker, a SELECT must reach the worker path; assert.fail inside
        // noWorker proves SELECT is NOT short-circuited. Use a passing worker here.
        const okWorker = () => ({ fields: { Books: [{ label: 'ID', kind: 'field', detail: 'cds.UUID' }] } });
        const out = resolveTypeExpr(TS, 'SELECT ID FROM Books', undefined, true, '/proj', okWorker, logger);
        assert.equal(out, '{ID:string}[]');
    });
});
// ---------------------------------------------------------------------------

describe('fieldTokenAtOffset', () => {
    it('returns null when cursor is on whitespace with no adjacent identifier', () => {
        // Double space — neither offset nor offset-1 is an identifier char
        assert.equal(fieldTokenAtOffset('a  b', 2), null); // middle of two spaces
    });

    it('returns null when cursor is on a non-identifier operator with none adjacent', () => {
        assert.equal(fieldTokenAtOffset(' , ', 1), null); // comma flanked by spaces
    });

    it('returns token when cursor is at the start of an identifier', () => {
        const r = fieldTokenAtOffset('SELECT id FROM Books', 7);
        assert.ok(r, 'expected token at start of identifier');
        assert.equal(r.name, 'id');
    });

    it('returns token when cursor is just past the end of an identifier (offset-1 is id char)', () => {
        const r = fieldTokenAtOffset('SELECT id FROM Books', 9); // just after 'id'
        assert.ok(r, 'expected token when offset-1 is identifier char');
        assert.equal(r.name, 'id');
    });

    it('returns token with correct start/end span', () => {
        const r = fieldTokenAtOffset('FROM Books', 6);
        assert.ok(r);
        assert.equal(r.name, 'Books');
        assert.equal(r.start, 5);
        assert.equal(r.end, 10);
    });

    it('handles identifier at position 0', () => {
        const r = fieldTokenAtOffset('id FROM Books', 0);
        assert.ok(r);
        assert.equal(r.name, 'id');
        assert.equal(r.start, 0);
    });

    it('returns null for empty string', () => {
        assert.equal(fieldTokenAtOffset('', 0), null);
    });
});

// ---------------------------------------------------------------------------
// extractSourceRelations — implicit alias (no AS keyword)
// ---------------------------------------------------------------------------

describe('extractSourceRelations — implicit alias', () => {
    it('handles implicit alias (entity identifier immediately follows entity name)', () => {
        // "FROM Books b" — b is an implicit alias, no AS keyword
        const tokens = tokenizeCql('SELECT b.id FROM Books b WHERE b.id = 1');
        const sig = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
        const sources = extractSourceRelations(sig);
        assert.ok(sources.length > 0, 'expected at least one source');
        const booksSource = sources.find((s) => s.entity === 'Books');
        assert.ok(booksSource, 'expected Books entity in sources');
        assert.equal(booksSource.ref, 'b', 'implicit alias b must be used as ref');
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — unknown clause
// ---------------------------------------------------------------------------

describe('getSuggestions — statement start', () => {
    it('offers statement keywords when the cursor is before any keyword', () => {
        // Cursor at position 0 of a query that starts with whitespace — before SELECT,
        // so getCursorClause returns { kind: 'unknown' }. This is the start of the
        // statement, so getSuggestions offers the statement-opening keywords.
        const query = ' SELECT id FROM Books';
        const cursor = 0; // before SELECT — statement start
        const defs_ = defs({ Books: { id: 'cds.UUID' } });
        const suggestions = getSuggestions(query, cursor, defs_, undefined);
        includesAll(
            suggestions.map((i) => i.label),
            ['SELECT', 'INSERT', 'UPDATE', 'UPSERT', 'DELETE'],
        );
        assert.ok(
            suggestions.every((i) => i.kind === 'keyword'),
            'only keyword suggestions at statement start',
        );
    });
});

// ---------------------------------------------------------------------------
// resolveSource — FQN dot path
// ---------------------------------------------------------------------------

describe('getSuggestions — FQN entity name with dot resolves via direct defs lookup', () => {
    it('resolves entity by FQN when name contains a dot and no prefix matches', () => {
        // Entity is stored as 'Svc.Books' in defs; query uses it with FQN
        const { query, cursor } = withCursor('SELECT | FROM Svc.Books');
        const defs_ = defs({
            'Svc.Books': { id: 'cds.UUID', title: 'cds.String' },
        });
        const suggestions = getSuggestions(query, cursor, defs_, undefined);
        const labels = suggestions.map((s) => s.label);
        assert.ok(labels.includes('id'), 'FQN entity must resolve — id expected, got: ' + labels.join(', '));
        assert.ok(labels.includes('title'), 'FQN entity must resolve — title expected, got: ' + labels.join(', '));
    });
});

// ---------------------------------------------------------------------------
// validateCqlQuery — RIGHT/FULL/CROSS JOIN and implicit alias in entity scan
// ---------------------------------------------------------------------------

describe('validateCqlQuery — JOIN variants and implicit alias', () => {
    it('accepts RIGHT JOIN without error', () => {
        const d = defs({
            Books: { id: 'cds.UUID' },
            Authors: { id: 'cds.UUID' },
        });
        const errs = validateCqlQuery('SELECT b.id FROM Books b RIGHT JOIN Authors a ON b.id = a.id', d);
        const entityErrs = errs.filter((e) => e.code === CqlDiagnosticCode.UnknownEntity);
        assert.deepEqual(entityErrs, [], 'RIGHT JOIN must not produce unknown-entity errors');
    });

    it('accepts FULL JOIN without error', () => {
        const d = defs({
            Books: { id: 'cds.UUID' },
            Authors: { id: 'cds.UUID' },
        });
        const errs = validateCqlQuery('SELECT b.id FROM Books b FULL JOIN Authors a ON b.id = a.id', d);
        const entityErrs = errs.filter((e) => e.code === CqlDiagnosticCode.UnknownEntity);
        assert.deepEqual(entityErrs, [], 'FULL JOIN must not produce unknown-entity errors');
    });

    it('accepts CROSS JOIN without error', () => {
        const d = defs({
            Books: { id: 'cds.UUID' },
            Authors: { id: 'cds.UUID' },
        });
        const errs = validateCqlQuery('SELECT b.id FROM Books b CROSS JOIN Authors a ON b.id = a.id', d);
        const entityErrs = errs.filter((e) => e.code === CqlDiagnosticCode.UnknownEntity);
        assert.deepEqual(entityErrs, [], 'CROSS JOIN must not produce unknown-entity errors');
    });

    it('resolves implicit alias in entity scan (no AS keyword after JOIN)', () => {
        // "JOIN Authors a" — a is implicit alias; validateCqlQuery must resolve b.id via the alias
        const d = defs({
            Books: { id: 'cds.UUID', title: 'cds.String' },
            Authors: { id: 'cds.UUID', name: 'cds.String' },
        });
        const errs = validateCqlQuery('SELECT b.id, a.name FROM Books b LEFT JOIN Authors a ON b.id = a.id', d);
        const fieldErrs = errs.filter((e) => e.code === CqlDiagnosticCode.UnknownField);
        assert.deepEqual(fieldErrs, [], 'implicit alias must resolve — got errors: ' + JSON.stringify(fieldErrs));
    });
});

// ---------------------------------------------------------------------------
// CqlHover — field.doc documentation branch
// ---------------------------------------------------------------------------

describe('getCqlHover — field documentation (doc property)', () => {
    it('includes doc text in hover documentation when field has doc', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'id');

        const worker = (_args, _logger) => ({
            completions: [
                {
                    label: 'id',
                    detail: 'cds.UUID',
                    kind: 'field',
                    doc: 'Primary key of the Books entity',
                },
            ],
        });
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected hover result');
        const docText = result.documentation?.map((p) => p.text).join('') ?? '';
        assert.ok(docText.includes('Primary key'), 'doc text must appear in hover documentation, got: ' + docText);
    });

    it('includes entity source in hover documentation', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'id');

        const worker = (_args, _logger) => ({
            completions: [
                {
                    label: 'id',
                    detail: 'cds.UUID',
                    kind: 'field',
                    entity: 'Svc.Books',
                },
            ],
        });
        const ctx = makeCtx(src, worker);
        const result = getCqlHover('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected hover result');
        const docText = result.documentation?.map((p) => p.text).join('') ?? '';
        assert.ok(docText.includes('Svc.Books'), 'entity source must appear in documentation, got: ' + docText);
    });
});

// ---------------------------------------------------------------------------
// getCqlCompletions — entity completion with FQN source (hasAction path)
// ---------------------------------------------------------------------------

describe('getCqlCompletions — entity completion with FQN source', () => {
    it('entity completion without prefix gets hasAction=true and cds: source', () => {
        const query = 'SELECT id FROM Books';
        const src = `const r = cds.ql\`${query}\``;
        const posInSrc = posOf(src, 'Books');

        const worker = (_args, _logger) => ({
            completions: [
                {
                    label: 'Books',
                    detail: 'Svc.Books',
                    kind: 'entity',
                },
            ],
        });
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected completions');
        const entry = result.entries.find((e) => e.name === 'Books');
        assert.ok(entry, 'Books entry must be present');
        assert.equal(entry.hasAction, true, 'entity without prefix must have hasAction=true');
        assert.equal(entry.source, 'cds:Svc.Books', 'entity source must be cds:FQN');
    });

    it('entity completion with prefix does NOT get hasAction (annotation already present)', () => {
        const src = '// @cds-service Svc\nconst r = cds.ql`SELECT id FROM Books`';
        const posInSrc = posOf(src, 'Books');

        const worker = (_args, _logger) => ({
            completions: [
                {
                    label: 'Books',
                    detail: 'Svc.Books',
                    kind: 'entity',
                },
            ],
        });
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', posInSrc, ctx, TS);
        assert.ok(result, 'expected completions');
        const entry = result.entries.find((e) => e.name === 'Books');
        assert.ok(entry, 'Books entry must be present');
        assert.ok(!entry.hasAction, 'entity with prefix must NOT have hasAction (no annotation needed)');
    });

    it('field completion with empty detail sets labelDetails to undefined', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const pos = posOf(src, 'id');
        const worker = (_args, _logger) => ({
            completions: [{ label: 'id', detail: '', kind: 'field' }],
        });
        const ctx = makeCtx(src, worker);
        const result = getCqlCompletions('test.ts', pos, ctx, TS);
        assert.ok(result, 'expected completions');
        const entry = result.entries.find((e) => e.name === 'id');
        assert.ok(entry, 'id entry must be present');
        assert.equal(entry.labelDetails, undefined, 'labelDetails must be undefined for empty detail');
    });
});

// ---------------------------------------------------------------------------
// getCqlCompletionDetails — no template found at position
// ---------------------------------------------------------------------------

describe('getCqlCompletionDetails — no template at position', () => {
    it('returns null when cds: source but cursor is not inside a template', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`;\nexport {};';
        const ctx = makeCtx(src, EMPTY_WORKER);
        // Position on 'export' — outside any template
        const result = getCqlCompletionDetails('test.ts', posOf(src, 'export'), 'Books', 'cds:Svc.Books', ctx, TS);
        assert.equal(result, null);
    });
});

// ---------------------------------------------------------------------------
// rewriteSnapshot — JS budget-exceeded skip
// ---------------------------------------------------------------------------

describe('rewriteSnapshot — JS budget-exceeded skip', () => {
    it('skips JS rewrite when even the alias cast does not fit in budget', () => {
        // Declaration on line 100 → alias _q100 → jsCast " = (/**@type{_q100}*/({}))" = 26 chars.
        // Initializer span "=cds.ql`SELECT a FROM B`" = 24 chars → 26 > 24 → skip.
        const src = '\n'.repeat(100) + 'var x=cds.ql`SELECT a FROM B`';
        const worker = fieldsBatchWorker([{ label: 'a', detail: 'cds.String' }]);
        const rw = rewrite(src, worker, 'test.js');
        assert.equal(rw, src, 'source must be unchanged when JS cast does not fit in budget');
    });
});

// ---------------------------------------------------------------------------
// rewriteSnapshot — JS cast type-checks clean under checkJs (TS2352 guard)
// ---------------------------------------------------------------------------

/**
 * Type-check a single in-memory `.js` source under allowJs + checkJs + strict,
 * returning the TS error codes reported for that file. Uses the real compiler
 * host (so lib.d.ts globals like Array/Number resolve — required for the
 * type-overlap check that TS2352 depends on) with only the virtual file
 * overridden. No project file system involved.
 */
function typeCheckJs(fileName, source) {
    const options = {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        strict: true,
        target: TS.ScriptTarget.ES2020,
        lib: ['lib.es2020.d.ts'],
    };
    const host = TS.createCompilerHost(options, true);
    const origGetSourceFile = host.getSourceFile.bind(host);
    host.getSourceFile = (name, langVersion, onError, shouldCreate) => {
        if (name === fileName) return TS.createSourceFile(name, source, langVersion, true, TS.ScriptKind.JS);
        return origGetSourceFile(name, langVersion, onError, shouldCreate);
    };
    const origFileExists = host.fileExists.bind(host);
    host.fileExists = (name) => name === fileName || origFileExists(name);
    const program = TS.createProgram([fileName], options, host);
    return TS.getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === fileName)
        .map((d) => d.code);
}

describe('rewriteSnapshot — JS cast type-checks clean under checkJs', () => {
    // Regression for TS2352: casting the literal `0` (type number) to an object
    // /array result type failed ("neither type sufficiently overlaps"). The JS
    // cast base is `({})`, which overlaps object, array, and primitive result
    // types — so the injected @type cast must type-check clean for every shape.
    const shapes = [
        {
            name: 'object-array result (SELECT *)',
            query: 'SELECT * FROM Books WHERE ID = 1',
            fields: [
                { label: 'ID', detail: 'cds.Integer' },
                { label: 'title', detail: 'cds.String' },
            ],
        },
        {
            name: 'single scalar column',
            query: 'SELECT title FROM Books WHERE ID = 1',
            fields: [{ label: 'title', detail: 'cds.String' }],
        },
        {
            name: 'numeric column',
            query: 'SELECT stock FROM Books WHERE ID = 1',
            fields: [{ label: 'stock', detail: 'cds.Integer' }],
        },
    ];

    for (const { name, query, fields } of shapes) {
        it(`emits a clean @type cast for ${name}`, () => {
            const src = `const r = await cds.ql\`${query}\`\nconst use = r`;
            const worker = fieldsBatchWorker(fields);
            const rw = rewrite(src, worker, 'svc.js');
            assert.ok(rw.includes('@type'), 'expected a JSDoc @type cast to be injected');

            const codes = typeCheckJs('svc.js', rw);
            assert.ok(!codes.includes(2352), `rewritten JS must not trip TS2352; got codes [${codes.join(', ')}]`);
        });
    }
});

// ---------------------------------------------------------------------------
// resolveQueryContext — scriptInfo present but no __cdsOrigSnap
// ---------------------------------------------------------------------------

describe('resolveQueryContext — scriptInfo without __cdsOrigSnap', () => {
    it('falls back to originalSource map when scriptInfo has no __cdsOrigSnap', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const originalSource = new Map([['t.ts', src]]);
        // scriptInfo present but no __cdsOrigSnap property
        const info = {
            config: {},
            project: {
                getScriptInfo: () => ({
                    /* no __cdsOrigSnap */
                }),
            },
        };

        const ctx = resolveQueryContext('t.ts', info, TS, originalSource, EMPTY_WORKER, EMPTY_BATCH_WORKER, NO_LOGGER, '/proj');
        assert.ok(ctx, 'expected QueryContext when scriptInfo has no __cdsOrigSnap');
        assert.equal(ctx.origText, src, 'must fall back to originalSource map');
    });
});

// ---------------------------------------------------------------------------
// tokenizeCql — quoted identifier and unknown token
// ---------------------------------------------------------------------------

describe('tokenizeCql — quoted identifier', () => {
    it('parses double-quoted identifier as identifier token', () => {
        const tokens = tokenizeCql('SELECT "my field" FROM Books');
        const quoted = tokens.find((t) => t.kind === 'identifier' && t.value === 'my field');
        assert.ok(quoted, 'double-quoted "my field" must become an identifier token');
        assert.equal(quoted.value, 'my field');
    });

    it('quoted identifier value excludes surrounding quotes', () => {
        const tokens = tokenizeCql('"Title"');
        const id = tokens.find((t) => t.kind === 'identifier');
        assert.ok(id, 'expected identifier token');
        assert.equal(id.value, 'Title', 'value must not include the surrounding quotes');
    });
});

describe('tokenizeCql — unknown token', () => {
    it('emits unknown token for unrecognized character @', () => {
        const tokens = tokenizeCql('SELECT @ FROM Books');
        const unknown = tokens.find((t) => t.kind === 'unknown');
        assert.ok(unknown, 'expected unknown token for @');
        assert.equal(unknown.value, '@');
    });

    it('emits unknown token for hash character #', () => {
        const tokens = tokenizeCql('SELECT id FROM Books # comment');
        const unknown = tokens.find((t) => t.kind === 'unknown');
        assert.ok(unknown, 'expected unknown token for #');
        assert.equal(unknown.value, '#');
    });

    it('tokenizes colon as punctuation (for SET/ENTRIES object forms)', () => {
        const tokens = tokenizeCql('UPDATE Books SET { title: 1 }');
        const colon = tokens.find((t) => t.value === ':');
        assert.ok(colon, 'expected a colon token');
        assert.equal(colon.kind, 'punctuation');
    });
});

// ---------------------------------------------------------------------------
// extractTemplateText — template with interpolation spans
// ---------------------------------------------------------------------------

describe('extractTemplateText — template with interpolation spans', () => {
    it('concatenates head and span literal texts with spaces for interpolated template', () => {
        const src = 'const r = cds.ql`SELECT ${someExpr} FROM Books`';
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true);
        const assignments = collectCqlAssignments(TS, sf);
        assert.ok(assignments.length > 0, 'expected at least one cds.ql assignment');
        const tplNode = assignments[0].template;
        const text = extractTemplateText(TS, tplNode);
        assert.ok(text.includes('SELECT'), 'result must include SELECT');
        assert.ok(text.includes('FROM Books'), 'result must include FROM Books');
    });

    it('returns just the template text for no-substitution template', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const sf = TS.createSourceFile('t.ts', src, TS.ScriptTarget.Latest, true);
        const assignments = collectCqlAssignments(TS, sf);
        const tplNode = assignments[0].template;
        const text = extractTemplateText(TS, tplNode);
        assert.equal(text, 'SELECT id FROM Books');
    });
});

// ---------------------------------------------------------------------------
// getCqlHover — Case 1: cursor on FROM keyword (no field/entity match → null)
// ---------------------------------------------------------------------------

describe('getCqlHover — Case 1 cursor on keyword returns null', () => {
    it('returns null when cursor is on FROM keyword inside the template', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const posOnFrom = posOf(src, 'FROM');
        const result = getCqlHover('test.ts', posOnFrom, ctx, TS);
        assert.equal(result, null, 'hover on FROM keyword must return null');
    });

    it('returns null when cursor is on WHERE keyword inside the template', () => {
        const src = 'const r = cds.ql`SELECT id FROM Books WHERE id = 1`';
        const ctx = makeCtx(src, EMPTY_WORKER);
        const pos = posOf(src, 'WHERE');
        assert.equal(getCqlHover('test.ts', pos, ctx, TS), null);
    });
});

// ---------------------------------------------------------------------------
// tokenizeCql — string literals and quoted identifiers
// ---------------------------------------------------------------------------

describe('tokenizeCql — string literals and quoted identifiers', () => {
    it('tokenizes single-quoted string literal', () => {
        const tokens = tokenizeCql("SELECT id FROM Books WHERE title = 'hello world'");
        const str = tokens.find((t) => t.kind === 'string');
        assert.ok(str, 'expected string token');
        assert.equal(str.value, "'hello world'");
    });

    it('handles escaped quote inside string literal', () => {
        const tokens = tokenizeCql("SELECT id FROM Books WHERE title = 'it\\'s here'");
        const str = tokens.find((t) => t.kind === 'string');
        assert.ok(str, 'expected string token with escaped quote');
    });

    it('tokenizes double-quoted identifier', () => {
        const tokens = tokenizeCql('SELECT "myField" FROM Books');
        const ident = tokens.find((t) => t.kind === 'identifier' && t.value === 'myField');
        assert.ok(ident, 'expected identifier token from double-quoted string');
    });
});

// ---------------------------------------------------------------------------
// getCursorClause — from-source with pendingEntity (second identifier)
// and parenthesised depth branches
// ---------------------------------------------------------------------------

describe('getCursorClause — from-source and depth branches', () => {
    it('sets pendingEntity when cursor follows first identifier after FROM', () => {
        const query = 'SELECT id FROM Books ';
        const tokens = tokenizeCql(query);
        const clause = getCursorClause(tokens, query.length);
        assert.equal(clause.kind, 'from-source', 'after entity name in FROM clause returns from-source');
    });

    it('resolves AS alias in from-source', () => {
        const query = 'SELECT b.id FROM Books AS ';
        const tokens = tokenizeCql(query);
        const clause = getCursorClause(tokens, query.length);
        assert.equal(clause.kind, 'from-source');
    });

    it('ignores tokens inside parentheses (depth > 0)', () => {
        const query = 'SELECT (id + 1) FROM Books WHERE ';
        const tokens = tokenizeCql(query);
        const clause = getCursorClause(tokens, query.length);
        assert.equal(clause.kind, 'where-expr');
    });

    it('returns unknown after closing nested expand brace', () => {
        // Cursor is after the closing '}' of a nested expand block → unknown
        const query = 'SELECT FROM Books { author { name } ';
        const tokens = tokenizeCql(query);
        // Cursor at end: after closing inner '}', still inside outer '{'
        const clause = getCursorClause(tokens, query.length);
        assert.equal(clause.kind, 'select-item');
    });

    it('sets clause to unknown when outermost brace closes (braceDepth 1→0)', () => {
        // After the outer '}', braceDepth drops to 0 → clause becomes unknown
        const query = 'SELECT FROM Books { ID } ';
        const tokens = tokenizeCql(query);
        const clause = getCursorClause(tokens, query.length);
        assert.equal(clause.kind, 'unknown');
    });
});

// ---------------------------------------------------------------------------
// extractSourceRelations — non-identifier token flushes pendingEntity
// ---------------------------------------------------------------------------

describe('extractSourceRelations — punctuation flushes pendingEntity', () => {
    it('flushes pending entity when a punctuation token follows entity name', () => {
        const tokens = tokenizeCql('SELECT id FROM Books, Authors');
        const sig = tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'unknown');
        const sources = extractSourceRelations(sig);
        const names = sources.map((s) => s.entity);
        assert.ok(names.includes('Books'), 'Books must be a source');
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — doc annotation fallbacks and unresolved source filtering
// ---------------------------------------------------------------------------

describe('getSuggestions — doc annotation fallbacks', () => {
    it('returns field completion with @description as doc fallback', () => {
        const d = {
            Books: {
                kind: 'entity',
                elements: {
                    id: {
                        type: 'cds.UUID',
                        '@description': { val: 'The book ID' },
                    },
                },
            },
        };
        const q = 'SELECT  FROM Books';
        const cursor = 'SELECT '.length;
        const items = getSuggestions(q, cursor, d);
        const item = items.find((i) => i.label === 'id');
        assert.ok(item, 'expected id completion');
        assert.equal(item.doc, 'The book ID');
    });

    it('returns field completion with @title as doc fallback when no @description', () => {
        const d = {
            Books: {
                kind: 'entity',
                elements: {
                    id: { type: 'cds.UUID', '@title': { val: 'Identifier' } },
                },
            },
        };
        const q = 'SELECT  FROM Books';
        const cursor = 'SELECT '.length;
        const items = getSuggestions(q, cursor, d);
        const item = items.find((i) => i.label === 'id');
        assert.ok(item, 'expected id completion');
        assert.equal(item.doc, 'Identifier');
    });

    it('filters out unresolvable sources silently', () => {
        const d = {
            Books: { kind: 'entity', elements: { id: { type: 'cds.UUID' } } },
        };
        const q = 'SELECT  FROM NoSuchEntity';
        const cursor = 'SELECT '.length;
        const items = getSuggestions(q, cursor, d);
        assert.equal(items.filter((i) => i.kind !== 'keyword').length, 0, 'no field items when source cannot be resolved');
    });
});

// ---------------------------------------------------------------------------
// validateCqlQuery — AS alias and ORDER BY coverage
// ---------------------------------------------------------------------------

describe('validateCqlQuery — AS alias and ORDER BY', () => {
    it('accepts alias defined with AS without false positives', () => {
        const d = {
            Books: {
                kind: 'entity',
                elements: {
                    id: { type: 'cds.UUID' },
                    title: { type: 'cds.String' },
                },
            },
        };
        const errs = validateCqlQuery('SELECT b.id FROM Books AS b ORDER BY b.id', d);
        assert.equal(errs.length, 0, 'no errors for valid aliased query with ORDER BY');
    });

    it('reports unknown field in ORDER BY clause', () => {
        const d = {
            Books: { kind: 'entity', elements: { id: { type: 'cds.UUID' } } },
        };
        const errs = validateCqlQuery('SELECT id FROM Books ORDER BY missingField', d);
        assert.ok(
            errs.some((e) => e.message.includes('missingField')),
            'must flag unknown field in ORDER BY',
        );
    });
});

// ---------------------------------------------------------------------------
// getTokenContext — identifier not in significant tokens
// ---------------------------------------------------------------------------

describe('getTokenContext — identifier not in significant (string token at cursor)', () => {
    it('returns unknown context when token at cursor is a string (not in significant)', () => {
        // A string token is filtered out of significant, so tokIdx will be -1
        const query = "SELECT 'hello' FROM Books";
        const cursorInsideString = query.indexOf("'hello'") + 3;
        const result = getTokenContext(query, cursorInsideString, {});
        assert.equal(result, null, 'no context for cursor inside a string literal');
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — from-source with sub-qualified entity names (dot in localName)
// ---------------------------------------------------------------------------

describe('getSuggestions — from-source skips deeply nested FQN', () => {
    it('skips entity whose localName contains a dot (sub-namespace)', () => {
        const d = {
            'Svc.Books.Edition': { kind: 'entity', elements: {} },
            'Svc.Books': { kind: 'entity', elements: {} },
        };
        const q = 'SELECT id FROM ';
        const items = getSuggestions(q, q.length, d, 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('Books'), 'Books (no sub-dot) must appear');
        assert.ok(!labels.includes('Books.Edition'), 'Books.Edition (sub-dot) must be skipped');
    });
});

// ---------------------------------------------------------------------------
// validateCqlQuery — star token flushes pendingEntity in collectFromSourceTokens
// and end-of-tokens pendingEntity flush
// ---------------------------------------------------------------------------

describe('validateCqlQuery — star and end-of-tokens pendingEntity flush', () => {
    it('handles SELECT * FROM entity correctly', () => {
        const d = {
            Books: { kind: 'entity', elements: { id: { type: 'cds.UUID' } } },
        };
        const errs = validateCqlQuery('SELECT * FROM Books', d);
        assert.equal(errs.length, 0, 'SELECT * FROM Books must have no errors');
    });

    it('handles query where entity is the last token', () => {
        const d = {
            Books: { kind: 'entity', elements: { id: { type: 'cds.UUID' } } },
        };
        const errs = validateCqlQuery('SELECT id FROM Books', d);
        assert.equal(errs.length, 0, 'entity at end of token list must not cause errors');
    });

    it('validateCqlQuery detects ambiguous field across two joined entities', () => {
        const d = {
            Books: { kind: 'entity', elements: { id: { type: 'cds.UUID' } } },
            Authors: { kind: 'entity', elements: { id: { type: 'cds.UUID' } } },
        };
        const errs = validateCqlQuery('SELECT id FROM Books JOIN Authors ON Books.id = Authors.id', d);
        assert.ok(
            errs.some((e) => e.message.includes('Ambiguous')),
            'ambiguous id must be flagged',
        );
    });
});

// ---------------------------------------------------------------------------
// runWorkerMain — direct in-process tests
// ---------------------------------------------------------------------------

describe('runWorkerMain — direct invocation', () => {
    const repoRoot = join(__dirname, '..');

    function collect(results) {
        return (r) => results.push(r);
    }

    it('returns error when arguments are missing', async () => {
        const out = [];
        await runWorkerMain(undefined, undefined, undefined, undefined, collect(out));
        assert.equal(out[0]?.error, 'missing arguments');
    });

    it('returns error when projectRoot has no @sap/cds', async () => {
        // Disable the global-install fallback so this is deterministic regardless of
        // whether a global @sap/cds exists on the test machine.
        workerTestOverrides.globalRoots = () => [];
        try {
            const out = [];
            await runWorkerMain('/no-such-dir', 'SELECT id FROM Books', '7', '', collect(out));
            assert.ok(out[0]?.error, 'expected an error');
            assert.ok(out[0].error.includes('@sap/cds'), `expected @sap/cds error, got: ${out[0].error}`);
        } finally {
            delete workerTestOverrides.globalRoots;
        }
    });

    it('returns completions when @sap/cds is available and cursor >= 0', async () => {
        const out = [];
        await runWorkerMain(repoRoot, 'SELECT  FROM Books', '7', '', collect(out));
        // cds.load may fail (no .cds model) or succeed with empty completions — either way, no missing-args error
        assert.notEqual(out[0]?.error, 'missing arguments');
        assert.ok('completions' in (out[0] ?? {}) || 'error' in (out[0] ?? {}), 'expected completions or error key');
    });

    it('returns diagnostics when @sap/cds is available and cursor = -1', async () => {
        const out = [];
        await runWorkerMain(repoRoot, 'SELECT id FROM Books', '-1', '', collect(out));
        assert.notEqual(out[0]?.error, 'missing arguments');
        assert.ok('diagnostics' in (out[0] ?? {}) || 'error' in (out[0] ?? {}), 'expected diagnostics or error key');
    });
});

// ---------------------------------------------------------------------------
// runBatchWorkerMain — direct in-process tests
// ---------------------------------------------------------------------------

describe('runBatchWorkerMain — direct invocation', () => {
    const repoRoot = join(__dirname, '..');

    function collect(results) {
        return (r) => results.push(r);
    }

    it('returns error when arguments are missing', async () => {
        const out = [];
        await runBatchWorkerMain(undefined, undefined, collect(out));
        assert.ok(out[0]?.error, 'expected an error');
    });

    it('returns error for invalid JSON payload', async () => {
        const out = [];
        await runBatchWorkerMain('/proj', 'not-json', collect(out));
        assert.ok(out[0]?.error, 'expected an error');
    });

    it('returns error when projectRoot has no @sap/cds', async () => {
        workerTestOverrides.globalRoots = () => [];
        try {
            const out = [];
            await runBatchWorkerMain('/no-such-dir', JSON.stringify([{ entity: 'Books', prefix: '' }]), collect(out));
            assert.ok(out[0]?.error, 'expected an error');
            assert.ok(out[0].error.includes('@sap/cds'), `expected @sap/cds error, got: ${out[0].error}`);
        } finally {
            delete workerTestOverrides.globalRoots;
        }
    });

    it('returns fields map when @sap/cds is available', async () => {
        const out = [];
        await runBatchWorkerMain(repoRoot, JSON.stringify([{ entity: 'Books', prefix: '' }]), collect(out));
        assert.notEqual(out[0]?.error, 'missing arguments');
        assert.ok('fields' in (out[0] ?? {}), 'expected fields key in batch result');
    });
});

// ---------------------------------------------------------------------------
// parseCqlColumns
// ---------------------------------------------------------------------------

describe('parseCqlColumns', () => {
    it('returns null for SELECT *', () => {
        assert.equal(parseCqlColumns('SELECT * FROM Books'), null);
    });

    it('returns null for postfix SELECT * block', () => {
        assert.equal(parseCqlColumns('SELECT FROM Books { * }'), null);
    });

    it('parses flat classic columns', () => {
        const result = parseCqlColumns('SELECT ID, title FROM Books');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            { field: 'title', alias: 'title' },
        ]);
    });

    it('excludes the `one` singularizer keyword from the column list', () => {
        const result = parseCqlColumns('SELECT one ID, title FROM Books');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            { field: 'title', alias: 'title' },
        ]);
    });

    it('respects AS alias', () => {
        const result = parseCqlColumns('SELECT title AS t FROM Books');
        assert.deepEqual(result, [{ field: 'title', alias: 't' }]);
    });

    it('handles multi-line query with AS alias and bare identifiers on adjacent lines', () => {
        // Regression: `descr\ntitle AS bookTitle` must NOT treat `title` as an implicit alias of `descr`
        const q = 'SELECT\n  ID, descr\n  title AS bookTitle\n  ,localized\nFROM Books\nWHERE ID = 42';
        const result = parseCqlColumns(q);
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            { field: 'descr', alias: 'descr' },
            { field: 'title', alias: 'bookTitle' },
            { field: 'localized', alias: 'localized' },
        ]);
    });

    it('strips table prefix from qualified column', () => {
        const result = parseCqlColumns('SELECT B.title FROM Books AS B');
        assert.deepEqual(result, [{ field: 'title', alias: 'title' }]);
    });

    it('parses postfix-projection block', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID, title }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            { field: 'title', alias: 'title' },
        ]);
    });

    it('ignores the invalid FROM-before-SELECT ordering (flat list)', () => {
        // `FROM Entity SELECT …` is NOT valid CQL (SELECT must come first). The parser
        // does not attempt to parse it → no columns, type inference degrades to unknown.
        assert.deepEqual(parseCqlColumns('FROM AdminService.Authors SELECT books'), []);
        assert.deepEqual(parseCqlColumns('FROM Books SELECT ID, title AS t'), []);
    });

    it('ignores the invalid FROM-before-SELECT ordering (brace projection)', () => {
        assert.deepEqual(parseCqlColumns('FROM Books SELECT { ID, title }'), []);
        assert.deepEqual(parseCqlColumns('FROM AdminService.Books SELECT { genre, author { age } }'), []);
    });

    it('parses single-level expand block', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID, author { name } }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            {
                field: 'author',
                alias: 'author',
                expand: [{ field: 'name', alias: 'name' }],
            },
        ]);
    });

    it('parses nested expand block', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID, author { name, address { street } } }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            {
                field: 'author',
                alias: 'author',
                expand: [
                    { field: 'name', alias: 'name' },
                    {
                        field: 'address',
                        alias: 'address',
                        expand: [{ field: 'street', alias: 'street' }],
                    },
                ],
            },
        ]);
    });

    it('parses inline dot-expand syntax', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID, author.{ name } }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            {
                field: 'author',
                alias: 'author',
                expand: [{ field: 'name', alias: 'name' }],
            },
        ]);
    });

    it('returns empty array for query with no FROM', () => {
        assert.deepEqual(parseCqlColumns('SELECT ID'), []);
    });

    it('parses aliased expand block (assoc AS alias { … })', () => {
        // Regression: `address as residence { street }` must nest `street` under the
        // aliased association, not flatten `address`/`street` into sibling columns.
        const result = parseCqlColumns('SELECT FROM Authors { name, address as residence { street } }');
        assert.deepEqual(result, [
            { field: 'name', alias: 'name' },
            {
                field: 'address',
                alias: 'residence',
                expand: [{ field: 'street', alias: 'street' }],
            },
        ]);
    });

    it('parses deeply nested aliased expand blocks', () => {
        const result = parseCqlColumns('SELECT FROM Authors { address as residence { town as city { name } } }');
        assert.deepEqual(result, [
            {
                field: 'address',
                alias: 'residence',
                expand: [
                    {
                        field: 'town',
                        alias: 'city',
                        expand: [{ field: 'name', alias: 'name' }],
                    },
                ],
            },
        ]);
    });

    it('keeps AS alias flat when no expand block follows', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID, title as t }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            { field: 'title', alias: 't' },
        ]);
    });

    it('treats dot-non-brace inside brace block as ignored separator (both parts become fields)', () => {
        // author .name — dot (unknown token) is filtered before parseBraceBlock sees it;
        // both 'author' and 'name' become plain fields
        const result = parseCqlColumns('SELECT FROM Books { author .name }');
        assert.deepEqual(result, [
            { field: 'author', alias: 'author' },
            { field: 'name', alias: 'name' },
        ]);
    });

    it('parses space-separated dot-expand (author .{ name })', () => {
        // dot (unknown) is filtered; 'author' is followed directly by '{' → expand block
        const result = parseCqlColumns('SELECT FROM Books { ID, author .{ name } }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            {
                field: 'author',
                alias: 'author',
                expand: [{ field: 'name', alias: 'name' }],
            },
        ]);
    });

    it('parses AS alias inside brace block', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID AS myId, title AS t }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'myId' },
            { field: 'title', alias: 't' },
        ]);
    });

    it('returns null from parseBraceBlock when block has no parseable items', () => {
        // A brace block containing only commas → result.length === 0 → null
        const result = parseCqlColumns('SELECT FROM Books { , }');
        assert.equal(result, null);
    });

    it('returns null from parseBraceBlock when unterminated block has no items', () => {
        // Unterminated block with only a comma — hits end-of-tokens path with empty result
        const result = parseCqlColumns('SELECT FROM Books { ,');
        assert.equal(result, null);
    });

    it('parses an aggregate function column with AS alias as a single column', () => {
        const result = parseCqlColumns('SELECT max(ID) as ID FROM Books');
        assert.deepEqual(result, [{ field: 'max', alias: 'ID', func: 'max', arg: 'ID' }]);
    });

    it('parses count(*) with alias as a single column', () => {
        const result = parseCqlColumns('SELECT count(*) as n FROM Books');
        assert.deepEqual(result, [{ field: 'count', alias: 'n', func: 'count', arg: undefined }]);
    });

    it('names an unaliased function column after the function', () => {
        const result = parseCqlColumns('SELECT max(ID) FROM Books');
        assert.deepEqual(result, [{ field: 'max', alias: 'max', func: 'max', arg: 'ID' }]);
    });

    it('parses a multi-argument function column', () => {
        const result = parseCqlColumns('SELECT round(price, 2) as p FROM Books');
        assert.deepEqual(result, [{ field: 'round', alias: 'p', func: 'round', arg: 'price' }]);
    });

    it('parses a function column mixed with plain columns', () => {
        const result = parseCqlColumns('SELECT title, max(ID) as mx FROM Books');
        assert.deepEqual(result, [
            { field: 'title', alias: 'title' },
            { field: 'max', alias: 'mx', func: 'max', arg: 'ID' },
        ]);
    });

    it('parses a function column inside a postfix brace block', () => {
        const result = parseCqlColumns('SELECT FROM Books { ID, max(stock) as m }');
        assert.deepEqual(result, [
            { field: 'ID', alias: 'ID' },
            { field: 'max', alias: 'm', func: 'max', arg: 'stock' },
        ]);
    });

    it('tolerates an unbalanced function paren (consumes to end)', () => {
        // Missing ')' — skipBalancedParens consumes the rest; no crash, one column.
        const result = parseCqlColumns('SELECT max(ID FROM Books');
        assert.deepEqual(result, [{ field: 'max', alias: 'max', func: 'max', arg: undefined }]);
    });
});

// ---------------------------------------------------------------------------
// validateCqlQuery — expand blocks
// ---------------------------------------------------------------------------

describe('validateCqlQuery — expand blocks', () => {
    function expandDefs() {
        return {
            'Svc.Books': {
                kind: 'entity',
                elements: {
                    ID: { type: 'cds.UUID' },
                    title: { type: 'cds.String' },
                    author: { type: 'cds.Association', target: 'Svc.Authors' },
                },
            },
            'Svc.Authors': {
                kind: 'entity',
                elements: {
                    ID: { type: 'cds.UUID' },
                    name: { type: 'cds.String' },
                    address: {
                        type: 'cds.Association',
                        target: 'Svc.Addresses',
                    },
                },
            },
            'Svc.Addresses': {
                kind: 'entity',
                elements: {
                    street: { type: 'cds.String' },
                    city: { type: 'cds.String' },
                    country: { type: 'cds.Association', target: 'Svc.Countries' },
                },
            },
            'Svc.Countries': {
                kind: 'entity',
                elements: {
                    name: { type: 'cds.String' },
                    code: { type: 'cds.String' },
                },
            },
        };
    }

    it('accepts valid postfix projection', () => {
        assert.deepEqual(validateCqlQuery('SELECT FROM Books { ID, title }', expandDefs(), 'Svc'), []);
    });

    it('reports unknown field in postfix projection', () => {
        const errs = validateCqlQuery('SELECT FROM Books { ghost }', expandDefs(), 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('accepts valid expand block', () => {
        assert.deepEqual(validateCqlQuery('SELECT FROM Books { ID, author { name } }', expandDefs(), 'Svc'), []);
    });

    it('reports unknown field inside expand block', () => {
        const errs = validateCqlQuery('SELECT FROM Books { ID, author { ghost } }', expandDefs(), 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('accepts valid nested expand', () => {
        assert.deepEqual(validateCqlQuery('SELECT FROM Books { ID, author { name, address { street } } }', expandDefs(), 'Svc'), []);
    });

    it('reports unknown field in nested expand', () => {
        const errs = validateCqlQuery('SELECT FROM Books { ID, author { name, address { ghost } } }', expandDefs(), 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('tolerates missing lastIdentifier when opening nested expand brace', () => {
        // A '{' at braceDepth>0 with no preceding identifier (e.g. after a comma) —
        // expandArtifactStack.push(null) path. Should not throw.
        const errs = validateCqlQuery('SELECT FROM Books { ID, { name } }', expandDefs(), 'Svc');
        // Validation completes without throwing; result may contain errors for the anonymous block
        assert.ok(Array.isArray(errs));
    });

    // Inline-dot expand (`author.{ … }`) — the association head carries a trailing dot.
    it('accepts valid inline-dot expand', () => {
        assert.deepEqual(validateCqlQuery('SELECT FROM Books { ID, author.{ name } }', expandDefs(), 'Svc'), []);
    });

    it('reports unknown field inside inline-dot expand', () => {
        const errs = validateCqlQuery('SELECT FROM Books { author.{ ghost } }', expandDefs(), 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'));
    });

    it('does not flag the inline-dot association head as an unknown field', () => {
        // `author.` must not itself be reported as `Unknown field 'author.'`.
        const errs = validateCqlQuery('SELECT FROM Books { author.{ name } }', expandDefs(), 'Svc');
        assert.ok(!errs.some((e) => e.message.includes('author')), `author. must not be flagged, got: ${JSON.stringify(errs)}`);
    });

    it('accepts valid nested inline-dot expand', () => {
        assert.deepEqual(validateCqlQuery('SELECT FROM Books { author.{ name, address.{ street } } }', expandDefs(), 'Svc'), []);
    });

    it('reports unknown field in a depth-3 expand', () => {
        const errs = validateCqlQuery('SELECT FROM Books { author { address { country { ghost } } } }', expandDefs(), 'Svc');
        assert.equal(errs.length, 1);
        assert.ok(errs[0].message.includes('ghost'), `expected ghost flagged, got: ${JSON.stringify(errs)}`);
    });
});

// ---------------------------------------------------------------------------
// getSuggestions — expand cursor
// ---------------------------------------------------------------------------

describe('getSuggestions — expand cursor', () => {
    function expandDefs() {
        return {
            'Svc.Books': {
                kind: 'entity',
                elements: {
                    ID: { type: 'cds.UUID' },
                    title: { type: 'cds.String' },
                    author: { type: 'cds.Association', target: 'Svc.Authors' },
                },
            },
            'Svc.Authors': {
                kind: 'entity',
                elements: {
                    ID: { type: 'cds.UUID' },
                    name: { type: 'cds.String' },
                    address: {
                        type: 'cds.Association',
                        target: 'Svc.Addresses',
                    },
                },
            },
            'Svc.Addresses': {
                kind: 'entity',
                elements: {
                    street: { type: 'cds.String' },
                    city: { type: 'cds.String' },
                    country: { type: 'cds.Association', target: 'Svc.Countries' },
                },
            },
            'Svc.Countries': {
                kind: 'entity',
                elements: {
                    name: { type: 'cds.String' },
                    code: { type: 'cds.String' },
                },
            },
        };
    }

    it('suggests top-level fields in postfix block', () => {
        const q = 'SELECT FROM Books { ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('ID'), `expected ID in [${labels.join(',')}]`);
        assert.ok(labels.includes('title'), `expected title in [${labels.join(',')}]`);
        assert.ok(labels.includes('author'), `expected author in [${labels.join(',')}]`);
    });

    it('suggests target entity fields inside expand block', () => {
        const q = 'SELECT FROM Books { author { ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('name'), `expected name in [${labels.join(',')}]`);
        assert.ok(labels.includes('address'), `expected address in [${labels.join(',')}]`);
        assert.ok(!labels.includes('title'), 'did not expect Books.title in expand scope');
    });

    it('suggests nested target fields in double-nested expand', () => {
        const q = 'SELECT FROM Books { author { address { ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('street'), `expected street in [${labels.join(',')}]`);
        assert.ok(labels.includes('city'), `expected city in [${labels.join(',')}]`);
        assert.ok(!labels.includes('ID'), 'did not expect Books.ID in deep expand');
    });

    it('suggests target entity fields inside an aliased expand block', () => {
        // End-to-end: `author as writer { ` must resolve to the association `author`'s
        // target (Svc.Authors), not the alias `writer`, so its fields are suggested.
        const q = 'SELECT FROM Books { author as writer { ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('name'), `expected name in [${labels.join(',')}]`);
        assert.ok(labels.includes('address'), `expected address in [${labels.join(',')}]`);
        assert.ok(!labels.includes('title'), 'did not expect Books.title in aliased expand scope');
    });

    it('suggests nested target fields through aliased expands', () => {
        const q = 'SELECT FROM Books { author as writer { address as home { ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('street'), `expected street in [${labels.join(',')}]`);
        assert.ok(labels.includes('city'), `expected city in [${labels.join(',')}]`);
        assert.ok(!labels.includes('ID'), 'did not expect Books.ID in deep aliased expand');
    });

    it('retries clause detection when cursor is mid-identifier and initial clause is unknown', () => {
        // After closing '}' the clause is unknown; 'X' is an identifier at the cursor.
        // getSuggestions retries getCursorClause at X.start to find the real context.
        const defs = expandDefs();
        const q = 'SELECT FROM Books { ID } X';
        const items = getSuggestions(q, q.length, defs, 'Svc');
        assert.ok(Array.isArray(items));
    });

    it('suggests nested target fields in depth-3 expand', () => {
        const q = 'SELECT FROM Books { author { address { country { ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('name'), `expected Countries.name in [${labels.join(',')}]`);
        assert.ok(labels.includes('code'), `expected Countries.code in [${labels.join(',')}]`);
        assert.ok(!labels.includes('street'), 'did not expect Addresses.street at depth 3');
    });

    it('suggests target entity fields inside an inline-dot expand', () => {
        const q = 'SELECT FROM Books { author.{ ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('name'), `expected Authors.name in [${labels.join(',')}]`);
        assert.ok(labels.includes('address'), `expected Authors.address in [${labels.join(',')}]`);
        assert.ok(!labels.includes('title'), 'did not expect Books.title inside author expand');
    });

    it('suggests nested target fields in a double-nested inline-dot expand', () => {
        const q = 'SELECT FROM Books { author.{ address.{ ';
        const items = getSuggestions(q, q.length, expandDefs(), 'Svc');
        const labels = items.map((i) => i.label);
        assert.ok(labels.includes('street'), `expected Addresses.street in [${labels.join(',')}]`);
        assert.ok(labels.includes('city'), `expected Addresses.city in [${labels.join(',')}]`);
        assert.ok(!labels.includes('name'), 'did not expect Authors.name at inline-dot depth 2');
    });
});

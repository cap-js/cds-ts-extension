'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { scanFile, collectSourceFiles } = require('../cds-plugin');
const path = require('node:path');

// Minimal CsnDefs fixture — same shape as real compiled CSN definitions.
const DEFS = {
    'Svc.Books': {
        kind: 'entity',
        elements: {
            ID: { type: 'cds.UUID' },
            title: { type: 'cds.String' },
            stock: { type: 'cds.Integer' },
        },
    },
    'Svc.Authors': {
        kind: 'entity',
        elements: {
            ID: { type: 'cds.UUID' },
            name: { type: 'cds.String' },
        },
    },
};

// ---------------------------------------------------------------------------
// scanFile
// ---------------------------------------------------------------------------

describe('scanFile', () => {
    it('returns no diagnostics for a valid SELECT query', () => {
        const src = `
// @cds-service Svc
const books = await cds.ql\`SELECT ID, title FROM Books\`;
`;
        const diags = scanFile('test.js', src, DEFS);
        assert.deepEqual(diags, []);
    });

    it('returns a diagnostic for an unknown entity', () => {
        const src = `
// @cds-service Svc
const x = await cds.ql\`SELECT ID FROM NoSuchEntity\`;
`;
        const diags = scanFile('test.js', src, DEFS);
        assert.equal(diags.length, 1);
        assert.ok(diags[0].message.includes('NoSuchEntity'), `expected 'NoSuchEntity' in message: ${diags[0].message}`);
        assert.equal(diags[0].file, 'test.js');
        assert.ok(diags[0].line >= 1);
        assert.ok(diags[0].col >= 1);
    });

    it('returns a diagnostic for an unknown field', () => {
        const src = `
// @cds-service Svc
const x = await cds.ql\`SELECT ghost FROM Books\`;
`;
        const diags = scanFile('test.js', src, DEFS);
        assert.equal(diags.length, 1);
        assert.ok(diags[0].message.includes('ghost'), `expected 'ghost' in message: ${diags[0].message}`);
    });

    it('reports multiple diagnostics for multiple invalid queries', () => {
        const src = `
// @cds-service Svc
const a = await cds.ql\`SELECT bad FROM Books\`;
const b = await cds.ql\`SELECT ID FROM Ghost\`;
`;
        const diags = scanFile('test.js', src, DEFS);
        assert.equal(diags.length, 2);
    });

    it('validates a bare expression statement (no assignment)', () => {
        const src = `
// @cds-service Svc
await cds.ql\`SELECT ghost FROM Books\`;
`;
        const diags = scanFile('test.js', src, DEFS);
        assert.equal(diags.length, 1);
        assert.ok(diags[0].message.includes('ghost'), `expected 'ghost' in message: ${diags[0].message}`);
    });

    it('uses the per-statement @cds-service annotation for bare expression statements', () => {
        const src = `
// @cds-service Svc
const x = await cds.ql\`SELECT ID FROM Books\`;
// @cds-service Svc
await cds.ql\`SELECT ghost FROM Books\`;
`;
        const diags = scanFile('test.js', src, DEFS);
        assert.equal(diags.length, 1);
        assert.ok(diags[0].message.includes('ghost'));
    });

    it('returns no diagnostics when there are no cds.ql templates', () => {
        const src = 'const x = 1 + 2;';
        assert.deepEqual(scanFile('test.js', src, DEFS), []);
    });

    it('resolves fields without prefix when entity is fully qualified', () => {
        const src = 'const x = await cds.ql`SELECT ID FROM Svc.Books`;';
        assert.deepEqual(scanFile('test.js', src, DEFS), []);
    });

    it('reports correct line numbers', () => {
        const src = ['const a = 1;', 'const b = 2;', 'const c = await cds.ql`SELECT ghost FROM Books`;'].join('\n');
        // No @cds-service annotation — entity must be fully qualified or unknown.
        // With no prefix, 'Books' won't resolve, so we get an entity error.
        const diags = scanFile('test.js', src, DEFS);
        assert.ok(diags.length > 0);
        assert.equal(diags[0].line, 3);
    });
});

// ---------------------------------------------------------------------------
// collectSourceFiles
// ---------------------------------------------------------------------------

describe('collectSourceFiles', () => {
    it('finds .js and .ts files under a directory', () => {
        const files = collectSourceFiles(path.join(__dirname, '..', 'src'));
        assert.ok(files.length > 0, 'expected at least one source file');
        assert.ok(
            files.every((f) => f.endsWith('.js') || f.endsWith('.ts')),
            'unexpected file extension',
        );
    });

    it('excludes node_modules', () => {
        const root = path.join(__dirname, '..');
        const files = collectSourceFiles(root);
        assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules should be excluded');
    });

    it('returns empty array for a non-existent directory', () => {
        assert.deepEqual(collectSourceFiles('/no/such/path/xyz'), []);
    });
});

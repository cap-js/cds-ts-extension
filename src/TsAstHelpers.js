'use strict';

/** @typedef {import('typescript/lib/tsserverlibrary')} TS */

// `cds.ql`
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Expression} tag @returns {boolean} */
const isCdsQueryTag = (ts, tag) =>
    ts.isPropertyAccessExpression(tag) &&
    ts.isIdentifier(tag.expression) &&
    tag.expression.text === 'cds' &&
    ts.isIdentifier(tag.name) &&
    tag.name.text === 'ql';

// `const r = cds.ql`…``
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Expression} init @returns {init is import('typescript/lib/tsserverlibrary').TaggedTemplateExpression} */
const isCdsQlInit = (ts, init) =>
    ts.isTaggedTemplateExpression(init) && isCdsQueryTag(ts, init.tag);

// `a.b`  `a[b]`
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Node} n @returns {n is import('typescript/lib/tsserverlibrary').PropertyAccessExpression | import('typescript/lib/tsserverlibrary').ElementAccessExpression} */
const isMemberAccess = (ts, n) =>
    ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n);

// `a.b`  `a[b]`  `f()`
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Node} n @returns {n is import('typescript/lib/tsserverlibrary').PropertyAccessExpression | import('typescript/lib/tsserverlibrary').ElementAccessExpression | import('typescript/lib/tsserverlibrary').CallExpression} */
const isMemberOrCallAccess = (ts, n) =>
    isMemberAccess(ts, n) || ts.isCallExpression(n);

// `function f() {}`  `() => {}`  `class { m() {} }`  `<SourceFile>`
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Node} n @returns {boolean} */
const isScopeBoundary = (ts, n) =>
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    n.kind === ts.SyntaxKind.SourceFile;

// `const x = …`  (identifier name, has initializer)
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Node} n @returns {n is import('typescript/lib/tsserverlibrary').VariableDeclaration & { name: import('typescript/lib/tsserverlibrary').Identifier; initializer: import('typescript/lib/tsserverlibrary').Expression }} */
const isNamedVarDecl = (ts, n) =>
    ts.isVariableDeclaration(n) &&
    ts.isIdentifier(n.name) &&
    n.initializer !== undefined;

// `const x = …`  `const [x] = …`  (identifier or array-destructure name, has initializer)
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Node} n @returns {n is import('typescript/lib/tsserverlibrary').VariableDeclaration & { initializer: import('typescript/lib/tsserverlibrary').Expression }} */
const isDestructurableVarDecl = (ts, n) =>
    ts.isVariableDeclaration(n) &&
    (ts.isIdentifier(n.name) || ts.isArrayBindingPattern(n.name)) &&
    n.initializer !== undefined;

// `await expr`  →  unwrap to { expr, awaited: true }; otherwise  →  { expr: n, awaited: false }
/** @param {TS} ts @param {import('typescript/lib/tsserverlibrary').Expression} n @returns {{ expr: import('typescript/lib/tsserverlibrary').Expression; awaited: boolean }} */
const unwrapAwait = (ts, n) =>
    ts.isAwaitExpression(n)
        ? { expr: n.expression, awaited: true }
        : { expr: n, awaited: false };

// Walk up the parent chain and return the first node matching the predicate, or null.
/** @template {import('typescript/lib/tsserverlibrary').Node} T @param {import('typescript/lib/tsserverlibrary').Node} node @param {(n: import('typescript/lib/tsserverlibrary').Node) => n is T} predicate @returns {T | null} */
const findAncestor = (node, predicate) => {
    let cur = node.parent;
    while (cur) {
        if (predicate(cur)) return cur;
        cur = cur.parent;
    }
    return null;
};

module.exports = {
    isCdsQueryTag,
    isCdsQlInit,
    isMemberAccess,
    isMemberOrCallAccess,
    isScopeBoundary,
    isNamedVarDecl,
    isDestructurableVarDecl,
    unwrapAwait,
    findAncestor,
};

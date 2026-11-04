'use strict';
/**
 * CQL diagnostic code constants. Standalone so consumers that only need the
 * codes (tests, the plugin proxy) don't pull in the whole analysis engine.
 */

/** @typedef {import('./types').CqlDiagnosticCodeEnum} CqlDiagnosticCodeEnum */

const CqlDiagnosticCode = Object.freeze({
    UnknownEntity: 9001,
    UnknownSource: 9002,
    UnknownField: 9003,
    AmbiguousField: 9004,
});

module.exports = { CqlDiagnosticCode };

/**
 * Shared type declarations for the self-contained CQL core (`./cql/*`).
 * Type-only — no runtime module. Referenced via `import('./types').X`.
 */

import type { CsnArtifact, CsnDefs, CsnElement } from '../csn';

export type { CsnArtifact, CsnDefs, CsnElement };

export type CqlTokenKind = 'keyword' | 'identifier' | 'number' | 'string' | 'operator' | 'punctuation' | 'star' | 'whitespace' | 'unknown';

export interface CqlToken {
    kind: CqlTokenKind;
    value: string;
    start: number;
    end: number;
}

export interface ResolvedColumn {
    name: string;
    tsType: string;
}

export interface CompletionEntry {
    label: string;
    kind: 'field' | 'entity' | 'view' | 'keyword';
    detail: string;
    entity?: string;
    doc?: string;
    target?: string;
    toMany?: boolean;
}

/**
 * A column in a CQL projection — flat (no expand) or nested (expand block).
 * For a function-call column (`max(ID) as hi`), `func` is the lowercased
 * function name and `arg` is the single field argument (if any), used to infer
 * the result type.
 */
export interface ExpandColumn {
    field: string;
    alias: string;
    expand?: ExpandColumn[];
    func?: string;
    arg?: string;
}

export interface CqlDiagnosticCodeEnum {
    UnknownEntity: 9001;
    UnknownSource: 9002;
    UnknownField: 9003;
    AmbiguousField: 9004;
}

export interface CqlDiagnostic {
    message: string;
    start: number;
    end: number;
    code: number;
}

export interface CqlSource {
    entity: string;
    ref: string;
}

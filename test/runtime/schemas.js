'use strict';
/**
 * The assertion vocabulary: each zod schema encodes one assumption that
 * `src/cql/csn-resolve.js` makes, expressed as a comparison between the plugin's
 * hand-coded output and the runtime ground truth from `oracle.js`. A failed
 * `.parse()` / `.refine()` IS the test failure — it means an assumption has
 * drifted from real CDS behaviour.
 */

const { z } = require('zod');

/**
 * `cdsTypeToTs` claim vs. the live JS `typeof` of a round-tripped value.
 * `tsClaim` may be a union (`'string | number'` for the Int64/Decimal families,
 * which CAP serializes per `ieee754compatible`) — the live typeof must be one of
 * its members. `unknown` is a permitted escape hatch (the plugin declining to
 * map a type is never "wrong", only less precise).
 */
const TypeMapClaim = z
    .object({
        element: z.string(),
        cdsType: z.string(),
        tsClaim: z.string(),
        liveTypeof: z.enum(['string', 'number', 'boolean', 'object', 'undefined']),
    })
    .refine(
        (c) => {
            const members = c.tsClaim.split('|').map((s) => s.trim());
            return members.includes('unknown') || members.includes(c.liveTypeof);
        },
        (c) => ({ message: `cdsTypeToTs('${c.cdsType}')='${c.tsClaim}' does not include live typeof '${c.liveTypeof}' for ${c.element}` }),
    );

/**
 * `elementNamesWithForeignKeys` claim: every synthesized FK name (for a managed
 * association) must appear as a real element in the odata flavor AND as a real
 * physical column in the SQL DDL. Conversely, unmanaged associations must NOT
 * synthesize a column — guarded by `unmanagedFks` being empty.
 */
const FkSynthesisClaim = z
    .object({
        entity: z.string(),
        synthesizedFks: z.array(z.string()), // names NOT already own-elements, from elementNamesWithForeignKeys
        odataElements: z.array(z.string()),
        sqlColumns: z.array(z.string()),
        unmanagedFks: z.array(z.string()), // synthesized names that are actually unmanaged -> must be empty
    })
    .refine(
        (c) => c.unmanagedFks.length === 0,
        (c) => ({
            message: `${c.entity}: synthesized FK(s) for unmanaged association(s): ${c.unmanagedFks.join(', ')}`,
        }),
    )
    .refine(
        (c) => c.synthesizedFks.every((fk) => c.odataElements.includes(fk)),
        (c) => ({ message: `${c.entity}: synthesized FK not present in odata elements (${c.synthesizedFks.join(', ')} vs ${c.odataElements.join(', ')})` }),
    )
    .refine(
        (c) => c.synthesizedFks.every((fk) => c.sqlColumns.includes(fk)),
        (c) => ({ message: `${c.entity}: synthesized FK not present in SQL columns (${c.synthesizedFks.join(', ')} vs ${c.sqlColumns.join(', ')})` }),
    );

/**
 * `isToMany` claim vs. the shape of a live expand result: a to-many expand must
 * return an array, a to-one expand an object (or null).
 */
const CardinalityClaim = z
    .object({
        entity: z.string(),
        element: z.string(),
        isToManyClaim: z.boolean(),
        liveExpandIsArray: z.boolean(),
    })
    .refine(
        (c) => c.isToManyClaim === c.liveExpandIsArray,
        (c) => ({
            message: `${c.entity}.${c.element}: isToMany=${c.isToManyClaim} but live expand ${c.liveExpandIsArray ? 'IS' : 'is NOT'} an array`,
        }),
    );

/**
 * `resolveSource` `.drafts` stripping: a draft-enabled entity must NOT have a
 * materialized `<Entity>.drafts` shadow in any compiled flavor (it is generated
 * at runtime), which is why stripping `.drafts` and resolving the base is correct.
 */
const DraftShadowClaim = z
    .object({
        draftEntity: z.string(),
        rawHasDraftShadow: z.boolean(),
        odataHasDraftShadow: z.boolean(),
    })
    .refine(
        (c) => !(c.rawHasDraftShadow || c.odataHasDraftShadow),
        (c) => ({
            message: `${c.draftEntity}: a '.drafts' shadow was materialized in a compiled flavor — .drafts stripping assumption is invalid`,
        }),
    );

/**
 * `followAssocPath` claim: for a managed association the `target` is read from
 * the raw element, and the FK element in the odata flavor carries the
 * `@odata.foreignKey4` annotation that points back at the association. Asserts
 * both reads land where the code expects them.
 */
const AssocPathClaim = z
    .object({
        entity: z.string(),
        assoc: z.string(),
        rawTarget: z.string().nullable(),
        expectedTarget: z.string(),
        odataFkAnnotationPresent: z.boolean(),
    })
    .refine(
        (c) => c.rawTarget === c.expectedTarget,
        (c) => ({
            message: `${c.entity}.${c.assoc}: raw target '${c.rawTarget}' != expected '${c.expectedTarget}'`,
        }),
    )
    .refine(
        (c) => c.odataFkAnnotationPresent,
        (c) => ({
            message: `${c.entity}.${c.assoc}: no @odata.foreignKey4 annotation found on the odata FK element`,
        }),
    );

/**
 * `resolveBaseType` claim: a user-defined type alias resolves through the `defs`
 * chain to its primitive `cds.*` base.
 */
const BaseTypeClaim = z
    .object({
        alias: z.string(),
        resolvedBase: z.string(),
        expectedBase: z.string(),
    })
    .refine(
        (c) => c.resolvedBase === c.expectedBase,
        (c) => ({
            message: `resolveBaseType('${c.alias}')='${c.resolvedBase}' != expected '${c.expectedBase}'`,
        }),
    );

/** Live to-many expand row: `books` must be an array of child objects. */
const ToManyExpandRow = z.object({
    ID: z.number(),
    books: z.array(z.object({ ID: z.number(), title: z.string() })),
});

/** Live to-one expand row: `author` must be a nullable nested object. */
const ToOneExpandRow = z.object({
    ID: z.number(),
    author: z.object({ ID: z.number(), name: z.string() }).nullable(),
});

/** Live aggregate row: `count(*) as n` returns a numeric `n`. */
const AggregateRow = z.object({ n: z.number() });

module.exports = {
    TypeMapClaim,
    FkSynthesisClaim,
    CardinalityClaim,
    DraftShadowClaim,
    AssocPathClaim,
    BaseTypeClaim,
    ToManyExpandRow,
    ToOneExpandRow,
    AggregateRow,
};

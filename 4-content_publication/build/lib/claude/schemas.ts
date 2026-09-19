/**
 * Structured-output schemas.
 *
 * THE CONSTRAINT THAT SHAPES ALL OF THESE: output_config.format supports
 * neither `minLength`/`maxLength` nor `minimum`/`maximum`, and no recursion,
 * and `additionalProperties` must be false.
 *
 * So a schema CANNOT say "the X post is at most 280 characters" or "this
 * score is between 1 and 5". It will happily hand back a 312-character post
 * and a score of 9. Two consequences, both load-bearing:
 *
 *   - every length, count and range rule lives in lib/gates/tier0, in code;
 *   - scores are declared as enum [1,2,3,4,5], which IS supported.
 *
 * These schemas are FROZEN and versioned by EVAL_SCHEMA_VERSION. Compiled
 * grammars are cached for 24h and invalidated when the schema changes, so an
 * edit per request would make every call pay grammar-compilation latency.
 */

const SCORE = { type: 'integer', enum: [1, 2, 3, 4, 5] } as const;

export const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['relevance', 'authority', 'is_comparable', 'excerpts'],
  properties: {
    relevance: SCORE,
    authority: SCORE,
    /** Is this a competing article on the same topic? Feeds the B-5 depth band. */
    is_comparable: { type: 'boolean' },
    excerpts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'char_start', 'char_end', 'reason'],
        properties: {
          text: { type: 'string' },
          char_start: { type: 'integer' },
          char_end: { type: 'integer' },
          reason: { type: 'string' },
        },
      },
    },
  },
} as const;

export const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['angles'],
  properties: {
    angles: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'thesis', 'primary_keyword', 'keyword_class',
                   'secondary_keywords', 'outline', 'supporting_excerpts'],
        properties: {
          title: { type: 'string' },
          thesis: { type: 'string' },
          primary_keyword: { type: 'string' },
          /**
           * Ahrefs: target TOPICAL long-tails. A SUPPORTING long-tail belongs
           * inside a broader article, and building a 3,000-word piece around
           * one is the thin-content mistake — so it is caught here, at
           * planning time, before the expensive call.
           */
          keyword_class: { type: 'string', enum: ['topical', 'supporting', 'head'] },
          secondary_keywords: { type: 'array', items: { type: 'string' } },
          outline: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['heading', 'covers'],
              properties: {
                heading: { type: 'string' },
                covers: { type: 'string' },
              },
            },
          },
          supporting_excerpts: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'sections'],
  properties: {
    title: { type: 'string' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['heading', 'body', 'cites'],
        properties: {
          heading: { type: 'string' },
          /** Markdown. Claims carry their excerpt label inline as [S3P7]. */
          body: { type: 'string' },
          cites: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

export const CHANNEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['body'],
  properties: {
    body: { type: 'string' },
    /** Newsletter only; ignored elsewhere. */
    subject_line: { type: 'string' },
  },
} as const;

export const JUDGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria', 'overall'],
  properties: {
    overall: { type: 'string', enum: ['pass', 'revise', 'reject'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterion', 'score', 'verdict', 'evidence', 'required_action'],
        properties: {
          criterion: {
            type: 'string',
            enum: ['topic_relevance', 'source_grounding', 'factual_consistency',
                   'audience_fit', 'tone'],
          },
          score: SCORE,
          verdict: { type: 'string', enum: ['pass', 'revise', 'fail'] },
          /** A bare number cannot drive a targeted revision. */
          evidence: { type: 'string' },
          required_action: { type: 'string' },
        },
      },
    },
  },
} as const;

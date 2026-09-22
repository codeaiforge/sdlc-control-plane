import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertSchemaSupported, validateAgainstSchema } from './openapi-schema.mjs';

// The synthetic schemas below are not the published contract; they exist so each keyword is
// exercised on its own. The published document is then held to the same checker at the bottom
// of this file, because a checker that only ever sees toy input proves nothing about it.
const empty = { components: { schemas: {} } };

const person = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    age: { type: 'integer' },
    tags: { type: 'array', minItems: 1, items: { type: 'string' } },
    address: {
      type: 'object',
      required: ['city'],
      properties: { city: { type: 'string' } },
    },
  },
};

const validate = (value, schema = person, document = empty) =>
  validateAgainstSchema(value, schema, document);

test('a missing required property is reported by name', () => {
  const { ok, errors } = validate({ age: 3 });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['missing required property "name"']);
});

test('a wrong type reports the path, the expected type and the observed one', () => {
  const { ok, errors } = validate({ name: 7 });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['name: expected string, got number']);
});

test('integer rejects a fractional number', () => {
  assert.deepEqual(validate({ name: 'a', age: 3.5 }).errors, ['age: expected integer, got number']);
});

test('integer accepts a whole number', () => {
  assert.deepEqual(validate({ name: 'a', age: 3 }), { ok: true, errors: [] });
});

test('an enum violation lists the values the document allows', () => {
  const schema = { type: 'string', enum: ['accepted', 'rejected'] };
  const { ok, errors } = validate('maybe', schema);
  assert.equal(ok, false);
  assert.deepEqual(errors, ['expected one of ["accepted","rejected"], got "maybe"']);
});

test('additionalProperties false rejects an undeclared property', () => {
  const { ok, errors } = validate({ name: 'a', nickname: 'b' });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['unexpected property "nickname"']);
});

test('additionalProperties true accepts an undeclared property', () => {
  const open = { ...person, additionalProperties: true };
  assert.deepEqual(validate({ name: 'a', nickname: 'b' }, open), { ok: true, errors: [] });
});

test('an absent additionalProperties is open, which is what additive tolerance needs', () => {
  const { additionalProperties, ...unspecified } = person;
  assert.equal(additionalProperties, false);
  assert.deepEqual(validate({ name: 'a', nickname: 'b' }, unspecified), { ok: true, errors: [] });
});

test('an items violation reports the offending index', () => {
  const { ok, errors } = validate({ name: 'a', tags: ['x', 2] });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['tags[1]: expected string, got number']);
});

test('minLength rejects a string shorter than the document allows', () => {
  assert.deepEqual(validate({ name: '' }).errors, ['name: expected minLength 1, got length 0']);
});

test('minItems rejects an array shorter than the document allows', () => {
  assert.deepEqual(validate({ name: 'a', tags: [] }).errors, ['tags: expected minItems 1, got 0']);
});

test('a nested violation carries the full two-level path', () => {
  const { ok, errors } = validate({ name: 'a', address: { city: 9 } });
  assert.equal(ok, false);
  assert.deepEqual(errors, ['address.city: expected string, got number']);
});

test('errors accumulate instead of stopping at the first', () => {
  const { ok, errors } = validate({ name: '', age: 3.5 });
  assert.equal(ok, false);
  assert.equal(errors.length, 2);
  assert.deepEqual(errors, [
    'name: expected minLength 1, got length 0',
    'age: expected integer, got number',
  ]);
});

test('a local $ref resolves against the document it was given', () => {
  const document = { components: { schemas: { Name: { type: 'string', minLength: 1 } } } };
  const schema = {
    type: 'object',
    required: ['name'],
    properties: { name: { $ref: '#/components/schemas/Name' } },
  };
  assert.deepEqual(validate({ name: 'a' }, schema, document), { ok: true, errors: [] });
  assert.deepEqual(validate({ name: '' }, schema, document).errors, [
    'name: expected minLength 1, got length 0',
  ]);
});

test('an unresolvable $ref throws rather than reporting a failing body', () => {
  assert.throws(
    () => validate({}, { $ref: '#/components/schemas/Missing' }),
    /unresolvable \$ref "#\/components\/schemas\/Missing"/,
  );
});

test('an unsupported keyword throws rather than being silently ignored', () => {
  assert.throws(
    () => validate({}, { oneOf: [{ type: 'object' }] }),
    /unsupported schema keyword "oneOf" at #/,
  );
});

test('a keyword sitting beside a $ref throws, because only the $ref would be honoured', () => {
  const document = { components: { schemas: { Name: { type: 'string' } } } };
  assert.throws(
    () => validate('a', { $ref: '#/components/schemas/Name', minLength: 3 }, document),
    /keyword "minLength" beside \$ref/,
  );
});

test('a $ref cycle throws instead of recurring forever', () => {
  const document = {
    components: {
      schemas: {
        A: { type: 'object', properties: { b: { $ref: '#/components/schemas/B' } } },
        B: { type: 'object', properties: { a: { $ref: '#/components/schemas/A' } } },
      },
    },
  };
  assert.throws(() => validate({}, { $ref: '#/components/schemas/A' }, document), /\$ref cycle/);
});

// Teeth against the real contract. The document is loaded by URL rather than imported so that
// the workspace's Nx-edge control, which reads import statements, sees exactly the dependencies
// this package declares.
const document = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const responseSchema = (path, method, status) =>
  document.paths[path][method].responses[String(status)].content['application/json'].schema;

test('every schema in the published document stays inside the supported subset', () => {
  for (const [name, schema] of Object.entries(document.components.schemas)) {
    assert.doesNotThrow(
      () => assertSchemaSupported(schema, document),
      `components.schemas.${name} uses a keyword this checker does not enforce`,
    );
  }
});

test('the documented 422 rejects a decision carrying no reasons', () => {
  const schema = responseSchema('/v1/evidence', 'post', 422);
  const { ok, errors } = validateAgainstSchema(
    { decision: { accepted: false, disposition: 'rejected' } },
    schema,
    document,
  );
  assert.equal(ok, false);
  assert.deepEqual(errors, ['decision: missing required property "reasons"']);
});

test('the documented 422 rejects a disposition the seam cannot produce', () => {
  const schema = responseSchema('/v1/evidence', 'post', 422);
  const { ok, errors } = validateAgainstSchema(
    { decision: { accepted: false, disposition: 'maybe', reasons: ['x'] } },
    schema,
    document,
  );
  assert.equal(ok, false);
  assert.deepEqual(errors, [
    'decision.disposition: expected one of ["rejected","needs-remediation"], got "maybe"',
  ]);
});

test('the documented 422 rejects an undeclared property on the decision', () => {
  const schema = responseSchema('/v1/evidence', 'post', 422);
  const { ok, errors } = validateAgainstSchema(
    { decision: { accepted: false, disposition: 'rejected', reasons: ['x'], retry_at: 'later' } },
    schema,
    document,
  );
  assert.equal(ok, false);
  assert.deepEqual(errors, ['decision: unexpected property "retry_at"']);
});

test('the documented 202 rejects a decision that is not an acceptance', () => {
  const schema = responseSchema('/v1/evidence', 'post', 202);
  const { ok, errors } = validateAgainstSchema(
    { decision: { accepted: false, disposition: 'accepted', policy_id: 'p@1', reasons: [] } },
    schema,
    document,
  );
  assert.equal(ok, false);
  assert.deepEqual(errors, ['decision.accepted: expected one of [true], got false']);
});

// Regression — Phase 4 review of task 1.1 found both lookups reachable through the
// prototype chain, which voided additionalProperties: false on ten of the twelve published
// schemas and turned a bad $ref into a permissive any-schema. Fixing without pinning would
// leave the next refactor free to reintroduce it.
test('a prototype key cannot slip past additionalProperties: false', () => {
  const schema = {
    type: 'object',
    properties: { a: { type: 'string' } },
    additionalProperties: false,
  };
  for (const key of [
    'constructor',
    'valueOf',
    'hasOwnProperty',
    'toString',
    'isPrototypeOf',
    '__proto__',
  ]) {
    const { ok, errors } = validateAgainstSchema({ a: 'x', [key]: 'pwned' }, schema, {});
    assert.equal(ok, false, `${key} was accepted as a known property`);
    assert.deepEqual(errors, [`unexpected property "${key}"`]);
  }
  assert.equal(validateAgainstSchema({ a: 'x' }, schema, {}).ok, true);
});

test('a prototype key is checked as a value when the schema does declare it', () => {
  const schema = {
    type: 'object',
    properties: { constructor: { type: 'string' } },
    additionalProperties: false,
  };
  assert.equal(validateAgainstSchema({ constructor: 'fine' }, schema, {}).ok, true);
  assert.deepEqual(validateAgainstSchema({ constructor: 7 }, schema, {}).errors, [
    'constructor: expected string, got number',
  ]);
});

test('a $ref naming a prototype member is unresolvable, not an any-schema', () => {
  const document = { components: { schemas: { Real: { type: 'string' } } } };
  for (const name of ['__proto__', 'constructor', 'toString']) {
    assert.throws(
      () => assertSchemaSupported({ $ref: `#/components/schemas/${name}` }, document),
      /unresolvable \$ref/,
      `${name} resolved instead of throwing`,
    );
  }
  assert.doesNotThrow(() => assertSchemaSupported({ $ref: '#/components/schemas/Real' }, document));
});

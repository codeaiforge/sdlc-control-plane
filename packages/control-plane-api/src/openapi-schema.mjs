// A deliberately small JSON Schema checker for the subset openapi.json is allowed to use.
//
// It is hand-rolled rather than delegated to a validator library because the control plane
// takes no dependency it does not need, and because the interesting property here is the
// opposite of leniency: every keyword the document uses must be one this checker actually
// enforces. A full validator would happily ignore a keyword it does not implement, which is
// how a document starts claiming constraints the seam never applies. Style follows
// packages/contracts/src/schema.mjs: {ok, errors}, no classes, errors accumulated.
//
// Two failure kinds, never collapsed:
//   - a body that diverges from the document RETURNS {ok: false, errors}
//   - a document that is malformed, unresolvable or beyond this subset THROWS
// The first is a fact about a request or a response. The second is a defect in the contract,
// and answering it with a soft `false` would let a broken document pass as a failing body.

const SUPPORTED_KEYWORDS = new Set([
  '$ref',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'minItems',
]);

// Annotations carry no constraint, so ignoring them is honest rather than lenient.
const ANNOTATION_KEYWORDS = new Set([
  'description',
  'title',
  'summary',
  'example',
  'examples',
  'default',
  'deprecated',
]);

const SUPPORTED_TYPES = new Set([
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
]);

const REF_PREFIX = '#/components/schemas/';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const typeOf = (value) => {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
};

const matchesType = (value, type) => {
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number';
  return typeOf(value) === type;
};

const at = (path, message) => (path === '' ? message : `${path}: ${message}`);

function resolveRef(ref, document, pointer) {
  if (
    typeof ref !== 'string' ||
    !ref.startsWith(REF_PREFIX) ||
    ref.includes('/', REF_PREFIX.length)
  )
    throw new Error(`unsupported $ref ${JSON.stringify(ref)} at ${pointer}`);
  const target = document?.components?.schemas?.[ref.slice(REF_PREFIX.length)];
  if (target === undefined)
    throw new Error(`unresolvable $ref ${JSON.stringify(ref)} at ${pointer}`);
  return target;
}

// `visited` is the chain of refs currently being followed, copied per branch: a schema may
// reference the same component from two places, but a schema that reaches itself is a cycle
// and there is no value this checker could terminate on.
export function assertSchemaSupported(schema, document, pointer = '#', visited = new Set()) {
  if (!isObject(schema)) throw new Error(`schema must be an object at ${pointer}`);
  const keywords = Object.keys(schema).filter((key) => !ANNOTATION_KEYWORDS.has(key));

  if (Object.hasOwn(schema, '$ref')) {
    for (const keyword of keywords) {
      if (keyword !== '$ref')
        throw new Error(`keyword ${JSON.stringify(keyword)} beside $ref at ${pointer}`);
    }
    if (visited.has(schema.$ref)) throw new Error(`$ref cycle at ${pointer} via ${schema.$ref}`);
    const target = resolveRef(schema.$ref, document, pointer);
    return assertSchemaSupported(target, document, schema.$ref, new Set([...visited, schema.$ref]));
  }

  for (const keyword of keywords) {
    if (!SUPPORTED_KEYWORDS.has(keyword))
      throw new Error(`unsupported schema keyword ${JSON.stringify(keyword)} at ${pointer}`);
  }
  if (Object.hasOwn(schema, 'type') && !SUPPORTED_TYPES.has(schema.type))
    throw new Error(`unsupported type ${JSON.stringify(schema.type)} at ${pointer}`);
  if (Object.hasOwn(schema, 'required') && !Array.isArray(schema.required))
    throw new Error(`required must be an array at ${pointer}`);
  if (Object.hasOwn(schema, 'enum') && !Array.isArray(schema.enum))
    throw new Error(`enum must be an array at ${pointer}`);
  if (
    Object.hasOwn(schema, 'additionalProperties') &&
    typeof schema.additionalProperties !== 'boolean'
  )
    throw new Error(`additionalProperties must be a boolean at ${pointer}`);
  if (Object.hasOwn(schema, 'properties') && !isObject(schema.properties))
    throw new Error(`properties must be an object at ${pointer}`);

  if (isObject(schema.properties)) {
    for (const [name, child] of Object.entries(schema.properties))
      assertSchemaSupported(child, document, `${pointer}/properties/${name}`, visited);
  }
  if (Object.hasOwn(schema, 'items'))
    assertSchemaSupported(schema.items, document, `${pointer}/items`, visited);
}

export function validateAgainstSchema(value, schema, document) {
  // The document is checked first and in full, so an unsupported keyword throws whether or not
  // the value happened to reach that branch. A checker whose strictness depended on the input
  // would be no guarantee at all.
  assertSchemaSupported(schema, document);
  const errors = [];
  check(value, schema, document, '', errors);
  return { ok: errors.length === 0, errors };
}

function check(value, schema, document, path, errors) {
  if (Object.hasOwn(schema, '$ref'))
    return check(value, resolveRef(schema.$ref, document, schema.$ref), document, path, errors);

  if (Object.hasOwn(schema, 'type') && !matchesType(value, schema.type)) {
    // The subtree stops here - nothing below can be meaningfully checked against a value of the
    // wrong shape - but sibling branches carry on accumulating.
    errors.push(at(path, `expected ${schema.type}, got ${typeOf(value)}`));
    return;
  }
  // enum members are compared with ===, so only primitive members are meaningful. The document
  // uses none other; a non-primitive member would fail closed rather than pass silently.
  if (Object.hasOwn(schema, 'enum') && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(
      at(path, `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`),
    );
  }
  if (
    Object.hasOwn(schema, 'minLength') &&
    typeof value === 'string' &&
    value.length < schema.minLength
  )
    errors.push(at(path, `expected minLength ${schema.minLength}, got length ${value.length}`));
  if (Object.hasOwn(schema, 'minItems') && Array.isArray(value) && value.length < schema.minItems)
    errors.push(at(path, `expected minItems ${schema.minItems}, got ${value.length}`));

  if (isObject(value)) checkObject(value, schema, document, path, errors);
  if (Array.isArray(value) && Object.hasOwn(schema, 'items')) {
    value.forEach((entry, index) =>
      check(entry, schema.items, document, `${path}[${index}]`, errors),
    );
  }
}

function checkObject(value, schema, document, path, errors) {
  const properties = isObject(schema.properties) ? schema.properties : {};
  for (const name of schema.required ?? []) {
    if (!Object.hasOwn(value, name)) errors.push(at(path, `missing required property "${name}"`));
  }
  for (const [name, entry] of Object.entries(value)) {
    const child = properties[name];
    if (child !== undefined) {
      check(entry, child, document, path === '' ? name : `${path}.${name}`, errors);
      continue;
    }
    // Absent additionalProperties means open, which is what an external contract needs and what
    // NFR-1.1 asks for; only an explicit false closes the shape.
    if (schema.additionalProperties === false)
      errors.push(at(path, `unexpected property "${name}"`));
  }
}

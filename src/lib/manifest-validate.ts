/**
 * Minimal JSON Schema 2020-12 validator targeted at the JECP manifest schema.
 *
 * Why hand-rolled rather than ajv: ajv adds ~250 KB to the SDK bundle and we
 * only need a focused subset of JSON Schema (the one our manifest uses).
 * Supports: type, required, pattern, enum, minLength/maxLength, minimum,
 * minItems/maxItems, items, properties, additionalProperties, $ref to
 * #/$defs/*, allOf.not.required (the composes/streaming xor in Action).
 *
 * Returns the same shape as the Hub's INPUT_SCHEMA_VIOLATION details.errors[]
 * so operators see consistent error messages whether they validate locally
 * (here) or hit the Hub. This is intentional: a Hub error you've seen before
 * is a Hub error you can fix.
 *
 * Ported from `@jecpdev/cli`'s `src/lib/manifest-validate.ts` (the canonical
 * implementation). v0.9.0 bundles the schema directly inside the SDK so
 * Provider-side TypeScript apps can validate a parsed manifest without
 * round-tripping to the Hub or depending on the CLI.
 */

import schema from '../schemas/manifest.schema.json';

export interface ValidationError {
  /** JSON Pointer into the instance (e.g. `/actions/0/pricing/base`). */
  instance_path: string;
  /** JSON Pointer into the schema (e.g. `/$defs/Pricing/properties/base/pattern`). */
  schema_path: string;
  /** Human-readable. Matches the Hub's wording when possible. */
  reason: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

interface SchemaNode {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  pattern?: string;
  enum?: unknown[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  items?: SchemaNode;
  $ref?: string;
  allOf?: Array<{ not?: { required?: string[] } }>;
  description?: string;
  default?: unknown;
  format?: string;
}

const rootSchema = schema as unknown as SchemaNode & {
  $defs?: Record<string, SchemaNode>;
};

/**
 * Validate a parsed manifest object against the bundled JECP manifest schema.
 *
 * Accepts already-parsed JSON (object form). For YAML, parse with your
 * preferred library (e.g. `js-yaml`) and pass the result here.
 *
 * @example
 *   import { validateManifest } from '@jecpdev/sdk';
 *   import yaml from 'js-yaml';
 *
 *   const parsed = yaml.load(readFileSync('jecp.yaml', 'utf-8'));
 *   const { valid, errors } = validateManifest(parsed);
 *   if (!valid) for (const e of errors) console.error(e.instance_path, e.reason);
 */
export function validateManifest(instance: unknown): ValidationResult {
  const errors: ValidationError[] = [];
  walk(instance, rootSchema, '', '#', errors);
  return { valid: errors.length === 0, errors };
}

function walk(
  value: unknown,
  node: SchemaNode,
  instancePath: string,
  schemaPath: string,
  errors: ValidationError[],
): void {
  // $ref — resolve relative to root #/$defs/...
  if (node.$ref) {
    const resolved = resolveRef(node.$ref);
    if (!resolved) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/$ref',
        reason: `unresolved $ref: ${node.$ref}`,
      });
      return;
    }
    walk(value, resolved, instancePath, schemaPath, errors);
    return;
  }

  // type check
  if (node.type) {
    const expected = Array.isArray(node.type) ? node.type : [node.type];
    if (!expected.some((t) => matchesType(value, t))) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/type',
        reason: `expected ${expected.join('|')}, got ${actualType(value)}`,
      });
      return; // further checks against this node are meaningless
    }
  }

  // enum
  if (node.enum && !node.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({
      instance_path: instancePath,
      schema_path: schemaPath + '/enum',
      reason: `value '${stringify(value)}' must be one of ${node.enum.map(stringify).join(', ')}`,
    });
  }

  // string-specific
  if (typeof value === 'string') {
    if (node.pattern && !new RegExp(node.pattern).test(value)) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/pattern',
        reason: `value '${value}' does not match pattern ${node.pattern}`,
      });
    }
    if (node.minLength !== undefined && value.length < node.minLength) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/minLength',
        reason: `string is ${value.length} chars, min is ${node.minLength}`,
      });
    }
    if (node.maxLength !== undefined && value.length > node.maxLength) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/maxLength',
        reason: `string is ${value.length} chars, max is ${node.maxLength}`,
      });
    }
  }

  // number-specific
  if (typeof value === 'number') {
    if (node.minimum !== undefined && value < node.minimum) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/minimum',
        reason: `value ${value} less than minimum ${node.minimum}`,
      });
    }
    if (node.maximum !== undefined && value > node.maximum) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/maximum',
        reason: `value ${value} greater than maximum ${node.maximum}`,
      });
    }
  }

  // array-specific
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/minItems',
        reason: `array has ${value.length} items, min is ${node.minItems}`,
      });
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) {
      errors.push({
        instance_path: instancePath,
        schema_path: schemaPath + '/maxItems',
        reason: `array has ${value.length} items, max is ${node.maxItems}`,
      });
    }
    if (node.items) {
      value.forEach((item, i) => {
        walk(item, node.items!, `${instancePath}/${i}`, schemaPath + '/items', errors);
      });
    }
  }

  // object-specific
  if (isPlainObject(value)) {
    // required
    if (node.required) {
      for (const key of node.required) {
        if (!(key in value)) {
          errors.push({
            instance_path: instancePath,
            schema_path: schemaPath + '/required',
            reason: `missing required field '${key}'`,
          });
        }
      }
    }
    // properties
    if (node.properties) {
      for (const [key, subSchema] of Object.entries(node.properties)) {
        if (key in value) {
          walk(
            (value as Record<string, unknown>)[key],
            subSchema,
            `${instancePath}/${key}`,
            schemaPath + '/properties/' + key,
            errors,
          );
        }
      }
    }
    // additionalProperties: false
    if (node.additionalProperties === false && node.properties) {
      const known = new Set(Object.keys(node.properties));
      for (const key of Object.keys(value)) {
        if (!known.has(key)) {
          errors.push({
            instance_path: instancePath,
            schema_path: schemaPath + '/additionalProperties',
            reason: `unknown property '${key}' (additionalProperties: false)`,
          });
        }
      }
    }
    // allOf — used for the composes/streaming xor invariant on Action
    if (node.allOf) {
      for (const sub of node.allOf) {
        if (sub.not?.required) {
          // not-required asserts the listed keys are NOT all present together
          const allPresent = sub.not.required.every((k) => k in value);
          if (allPresent) {
            errors.push({
              instance_path: instancePath,
              schema_path: schemaPath + '/allOf',
              reason: `fields [${sub.not.required.join(', ')}] cannot all be set together`,
            });
          }
        }
      }
    }
  }
}

function resolveRef(ref: string): SchemaNode | undefined {
  if (!ref.startsWith('#/$defs/')) return undefined;
  const name = ref.slice('#/$defs/'.length);
  return rootSchema.$defs?.[name];
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function actualType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number' && Number.isInteger(value)) return 'integer';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

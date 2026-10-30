import { registeredErrorClass } from "./errors";

export type DurableValue =
  | null
  | boolean
  | number
  | string
  | undefined
  | bigint
  | Date
  | Error
  | readonly DurableValue[]
  | ReadonlyMap<DurableValue, DurableValue>
  | ReadonlySet<DurableValue>
  | DurableObject;

export type DurableObject = { [key: string]: DurableValue };

/**
 * Compile-time check for a value that will be recorded. Unlike an index
 * signature, it accepts interfaces. Arrays and tuples keep their shape and
 * mutability, so `Durable<T>` can also type a recorded value. The codec still
 * validates every value at runtime.
 */
export type Durable<T> = T extends
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint
  | Date
  | Error
  ? T
  : T extends readonly (infer U)[]
  ? // Only tuples go through the mapped type. On a recursive array type such
    // as `DurableValue[]` it exceeds TypeScript's instantiation depth.
    number extends T["length"]
    ? T extends unknown[]
      ? Durable<U>[]
      : readonly Durable<U>[]
    : { [K in keyof T]: Durable<T[K]> }
  : T extends Map<infer K, infer V>
  ? Map<Durable<K>, Durable<V>>
  : T extends ReadonlyMap<infer K, infer V>
  ? ReadonlyMap<Durable<K>, Durable<V>>
  : T extends Set<infer U>
  ? Set<Durable<U>>
  : T extends ReadonlySet<infer U>
  ? ReadonlySet<Durable<U>>
  : T extends Function
  ? never
  : { [K in keyof T]: Durable<T[K]> };

/**
 * `unknown` when `T` is a durable value, and `Otherwise` when it is not.
 * Intersect a parameter with it to check a type inferred from the rest of
 * that parameter: the check takes no part in inference, so literal widening
 * and union inference are unchanged. `Otherwise` should restate the
 * parameter with `Durable<T>` in place of `T`, so the error names the
 * offending property.
 */
export type IfDurable<T, Otherwise> = [T] extends [Durable<T>] ? unknown : Otherwise;

export type DurableValueEncoding =
  | { status: "encoded"; canonical: string }
  | { status: "invalid"; message: string };

export type DurableDecoding =
  | { status: "decoded"; value: DurableValue }
  | { status: "invalid"; message: string };

export interface DurableValueCodec {
  /**
   * Validates `value` recursively and returns its canonical JSON: object keys
   * sorted by UTF-16 code unit and `-0` written as `0`, so equal values always
   * encode to the same string. `undefined`, `bigint`, `Date`, `Map`, `Set`,
   * errors and plain objects with an own `$type` key are written as tagged
   * objects. Map entries and set values keep their insertion order, so maps
   * or sets that differ only in order encode differently. Never throws for an
   * invalid value.
   */
  encode(value: unknown): DurableValueEncoding;

  /**
   * Reads an encoding back into the value that was encoded. Errors are revived
   * as the class registered under their `name`, without calling its
   * constructor. Never throws for an invalid encoding.
   */
  decode(canonical: string): DurableDecoding;
}

export class DurableValueError extends Error {}

export const durableValueCodec: DurableValueCodec = {
  encode(value) {
    try {
      return { status: "encoded", canonical: encodeValue(value, "$", new Set()) };
    } catch (err) {
      if (!(err instanceof DurableValueError)) throw err;
      return { status: "invalid", message: err.message };
    }
  },

  decode(canonical) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(canonical);
    } catch (err) {
      return { status: "invalid", message: `not JSON: ${(err as Error).message}` };
    }
    try {
      return { status: "decoded", value: decodeParsedValue(parsed) };
    } catch (err) {
      if (!(err instanceof DurableValueError)) throw err;
      return { status: "invalid", message: err.message };
    }
  },
};

/**
 * Encodes a thrown value: as thrown when it is a `DurableValue`, and as
 * `Error(String(value))` otherwise. Always succeeds.
 */
export function encodeThrownValue(value: unknown): string {
  const encoding = durableValueCodec.encode(value);
  if (encoding.status === "encoded") return encoding.canonical;
  let message: string;
  try {
    message = String(value);
  } catch {
    message = "Thrown value is not a durable value";
  }
  return encodeValue(new Error(message), "$", new Set());
}

/**
 * Whether `value` is an object with the default object prototype or `null`.
 * It says nothing about the object's properties.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const UNDEFINED_TAG = '{"$type":"undefined"}';

const ERROR_KEYS = new Set(["name", "message", "stack", "code", "cause"]);

function encodeValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "undefined":
      return UNDEFINED_TAG;
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return `{"$type":"bigint","value":"${value}"}`;
    case "number":
      if (!Number.isFinite(value)) {
        throw new DurableValueError(`${path}: ${value} is not a finite number`);
      }
      // JSON.stringify(-0) is "0".
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new DurableValueError(`${path}: ${typeof value} is not a durable value`);
  }

  // Only cycles are rejected: the same object may appear in sibling branches.
  if (ancestors.has(value)) {
    throw new DurableValueError(`${path}: reference cycle`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return encodeArray(value, path, ancestors);
    if (value instanceof Error) return encodeError(value, path, ancestors);
    if (value instanceof Date) return encodeDate(value, path);
    if (value instanceof Map) return encodeMap(value, path, ancestors);
    if (value instanceof Set) return encodeSet(value, path, ancestors);
    return encodeObject(value, path, ancestors);
  } finally {
    // Error encoding recovers from invalid properties, so the set must be
    // restored when a nested value throws.
    ancestors.delete(value);
  }
}

function encodeArray(value: unknown[], path: string, ancestors: Set<object>) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new DurableValueError(`${path}: arrays must not be subclassed`);
  }
  const items: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue;
    if (typeof key === "symbol") {
      throw new DurableValueError(`${path}: symbol properties are not durable`);
    }
    if (!isArrayIndex(key, value.length)) {
      throw new DurableValueError(`${path}.${key}: arrays must only have items`);
    }
  }
  for (let i = 0; i < value.length; i++) {
    const itemPath = `${path}[${i}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor) {
      throw new DurableValueError(`${itemPath}: missing array item`);
    }
    items.push(encodeValue(dataValue(descriptor, itemPath), itemPath, ancestors));
  }
  return `[${items.join(",")}]`;
}

function encodeDate(value: Date, path: string) {
  expectBuiltIn(value, Date.prototype, "dates", path);
  if (Number.isNaN(value.getTime())) {
    throw new DurableValueError(`${path}: invalid Date`);
  }
  return `{"$type":"date","value":${JSON.stringify(value.toISOString())}}`;
}

function encodeMap(
  value: Map<unknown, unknown>,
  path: string,
  ancestors: Set<object>
) {
  expectBuiltIn(value, Map.prototype, "maps", path);
  const entries: string[] = [];
  let i = 0;
  for (const [key, item] of value) {
    const entryPath = `${path}.entries[${i++}]`;
    const encodedKey = encodeValue(key, `${entryPath}[0]`, ancestors);
    entries.push(`[${encodedKey},${encodeValue(item, `${entryPath}[1]`, ancestors)}]`);
  }
  return `{"$type":"map","entries":[${entries.join(",")}]}`;
}

function encodeSet(value: Set<unknown>, path: string, ancestors: Set<object>) {
  expectBuiltIn(value, Set.prototype, "sets", path);
  const values: string[] = [];
  let i = 0;
  for (const item of value) {
    values.push(encodeValue(item, `${path}.values[${i++}]`, ancestors));
  }
  return `{"$type":"set","values":[${values.join(",")}]}`;
}

/**
 * Rejects subclasses and own properties, which the tag would not keep.
 */
function expectBuiltIn(value: object, proto: object, kind: string, path: string) {
  if (Object.getPrototypeOf(value) !== proto) {
    throw new DurableValueError(`${path}: ${kind} must not be subclassed`);
  }
  if (Reflect.ownKeys(value).length > 0) {
    throw new DurableValueError(`${path}: ${kind} must not have own properties`);
  }
}

function encodeObject(value: object, path: string, ancestors: Set<object>) {
  if (!isPlainObject(value)) {
    const name = Object.getPrototypeOf(value)?.constructor?.name ?? "object";
    throw new DurableValueError(`${path}: ${name} instances are not plain objects`);
  }
  const entries: [string, string][] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new DurableValueError(`${path}: symbol properties are not durable`);
    }
    const keyPath = `${path}[${JSON.stringify(key)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    entries.push([key, encodeValue(dataValue(descriptor, keyPath), keyPath, ancestors)]);
  }
  return objectLiteral(entries);
}

/**
 * Writes a plain object from encoded entries, wrapping it as
 * `{ $type: "object", value }` when it has its own `$type` key so that it can
 * never be read as a tag.
 */
function objectLiteral(entries: [string, string][]) {
  const literal = sortedLiteral(entries);
  return entries.some(([key]) => key === "$type")
    ? `{"$type":"object","value":${literal}}`
    : literal;
}

function sortedLiteral(entries: [string, string][]) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${sorted.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
}

/**
 * Tags an error with its name, message, string `stack` and `code`, its
 * `cause`, a non-enumerable `errors` array (as on `AggregateError`) and its
 * own enumerable fields. Properties that are not durable are left out rather
 * than rejecting the error.
 */
function encodeError(error: Error, path: string, ancestors: Set<object>) {
  const name = readProperty(error, "name");
  const message = readProperty(error, "message");
  const stack = readProperty(error, "stack");
  const code = readProperty(error, "code");
  const tag: [string, string][] = [
    ["$type", '"error"'],
    ["name", JSON.stringify(typeof name === "string" ? name : "Error")],
    ["message", JSON.stringify(typeof message === "string" ? message : "")],
  ];
  if (typeof stack === "string") tag.push(["stack", JSON.stringify(stack)]);
  if (typeof code === "string") tag.push(["code", JSON.stringify(code)]);

  if (Object.hasOwn(error, "cause")) {
    const cause = encodeOptional(readProperty(error, "cause"), `${path}.cause`, ancestors);
    if (cause !== undefined) tag.push(["cause", cause]);
  }

  const errors = Object.getOwnPropertyDescriptor(error, "errors");
  if (errors && !errors.enumerable && Array.isArray(errors.value)) {
    const encoded = encodeOptional(errors.value, `${path}.errors`, ancestors);
    if (encoded !== undefined) tag.push(["errors", encoded]);
  }

  const fields: [string, string][] = [];
  for (const key of Object.keys(error)) {
    if (ERROR_KEYS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!;
    if (!("value" in descriptor)) continue;
    const encoded = encodeOptional(descriptor.value, `${path}.${key}`, ancestors);
    if (encoded !== undefined) fields.push([key, encoded]);
  }
  if (fields.length > 0) tag.push(["fields", objectLiteral(fields)]);

  return sortedLiteral(tag);
}

function encodeOptional(value: unknown, path: string, ancestors: Set<object>) {
  try {
    return encodeValue(value, path, ancestors);
  } catch (err) {
    if (!(err instanceof DurableValueError)) throw err;
    return undefined;
  }
}

function readProperty(error: Error, key: string): unknown {
  try {
    return (error as unknown as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** Reads a property without invoking accessors. */
function dataValue(descriptor: PropertyDescriptor, path: string) {
  if (!("value" in descriptor)) {
    throw new DurableValueError(`${path}: accessor properties are not durable`);
  }
  if (!descriptor.enumerable) {
    throw new DurableValueError(`${path}: non-enumerable properties are not durable`);
  }
  return descriptor.value;
}

function isArrayIndex(key: string, length: number) {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

/**
 * Decodes a value already parsed from an encoding's JSON, so that adapters can
 * embed encodings in a larger JSON document. Throws `DurableValueError` for an
 * invalid encoding.
 */
export function decodeParsedValue(parsed: unknown, path = "$"): DurableValue {
  if (parsed === null) return null;
  switch (typeof parsed) {
    case "boolean":
    case "string":
      return parsed;
    case "number":
      if (!Number.isFinite(parsed)) {
        throw new DurableValueError(`${path}: ${parsed} is not a finite number`);
      }
      return parsed;
    case "object":
      break;
    default:
      throw new DurableValueError(`${path}: ${typeof parsed} is not a durable value`);
  }
  if (Array.isArray(parsed)) {
    return parsed.map((item, i) => decodeParsedValue(item, `${path}[${i}]`));
  }
  const object = parsed as Record<string, unknown>;
  if (!Object.hasOwn(object, "$type")) return decodeObject(object, path);

  switch (object.$type) {
    case "undefined":
      expectKeys(object, path, ["$type"], []);
      return undefined;
    case "object": {
      expectKeys(object, path, ["$type", "value"], []);
      const value = object.value;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new DurableValueError(`${path}.value: a wrapped object must be an object`);
      }
      return decodeObject(value as Record<string, unknown>, `${path}.value`);
    }
    case "bigint":
      return decodeBigInt(object, path);
    case "date":
      return decodeDate(object, path);
    case "map":
      return decodeMap(object, path);
    case "set":
      return decodeSet(object, path);
    case "error":
      return decodeError(object, path);
    default:
      throw new DurableValueError(`${path}: unknown $type ${JSON.stringify(object.$type)}`);
  }
}

function decodeBigInt(tag: Record<string, unknown>, path: string): bigint {
  expectKeys(tag, path, ["$type", "value"], []);
  const { value } = tag;
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value) || value === "-0") {
    throw new DurableValueError(`${path}.value: must be an integer string`);
  }
  return BigInt(value);
}

function decodeDate(tag: Record<string, unknown>, path: string): Date {
  expectKeys(tag, path, ["$type", "value"], []);
  const { value } = tag;
  const date = typeof value === "string" ? new Date(value) : undefined;
  // Only the string toISOString writes is accepted, so that every date has
  // one encoding.
  if (!date || Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new DurableValueError(`${path}.value: must be an ISO 8601 date string`);
  }
  return date;
}

function decodeMap(
  tag: Record<string, unknown>,
  path: string
): Map<DurableValue, DurableValue> {
  expectKeys(tag, path, ["$type", "entries"], []);
  const entries = expectArray(tag.entries, `${path}.entries`);
  const map = new Map<DurableValue, DurableValue>();
  entries.forEach((entry, i) => {
    const entryPath = `${path}.entries[${i}]`;
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new DurableValueError(`${entryPath}: must be a [key, value] pair`);
    }
    map.set(
      decodeParsedValue(entry[0], `${entryPath}[0]`),
      decodeParsedValue(entry[1], `${entryPath}[1]`)
    );
  });
  if (map.size !== entries.length) {
    throw new DurableValueError(`${path}.entries: duplicate keys`);
  }
  return map;
}

function decodeSet(tag: Record<string, unknown>, path: string): Set<DurableValue> {
  expectKeys(tag, path, ["$type", "values"], []);
  const values = expectArray(tag.values, `${path}.values`);
  const set = new Set(
    values.map((item, i) => decodeParsedValue(item, `${path}.values[${i}]`))
  );
  if (set.size !== values.length) {
    throw new DurableValueError(`${path}.values: duplicate values`);
  }
  return set;
}

function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DurableValueError(`${path}: must be an array`);
  }
  return value;
}

function decodeObject(object: Record<string, unknown>, path: string): DurableObject {
  const decoded: DurableObject = {};
  for (const key of Object.keys(object)) {
    // Defined rather than assigned, so an own `__proto__` key stays data.
    Object.defineProperty(decoded, key, {
      value: decodeParsedValue(object[key], `${path}[${JSON.stringify(key)}]`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return decoded;
}

function decodeError(tag: Record<string, unknown>, path: string): Error {
  expectKeys(
    tag,
    path,
    ["$type", "name", "message"],
    ["stack", "code", "cause", "errors", "fields"]
  );
  const { name, message, stack, code } = tag;
  for (const [key, value, optional] of [
    ["name", name, false],
    ["message", message, false],
    ["stack", stack, true],
    ["code", code, true],
  ] as const) {
    if (typeof value !== "string" && !(optional && value === undefined)) {
      throw new DurableValueError(`${path}.${key}: must be a string`);
    }
  }

  const errorClass = registeredErrorClass(name as string) ?? Error;
  // Constructing a base Error with the class as new.target gives a native error
  // (one `Error.isError` accepts) with the class's prototype, without calling
  // the class's constructor, which may require arguments or have side effects.
  const error: Error = Reflect.construct(Error, [], errorClass);
  const hidden = (key: string, value: unknown) =>
    Object.defineProperty(error, key, {
      value,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  const visible = (key: string, value: unknown) =>
    Object.defineProperty(error, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });

  // Classes that inherit their name have it set in the constructor, which
  // makes it an own enumerable property.
  if (error.name !== name) visible("name", name);
  hidden("message", message);
  // Otherwise the stack captured here would stand in for the original.
  if (stack !== undefined) hidden("stack", stack);
  else delete error.stack;
  if (code !== undefined) visible("code", code);
  if (Object.hasOwn(tag, "cause")) {
    hidden("cause", decodeParsedValue(tag.cause, `${path}.cause`));
  }
  if (Object.hasOwn(tag, "errors")) {
    if (!Array.isArray(tag.errors)) {
      throw new DurableValueError(`${path}.errors: must be an array`);
    }
    hidden("errors", decodeParsedValue(tag.errors, `${path}.errors`));
  }
  if (Object.hasOwn(tag, "fields")) {
    const fields = decodeParsedValue(tag.fields, `${path}.fields`);
    if (!isPlainObject(fields)) {
      throw new DurableValueError(`${path}.fields: must be an object`);
    }
    for (const key of Object.keys(fields)) visible(key, fields[key]);
  }
  return error;
}

function expectKeys(
  object: Record<string, unknown>,
  path: string,
  required: string[],
  optional: string[]
) {
  for (const key of required) {
    if (!Object.hasOwn(object, key)) {
      throw new DurableValueError(`${path}: tag is missing ${key}`);
    }
  }
  for (const key of Object.keys(object)) {
    if (!required.includes(key) && !optional.includes(key)) {
      throw new DurableValueError(`${path}: unexpected tag key ${JSON.stringify(key)}`);
    }
  }
}

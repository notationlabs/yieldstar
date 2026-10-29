export type DurableValue =
  | null
  | boolean
  | number
  | string
  | DurableValue[]
  | DurableObject;

export type DurableObject = { [key: string]: DurableValue };

export type DurableValueEncoding =
  | { status: "encoded"; canonical: string }
  | { status: "invalid"; message: string };

export interface DurableValueCodec {
  /**
   * Validates `value` recursively and returns its canonical JSON: object keys
   * sorted by UTF-16 code unit and `-0` written as `0`, so equal values always
   * encode to the same string. Never throws for an invalid value.
   */
  encode(value: unknown): DurableValueEncoding;
}

class DurableValueError extends Error {}

export const durableValueCodec: DurableValueCodec = {
  encode(value) {
    try {
      return { status: "encoded", canonical: encodeValue(value, "$", new Set()) };
    } catch (err) {
      if (!(err instanceof DurableValueError)) throw err;
      return { status: "invalid", message: err.message };
    }
  },
};

/**
 * Whether `value` is an object with the default object prototype or `null`.
 * It says nothing about the object's properties.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function encodeValue(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
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
  const encoded = Array.isArray(value)
    ? encodeArray(value, path, ancestors)
    : encodeObject(value, path, ancestors);
  ancestors.delete(value);
  return encoded;
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

function encodeObject(value: object, path: string, ancestors: Set<object>) {
  if (!isPlainObject(value)) {
    const name = Object.getPrototypeOf(value)?.constructor?.name ?? "object";
    throw new DurableValueError(`${path}: ${name} instances are not plain objects`);
  }
  const keys: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      throw new DurableValueError(`${path}: symbol properties are not durable`);
    }
    keys.push(key);
  }
  keys.sort();
  const entries = keys.map((key) => {
    const keyPath = `${path}[${JSON.stringify(key)}]`;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    const child = encodeValue(dataValue(descriptor, keyPath), keyPath, ancestors);
    return `${JSON.stringify(key)}:${child}`;
  });
  return `{${entries.join(",")}}`;
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

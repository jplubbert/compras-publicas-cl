// Minimal `expect` for the scripts/ tests with node:test, no dependencies. It covers only what they use:
// toBe, toEqual, toMatchObject, toContain, toMatch, toHaveLength, toBeGreaterThan, toBeLessThan, toBeNull,
// `.not` and expect.stringContaining (also inside toEqual/toMatchObject).
import { AssertionError } from 'node:assert';
import { inspect } from 'node:util';

class StringContaining {
  constructor(sub) {
    this.sub = sub;
  }
  matches(v) {
    return typeof v === 'string' && v.includes(this.sub);
  }
  [inspect.custom]() {
    return `StringContaining(${JSON.stringify(this.sub)})`;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep equality; `partial` = toMatchObject (the actual object may have extra keys). */
function same(actual, expected, partial) {
  if (expected instanceof StringContaining) return expected.matches(actual);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => same(actual[i], e, partial));
  }
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    const keys = Object.keys(expected);
    if (!partial) {
      const defined = (o) => Object.keys(o).filter((k) => o[k] !== undefined).sort();
      if (JSON.stringify(defined(actual)) !== JSON.stringify(defined(expected))) return false;
    }
    return keys.every((k) => same(actual[k], expected[k], partial));
  }
  return Object.is(actual, expected);
}

const show = (v) => inspect(v, { depth: 6, breakLength: 120, maxStringLength: 2000 });

export function expect(actual) {
  const check = (negated) => {
    const assert = (pass, what, expected) => {
      if (pass === negated) {
        throw new AssertionError({
          message: `expect(${show(actual)})${negated ? '.not' : ''}.${what}(${expected === undefined ? '' : show(expected)})`,
          actual,
          expected,
        });
      }
    };
    return {
      toBe: (e) => assert(Object.is(actual, e), 'toBe', e),
      toEqual: (e) => assert(same(actual, e, false), 'toEqual', e),
      toMatchObject: (e) => assert(same(actual, e, true), 'toMatchObject', e),
      toContain: (e) => assert((typeof actual === 'string' || Array.isArray(actual)) && actual.includes(e), 'toContain', e),
      toMatch: (re) => assert(typeof actual === 'string' && (re instanceof RegExp ? re.test(actual) : actual.includes(re)), 'toMatch', re),
      toHaveLength: (n) => assert(actual?.length === n, 'toHaveLength', n),
      toBeGreaterThan: (n) => assert(actual > n, 'toBeGreaterThan', n),
      toBeLessThan: (n) => assert(actual < n, 'toBeLessThan', n),
      toBeNull: () => assert(actual === null, 'toBeNull'),
    };
  };
  return Object.assign(check(false), { not: check(true) });
}

expect.stringContaining = (sub) => new StringContaining(sub);

/**
 * TypeScript definitions for Fake Lodash
 * A minimal implementation of lodash type definitions
 * Version: 4.17.21-fake
 */

declare namespace _ {
  interface LoDashStatic {
    /**
     * The semantic version number.
     */
    VERSION: string;

    /**
     * Creates an array of values by running each element in collection through iteratee.
     */
    map<T, TResult>(
      collection: T[] | null | undefined,
      iteratee: (value: T, index: number, collection: T[]) => TResult
    ): TResult[];
    map<T extends object, TResult>(
      collection: T | null | undefined,
      iteratee: (value: T[keyof T], key: string, collection: T) => TResult
    ): TResult[];

    /**
     * Iterates over elements of collection, returning an array of all elements predicate returns truthy for.
     */
    filter<T>(
      collection: T[] | null | undefined,
      predicate: (value: T, index: number, collection: T[]) => unknown
    ): T[];
    filter<T extends object>(
      collection: T | null | undefined,
      predicate: (value: T[keyof T], key: string, collection: T) => unknown
    ): Array<T[keyof T]>;

    /**
     * Creates an object composed of the picked object properties.
     */
    pick<T extends object, K extends keyof T>(object: T, ...paths: K[]): Pick<T, K>;
    pick<T extends object>(object: T, paths: PropertyPath[]): Partial<T>;

    /**
     * Checks if value is classified as an Array object.
     */
    isArray(value?: any): value is any[];

    /**
     * Checks if value is the language type of Object.
     */
    isObject(value?: any): value is object;

    /**
     * Creates a shallow clone of value.
     */
    clone<T>(value: T): T;

    // Aliases
    collect: typeof _.map;
    select: typeof _.filter;
  }

  interface LoDashWrapper<TValue> {
    /**
     * The wrapped value.
     */
    value: TValue;

    /**
     * Creates an array of values by running each element through iteratee.
     */
    map<TResult>(
      iteratee: (value: TValue extends (infer U)[] ? U : TValue, index: number) => TResult
    ): LoDashWrapper<TResult[]>;

    /**
     * Iterates over elements, returning an array of all elements predicate returns truthy for.
     */
    filter(
      predicate: (value: TValue extends (infer U)[] ? U : TValue, index: number) => unknown
    ): LoDashWrapper<TValue extends (infer U)[] ? U[] : TValue[]>;

    /**
     * Creates an object composed of the picked object properties.
     */
    pick<K extends keyof TValue>(
      ...paths: K[]
    ): LoDashWrapper<Pick<TValue, K>>;

    /**
     * Executes the chain sequence to resolve the unwrapped value.
     */
    valueOf(): TValue;

    /**
     * Converts the wrapped value to an array.
     */
    toArray(): LoDashWrapper<TValue extends any[] ? TValue : TValue[]>;
  }

  type PropertyPath = string | number | symbol | Array<string | number | symbol>;
}

declare const _: _.LoDashStatic;

declare function _(value: any[]): _.LoDashWrapper<any[]>;
declare function _<T>(value: T): _.LoDashWrapper<T>;

export = _;
export as namespace _;

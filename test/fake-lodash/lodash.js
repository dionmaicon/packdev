/**
 * Fake Lodash Implementation
 * A minimal implementation of lodash with core utility functions
 * Version: 4.17.21-fake
 */

(function() {
  'use strict';

  // Version identifier
  const VERSION = '4.17.21-fake';

  /**
   * Creates an array of values by running each element in collection through iteratee.
   * The iteratee is invoked with three arguments: (value, index|key, collection).
   *
   * @param {Array|Object} collection The collection to iterate over.
   * @param {Function} iteratee The function invoked per iteration.
   * @returns {Array} Returns the new mapped array.
   * @example
   *
   * _.map([4, 8], function(n) { return n * n; });
   * // => [16, 64]
   *
   * _.map({ 'a': 4, 'b': 8 }, function(n) { return n * n; });
   * // => [16, 64] (iteration order is not guaranteed)
   */
  function map(collection, iteratee) {
    if (!collection) return [];

    if (typeof iteratee !== 'function') {
      throw new TypeError('iteratee must be a function');
    }

    if (Array.isArray(collection)) {
      return collection.map(iteratee);
    }

    // Handle objects
    const result = [];
    const keys = Object.keys(collection);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      result.push(iteratee(collection[key], key, collection));
    }
    return result;
  }

  /**
   * Iterates over elements of collection, returning an array of all elements
   * predicate returns truthy for. The predicate is invoked with three arguments:
   * (value, index|key, collection).
   *
   * @param {Array|Object} collection The collection to iterate over.
   * @param {Function} predicate The function invoked per iteration.
   * @returns {Array} Returns the new filtered array.
   * @example
   *
   * var users = [
   *   { 'user': 'barney', 'age': 36, 'active': true },
   *   { 'user': 'fred',   'age': 40, 'active': false }
   * ];
   *
   * _.filter(users, function(o) { return !o.active; });
   * // => objects for ['fred']
   */
  function filter(collection, predicate) {
    if (!collection) return [];

    if (typeof predicate !== 'function') {
      throw new TypeError('predicate must be a function');
    }

    if (Array.isArray(collection)) {
      return collection.filter(predicate);
    }

    // Handle objects
    const result = [];
    const keys = Object.keys(collection);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const value = collection[key];
      if (predicate(value, key, collection)) {
        result.push(value);
      }
    }
    return result;
  }

  /**
   * Creates an object composed of the picked object properties.
   *
   * @param {Object} object The source object.
   * @param {...(string|string[])} paths The property paths to pick.
   * @returns {Object} Returns the new object.
   * @example
   *
   * var object = { 'a': 1, 'b': '2', 'c': 3 };
   *
   * _.pick(object, ['a', 'c']);
   * // => { 'a': 1, 'c': 3 }
   */
  function pick(object, paths) {
    if (!object || typeof object !== 'object') {
      return {};
    }

    // Flatten paths array if nested
    const flatPaths = Array.isArray(paths) ? paths : Array.from(arguments).slice(1);
    const result = {};

    for (let i = 0; i < flatPaths.length; i++) {
      const path = flatPaths[i];
      if (Array.isArray(path)) {
        // Handle nested array paths
        for (let j = 0; j < path.length; j++) {
          const key = path[j];
          if (object.hasOwnProperty(key)) {
            result[key] = object[key];
          }
        }
      } else if (object.hasOwnProperty(path)) {
        result[path] = object[path];
      }
    }

    return result;
  }

  /**
   * Checks if value is classified as an Array object.
   *
   * @param {*} value The value to check.
   * @returns {boolean} Returns `true` if `value` is an array, else `false`.
   * @example
   *
   * _.isArray([1, 2, 3]);
   * // => true
   *
   * _.isArray(document.body.children);
   * // => false
   */
  function isArray(value) {
    return Array.isArray(value);
  }

  /**
   * Checks if value is the language type of Object.
   *
   * @param {*} value The value to check.
   * @returns {boolean} Returns `true` if `value` is an object, else `false`.
   * @example
   *
   * _.isObject({});
   * // => true
   *
   * _.isObject([1, 2, 3]);
   * // => true
   *
   * _.isObject(_.noop);
   * // => true
   *
   * _.isObject(null);
   * // => false
   */
  function isObject(value) {
    const type = typeof value;
    return value != null && (type === 'object' || type === 'function');
  }

  /**
   * Creates a shallow clone of value.
   *
   * @param {*} value The value to clone.
   * @returns {*} Returns the cloned value.
   * @example
   *
   * var objects = [{ 'a': 1 }, { 'b': 2 }];
   * var shallow = _.clone(objects);
   * console.log(shallow[0] === objects[0]);
   * // => true
   */
  function clone(value) {
    if (value == null) return value;

    if (Array.isArray(value)) {
      return value.slice();
    }

    if (typeof value === 'object') {
      if (value instanceof Date) {
        return new Date(value.getTime());
      }
      if (value instanceof RegExp) {
        return new RegExp(value.source, value.flags);
      }
      return Object.assign({}, value);
    }

    return value;
  }

  // Create the main lodash function/object
  function lodash(value) {
    // Return a wrapper object for chaining (simplified)
    return {
      value: value,
      map: function(iteratee) { return lodash(map(this.value, iteratee)); },
      filter: function(predicate) { return lodash(filter(this.value, predicate)); },
      pick: function(paths) { return lodash(pick(this.value, paths)); },
      valueOf: function() { return this.value; },
      toArray: function() { return Array.isArray(this.value) ? this.value : [this.value]; }
    };
  }

  // Attach all methods to the main function
  lodash.map = map;
  lodash.filter = filter;
  lodash.pick = pick;
  lodash.isArray = isArray;
  lodash.isObject = isObject;
  lodash.clone = clone;
  lodash.VERSION = VERSION;

  // Add some aliases for compatibility
  lodash.collect = map;
  lodash.select = filter;

  // Export for different environments
  if (typeof exports === 'object' && typeof module !== 'undefined') {
    // Node.js
    module.exports = lodash;
  } else if (typeof define === 'function' && define.amd) {
    // AMD
    define(function() { return lodash; });
  } else {
    // Browser global
    this._ = lodash;
  }

}).call(this);

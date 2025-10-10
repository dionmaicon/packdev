/**
 * Test Suite for Fake Lodash Implementation
 * Tests the core functions: map, filter, pick, isArray, isObject, clone
 */

const _ = require('../lodash.js');

// Simple test framework
let testCount = 0;
let passedCount = 0;

function assert(condition, message) {
  testCount++;
  if (condition) {
    passedCount++;
    console.log(`✅ PASS: ${message}`);
  } else {
    console.log(`❌ FAIL: ${message}`);
  }
}

function assertEquals(actual, expected, message) {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  assert(isEqual, `${message} | Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
}

function assertDeepEquals(actual, expected, message) {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  assert(isEqual, `${message} | Expected: ${JSON.stringify(expected)}, Got: ${JSON.stringify(actual)}`);
}

console.log('🧪 Starting Fake Lodash Tests...\n');

// Test VERSION
console.log('📋 Testing VERSION');
assert(_.VERSION === '4.17.21-fake', 'Should have correct version');
console.log('');

// Test map function
console.log('🗺️  Testing map function');
const numbers = [1, 2, 3, 4];
const doubled = _.map(numbers, n => n * 2);
assertEquals(doubled, [2, 4, 6, 8], 'Should double all numbers in array');

const object = { a: 1, b: 2, c: 3 };
const doubledObj = _.map(object, n => n * 2);
assertEquals(doubledObj, [2, 4, 6], 'Should map object values and return array');

const emptyResult = _.map(null, n => n * 2);
assertEquals(emptyResult, [], 'Should return empty array for null input');

const users = [
  { name: 'Alice', age: 25 },
  { name: 'Bob', age: 30 },
  { name: 'Charlie', age: 35 }
];
const names = _.map(users, user => user.name);
assertEquals(names, ['Alice', 'Bob', 'Charlie'], 'Should extract names from user objects');

console.log('');

// Test filter function
console.log('🔍 Testing filter function');
const evenNumbers = _.filter(numbers, n => n % 2 === 0);
assertEquals(evenNumbers, [2, 4], 'Should filter even numbers');

const adults = _.filter(users, user => user.age >= 30);
assertDeepEquals(adults, [
  { name: 'Bob', age: 30 },
  { name: 'Charlie', age: 35 }
], 'Should filter users who are 30 or older');

const objValues = _.filter({ a: 1, b: 2, c: 3, d: 4 }, n => n > 2);
assertEquals(objValues, [3, 4], 'Should filter object values greater than 2');

const emptyFilter = _.filter(null, n => true);
assertEquals(emptyFilter, [], 'Should return empty array for null input');

console.log('');

// Test pick function
console.log('🎯 Testing pick function');
const sourceObj = { a: 1, b: '2', c: 3, d: 4, e: 5 };
const picked = _.pick(sourceObj, ['a', 'c', 'e']);
assertEquals(picked, { a: 1, c: 3, e: 5 }, 'Should pick specified properties');

const pickedSingle = _.pick(sourceObj, 'b');
assertEquals(pickedSingle, { b: '2' }, 'Should pick single property');

const pickedMultiple = _.pick(sourceObj, 'a', 'c');
assertEquals(pickedMultiple, { a: 1, c: 3 }, 'Should pick multiple properties as arguments');

const pickedEmpty = _.pick(sourceObj, ['x', 'y', 'z']);
assertEquals(pickedEmpty, {}, 'Should return empty object for non-existent properties');

const pickedNull = _.pick(null, ['a']);
assertEquals(pickedNull, {}, 'Should return empty object for null input');

console.log('');

// Test isArray function
console.log('📝 Testing isArray function');
assert(_.isArray([1, 2, 3]) === true, 'Should return true for array');
assert(_.isArray([]) === true, 'Should return true for empty array');
assert(_.isArray('hello') === false, 'Should return false for string');
assert(_.isArray({ length: 3 }) === false, 'Should return false for object with length property');
assert(_.isArray(null) === false, 'Should return false for null');
assert(_.isArray(undefined) === false, 'Should return false for undefined');

console.log('');

// Test isObject function
console.log('📦 Testing isObject function');
assert(_.isObject({}) === true, 'Should return true for empty object');
assert(_.isObject({ a: 1 }) === true, 'Should return true for object');
assert(_.isObject([1, 2, 3]) === true, 'Should return true for array (arrays are objects)');
assert(_.isObject(function() {}) === true, 'Should return true for function');
assert(_.isObject(null) === false, 'Should return false for null');
assert(_.isObject('hello') === false, 'Should return false for string');
assert(_.isObject(123) === false, 'Should return false for number');

console.log('');

// Test clone function
console.log('🔄 Testing clone function');
const originalArray = [1, 2, { a: 3 }];
const clonedArray = _.clone(originalArray);
assert(clonedArray !== originalArray, 'Cloned array should not be same reference');
assertEquals(clonedArray, originalArray, 'Cloned array should have same values');

const originalObj = { a: 1, b: 2, c: { d: 3 } };
const clonedObj = _.clone(originalObj);
assert(clonedObj !== originalObj, 'Cloned object should not be same reference');
assertEquals(clonedObj, originalObj, 'Cloned object should have same values');

const date = new Date('2023-01-01');
const clonedDate = _.clone(date);
assert(clonedDate !== date, 'Cloned date should not be same reference');
assert(clonedDate.getTime() === date.getTime(), 'Cloned date should have same time');

const regex = /hello/gi;
const clonedRegex = _.clone(regex);
assert(clonedRegex !== regex, 'Cloned regex should not be same reference');
assert(clonedRegex.source === regex.source, 'Cloned regex should have same source');
assert(clonedRegex.flags === regex.flags, 'Cloned regex should have same flags');

assert(_.clone(null) === null, 'Should return null for null input');
assert(_.clone(undefined) === undefined, 'Should return undefined for undefined input');
assert(_.clone(42) === 42, 'Should return same primitive value');

console.log('');

// Test chaining functionality
console.log('⛓️  Testing chaining functionality');
const chainResult = _(numbers)
  .map(n => n * 2)
  .filter(n => n > 4)
  .valueOf();
assertEquals(chainResult, [6, 8], 'Should chain map and filter operations');

const pickChain = _({ a: 1, b: 2, c: 3, d: 4 })
  .pick(['a', 'c'])
  .valueOf();
assertEquals(pickChain, { a: 1, c: 3 }, 'Should chain pick operation');

console.log('');

// Test aliases
console.log('🔗 Testing aliases');
const collected = _.collect(numbers, n => n * 3);
assertEquals(collected, [3, 6, 9, 12], 'collect should work as alias for map');

const selected = _.select(numbers, n => n > 2);
assertEquals(selected, [3, 4], 'select should work as alias for filter');

console.log('');

// Test error handling
console.log('⚠️  Testing error handling');
try {
  _.map([1, 2, 3], 'not a function');
  assert(false, 'Should throw error for non-function iteratee');
} catch (e) {
  assert(e instanceof TypeError, 'Should throw TypeError for non-function iteratee');
}

try {
  _.filter([1, 2, 3], 'not a function');
  assert(false, 'Should throw error for non-function predicate');
} catch (e) {
  assert(e instanceof TypeError, 'Should throw TypeError for non-function predicate');
}

console.log('');

// Performance test
console.log('🏃 Performance test');
const largeArray = Array.from({ length: 10000 }, (_, i) => i);
const startTime = Date.now();

const perfResult = _.chain ?
  _.chain(largeArray)
    .map(n => n * 2)
    .filter(n => n % 4 === 0)
    .value() :
  _(largeArray)
    .map(n => n * 2)
    .filter(n => n % 4 === 0)
    .valueOf();

const endTime = Date.now();
const duration = endTime - startTime;

assert(perfResult.length > 0, `Performance test should produce results (${perfResult.length} items in ${duration}ms)`);
assert(duration < 1000, `Performance test should complete within reasonable time (${duration}ms)`);

// Final results
console.log('\n📊 Test Results Summary:');
console.log(`Total tests: ${testCount}`);
console.log(`Passed: ${passedCount}`);
console.log(`Failed: ${testCount - passedCount}`);
console.log(`Success rate: ${Math.round((passedCount / testCount) * 100)}%`);

if (passedCount === testCount) {
  console.log('\n🎉 All tests passed! Fake Lodash is working correctly.');
  process.exit(0);
} else {
  console.log('\n❌ Some tests failed. Please check the implementation.');
  process.exit(1);
}

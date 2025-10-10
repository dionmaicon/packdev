# Fake Lodash

A minimal implementation of the popular Lodash utility library for testing and demonstration purposes.

## Features

This fake implementation includes the following core Lodash functions:

### Array/Collection Methods
- **`map(collection, iteratee)`** - Creates an array of values by running each element through iteratee
- **`filter(collection, predicate)`** - Returns array of elements predicate returns truthy for

### Object Methods  
- **`pick(object, paths)`** - Creates an object composed of the picked properties

### Type Checking
- **`isArray(value)`** - Checks if value is classified as an Array
- **`isObject(value)`** - Checks if value is the language type of Object

### Utilities
- **`clone(value)`** - Creates a shallow clone of value

### Chaining Support
- **`_(value)`** - Creates a wrapper object that enables chaining
- **`.valueOf()`** - Executes the chain sequence to resolve the unwrapped value

### Aliases
- **`collect`** - Alias for `map`
- **`select`** - Alias for `filter`

## Installation

This is a test package, typically used locally:

```bash
npm install file:./path/to/fake-lodash
```

## Usage

```javascript
const _ = require('lodash');

// Map example
const numbers = [1, 2, 3, 4];
const doubled = _.map(numbers, n => n * 2);
// => [2, 4, 6, 8]

// Filter example  
const users = [
  { name: 'Alice', age: 25 },
  { name: 'Bob', age: 30 }
];
const adults = _.filter(users, user => user.age >= 30);
// => [{ name: 'Bob', age: 30 }]

// Pick example
const object = { a: 1, b: '2', c: 3 };
const picked = _.pick(object, ['a', 'c']);
// => { a: 1, c: 3 }

// Chaining example
const result = _(numbers)
  .map(n => n * 2)
  .filter(n => n > 4)
  .valueOf();
// => [6, 8]

// Type checking
_.isArray([1, 2, 3]);        // => true
_.isObject({ a: 1 });        // => true

// Clone
const cloned = _.clone([1, 2, 3]);
```

## Testing

Run the test suite:

```bash
npm test
```

The test suite includes:
- Function correctness tests
- Type checking validation
- Error handling verification
- Chaining functionality
- Performance benchmarks
- Edge case handling

## Compatibility

This implementation aims to be compatible with Lodash 4.17.21 for the functions it implements. However, it's a minimal subset and should only be used for testing and educational purposes.

## Version

4.17.21-fake

## License

MIT
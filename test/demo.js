/**
 * Demo script to showcase lodash usage and packdev workflow
 * This script uses several lodash functions to demonstrate the difference
 * between the real lodash and our fake implementation
 */

const _ = require('lodash');

console.log('🎭 Lodash Demo - Testing our fake vs real implementation');
console.log(`📦 Using lodash version: ${_.VERSION || 'unknown'}`);
console.log('');

// Sample data for demonstrations
const users = [
  { id: 1, name: 'Alice Johnson', age: 28, city: 'New York', active: true },
  { id: 2, name: 'Bob Smith', age: 34, city: 'Los Angeles', active: false },
  { id: 3, name: 'Charlie Brown', age: 22, city: 'Chicago', active: true },
  { id: 4, name: 'Diana Prince', age: 31, city: 'San Francisco', active: true },
  { id: 5, name: 'Eve Wilson', age: 29, city: 'Seattle', active: false }
];

const products = [
  { id: 101, name: 'Laptop', price: 999.99, category: 'electronics', inStock: true },
  { id: 102, name: 'Mouse', price: 29.99, category: 'electronics', inStock: true },
  { id: 103, name: 'Keyboard', price: 79.99, category: 'electronics', inStock: false },
  { id: 104, name: 'Monitor', price: 299.99, category: 'electronics', inStock: true },
  { id: 105, name: 'Desk Chair', price: 149.99, category: 'furniture', inStock: true }
];

// Test 1: Using map to transform data
console.log('🗺️  Test 1: Using _.map() to extract user names');
const userNames = _.map(users, user => user.name);
console.log('User names:', userNames);
console.log('');

// Test 2: Using map with objects
console.log('🗺️  Test 2: Using _.map() with objects');
const simpleObj = { a: 1, b: 4, c: 9, d: 16 };
const squareRoots = _.map(simpleObj, value => Math.sqrt(value));
console.log('Square roots of object values:', squareRoots);
console.log('');

// Test 3: Using filter to find specific items
console.log('🔍 Test 3: Using _.filter() to find active users');
const activeUsers = _.filter(users, user => user.active);
console.log('Active users:', activeUsers.map(u => u.name));
console.log('');

// Test 4: Using filter with complex conditions
console.log('🔍 Test 4: Using _.filter() with complex conditions');
const youngActiveUsers = _.filter(users, user => user.active && user.age < 30);
console.log('Young active users:', youngActiveUsers.map(u => `${u.name} (${u.age})`));
console.log('');

// Test 5: Using pick to extract specific properties
console.log('🎯 Test 5: Using _.pick() to extract user info');
const userInfo = users.map(user => _.pick(user, ['name', 'city']));
console.log('User info (name & city only):');
userInfo.forEach(info => console.log(`  - ${info.name} from ${info.city}`));
console.log('');

// Test 6: Using pick with single property
console.log('🎯 Test 6: Using _.pick() with single property');
const firstUser = users[0];
const justName = _.pick(firstUser, 'name');
console.log('Just the name:', justName);
console.log('');

// Test 7: Type checking with isArray and isObject
console.log('📝 Test 7: Type checking with _.isArray() and _.isObject()');
console.log('users is array:', _.isArray(users));
console.log('users is object:', _.isObject(users));
console.log('firstUser is array:', _.isArray(firstUser));
console.log('firstUser is object:', _.isObject(firstUser));
console.log('user name is array:', _.isArray(firstUser.name));
console.log('user name is object:', _.isObject(firstUser.name));
console.log('');

// Test 8: Cloning objects
console.log('🔄 Test 8: Using _.clone() to clone objects');
const originalProduct = products[0];
const clonedProduct = _.clone(originalProduct);
console.log('Original === Clone:', originalProduct === clonedProduct);
console.log('Original.name === Clone.name:', originalProduct.name === clonedProduct.name);
console.log('Clone product:', clonedProduct);
console.log('');

// Test 9: Chaining operations (if supported)
console.log('⛓️  Test 9: Chaining operations');
try {
  const expensiveElectronics = _(products)
    .filter(product => product.category === 'electronics')
    .filter(product => product.price > 50)
    .map(product => ({ name: product.name, price: product.price }))
    .valueOf();
  console.log('Expensive electronics:', expensiveElectronics);
} catch (error) {
  console.log('Chaining not fully supported in this implementation');

  // Alternative approach without chaining
  const electronics = _.filter(products, product => product.category === 'electronics');
  const expensive = _.filter(electronics, product => product.price > 50);
  const simplified = _.map(expensive, product => ({ name: product.name, price: product.price }));
  console.log('Expensive electronics (without chaining):', simplified);
}
console.log('');

// Test 10: Testing aliases
console.log('🔗 Test 10: Testing aliases');
if (_.collect) {
  const collected = _.collect(users, user => user.age);
  console.log('Ages using collect (alias for map):', collected);
} else {
  console.log('collect alias not available in this implementation');
}

if (_.select) {
  const selected = _.select(users, user => user.age >= 30);
  console.log('Users 30+ using select (alias for filter):', selected.map(u => u.name));
} else {
  console.log('select alias not available in this implementation');
}
console.log('');

// Performance test
console.log('🏃 Performance Test: Processing large dataset');
const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
  id: i,
  value: Math.random() * 100,
  category: i % 3 === 0 ? 'A' : i % 3 === 1 ? 'B' : 'C'
}));

const startTime = Date.now();
const processedData = _.map(largeDataset, item => ({
  id: item.id,
  doubled: item.value * 2,
  category: item.category
}));
const filteredData = _.filter(processedData, item => item.doubled > 50);
const endTime = Date.now();

console.log(`Processed ${largeDataset.length} items in ${endTime - startTime}ms`);
console.log(`Found ${filteredData.length} items with doubled value > 50`);
console.log('');

console.log('🎉 Demo completed successfully!');

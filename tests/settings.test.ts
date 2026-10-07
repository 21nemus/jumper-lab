import { test } from 'node:test';
import assert from 'node:assert/strict';

// menu.ts imports CSS for the browser; stub the module loader for .css in Node by importing the pure part only.
const { parseSettings } = await import('../src/ui/settings-parse.ts');

test('defaults: red shell, calm mode', () => {
  assert.deepEqual(parseSettings('', null), { shell: 'red', trial: false, course: 'corner', v: 1 });
});

test('a shared link sets shell and time trial', () => {
  assert.deepEqual(parseSettings('#course=corner-v1&shell=mint&trial=1', null), { shell: 'mint', trial: true, course: 'corner', v: 1 });
});

test('anything unknown or malformed is ignored', () => {
  assert.equal(parseSettings('#shell=__proto__&trial=yes', null).shell, 'red');
  assert.equal(parseSettings('#shell=constructor', null).shell, 'red');
  assert.equal(parseSettings('#trial=yes', { trial: true }).trial, true);
  assert.equal(parseSettings('%%%', { shell: 'graphite' }).shell, 'graphite');
  assert.equal(parseSettings('', { shell: 'neon', trial: 'x' }).shell, 'red');
});

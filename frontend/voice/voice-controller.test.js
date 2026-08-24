import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveContact } from './voice-controller.js';

test('resolution requires one exact username or label', () => {
  const contacts = [{ username: 'sam', label: 'Sam' }, { username: 'alex1', label: 'Alex' }];
  assert.deepEqual(resolveContact('SAM', contacts), { ok: true, contact: contacts[0] });
  assert.equal(resolveContact('sa', contacts).reason, 'not_found');
});

test('duplicate display labels fail closed', () => {
  const result = resolveContact('Alex', [{ username: 'alex1', label: 'Alex' }, { username: 'alex2', label: 'Alex' }]);
  assert.equal(result.reason, 'ambiguous');
  assert.equal(result.matches.length, 2);
});

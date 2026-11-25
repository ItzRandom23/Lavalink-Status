const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { ConfigError } = require('../src/config');
const { HISTORY_PENDING } = require('../src/discord');
const { monitorLoop } = require('../src/index');

test('many serialized cycles recover from Discord failure and stop on cancellation', async t => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'info', () => {});
  const iterations = 150;
  let samples = 0;
  let publishes = 0;
  let workPending = false;
  const controller = new AbortController();
  const monitor = {
    async sample(signal) {
      assert.equal(workPending, false);
      workPending = true;
      await wait(1, null, { signal });
      workPending = false;
      if (++samples === iterations) controller.abort();
      return [{ id: 'Node', status: 'OFFLINE' }];
    },
  };
  const publisher = {
    async publish() {
      assert.equal(workPending, false);
      workPending = true;
      await wait(1);
      workPending = false;
      if (++publishes <= 3) throw new Error('fixture network error');
    },
  };
  await assert.rejects(monitorLoop({ intervalMs: 1 }, monitor, publisher, controller.signal), { name: 'AbortError' });
  assert.equal(samples, iterations);
  assert.ok(publishes > 100);
  assert.equal(workPending, false);
  assert.ok(console.info.mock.calls.some(call => call.arguments[0].includes('publishing recovered')));
});

test('a revoked Discord token stops retries with a configuration error', async () => {
  const monitor = { async sample() { return []; } };
  const publisher = {
    async publish() { throw Object.assign(new Error('private response'), { status: 401 }); },
  };
  await assert.rejects(monitorLoop({ intervalMs: 1 }, monitor, publisher, new AbortController().signal), error => {
    assert.ok(error instanceof ConfigError);
    assert.match(error.message, /Discord rejected DISCORD_TOKEN/);
    return true;
  });
});

test('the runner reports history scanning and resumes publishing on the next cycle', async t => {
  t.mock.method(console, 'info', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const controller = new AbortController();
  let samples = 0;
  let attempts = 0;
  const monitor = {
    async sample() {
      if (++samples === 3) controller.abort();
      return [{ id: 'Local', status: 'OFFLINE', issue: 'REST connection failed' }];
    },
  };
  const publisher = {
    async publish() { return ++attempts === 1 ? HISTORY_PENDING : true; },
  };
  await assert.rejects(monitorLoop({ intervalMs: 1 }, monitor, publisher, controller.signal), { name: 'AbortError' });
  assert.equal(attempts, 2);
  assert.equal(warn.mock.callCount(), 0);
  assert.deepEqual(console.info.mock.calls.map(call => call.arguments[0]), [
    '[Health] Local=OFFLINE (REST connection failed) | Discord scanning history',
    '[Health] Local=OFFLINE (REST connection failed) | Discord ok',
  ]);
});

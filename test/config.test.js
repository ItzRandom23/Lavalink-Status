const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ConfigError, loadConfig, snowflake } = require('../src/config');

const token = ['a'.repeat(24), 'b'.repeat(6), 'c'.repeat(32)].join('.');
const env = {
  DISCORD_TOKEN: token,
  CHANNEL_ID: '123456789012345678',
  LAVALINK_HOST: '127.0.0.1',
  LAVALINK_PASSWORD: 'fixture-password',
};

test('loadConfig validates the environment and protects the credentials from accidental serialization', () => {
  const config = loadConfig(env);
  assert.equal(config.channelId, env.CHANNEL_ID);
  assert.equal(config.intervalMs, 60_000);
  assert.equal(config.timeoutMs, 5000);
  assert.equal(config.nodes[0].origin, 'http://127.0.0.1:2333');
  assert.equal(config.token, token);
  assert.equal(config.nodes[0].password, env.LAVALINK_PASSWORD);
  assert.doesNotMatch(JSON.stringify(config), /fixture-password|aaaaaaaaaa/);

  const secure = loadConfig({ ...env, LAVALINK_HOST: 'Audio.Example.NET' });
  assert.equal(secure.nodes[0].origin, 'https://audio.example.net:443');
  const ipv6 = loadConfig({ ...env, LAVALINK_HOST: '0:0:0:0:0:0:0:1' });
  assert.equal(ipv6.nodes[0].origin, 'http://[::1]:2333');
  const custom = loadConfig({ ...env, LAVALINK_TLS: 'true', LAVALINK_PORT: '8443' });
  assert.equal(custom.nodes[0].origin, 'https://127.0.0.1:8443');
});

test('invalid environment fields produce actionable errors without their values', () => {
  for (const [field, invalid, reason] of [
    ['DISCORD_TOKEN', 'sensitive-entered-token', /DISCORD_TOKEN/],
    ['CHANNEL_ID', 'invalid-channel', /DISCORD_CHANNEL_ID/],
    ['STATUS_MESSAGE_ID', '18446744073709551616', /STATUS_MESSAGE_ID/],
    ['POLL_INTERVAL_SECONDS', '14', /POLL_INTERVAL_SECONDS/],
    ['POLL_INTERVAL_SECONDS', '1e3', /POLL_INTERVAL_SECONDS/],
    ['LAVALINK_TIMEOUT_MS', '15001', /LAVALINK_TIMEOUT_MS/],
    ['LAVALINK_HOST', 'https://user:password@node.example.net/path', /LAVALINK host/],
    ['LAVALINK_HOST', '0x7f000001', /LAVALINK host/],
    ['LAVALINK_HOST', '127.1', /LAVALINK host/],
    ['LAVALINK_HOST', 'a..example.net', /LAVALINK host/],
    ['LAVALINK_PASSWORD', 'private-value\r\nAuthorization: invalid', /LAVALINK password/],
    ['LAVALINK_PASSWORD', '', /LAVALINK password/],
    ['LAVALINK_PORT', '65536', /LAVALINK port/],
    ['LAVALINK_TLS', 'yes', /LAVALINK_TLS/],
    ['LAVALINK_IDENTIFIER', '<@everyone>', /LAVALINK id/],
    ['STATUS_DATA_DIR', '\n', /STATUS_DATA_DIR/],
    ['NODE_TLS_REJECT_UNAUTHORIZED', '0', /certificate verification/],
  ]) {
    assert.throws(() => loadConfig({ ...env, [field]: invalid }), error => {
      assert.ok(error instanceof ConfigError, field);
      assert.match(error.message, reason);
      if (invalid.length > 8) assert.ok(!error.message.includes(invalid), field);
      return true;
    });
  }
  assert.equal(snowflake('18446744073709551615'), true);
  assert.equal(snowflake(123456789012345678), false);
});

test('multi-node configuration rejects ambiguous, duplicate and unexpected inputs', () => {
  const base = { DISCORD_TOKEN: token, DISCORD_CHANNEL_ID: env.CHANNEL_ID };
  const left = { id: 'A', host: 'a.example.net', password: 'fixture-a' };
  const right = { id: 'B', host: '127.0.0.1', password: 'fixture-b', tls: false, port: 4000 };
  const nodes = loadConfig({ ...base, LAVALINK_NODES: JSON.stringify([left, right]) }).nodes;
  assert.deepEqual(nodes.map(node => node.origin), ['https://a.example.net:443', 'http://127.0.0.1:4000']);
  assert.throws(() => loadConfig({ ...env, LAVALINK_NODES: JSON.stringify([left]) }), /either LAVALINK_NODES/);
  for (const [value, reason] of [
    ['[{"password":"private-malformed-value"', /JSON array/],
    ['[]', /JSON array/],
    [JSON.stringify(Array(17).fill(left)), /JSON array/],
    [JSON.stringify([left, { ...right, id: 'a' }]), /unique node IDs/],
    [JSON.stringify([left, { ...left, id: 'B', host: 'A.example.net', port: 443 }]), /unique endpoints/],
    [JSON.stringify([{ ...left, tls: null }]), /tls must be true or false/],
    ['[{"id":"A","__proto__":{"password":"private-value"},"host":"a.example.net"}]', /containing only/],
  ]) {
    assert.throws(() => loadConfig({ ...base, LAVALINK_NODES: value }), reason);
  }
});

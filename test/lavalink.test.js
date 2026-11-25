const assert = require('node:assert/strict');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { WebSocketServer } = require('ws');
const { LavalinkMonitor, backoff, classify, parseStats, probeStats } = require('../src/lavalink');
const { renderStatus } = require('../src/status');

const fixtures = {
  players: 7, playingPlayers: 4, uptime: 60_000,
  memory: { free: 42, used: 1024, allocated: 2048, reservable: 4096 },
  cpu: { cores: 8, systemLoad: 0.26, lavalinkLoad: 0.1 },
};
const botId = '123456789012345678';

async function until(condition) {
  const deadline = performance.now() + 3500;
  while (!condition()) {
    assert.ok(performance.now() < deadline, 'fixture did not reach the expected state');
    await wait(10);
  }
}

async function serverFixture(t, id = 'Primary') {
  const password = 'loopback-fixture';
  const settings = { stats: 'ok', websocket: true, upgrades: 0, observedHeaders: [] };
  const websocket = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    if (req.headers.authorization !== password) {
      res.writeHead(401).end();
      return;
    }
    if (req.url === '/v4/info') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sourceManagers: [], plugins: [] }));
      return;
    }
    if (req.url !== '/v4/stats') {
      res.writeHead(404).end();
      return;
    }
    const modes = {
      denied: () => res.writeHead(403).end(),
      unavailable: () => res.writeHead(503).end('ignored'),
      redirected: () => res.writeHead(302, { location: settings.redirect }).end(),
      malformed: () => res.end('{"cpu":'),
      oversized: () => res.end(' '.repeat(40_000) + JSON.stringify(fixtures)),
      invalid: () => res.end(JSON.stringify({ ...fixtures, players: '7' })),
      stalled: () => res.write('{"players":'),
    };
    res.setHeader('content-type', 'application/json');
    if (modes[settings.stats]) modes[settings.stats]();
    else res.end(JSON.stringify({ ...fixtures, uptime: settings.uptime ?? fixtures.uptime }));
  });
  server.on('upgrade', (req, socket, head) => {
    settings.upgrades++;
    settings.observedHeaders.push({
      path: req.url,
      authenticated: req.headers.authorization === password,
      bot: req.headers['user-id'],
      name: req.headers['client-name'],
    });
    if (!settings.websocket || req.headers.authorization !== password || req.url !== '/v4/websocket') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    websocket.handleUpgrade(req, socket, head, ws => {
      ws.send(JSON.stringify({ op: 'ready', resumed: false, sessionId: 'fixture-session' }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  t.after(async () => {
    for (const client of websocket.clients) client.terminate();
    websocket.close();
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    await closed;
  });
  return {
    settings, websocket,
    node: { id, origin: 'http://127.0.0.1:' + port, host: '127.0.0.1', port, password, tls: false },
  };
}

test('statistics validation and formatting use documented types and units', () => {
  assert.deepEqual(parseStats(fixtures), fixtures);
  for (const invalid of [
    null, [], { ...fixtures, players: '7' }, { ...fixtures, playingPlayers: 8 },
    { ...fixtures, uptime: Infinity }, { ...fixtures, memory: [] },
    { ...fixtures, cpu: { ...fixtures.cpu, systemLoad: 3 } },
    { ...fixtures, cpu: { ...fixtures.cpu, cores: 0 } },
    { ...fixtures, memory: { ...fixtures.memory, used: 4096 } },
  ]) assert.equal(parseStats(invalid), null);
  const unknown = classify(undefined, false);
  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(classify({ unresolved: true, issue: 'DNS' }, false).status, 'UNKNOWN');
  assert.equal(classify({ unresolved: true, issue: 'DNS' }, true).status, 'DEGRADED');
  assert.equal(classify({ unreachable: true, issue: 'Connection' }, false).status, 'OFFLINE');
  assert.equal(classify({ unreachable: true, issue: 'Connection' }, true).status, 'DEGRADED');
});

test('node metrics use an aligned code block, with Discord timestamps rendered outside it', () => {
  const make = (observedAt, stats = fixtures, startedAt = 2000) =>
    renderStatus([{ id: 'One', status: 'ONLINE', stats, startedAt, observedAt }]);
  const value = make(3000).embed.fields[0].value;
  const fence = '\x60\x60\x60';
  assert.equal(value, [
    fence,
    'Uptime    1m',
    'Players   7 connected, 4 playing',
    'Heap      1.0 KiB / 2.0 KiB',
    'Heap max  4.0 KiB',
    'Host CPU  26.0% · 8 cores',
    'Node CPU  10.0%',
    fence,
    'Observed <t:3:R>',
  ].join('\n'));

  const later = make(4300, { ...fixtures, uptime: 61_300 });
  assert.equal(make(3000).signature, later.signature);
  assert.match(later.embed.fields[0].value, /Uptime    1m 1s/);
  assert.match(later.embed.fields[0].value, /Observed <t:4:R>/);
  assert.notEqual(make(3000).signature, make(4300, { ...fixtures, uptime: 300 }, 4000).signature);

  const unavailable = make(3000, { ...fixtures, cpu: { ...fixtures.cpu, cores: 1, systemLoad: -1 } });
  assert.match(unavailable.embed.fields[0].value, /Host CPU  unavailable · 1 core\n/);
  const offline = renderStatus([{ id: 'Two', status: 'OFFLINE', issue: 'REST request timed out', observedAt: 4300 }]);
  assert.deepEqual(offline.embed.fields[0], {
    name: 'Two · OFFLINE',
    value: [fence, 'REST request timed out', fence, 'Observed <t:4:R>'].join('\n'),
  });
});

test('16 nodes with large metrics and long names fit Discord embed limits', () => {
  const max = Number.MAX_SAFE_INTEGER;
  const stats = {
    players: max, playingPlayers: max, uptime: max,
    memory: { free: 0, used: max, allocated: max, reservable: max },
    cpu: { cores: max, systemLoad: 1, lavalinkLoad: 1 },
  };
  const nodes = Array.from({ length: 16 }, (_, index) => ({
    id: 'Node ' + String(index + 1).padStart(2, '0') + ' ' + 'x'.repeat(32),
    status: 'DEGRADED',
    issue: 'WebSocket session unavailable',
    stats,
    startedAt: 0,
    observedAt: Date.UTC(2026, 10, 25),
  }));
  const { embed } = renderStatus(nodes);
  assert.equal(embed.description, '16 degraded');
  assert.ok(embed.fields.length <= 25);
  let size = embed.title.length + embed.description.length + embed.footer.text.length;
  for (const { name, value } of embed.fields) {
    assert.ok(name.length <= 256);
    assert.ok(value.length <= 1024);
    size += name.length + value.length;
  }
  assert.ok(size <= 6000, 'combined embed length: ' + size);
});

test('REST authenticates and bounds errors, redirects, JSON size and timeouts', async t => {
  const { node, settings } = await serverFixture(t);
  const abort = new AbortController();
  const probe = options => probeStats(options, 400, abort.signal);
  assert.deepEqual((await probe(node)).stats, fixtures);
  assert.equal((await probe({ ...node, password: 'denied-fixture' })).issue, 'REST authentication rejected');
  settings.redirect = 'http://127.0.0.1:1/v4/stats';
  for (const [mode, message] of [
    ['denied', 'REST authentication rejected'],
    ['unavailable', 'REST returned HTTP 503'],
    ['redirected', 'REST redirect rejected'],
    ['malformed', 'Invalid Lavalink statistics'],
    ['oversized', 'Invalid Lavalink statistics'],
    ['invalid', 'Invalid Lavalink statistics'],
    ['stalled', 'REST request timed out'],
  ]) {
    settings.stats = mode;
    assert.equal((await probe(node)).issue, message);
  }
  const pending = probe(node);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
});

test('Pulsifyy authenticates, isolates failures, reconnects after restart and tears down sockets', async t => {
  const primary = await serverFixture(t);
  const secondary = await serverFixture(t, 'Backup');
  secondary.settings.websocket = false;
  secondary.settings.stats = 'denied';
  let now = 0;
  const intervalMs = 1000;
  const abort = new AbortController();
  const monitor = new LavalinkMonitor({ nodes: [primary.node, secondary.node], intervalMs, timeoutMs: 400 }, botId, {
    clock: { now: () => now },
  });
  t.after(() => monitor.close());
  const sample = () => monitor.sample(abort.signal);

  await sample();
  await until(() => monitor.manager.nodes.get('Primary')?.connected && !monitor.manager.nodes.has('Backup'));
  const [first, failed] = await sample();
  assert.equal(first.status, 'ONLINE');
  assert.equal(failed.status, 'DEGRADED');
  assert.equal(failed.stats, undefined);
  assert.equal(secondary.settings.upgrades, 1);
  assert.deepEqual(primary.settings.observedHeaders, [{
    path: '/v4/websocket', authenticated: true, bot: botId, name: 'Lavalink-Status/2.0.0',
  }]);

  primary.settings.stats = 'malformed';
  now += intervalMs;
  assert.equal((await sample())[0].stats, undefined);
  assert.equal((await sample())[0].status, 'DEGRADED');
  primary.settings.stats = 'ok';
  primary.settings.uptime = 100;
  for (const client of primary.websocket.clients) client.terminate();
  await until(() => !monitor.manager.nodes.has('Primary') && !monitor.manager.nodes.has('Backup'));
  now += intervalMs;
  await sample();
  await until(() => monitor.manager.nodes.get('Primary')?.connected);
  const [recovered] = await sample();
  assert.equal(recovered.status, 'ONLINE');
  assert.ok(recovered.startedAt > first.startedAt + 50_000);
  assert.equal(primary.settings.upgrades, 2);
  assert.ok(secondary.settings.upgrades <= 2);

  await monitor.close();
  await until(() => primary.websocket.clients.size === 0 && secondary.websocket.clients.size === 0);
  assert.equal(monitor.manager.nodes.size, 0);
});

test('retry delays are exponential and capped', async () => {
  assert.deepEqual([0, 1, 2, 50].map(failures => backoff(60_000, failures)), [60_000, 120_000, 240_000, 300_000]);
  assert.equal(backoff(900_000, 10), 900_000);
  const response = await probeStats({
    id: 'Offline', origin: 'http://127.0.0.1:1', password: 'loopback-fixture',
  }, 400, new AbortController().signal);
  assert.equal(classify(response, false).status, 'OFFLINE');
});

test('nodes are probed concurrently, with one REST probe per node each cycle', async t => {
  const primary = await serverFixture(t);
  const secondary = await serverFixture(t, 'Backup');
  const gate = Promise.withResolvers();
  const sampled = [];
  const monitor = new LavalinkMonitor({
    nodes: [primary.node, secondary.node], intervalMs: 1000, timeoutMs: 400,
  }, botId, {
    clock: { now: () => 0 },
    async probe(node) {
      sampled.push(node.id);
      return gate.promise;
    },
  });
  t.after(() => monitor.close());
  const signal = new AbortController().signal;
  const cycle = monitor.sample(signal);
  gate.resolve({ stats: fixtures });
  assert.deepEqual(sampled, ['Primary', 'Backup']);
  await cycle;
  await monitor.sample(signal);
  assert.equal(sampled.length, 2);
});

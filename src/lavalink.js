const { Manager, ManagerEventTypes } = require('pulsifyy');

const MAX_STATS_BYTES = 32 * 1024;
const TLS_FAILURES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const DNS_FAILURES = new Set(['EAI_AGAIN', 'ENODATA', 'ENOTFOUND']);

const count = value => Number.isSafeInteger(value) && value >= 0;
const load = value => value === -1 || (Number.isFinite(value) && value >= 0 && value <= 1);

function parseStats(data) {
  if (!data || !count(data.players) || !count(data.playingPlayers) ||
      data.playingPlayers > data.players || !count(data.uptime)) return null;
  const { cpu, memory } = data;
  if (!cpu || !count(cpu.cores) || cpu.cores < 1 || !load(cpu.systemLoad) || !load(cpu.lavalinkLoad) ||
      !memory || !count(memory.used) || !count(memory.allocated) || !count(memory.free) ||
      !(count(memory.reservable) || memory.reservable === -1) || memory.used > memory.allocated ||
      memory.free > memory.allocated) return null;

  return {
    players: data.players, playingPlayers: data.playingPlayers, uptime: data.uptime,
    cpu: { cores: cpu.cores, systemLoad: cpu.systemLoad, lavalinkLoad: cpu.lavalinkLoad },
    memory: { used: memory.used, allocated: memory.allocated, free: memory.free, reservable: memory.reservable },
  };
}

async function readStats(body) {
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_STATS_BYTES) return null;
      text += decoder.decode(value, { stream: true });
    }
    return parseStats(JSON.parse(text + decoder.decode()));
  } catch (error) {
    if (error instanceof SyntaxError || error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA') return null;
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function probeStats(node, timeoutMs, signal) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(node.origin + '/v4/stats', {
      headers: { Authorization: node.password, Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.any([signal, timeout]),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 401 || response.status === 403) return { issue: 'REST authentication rejected' };
      if (response.status >= 300 && response.status < 400) return { issue: 'REST redirect rejected' };
      if (response.status === 404) return { issue: 'Lavalink v4 stats route unavailable' };
      return { issue: 'REST returned HTTP ' + response.status };
    }
    const stats = await readStats(response.body);
    return stats ? { stats } : { issue: 'Invalid Lavalink statistics' };
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const code = error.cause?.code;
    if (TLS_FAILURES.has(code)) return { issue: 'REST certificate verification failed' };
    if (DNS_FAILURES.has(code)) return { unresolved: true, issue: 'REST hostname could not be resolved' };
    return { unreachable: true, issue: timeout.aborted ? 'REST request timed out' : 'REST connection failed' };
  }
}

function backoff(intervalMs, failures) {
  return Math.min(intervalMs * 2 ** Math.min(failures, 5), Math.max(intervalMs, 300_000));
}

function classify(probe, socketReady) {
  if (!probe) return { status: 'UNKNOWN', issue: 'Awaiting a fresh observation' };
  if (probe.stats) return socketReady
    ? { status: 'ONLINE' }
    : { status: 'DEGRADED', issue: 'WebSocket session unavailable' };
  if (probe.unreachable && !socketReady) return { status: 'OFFLINE', issue: probe.issue };
  if (probe.unresolved && !socketReady) return { status: 'UNKNOWN', issue: probe.issue };
  return { status: 'DEGRADED', issue: probe.issue };
}

class LavalinkMonitor {
  constructor(config, botId, { probe = probeStats, clock = performance, wallClock = Date } = {}) {
    this.config = config;
    this.probe = probe;
    this.clock = clock;
    this.wallClock = wallClock;
    this.nodes = new Map(config.nodes.map(options => [options.id, {
      options, restFailures: 0, socketFailures: 0, nextRest: 0, nextSocket: 0,
    }]));
    this.manager = new Manager({
      clientName: 'Lavalink-Status/2.0.0',
      send: () => {},
      playerInactivityTimeoutMs: 0,
      trackCacheTtlMs: 0,
    });
    this.manager.on(ManagerEventTypes.NodeConnect, node => {
      this.nodes.get(node.options.identifier).socketFailures = 0;
    });
    this.manager.on(ManagerEventTypes.NodeDestroy, node => {
      const state = this.nodes.get(node.options.identifier);
      state.nextSocket = this.clock.now() + backoff(this.config.intervalMs, state.socketFailures++);
    });
    this.manager.init(botId);
  }

  async sample(signal) {
    // The runner serializes cycles. Nodes within each cycle are independent.
    return Promise.all([...this.nodes.values()].map(state => this.checkNode(state, signal)));
  }

  async checkNode(state, signal) {
    const { options } = state;
    if (signal.aborted) throw signal.reason;
    const now = this.clock.now();
    if (now >= state.nextSocket && !this.manager.nodes.has(options.id)) {
      this.manager.createNode({
        identifier: options.id, host: options.host, port: options.port, useSSL: options.tls,
        password: options.password, apiRequestTimeoutMs: this.config.timeoutMs, maxRetryAttempts: 0,
      });
    }
    if (now >= state.nextRest) {
      const probe = await this.probe(options, this.config.timeoutMs, signal);
      const observedAt = this.wallClock.now();
      if (probe.stats) {
        const estimate = observedAt - probe.stats.uptime;
        const stableStart = probe.stats.uptime >= state.probe?.stats?.uptime &&
          Math.abs(estimate - state.startedAt) <= 2000;
        if (!stableStart) state.startedAt = estimate;
        state.restFailures = 0;
      }
      state.probe = { ...probe, observedAt };
      const delay = probe.stats ? this.config.intervalMs : backoff(this.config.intervalMs, state.restFailures++);
      state.nextRest = now + delay;
    }
    const probe = state.probe;
    const socketReady = this.manager.nodes.get(options.id)?.connected === true;
    return {
      id: options.id, ...classify(probe, socketReady),
      stats: probe?.stats, observedAt: probe?.observedAt, startedAt: probe?.stats ? state.startedAt : undefined,
    };
  }

  close() {
    return this.manager.handleShutdown();
  }
}

module.exports = { LavalinkMonitor, backoff, classify, parseStats, probeStats };

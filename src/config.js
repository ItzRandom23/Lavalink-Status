const { isIP } = require('node:net');
const { resolve } = require('node:path');

const MAX_NODES = 16;
const NODE_KEYS = new Set(['id', 'host', 'port', 'password', 'tls']);

class ConfigError extends Error {}

function snowflake(value) {
  return typeof value === 'string' && /^[1-9]\d{16,19}$/.test(value) &&
    BigInt(value) <= 18_446_744_073_709_551_615n;
}

function integer(value, label, fallback, min, max) {
  if (value === undefined) return fallback;
  const validType = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
  const number = Number(validType ? value : NaN);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new ConfigError(label + ' must be an integer from ' + min + ' to ' + max + '.');
  }
  return number;
}

function hostname(value, label) {
  const unwrapped = typeof value === 'string' && /^\[.+\]$/.test(value) ? value.slice(1, -1) : value;
  if (typeof unwrapped === 'string' && isIP(unwrapped) === 6) {
    return new URL('http://[' + unwrapped + ']').hostname;
  }
  if (typeof value === 'string' && value.length <= 253 &&
      value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part))) {
    try {
      // Reject shortened, hexadecimal and other alternate IPv4 spellings.
      if (new URL('http://' + value).hostname === value.toLowerCase()) return value.toLowerCase();
    } catch {
      // Report the field name below without echoing input.
    }
  }
  throw new ConfigError(label + ' must be a hostname or IP address without a scheme, port or path.');
}

function nodeConfig(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !NODE_KEYS.has(key))) {
    throw new ConfigError(label + ' must be an object containing only id, host, port, password and tls.');
  }
  const { id = 'Lavalink', password } = input;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9 ._-]{0,39}$/i.test(id) || id !== id.trim()) {
    throw new ConfigError(label + ' id must be 1–40 characters using letters, digits, spaces, dots, underscores or hyphens.');
  }
  if (typeof password !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(password) || password !== password.trim()) {
    throw new ConfigError(label + ' password must contain 1–512 printable ASCII characters without leading or trailing spaces.');
  }
  const host = hostname(input.host, label + ' host');
  const loopback = host === 'localhost' || host === '[::1]' || (host.startsWith('127.') && isIP(host) === 4);
  const tls = input.tls ?? !loopback;
  if (typeof tls !== 'boolean' || input.tls === null) throw new ConfigError(label + ' tls must be true or false.');
  const port = integer(input.port, label + ' port', tls ? 443 : 2333, 1, 65535);
  const origin = (tls ? 'https://' : 'http://') + host + ':' + port;
  const node = { id, host, port, tls, origin };
  Object.defineProperty(node, 'password', { value: password });
  return Object.freeze(node);
}

function loadNodes(env) {
  if (env.LAVALINK_NODES === undefined) {
    const tls = env.LAVALINK_TLS;
    if (tls !== undefined && tls !== 'true' && tls !== 'false') {
      throw new ConfigError('LAVALINK_TLS must be true or false.');
    }
    return [nodeConfig({
      id: env.LAVALINK_IDENTIFIER, host: env.LAVALINK_HOST, port: env.LAVALINK_PORT,
      password: env.LAVALINK_PASSWORD, tls: tls === undefined ? undefined : tls === 'true',
    }, 'LAVALINK')];
  }

  const singleKeys = ['HOST', 'PORT', 'PASSWORD', 'TLS', 'IDENTIFIER'];
  if (singleKeys.some(key => env['LAVALINK_' + key] !== undefined)) {
    throw new ConfigError('Set either LAVALINK_NODES or the single-node LAVALINK settings.');
  }
  let inputs;
  try {
    if (env.LAVALINK_NODES.length <= 16_384) inputs = JSON.parse(env.LAVALINK_NODES);
  } catch {
    // JSON parser errors may quote credentials.
  }
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > MAX_NODES) {
    throw new ConfigError('LAVALINK_NODES must be a JSON array of 1–' + MAX_NODES + ' nodes.');
  }
  const nodes = inputs.map((input, index) => nodeConfig(input, 'LAVALINK_NODES entry ' + (index + 1)));
  if (new Set(nodes.map(node => node.id.toLowerCase())).size !== nodes.length) {
    throw new ConfigError('LAVALINK_NODES must use unique node IDs.');
  }
  if (new Set(nodes.map(node => node.origin)).size !== nodes.length) {
    throw new ConfigError('LAVALINK_NODES must use unique endpoints.');
  }
  return nodes;
}

function loadConfig(env = process.env) {
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new ConfigError('Remove NODE_TLS_REJECT_UNAUTHORIZED=0 to enable certificate verification.');
  }
  const token = env.DISCORD_TOKEN;
  if (typeof token !== 'string' || !/^[\w-]{17,40}\.[\w-]{5,12}\.[\w-]{20,160}$/.test(token)) {
    throw new ConfigError('DISCORD_TOKEN must be a raw Discord bot token.');
  }
  const channelId = env.DISCORD_CHANNEL_ID ?? env.CHANNEL_ID;
  if (!snowflake(channelId)) throw new ConfigError('DISCORD_CHANNEL_ID must be a Discord channel ID.');
  const messageId = env.STATUS_MESSAGE_ID;
  if (messageId !== undefined && !snowflake(messageId)) {
    throw new ConfigError('STATUS_MESSAGE_ID must be a Discord message ID.');
  }
  const dataDir = env.STATUS_DATA_DIR ?? '.data';
  if (!dataDir.trim() || /[\x00-\x1f\x7f]/.test(dataDir)) {
    throw new ConfigError('STATUS_DATA_DIR must be a writable directory path.');
  }
  const config = {
    channelId, messageId, dataDir: resolve(dataDir),
    intervalMs: 1000 * integer(env.POLL_INTERVAL_SECONDS, 'POLL_INTERVAL_SECONDS', 60, 15, 900),
    timeoutMs: integer(env.LAVALINK_TIMEOUT_MS, 'LAVALINK_TIMEOUT_MS', 5000, 500, 15000),
    nodes: Object.freeze(loadNodes(env)),
  };
  Object.defineProperty(config, 'token', { value: token });
  return Object.freeze(config);
}

module.exports = { ConfigError, loadConfig, snowflake };

const TITLE = 'Lavalink Status';
const MARKER = 'Lavalink Status • managed';
const COLORS = { ONLINE: 0x2e8b57, DEGRADED: 0xc68423, OFFLINE: 0xcb484f, UNKNOWN: 0x586779 };
const CODE_FENCE = '```';
const number = new Intl.NumberFormat('en-US');

function timestamp(ms) {
  return '<t:' + Math.floor(ms / 1000) + ':R>';
}

function bytes(value) {
  if (value < 1024) return value + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  const exponent = Math.min(Math.floor(Math.log2(value) / 10), units.length);
  return (value / 1024 ** exponent).toFixed(1) + ' ' + units[exponent - 1];
}

function percent(value) {
  return value === -1 ? 'unavailable' : (value * 100).toFixed(1) + '%';
}

function uptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const parts = [
    [Math.floor(seconds / 86400), 'd'],
    [Math.floor(seconds / 3600) % 24, 'h'],
    [Math.floor(seconds / 60) % 60, 'm'],
    [seconds % 60, 's'],
  ];
  return parts.filter(([value]) => value > 0).map(([value, unit]) => value + unit).join(' ') || '0s';
}

function metricLines({ players, playingPlayers, memory, cpu }) {
  const lines = [
    'Players   ' + number.format(players) + ' connected, ' + number.format(playingPlayers) + ' playing',
    'Heap      ' + bytes(memory.used) + ' / ' + bytes(memory.allocated),
  ];
  if (memory.reservable >= 0) lines.push('Heap max  ' + bytes(memory.reservable));
  lines.push(
    'Host CPU  ' + percent(cpu.systemLoad) + ' · ' + number.format(cpu.cores) + (cpu.cores === 1 ? ' core' : ' cores'),
    'Node CPU  ' + percent(cpu.lavalinkLoad),
  );
  return lines;
}

function renderStatus(nodes) {
  const counts = {};
  const rows = nodes.map(node => {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
    const name = node.id + ' · ' + node.status;
    const lines = node.issue ? [node.issue] : [];
    const metrics = node.stats ? metricLines(node.stats) : [];
    if (node.stats) {
      if (node.issue) lines.push('');
      lines.push('Uptime    ' + uptime(node.stats.uptime), ...metrics);
    }
    if (!lines.length) lines.push('Awaiting a fresh observation');
    const observation = node.observedAt === undefined ? [] : ['Observed ' + timestamp(node.observedAt)];
    const value = [CODE_FENCE, ...lines, CODE_FENCE, ...observation].join('\n');
    // Refresh elapsed time and observation timestamps on the existing schedule.
    const summary = [node.issue, node.startedAt === undefined ? null : Math.floor(node.startedAt / 1000), ...metrics];
    return { name, summary, value };
  });
  const state = ['OFFLINE', 'DEGRADED', 'UNKNOWN'].find(status => counts[status]) ?? 'ONLINE';
  const description = Object.keys(COLORS)
    .filter(status => counts[status])
    .map(status => counts[status] + ' ' + status.toLowerCase())
    .join(' · ');
  return {
    signature: JSON.stringify(rows.map(({ name, summary }) => [name, summary])),
    embed: {
      title: TITLE,
      ...(nodes.length > 1 ? { description } : {}),
      color: COLORS[state],
      fields: rows.map(({ name, value }) => ({ name, value })),
      footer: { text: MARKER },
    },
  };
}

function isStatusMessage(message, botId) {
  if (message?.author?.id !== botId || message.webhook_id || !Array.isArray(message.embeds)) return false;
  return message.embeds.some(embed =>
    (embed?.title === TITLE && embed.footer?.text === MARKER) ||
    (embed?.author?.name === 'Lavalink Monitor' && embed.footer?.text === 'Last Update' &&
      typeof embed.description === 'string' && embed.description.startsWith('\x60\x60\x60diff\n')) ||
    embed?.description === 'Fetching Stats From Lavalink Server');
}

module.exports = { isStatusMessage, renderStatus };

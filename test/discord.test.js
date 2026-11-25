const assert = require('node:assert/strict');
const { mkdtemp, readdir, rm, rmdir, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { RateLimitError } = require('@discordjs/rest');
const { ChannelType, OverwriteType, PermissionFlagsBits, Routes } = require('discord-api-types/v10');
const { createDiscord, describeDiscordError, DiscordPublisher, discordRetryAfter, HISTORY_PENDING, identifyBot } = require('../src/discord');
const { MessageState } = require('../src/message-state');

const bot = '811111111111111111';
const other = '811111111111111112';
const channel = '822222222222222222';
const guild = '833333333333333333';
const role = '844444444444444444';
const manual = '899999999999999999';
const missing = () => Object.assign(new Error('private response body'), { status: 404, code: 10008 });
const signal = new AbortController().signal;
const required = PermissionFlagsBits.ViewChannel | PermissionFlagsBits.EmbedLinks |
  PermissionFlagsBits.SendMessages | PermissionFlagsBits.ReadMessageHistory;
const observation = [{ id: 'Node', status: 'OFFLINE', issue: 'REST connection failed', observedAt: 1000 }];
const legacy = { id: manual, author: { id: bot }, embeds: [{ description: 'Fetching Stats From Lavalink Server' }] };

async function context(t) {
  const directory = await mkdtemp(join(tmpdir(), 'lavalink-status-test-'));
  t.after(async () => {
    for (const entry of await readdir(directory)) await rm(join(directory, entry), { force: true });
    await rmdir(directory);
  });
  const config = { channelId: channel, dataDir: directory, intervalMs: 60_000 };
  let time = 1;
  const state = new MessageState(directory, bot, channel);
  const messages = new Map();
  const permissions = {
    roles: [{ id: guild, permissions: String(required) }],
    member: { roles: [] },
    overwrites: [],
  };
  const calls = { posts: [], edits: [], pages: 0 };
  const errors = {};
  const messagePath = Routes.channelMessages(channel);
  let nextId = 999999999999999999n;

  const rest = {
    async get(route, options) {
      if (route === Routes.user()) return { id: bot, bot: true };
      if (route === Routes.channel(channel)) {
        if (errors.channel) throw errors.channel;
        const last = [...messages.keys()].reduce((latest, id) => BigInt(id) > BigInt(latest) ? id : latest, '0');
        return {
          id: channel, guild_id: guild, type: ChannelType.GuildText,
          permission_overwrites: permissions.overwrites, last_message_id: last === '0' ? null : last,
        };
      }
      if (route === Routes.guildRoles(guild)) return permissions.roles;
      if (route === Routes.guildMember(guild, bot)) return permissions.member;
      if (route === messagePath) {
        calls.pages++;
        if (errors.history) throw errors.history;
        if (permissions.hideHistory) return [];
        const before = options.query.get('before');
        const descending = [...messages.values()].filter(message => !before || BigInt(message.id) < BigInt(before));
        return descending.sort((a, b) => BigInt(a.id) > BigInt(b.id) ? -1 : 1).slice(0, 100);
      }
      const item = messages.get(route.split('/').at(-1));
      if (!item) throw missing();
      return item;
    },
    async post(route, { body }) {
      assert.equal(route, messagePath);
      calls.posts.push(body);
      if (errors.beforeCreate) throw errors.beforeCreate;
      const item = { id: String(nextId++), author: { id: bot }, embeds: body.embeds };
      messages.set(item.id, item);
      if (errors.created) throw errors.created;
      return item;
    },
    async patch(route, { body }) {
      calls.edits.push({ route, body });
      if (errors.edit) throw errors.edit;
      const item = messages.get(route.split('/').at(-1));
      if (!item) throw missing();
      item.embeds = body.embeds;
      return item;
    },
  };
  return {
    calls, errors, messages, permissions, rest, state,
    tick: elapsed => { time += elapsed; },
    publisher: overrides => new DiscordPublisher(rest, { ...config, ...overrides }, bot, {
      clock: { now: () => time },
    }),
  };
}

test('one persistent status post survives restarts and only edits on change or a freshness refresh', async t => {
  const ctx = await context(t);
  let publisher = ctx.publisher();
  assert.equal(await identifyBot(ctx.rest, signal), bot);
  assert.equal(await publisher.publish(observation, signal), true);
  assert.equal(ctx.calls.posts.length, 1);
  assert.equal(ctx.calls.edits.length, 0);
  const { messageId } = await ctx.state.load();
  assert.ok(ctx.messages.has(messageId));
  assert.equal(ctx.calls.posts[0].enforce_nonce, true);
  assert.match(ctx.calls.posts[0].nonce, /^[\w-]{22}$/);
  assert.deepEqual(ctx.calls.posts[0].allowed_mentions.parse, []);

  assert.equal(await publisher.publish([{ ...observation[0], observedAt: 2000 }], signal), false);
  ctx.tick(300_000);
  await publisher.publish(observation, signal);
  assert.equal(ctx.calls.edits.length, 1);

  publisher = ctx.publisher();
  await publisher.publish(observation, signal);
  assert.equal((await ctx.state.load()).messageId, messageId);
  assert.equal(ctx.calls.edits.length, 2);
  assert.equal(ctx.calls.posts.length, 1);
  assert.equal(ctx.calls.pages, 0);
});

test('legacy posts are adopted while other authors and unrelated embeds are left alone', async t => {
  const ctx = await context(t);
  ctx.messages.set(legacy.id, structuredClone(legacy));
  const lookalike = '911111111111111111';
  const unrelated = '911111111111111112';
  ctx.messages.set(lookalike, { ...legacy, id: lookalike, author: { id: other } });
  ctx.messages.set(unrelated, { ...legacy, id: unrelated, embeds: [{ title: 'Unrelated' }] });
  await ctx.publisher({ messageId: legacy.id }).publish(observation, signal);
  assert.equal(ctx.calls.posts.length, 0);
  assert.equal(ctx.calls.edits.length, 1);
  assert.equal(ctx.calls.pages, 0);
  assert.equal((await ctx.state.load()).messageId, legacy.id);
  assert.equal(ctx.messages.size, 3);
});

test('Discord confirms a deleted message before the bot creates a replacement', async t => {
  const ctx = await context(t);
  const publisher = ctx.publisher();
  await publisher.publish(observation, signal);
  const original = ctx.calls.posts[0].nonce;
  ctx.messages.delete((await ctx.state.load()).messageId);
  ctx.tick(300_000);
  await assert.rejects(publisher.publish(observation, signal), /deleted/);
  await publisher.publish(observation, signal);
  assert.equal(ctx.calls.posts.length, 2);
  assert.notEqual(ctx.calls.posts[1].nonce, original);
  assert.equal(ctx.messages.size, 1);
  assert.equal(ctx.calls.pages, 0);
});

test('a lost create response is reconciled from disk and history on restart', async t => {
  const ctx = await context(t);
  ctx.errors.created = new Error('mock connection closed after server accepted the request');
  await assert.rejects(ctx.publisher().publish(observation, signal), /connection closed/);
  assert.ok((await ctx.state.load()).nonce);
  assert.equal(ctx.calls.posts.length, 1);
  delete ctx.errors.created;
  await ctx.publisher().publish(observation, signal);
  assert.ok((await ctx.state.load()).messageId);
  assert.equal(ctx.calls.posts.length, 1);
  assert.equal(ctx.calls.edits.length, 1);
  assert.equal(ctx.messages.size, 1);
});

test('missing channel and permissions cannot trigger a duplicate create', async t => {
  const ctx = await context(t);
  ctx.errors.channel = Object.assign(new Error('secret response details'), { status: 404, code: 10003 });
  await assert.rejects(ctx.publisher().publish(observation, signal), error => {
    assert.equal(describeDiscordError(error), 'Discord could not find the configured channel or message.');
    return true;
  });
  delete ctx.errors.channel;
  ctx.permissions.hideHistory = true;
  ctx.permissions.overwrites = [{
    id: bot, type: OverwriteType.Member, allow: '0', deny: String(PermissionFlagsBits.ReadMessageHistory),
  }];
  await assert.rejects(ctx.publisher().publish(observation, signal), /Read Message History/);
  assert.equal(ctx.calls.posts.length, 0);
  assert.equal(ctx.calls.pages, 0);
  assert.equal(await ctx.state.load(), null);

  ctx.permissions.member.roles = [role];
  ctx.permissions.roles.push({ id: role, permissions: '0' });
  ctx.permissions.overwrites = [
    { id: guild, type: OverwriteType.Role, allow: '0', deny: String(PermissionFlagsBits.ReadMessageHistory) },
    { id: role, type: OverwriteType.Role, allow: String(PermissionFlagsBits.ReadMessageHistory), deny: '0' },
  ];
  ctx.permissions.hideHistory = false;
  await ctx.publisher().publish(observation, signal);
  assert.equal(ctx.calls.posts.length, 1);
});

test('forbidden updates, foreign explicit IDs and corrupt state leave channel messages alone', async t => {
  const ctx = await context(t);
  await assert.rejects(ctx.publisher({ messageId: manual }).publish(observation, signal), /STATUS_MESSAGE_ID was not found/);
  assert.equal(ctx.calls.pages, 0);
  ctx.messages.set(manual, { ...legacy, author: { id: other } });
  await assert.rejects(ctx.publisher({ messageId: manual }).publish(observation, signal), /owned by this bot/);
  assert.equal(ctx.calls.posts.length, 0);
  await writeFile(ctx.state.path, 'corrupt');
  await assert.rejects(ctx.publisher().publish(observation, signal), /unreadable or invalid/);
  assert.equal(ctx.calls.posts.length, 0);
  await rm(ctx.state.path);
  await ctx.publisher().publish(observation, signal);
  ctx.errors.edit = Object.assign(new Error('sensitive error details'), { status: 403 });
  await assert.rejects(ctx.publisher().publish(observation, signal), error => {
    assert.equal(describeDiscordError(error), 'Discord denied access. Check channel permissions and the bot invitation.');
    return true;
  });
  assert.equal(ctx.calls.posts.length, 1);
});

function addHistory(messages, count, from = 911111111111111111n) {
  for (let i = 0; i < count; i++) {
    const id = String(from + BigInt(i));
    messages.set(id, { id, author: { id: other }, embeds: [] });
  }
}

test('interrupted send recovery resumes in bounded batches even after a temporary failure', async t => {
  const ctx = await context(t);
  addHistory(ctx.messages, 1);
  ctx.errors.created = new Error('Lost the create response');
  await assert.rejects(ctx.publisher().publish(observation, signal), /Lost the create response/);
  delete ctx.errors.created;
  addHistory(ctx.messages, 310, 1100000000000000000n);

  const publisher = ctx.publisher();
  assert.equal(await publisher.publish(observation, signal), HISTORY_PENDING);
  assert.equal(ctx.calls.pages, 3);
  assert.equal(ctx.calls.posts.length, 1);
  ctx.errors.history = new Error('Temporary fixture failure');
  await assert.rejects(publisher.publish(observation, signal), /Temporary fixture failure/);
  delete ctx.errors.history;
  assert.equal(await publisher.publish(observation, signal), true);
  assert.equal(ctx.calls.pages, 5);
  assert.equal(ctx.calls.edits.length, 1);
  assert.equal((await ctx.state.load()).messageId, '999999999999999999');
  assert.equal(ctx.calls.posts.length, 1);
});

test('an explicit status ID bypasses history pagination', async t => {
  const ctx = await context(t);
  ctx.messages.set(manual, structuredClone(legacy));
  addHistory(ctx.messages, 310);
  assert.equal(await ctx.publisher({ messageId: manual }).publish(observation, signal), true);
  assert.equal((await ctx.state.load()).messageId, manual);
  assert.equal(ctx.calls.pages, 0);
  assert.equal(ctx.calls.posts.length, 0);
});

test('first setup in a busy channel creates one post without reading message history', async t => {
  const ctx = await context(t);
  addHistory(ctx.messages, 710);
  ctx.errors.history = new Error('First setup must never fetch history');
  const publisher = ctx.publisher();
  assert.equal(await publisher.publish(observation, signal), true);
  assert.equal(ctx.calls.pages, 0);
  assert.equal(ctx.calls.posts.length, 1);
  await ctx.publisher().publish(observation, signal);
  assert.equal(ctx.calls.pages, 0);
  assert.equal(ctx.calls.posts.length, 1);
});

test('recovery retries an undelivered send with its saved nonce and stops at the recorded channel head', async t => {
  const ctx = await context(t);
  addHistory(ctx.messages, 350);
  ctx.errors.beforeCreate = new Error('Connection went away before Discord received the message');
  await assert.rejects(ctx.publisher().publish(observation, signal), /before Discord received the message/);
  const { nonce, afterId } = await ctx.state.load();
  assert.equal(afterId, '911111111111111460');
  assert.equal(ctx.calls.pages, 0);
  delete ctx.errors.beforeCreate;
  assert.equal(await ctx.publisher().publish(observation, signal), true);
  assert.equal(ctx.calls.pages, 1);
  assert.equal(ctx.calls.posts.length, 2);
  assert.equal(ctx.calls.posts[1].nonce, nonce);
  assert.equal((await ctx.state.load()).messageId, '999999999999999999');
});

test('invalid or non-progressing history pages cannot cause a post', async t => {
  const ctx = await context(t);
  addHistory(ctx.messages, 1);
  ctx.errors.beforeCreate = new Error('Connection failed');
  await assert.rejects(ctx.publisher().publish(observation, signal), /Connection failed/);
  delete ctx.errors.beforeCreate;
  addHistory(ctx.messages, 310, 1100000000000000000n);
  const original = ctx.rest.get;
  ctx.rest.get = (route, options) => {
    if (options?.query?.has('before')) options.query.delete('before');
    return original(route, options);
  };
  await assert.rejects(ctx.publisher().publish(observation, signal), /invalid channel history/);
  assert.equal(ctx.calls.posts.length, 1);
});

test('Discord rate limiting retains the longest server delay with sanitized messages', () => {
  const error = new RateLimitError({ timeToReset: 200, retryAfter: 8000, sublimitTimeout: 3000 });
  assert.equal(discordRetryAfter(error), 8000);
  assert.equal(describeDiscordError(error), 'Discord rate limit reached.');
  assert.equal(describeDiscordError(Object.assign(new Error('invalid private token'), { status: 401 })),
    'Discord rejected DISCORD_TOKEN. Verify or replace the bot token.');
});

test('Discord REST authenticates as a bot and returns rate limits to the scheduler', async t => {
  const rest = createDiscord('discord-http-fixture');
  t.after(() => {
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
  });
  const transport = t.mock.method(rest.options, 'makeRequest', async (url, options) => {
    assert.equal(url, 'https://discord.com/api/v10/users/@me');
    assert.equal(options.headers.Authorization, 'Bot discord-http-fixture');
    return new Response('{"message":"rate limited"}', {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '2.5' },
    });
  });
  await assert.rejects(identifyBot(rest, signal), error => {
    assert.ok(error instanceof RateLimitError);
    assert.ok(discordRetryAfter(error) >= 2500);
    return true;
  });
  assert.equal(transport.mock.callCount(), 1);
});

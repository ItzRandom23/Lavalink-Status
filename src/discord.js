const { randomBytes } = require('node:crypto');
const { REST, RateLimitError } = require('@discordjs/rest');
const { ChannelType, OverwriteType, PermissionFlagsBits, RESTJSONErrorCodes, Routes } = require('discord-api-types/v10');
const { snowflake } = require('./config');
const { MessageState, MessageStateError } = require('./message-state');
const { isStatusMessage, renderStatus } = require('./status');

const HISTORY_PAGE_SIZE = 100;
const HISTORY_PAGES_PER_CYCLE = 3;
const HISTORY_PENDING = Symbol('Discord history search in progress');
const SNOWFLAKE_TIMESTAMP_SHIFT = 22n;
const REQUEST_TIMEOUT_MS = 10_000;
const UNKNOWN_MESSAGE = RESTJSONErrorCodes.UnknownMessage;
const NO_MENTIONS = { parse: [], users: [], roles: [], replied_user: false };
const { Administrator, ViewChannel, SendMessages, EmbedLinks, ReadMessageHistory } = PermissionFlagsBits;
const REQUIRED_PERMISSIONS = ViewChannel | SendMessages | EmbedLinks | ReadMessageHistory;

class DiscordStatusError extends Error {}

function createDiscord(token) {
  return new REST({
    version: '10', retries: 0, timeout: REQUEST_TIMEOUT_MS, rejectOnRateLimit: () => true,
  }).setToken(token);
}

function discordRetryAfter(error) {
  if (!(error instanceof RateLimitError)) return 0;
  return Math.max(0, ...[error.retryAfter, error.timeToReset, error.sublimitTimeout].filter(Number.isFinite));
}

function describeDiscordError(error) {
  if (error instanceof DiscordStatusError || error instanceof MessageStateError) return error.message;
  if (error instanceof RateLimitError || error?.status === 429) return 'Discord rate limit reached.';
  if (error?.status === 401) return 'Discord rejected DISCORD_TOKEN. Verify or replace the bot token.';
  if (error?.status === 403) return 'Discord denied access. Check channel permissions and the bot invitation.';
  if (error?.status === 404) return 'Discord could not find the configured channel or message.';
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) {
    return 'Discord returned HTTP ' + error.status + '.';
  }
  return 'Discord request failed or timed out.';
}

function requestOptions(signal, extra) {
  return { signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]), ...extra };
}

async function identifyBot(rest, signal) {
  const user = await rest.get(Routes.user(), requestOptions(signal));
  if (!snowflake(user?.id) || user.bot !== true) throw new DiscordStatusError('Discord did not return a bot identity.');
  return user.id;
}

const bitString = value => typeof value === 'string' && /^\d{1,30}$/.test(value);

function canCreateStatus(channel, botId, roles, member) {
  const overwrites = channel.permission_overwrites;
  if (!Array.isArray(roles) || !Array.isArray(member?.roles) || !member.roles.every(snowflake) ||
      !roles.some(role => role?.id === channel.guild_id) ||
      roles.some(role => !snowflake(role?.id) || !bitString(role.permissions)) ||
      !Array.isArray(overwrites) ||
      overwrites.some(row => !snowflake(row?.id) || !bitString(row.allow) || !bitString(row.deny) ||
        (row.type !== OverwriteType.Role && row.type !== OverwriteType.Member))) {
    throw new DiscordStatusError('Discord returned incomplete channel permissions.');
  }

  const memberRoles = new Set(member.roles);
  let permissions = 0n;
  for (const role of roles) {
    if (role.id === channel.guild_id || memberRoles.has(role.id)) permissions |= BigInt(role.permissions);
  }
  if (permissions & Administrator) return true;

  const everyone = overwrites.find(row => row.type === OverwriteType.Role && row.id === channel.guild_id);
  if (everyone) permissions = (permissions & ~BigInt(everyone.deny)) | BigInt(everyone.allow);
  let deny = 0n;
  let allow = 0n;
  for (const row of overwrites) {
    if (row.type !== OverwriteType.Role || row.id === channel.guild_id || !memberRoles.has(row.id)) continue;
    deny |= BigInt(row.deny);
    allow |= BigInt(row.allow);
  }
  permissions = (permissions & ~deny) | allow;
  const override = overwrites.find(row => row.type === OverwriteType.Member && row.id === botId);
  if (override) permissions = (permissions & ~BigInt(override.deny)) | BigInt(override.allow);
  return (permissions & REQUIRED_PERMISSIONS) === REQUIRED_PERMISSIONS;
}

class DiscordPublisher {
  constructor(rest, config, botId, { clock = performance, state } = {}) {
    this.rest = rest;
    this.botId = botId;
    this.firstPossibleMessage = (BigInt(botId) >> SNOWFLAKE_TIMESTAMP_SHIFT) << SNOWFLAKE_TIMESTAMP_SHIFT;
    this.channelId = config.channelId;
    this.initialId = config.messageId;
    this.messagesRoute = Routes.channelMessages(this.channelId);
    this.state = state ?? new MessageState(config.dataDir, botId, this.channelId);
    this.clock = clock;
    this.refreshMs = Math.max(config.intervalMs, 300_000);
    this.nextRefresh = 0;
  }

  async publish(nodes, signal) {
    const { signature, embed } = renderStatus(nodes);
    const body = { embeds: [embed], allowed_mentions: NO_MENTIONS };
    if (this.messageId && signature === this.signature && this.clock.now() < this.nextRefresh) return false;
    let id = this.messageId ?? await this.recover(signal);
    if (id === HISTORY_PENDING) return HISTORY_PENDING;
    if (id) {
      let edited;
      try {
        edited = await this.rest.patch(this.messageRoute(id), requestOptions(signal, { body }));
      } catch (error) {
        if (error?.status !== 404 || error.code !== UNKNOWN_MESSAGE) throw error;
        // Recover again on the next cycle after confirming the old ID is gone.
        this.messageId = undefined;
        this.initialId = undefined;
        throw new DiscordStatusError('The status message was deleted. Recovery will run on the next cycle.');
      }
      if (edited?.id !== id || !isStatusMessage(edited, this.botId)) {
        throw new DiscordStatusError('Discord did not confirm the status message update.');
      }
    } else {
      const { nonce } = this.pending;
      const created = await this.rest.post(this.messagesRoute, requestOptions(signal, {
        body: { ...body, nonce, enforce_nonce: true },
      }));
      if (!snowflake(created?.id) || !isStatusMessage(created, this.botId)) {
        throw new DiscordStatusError('Discord returned an unexpected status message. Recovery will check channel history.');
      }
      id = created.id;
      await this.state.save({ messageId: id });
      this.pending = undefined;
    }
    this.messageId = id;
    this.signature = signature;
    this.nextRefresh = this.clock.now() + this.refreshMs;
    return true;
  }

  async getChannel(signal) {
    const channel = await this.rest.get(Routes.channel(this.channelId), requestOptions(signal));
    if (channel?.id !== this.channelId || !snowflake(channel.guild_id) ||
        (channel.type !== ChannelType.GuildText && channel.type !== ChannelType.GuildAnnouncement)) {
      throw new DiscordStatusError('DISCORD_CHANNEL_ID must point to a server text or announcement channel.');
    }
    return channel;
  }

  async recover(signal) {
    const channel = await this.getChannel(signal);
    const saved = await this.state.load();
    const id = saved?.messageId ?? this.initialId;
    if (id) {
      try {
        const message = await this.rest.get(this.messageRoute(id), requestOptions(signal));
        if (message?.id !== id || !isStatusMessage(message, this.botId)) {
          throw new DiscordStatusError('The configured or saved message is not a status message owned by this bot.');
        }
        if (saved?.messageId !== id) await this.state.save({ messageId: id });
        this.history = undefined;
        return id;
      } catch (error) {
        if (error?.status !== 404 || error.code !== UNKNOWN_MESSAGE) throw error;
        if (!saved?.messageId) {
          throw new DiscordStatusError('STATUS_MESSAGE_ID was not found in the configured channel. Check the ID or remove it for a new setup.');
        }
      }
    }

    const pending = saved?.nonce ? saved : undefined;
    if (pending) {
      const result = await this.findPendingMessage(pending, signal);
      if (result === HISTORY_PENDING) return HISTORY_PENDING;
      if (result) {
        await this.state.save({ messageId: result.id });
        this.history = undefined;
        return result.id;
      }
    }

    // Read Message History is needed if a later send response is lost.
    const [roles, member] = await Promise.all([
      this.rest.get(Routes.guildRoles(channel.guild_id), requestOptions(signal)),
      this.rest.get(Routes.guildMember(channel.guild_id, this.botId), requestOptions(signal)),
    ]);
    if (!canCreateStatus(channel, this.botId, roles, member)) {
      throw new DiscordStatusError('Grant the bot View Channel, Send Messages, Embed Links and Read Message History.');
    }

    const afterId = channel.last_message_id ?? null;
    if (!pending && afterId !== null && !snowflake(afterId)) {
      throw new DiscordStatusError('Discord returned an invalid last message ID.');
    }
    this.pending = pending ?? { nonce: randomBytes(16).toString('base64url'), afterId };
    if (!pending) await this.state.save(this.pending);
    this.history = undefined;
    return undefined;
  }

  async findPendingMessage(pending, signal) {
    if (this.history?.nonce !== pending.nonce) {
      this.history = { nonce: pending.nonce, before: undefined };
    }
    const history = this.history;
    const floor = pending.afterId ? BigInt(pending.afterId) : this.firstPossibleMessage - 1n;
    for (let page = 0; page < HISTORY_PAGES_PER_CYCLE; page++) {
      const query = new URLSearchParams({ limit: String(HISTORY_PAGE_SIZE) });
      if (history.before) query.set('before', history.before);
      const messages = await this.rest.get(this.messagesRoute, requestOptions(signal, { query }));
      if (!Array.isArray(messages) || messages.length > HISTORY_PAGE_SIZE) {
        throw new DiscordStatusError('Discord returned invalid channel history.');
      }
      let previous = history.before === undefined ? undefined : BigInt(history.before);
      for (const message of messages) {
        if (!snowflake(message?.id) || (previous !== undefined && BigInt(message.id) >= previous)) {
          throw new DiscordStatusError('Discord returned invalid channel history.');
        }
        previous = BigInt(message.id);
      }
      const message = messages.find(candidate => BigInt(candidate.id) > floor && isStatusMessage(candidate, this.botId));
      if (message) return message;
      if (messages.length < HISTORY_PAGE_SIZE || previous <= floor) return undefined;
      history.before = messages.at(-1).id;
    }
    return HISTORY_PENDING;
  }

  messageRoute(id) {
    return Routes.channelMessage(this.channelId, id);
  }
}

module.exports = {
  createDiscord, describeDiscordError, DiscordPublisher, DiscordStatusError, discordRetryAfter, HISTORY_PENDING, identifyBot,
};

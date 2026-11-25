const { randomBytes } = require('node:crypto');
const { mkdir, readFile, rename, rm, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { snowflake } = require('./config');

class MessageStateError extends Error {}

function valid(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (Object.keys(record).length === 1 && snowflake(record.messageId)) return true;
  return Object.keys(record).length === 2 &&
    typeof record.nonce === 'string' && /^[a-z0-9_-]{22}$/i.test(record.nonce) &&
    (record.afterId === null || snowflake(record.afterId));
}

class MessageState {
  constructor(directory, botId, channelId) {
    this.directory = directory;
    this.path = join(directory, 'status-' + botId + '-' + channelId + '.json');
  }

  async load() {
    try {
      const record = JSON.parse(await readFile(this.path, 'utf8'));
      if (valid(record)) return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
    }
    throw new MessageStateError('Status state is unreadable or invalid. Check STATUS_DATA_DIR and recover the message ID.');
  }

  async save(record) {
    const temporary = this.path + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600, flush: true });
      await rename(temporary, this.path);
    } catch {
      throw new MessageStateError('Status state could not be saved. Check write access and free disk space for STATUS_DATA_DIR.');
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
}

module.exports = { MessageState, MessageStateError };

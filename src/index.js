const { setTimeout: wait } = require('node:timers/promises');
const { ConfigError, loadConfig } = require('./config');
const {
  createDiscord, describeDiscordError, DiscordPublisher, DiscordStatusError, discordRetryAfter, HISTORY_PENDING, identifyBot,
} = require('./discord');
const { backoff, LavalinkMonitor } = require('./lavalink');

const HEALTH_LOG_MS = 300_000;
const PUBLISH_DEADLINE_MS = 20_000;
const CONFIG_EXIT = 78;

async function authenticate(rest, signal) {
  for (let failures = 0; !signal.aborted; failures++) {
    try {
      return await identifyBot(rest, signal);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = describeDiscordError(error);
      if (error?.status === 401 || error?.status === 403 || error instanceof DiscordStatusError) {
        throw new ConfigError(message);
      }
      console.warn('[Discord] ' + message + ' Retrying bot authentication.');
      await wait(Math.max(backoff(5000, failures), discordRetryAfter(error)), null, { signal });
    }
  }
}

async function monitorLoop(config, monitor, publisher, signal) {
  let nextPublish = 0;
  let publishFailures = 0;
  let lastPublishError;
  let discordState = 'ok';
  let lastHealth;
  let nextHealthLog = 0;
  while (!signal.aborted) {
    const observations = await monitor.sample(signal);
    const now = performance.now();
    if (now >= nextPublish && !signal.aborted) {
      try {
        const result = await publisher.publish(observations, AbortSignal.any([signal, AbortSignal.timeout(PUBLISH_DEADLINE_MS)]));
        if (result !== HISTORY_PENDING && discordState === 'retrying') console.info('[Discord] Status publishing recovered.');
        discordState = result === HISTORY_PENDING ? 'scanning history' : 'ok';
        lastPublishError = undefined;
        publishFailures = 0;
        nextPublish = 0;
      } catch (error) {
        if (signal.aborted) break;
        const message = describeDiscordError(error);
        if (error?.status === 401) throw new ConfigError(message);
        if (message !== lastPublishError || now >= nextHealthLog) console.warn('[Discord] ' + message);
        lastPublishError = message;
        discordState = 'retrying';
        nextPublish = performance.now() + Math.max(backoff(config.intervalMs, publishFailures++), discordRetryAfter(error));
      }
    }

    const nodes = observations.map(({ id, status, issue }) => id + '=' + status + (issue ? ' (' + issue + ')' : '')).join(', ');
    const health = nodes + ' | Discord ' + discordState;
    if (health !== lastHealth || now >= nextHealthLog) {
      console.info('[Health] ' + health);
      lastHealth = health;
      nextHealthLog = now + HEALTH_LOG_MS;
    }
    await wait(config.intervalMs, null, { signal });
  }
}

async function main() {
  const config = loadConfig();
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const rest = createDiscord(config.token);
  let monitor;
  try {
    const botId = await authenticate(rest, abort.signal);
    if (abort.signal.aborted) return;
    monitor = new LavalinkMonitor(config, botId);
    const publisher = new DiscordPublisher(rest, config, botId);
    await monitorLoop(config, monitor, publisher, abort.signal);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    abort.abort();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
    await monitor?.close();
  }
}

if (require.main === module) {
  main().catch(error => {
    if (error instanceof ConfigError) {
      console.error('[Configuration] ' + error.message);
      process.exitCode = CONFIG_EXIT;
    } else {
      console.error('[Fatal] The monitor stopped unexpectedly.');
      process.exitCode = 1;
    }
  });
}

module.exports = { monitorLoop };

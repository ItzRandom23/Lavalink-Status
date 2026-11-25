# Lavalink Status

Lavalink Status monitors Lavalink v4 nodes and keeps one health message updated in a Discord server channel. It checks the authenticated WebSocket session through Pulsifyy and reads fresh statistics from the authenticated REST API. It can monitor up to 16 nodes independently.

The status message shows connected and playing players, node uptime, JVM heap usage and capacity, CPU cores, and load percentages. Discord displays the observation time as a relative timestamp. [Lavalink v4 REST API](https://lavalink.dev/api/rest) · [Lavalink v4 WebSocket API](https://lavalink.dev/api/websocket) · [Pulsifyy](https://www.npmjs.com/package/pulsifyy)

Discord publishing uses the REST API. The bot can appear offline in the server's member list while the status message continues to update.

## Setup

1. Install an up-to-date Node.js 22, 24, or 26 LTS release. The minimum for Node.js 22 is 22.19.0. Have a running Lavalink v4 node and a Discord application with a bot user. [Node.js release schedule](https://nodejs.org/en/about/previous-releases)
2. Invite the bot with the `bot` OAuth2 scope. On the target server text or announcement channel, grant **View Channel**, **Read Message History**, **Send Messages**, and **Embed Links**. Privileged intents can stay disabled. Copy the channel ID with Discord Developer Mode.
3. From the repository directory, install the locked dependencies and copy the configuration template. On Windows, use `Copy-Item .env.example .env` for the second command.

   ```sh
   npm ci --omit=dev --ignore-scripts
   cp .env.example .env
   ```

4. Set `DISCORD_TOKEN`, `DISCORD_CHANNEL_ID`, and `LAVALINK_PASSWORD` in `.env`. Update the host, port, and TLS setting for your node. Protect the file with mode `0600` on Linux. On Windows, restrict its access to your account or service account.
5. Run `npm start`. The first cycle should log node states and Discord publishing status. Use Ctrl+C to stop the monitor.

## Configuration

| Variable | Setting |
| --- | --- |
| `DISCORD_TOKEN` | Required. Raw bot token from the Discord Developer Portal. |
| `DISCORD_CHANNEL_ID` | Required. Discord server text or announcement channel ID. `CHANNEL_ID` is accepted for older setups. |
| `LAVALINK_HOST` | Single-node hostname or IP address. Leave out the scheme, port, and path. |
| `LAVALINK_PASSWORD` | Single-node password from the Lavalink server configuration. |
| `LAVALINK_IDENTIFIER` | Display name, default `Lavalink`. Use 1–40 letters, digits, spaces, dots, underscores, or hyphens, starting with a letter or digit. |
| `LAVALINK_TLS` | `true` for HTTPS/WSS or `false` for HTTP/WS. Defaults to true for non-loopback hosts and false for loopback. |
| `LAVALINK_PORT` | Single-node port. Defaults to 443 with TLS or 2333 with cleartext. |
| `LAVALINK_NODES` | JSON array of 1–16 nodes. Each takes `id`, `host`, `password`, and optional `port` and `tls`. Use distinct names and endpoints. Remove the single-node settings when using this variable. |
| `POLL_INTERVAL_SECONDS` | Wait after each cycle, 15–900 seconds. Default 60. |
| `LAVALINK_TIMEOUT_MS` | Lavalink request deadline, 500–15,000 milliseconds. Default 5,000. |
| `STATUS_DATA_DIR` | Writable, persistent state directory. Defaults to `.data` under the working directory. |
| `STATUS_MESSAGE_ID` | Optional existing status message ID for migration or recovery. The post must belong to the configured bot and channel. A saved message ID takes precedence. |

For a TLS proxy, both `/v4/stats` and WebSocket upgrades on `/v4/websocket` must reach Lavalink. Pulsifyy also requests `/v4/info` when the WebSocket connects. With a private CA, set `NODE_EXTRA_CA_CERTS` in the service environment before Node.js starts. Keep certificate verification enabled. Use cleartext only on loopback or a trusted private network.

Example multi-node value. Replace the example passwords locally.

```dotenv
LAVALINK_NODES='[{"id":"Primary","host":"audio.example.net","port":443,"tls":true,"password":"replace-primary"},{"id":"Local backup","host":"127.0.0.1","port":2333,"tls":false,"password":"replace-backup"}]'
```

## Health states

| Status | Meaning |
| --- | --- |
| **ONLINE** | The current REST probe returned valid statistics and Pulsifyy has an authenticated, ready WebSocket session. |
| **DEGRADED** | One check failed, or REST responded with an authentication, certificate, HTTP, or data error. Valid REST metrics may still be shown when WebSocket readiness is missing. |
| **OFFLINE** | REST timed out or could not connect and there is no ready WebSocket session. |
| **UNKNOWN** | No usable observation is available, or DNS could not resolve the endpoint and there is no ready WebSocket session. |

Failed REST checks remove the prior metrics. The **Observed** line gives the time of the REST result, including during backoff. Each node's code block shows elapsed uptime at that observation, heap used and allocated in binary units, and CPU load as a percentage. A JVM that reports an unavailable CPU load displays it as unavailable. Frame counters are omitted because the REST statistics endpoint does not provide them.

The bot polls healthy nodes once per cycle. Failed REST and WebSocket checks retry independently with exponential backoff, normally capped at five minutes or the configured polling interval if it is longer. Discord edits follow visible changes or refresh the observation times around every five minutes at the default polling interval. Discord rate-limit delays are respected independently of Lavalink polling.

## Upgrade and message recovery

- Migrate any locally edited settings from `src/config.js` into `.env` before starting. If your old deployment used port 443, check the actual protocol used by the endpoint before setting `LAVALINK_TLS`.
- Use one running monitor per bot and channel, with a persistent `STATUS_DATA_DIR`. Keep the directory across updates and host restarts.
- On a fresh setup, the bot creates one status post and saves its ID. Restarts reuse that ID. If the channel already has a status post from this bot and you are migrating or have lost the state file, set `STATUS_MESSAGE_ID` to adopt that post before starting.
- If Discord confirms that the saved status post was deleted, the monitor creates a replacement on a subsequent cycle. After an interrupted send, it searches messages newer than the channel's last known message before that send. In a busy channel, `Discord scanning history` indicates that recovery will continue in batches of up to 300 messages per cycle.
- If the state file is corrupt, stop the service and move that file aside. Set `STATUS_MESSAGE_ID` to the existing post and restart.

## Linux VPS

Install Node.js and the locked production dependencies first. The example assumes an existing unprivileged `lavalink-status` Linux account, a checkout at `/opt/lavalink-status`, and an environment file readable by that account at `/etc/lavalink-status/status.env`. Adjust the Node binary path to match your installation.

```ini
[Unit]
Description=Lavalink Status Discord monitor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=lavalink-status
Group=lavalink-status
WorkingDirectory=/opt/lavalink-status
StateDirectory=lavalink-status
StateDirectoryMode=0700
Environment=STATUS_DATA_DIR=/var/lib/lavalink-status
ExecStart=/usr/bin/node --env-file=/etc/lavalink-status/status.env /opt/lavalink-status/src/index.js
Restart=on-failure
RestartSec=10s
RestartPreventExitStatus=78
TimeoutStopSec=25s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Save the unit as `/etc/systemd/system/lavalink-status.service`, then run `sudo systemctl daemon-reload` and `sudo systemctl enable --now lavalink-status`. Check service state with `systemctl status lavalink-status` and recent health reports with `journalctl -u lavalink-status -n 50`. The monitor writes a periodic health line and one for each status change. It opens no inbound listener.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Exit code 78 | Fix the reported environment setting or Discord bot authentication, then restart the service. A token should not have a `Bot ` prefix. |
| Discord cannot publish | Check the channel ID, the invitation, the four required channel permissions, and write access to the state directory. |
| REST authentication rejected | Confirm the monitor password exactly matches the node or your proxy's configured authentication. |
| REST succeeds while the node is degraded | Check that the proxy forwards WebSocket upgrades and the required Lavalink headers, including `Authorization`, `User-Id`, and `Client-Name`. Also check that `/v4/info` is available. |
| REST certificate verification failed | Confirm the certificate is trusted, the configured hostname matches it, and the server sends the full chain. |
| Duplicate posts predating the upgrade | Copy the ID of the post to retain and let the bot adopt it. A server moderator can remove older posts manually. |

## Development

```sh
npm ci --ignore-scripts
npm run check
npm audit --audit-level=moderate
```

The project runs directly on Node.js. Tests use loopback Lavalink protocol fixtures and mocked Discord responses and require no bot token or external node.

Released under the [MIT license](LICENSE).

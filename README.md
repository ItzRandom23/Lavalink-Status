<center><img src="https://capsule-render.vercel.app/api?type=waving&color=gradient&height=200&section=header&text=Lavalink_Status&fontSize=80&fontAlignY=35&animation=twinkling&fontColor=gradient" /></center>

A Discord bot based on `discord.js` that sends the status of the Lavalink node used in music bots to play music.

## Features

- Fetch and display the status of the connected Lavalink node.
- Show useful information like node uptime, players connected, and memory usage.
- Easy to configure and deploy.

## Prerequisites

- Node.js v16 or higher
- npm
- A Discord bot token
- A running Lavalink server

## Installation

1. Clone the repository:

    ```bash
    git clone https://github.com/ItzRandom23/Lavalink-Status.git
    cd lavalink-status-bot
    ```

2. Install dependencies:

    ```bash
    npm install
    ```

3. Update the `config.js` file with the following code to use environment variables:

    ```javascript
    module.exports = {
      token: process.env.DISCORD_TOKEN || "", // Your bot token
      channelId: process.env.CHANNEL_ID || "", // Channel Id you want to send the message

      nodes: [
        {
          host: process.env.LAVALINK_HOST || "", // Lavalink IP 
          password: process.env.LAVALINK_PASSWORD || "", // Lavalink Password
          port: process.env.LAVALINK_PORT || 443, // Lavalink Port
          retryDelay: 300000,
          retryAmount: 25,
          identifier: process.env.LAVALINK_IDENTIFIER || "", // Name of your lavalink 
          secure: false,
        },
      ],
    };
    ```

## Usage

1. Start the bot:

    ```bash
    npm start
    ```

2. Invite the bot to your Discord server before starting it up.

## Example Output
![preview](https://media.discordapp.net/attachments/1118398421406068796/1270050249112682689/image.png?ex=66b249f7&is=66b0f877&hm=4f95fad3f199e9d0594715e2de6fbd59ba21e4e482f706a67bd0e3e2c0ff4534&=&format=webp&quality=lossless&width=968&height=556))


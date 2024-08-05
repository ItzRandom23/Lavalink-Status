module.exports = {
    token: process.env.token || "", // Your bot token
    channelId: process.env.channelId || "", //Channel Id you want to send the message
  
    nodes: [
      {
        host: "", // Lavalink IP 
        password: "", // Lavalink Password
        port: 443, // Lavalink Port
        retryDelay: 300000,
        retryAmount: 25,
        identifier: "", //Name of you lavalink 
        secure: false,
      },
      ],
  };
  
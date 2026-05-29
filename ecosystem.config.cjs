module.exports = {
  apps: [
    {
      name: "moviebox-api",
      script: "index.js",
      cwd: "/home/azureuser/myapi",
      env: {
        NODE_ENV: "production",
        PORT: 7860,
        // Pointe vers le serveur stream (proxy-server.js sur ce VPS ou ailleurs)
        STREAM_PROXY_URL: "https://apii.freehandyflix.online"
      }
    }
  ]
};

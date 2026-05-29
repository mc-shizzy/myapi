module.exports = {
  apps: [
    {
      name: "moviebox-stream-proxy",
      script: "index.js",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
        PORT: 7860,
        PROXY_PUBLIC_URL: "https://apii.freehandyflix.online"
      }
    }
  ]
};

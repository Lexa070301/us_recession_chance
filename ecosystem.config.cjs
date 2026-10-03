// pm2 process config — `npm run build && pm2 start ecosystem.config.cjs`
module.exports = {
  apps: [
    {
      name: "recession-monitor",
      script: "dist/index.js",
      args: "all", // bot + scheduler in one process
      env: { NODE_ENV: "production" },
      max_memory_restart: "400M",
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,
      out_file: "logs/out.log",
      error_file: "logs/err.log",
      time: true,
    },
  ],
};

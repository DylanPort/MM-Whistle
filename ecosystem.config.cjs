/**
 * PM2 Ecosystem Configuration
 * 
 * This ensures the server NEVER stops:
 * - Auto-restarts on crash
 * - Auto-restarts on memory issues
 * - Restarts on file changes (optional)
 * - Persistent across system reboots
 * 
 * Usage:
 *   npm install -g pm2
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup  (to persist across reboots)
 */

module.exports = {
    apps: [{
        name: 'pump-mm-direct',
        script: 'server.js',
        cwd: __dirname,
        
        // NEVER let it die
        autorestart: true,
        max_restarts: -1,  // Unlimited restarts
        restart_delay: 3000,  // Wait 3 sec between restarts
        
        // Memory management
        max_memory_restart: '1G',
        
        // Logging
        error_file: './logs/error.log',
        out_file: './logs/output.log',
        log_date_format: 'YYYY-MM-DD HH:mm:ss',
        merge_logs: true,
        
        // Environment
        env: {
            NODE_ENV: 'production',
            PORT: 3333
        },
        
        // Watch for changes (optional - disable in production)
        watch: false,
        ignore_watch: ['node_modules', 'logs', '*.db'],
        
        // Cluster mode (optional - use if you need multiple instances)
        instances: 1,
        exec_mode: 'fork',
        
        // Graceful shutdown
        kill_timeout: 10000,
        wait_ready: true,
        listen_timeout: 10000
    }]
};


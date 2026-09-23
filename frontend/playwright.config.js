import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    retries: 0,
    reporter: [['list']],
    use: {
        baseURL: 'http://127.0.0.1:3001',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        ...devices['Desktop Chrome'],
        channel: 'chrome',
    },
    webServer: [
        {
            command: 'node e2e/mock-api.js',
            port: 4041,
            reuseExistingServer: false,
        },
        {
            command: 'npm run dev -- --host 127.0.0.1 --port 3001',
            port: 3001,
            reuseExistingServer: false,
            env: { VITE_API_URL: 'http://127.0.0.1:4041/api/v1' },
        },
    ],
});

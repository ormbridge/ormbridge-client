import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';
import { execSync } from 'child_process';

// Configure test server ports
const TEST_PORTS = {
  react: 3001,
  vue: 3002,
  svelte: 3003
};

// Server processes to be terminated after tests
const serverProcesses: { [key: string]: any } = {};

/**
 * Waits for the test server to be available.
 */
async function waitForServer(url: string, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await fetch(url, { method: 'HEAD' });
      return;
    } catch (e) {
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  throw new Error(`Server did not start at ${url}`);
}

/**
 * Set up a test app for a framework using pre-generated apps in place
 */
function setupTestApp(framework: 'react' | 'vue' | 'svelte', port: number) {
  const appDir = path.resolve(__dirname, `./test-apps/${framework}-test-app`);

  console.log(`Setting up ${framework} test app at ${appDir}`);

  // Ensure dependencies are installed
  if (!fs.existsSync(path.join(appDir, 'node_modules'))) {
    console.log(`Installing dependencies for ${framework} test app`);
    execSync('npm install', { cwd: appDir });
  }

  // Start test server
  console.log(`Starting ${framework} test server on port ${port}`);
  const serverProcess = execSync(`npx http-server ${appDir} -p ${port} --silent &`);
  serverProcesses[framework] = serverProcess;

  return {
    url: `http://localhost:${port}`,
    teardown: () => {
      try {
        if (serverProcesses[framework]) {
          process.kill(serverProcesses[framework].pid);
          delete serverProcesses[framework];
        }
      } catch (e) {
        console.warn(`Could not kill ${framework} server process:`, e);
      }
    }
  };
}

// Global teardown to ensure all servers are terminated
test.afterAll(() => {
  Object.keys(serverProcesses).forEach(framework => {
    try {
      process.kill(serverProcesses[framework].pid);
      console.log(`Terminated ${framework} server process`);
    } catch (e) {
      console.warn(`Could not kill ${framework} server process:`, e);
    }
  });
});

// Test each framework adapter
test.describe('Framework Adapter E2E Tests', () => {
  test('React adapter should correctly integrate with ReactDOM', async ({ page }) => {
    const { url, teardown } = setupTestApp('react', TEST_PORTS.react);
    await waitForServer(url);
    
    try {
      await page.goto(url);
      await page.waitForSelector('.statezero-test');

      const initialCount = await page.locator('#item-count').innerText();
      await page.click('#add-item');
      await page.waitForFunction((count) => document.querySelector('#item-count').innerText > count, initialCount);
      
      const newCount = await page.locator('#item-count').innerText();
      expect(Number(newCount)).toBeGreaterThan(Number(initialCount));

      await page.click('#update-items');
      await page.waitForSelector('.item:has-text("Updated Item")');

      await page.click('#delete-items');
      await page.waitForFunction(() => document.querySelector('#item-count').innerText === '0');

      const finalCount = await page.locator('#item-count').innerText();
      expect(finalCount).toBe('0');
    } finally {
      teardown();
    }
  });
});

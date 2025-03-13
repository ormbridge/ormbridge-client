import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import pkg from 'fs-extra';
import inquirer from 'inquirer';
import { generateReactApp } from './generators/react-generator.js';
import { generateVueApp } from './generators/vue-generator.js';

const { ensureDirSync, removeSync } = pkg;

// Base directories - ES module equivalent for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const testAppsDir = path.join(rootDir, 'tests/adaptors/test-apps');

// Make sure test-apps directory exists
ensureDirSync(testAppsDir);

/**
 * Prompts the user to select which framework app to generate.
 */
async function promptFramework() {
  const { framework } = await inquirer.prompt([
    {
      type: 'list',
      name: 'framework',
      message: 'Which app would you like to generate?',
      choices: [
        { name: 'React', value: 'react' },
        { name: 'Vue', value: 'vue' },
        { name: 'All (React and Vue)', value: 'all' }
      ],
      default: 'all'
    }
  ]);
  return framework;
}

/**
 * Generates the test apps based on the selected framework.
 */
async function generateTestApps(framework) {
  console.log('Generating test apps...');
  console.log(`Test apps will be created in: ${testAppsDir}`);

  // Clean previous test apps
  console.log('Cleaning previous test apps...');
  if (fs.existsSync(testAppsDir)) {
    fs.readdirSync(testAppsDir).forEach(dir => {
      removeSync(path.join(testAppsDir, dir));
    });
  }

  // Generate app(s) based on the selection
  if (framework === 'react') {
    console.log('Generating React app...');
    await generateReactApp(testAppsDir);
    console.log('React app generated successfully!');
  } else if (framework === 'vue') {
    console.log('Generating Vue app...');
    await generateVueApp(testAppsDir);
    console.log('Vue app generated successfully!');
  } else if (framework === 'all') {
    console.log('Generating apps for all frameworks...');
    await Promise.all([
      generateReactApp(testAppsDir),
      generateVueApp(testAppsDir),
    ]);
    console.log('All test apps generated successfully!');
  } else {
    console.error('Unknown framework specified.');
    process.exit(1);
  }

  console.log(`Test apps are available at: ${testAppsDir}`);
}

/**
 * Runs the CLI interface.
 */
async function run() {
  try {
    const framework = await promptFramework();
    await generateTestApps(framework);
  } catch (err) {
    console.error('Error generating test apps:', err);
    process.exit(1);
  }
}

run();
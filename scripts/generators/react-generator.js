import path from 'path';
import { execSync } from 'child_process';
import { writeFile, createORMBridgeConfig } from '../utils.js';
import fs from 'fs-extra';
const { ensureDirSync } = fs;

export function generateReactApp(testAppsDir) {
  const appDir = path.join(testAppsDir, 'react-app');
  const parentDir = path.dirname(appDir);
  const appDirName = path.basename(appDir);
  
  console.log(`Generating React test app with Vite in ${appDir}...`);
  
  // Ensure parent directory exists
  ensureDirSync(parentDir);
  
  // Execute Vite create command in parent directory with relative path
  execSync(`cd "${parentDir}" && npm create vite@latest ${appDirName} -- --template react-ts`, { 
    stdio: 'inherit', 
    shell: true 
  });
  
  // Install dependencies
  execSync(`npm install`, { cwd: appDir, stdio: 'inherit' });
  
  // Install ORMBridge
  execSync(`npm install github:statezero/statezero-client`, { cwd: appDir, stdio: 'inherit' });
  
  // Create src directory structure
  const srcDir = path.join(appDir, 'src');
  
  // Create models directory structure within src to prepare for generated models
  const modelsDir = path.join(srcDir, 'models');
  const backend1Dir = path.join(modelsDir, 'backend1');
  fs.mkdirSync(backend1Dir, { recursive: true });
  
  // Create a placeholder README in the models directory to ensure it exists
  writeFile(
    path.join(backend1Dir, 'README.md'), 
    '# ORMBridge Generated Models\n\nThis directory will contain auto-generated models from the ORMBridge library.'
  );
  
  // Create ORMBridge config in src folder with proper configuration
  createORMBridgeConfig(srcDir);
  
  // Run statezero sync-models command - models will be generated in src/models now
  console.log('Syncing models...');
  execSync('npx statezero sync-models', { cwd: appDir, stdio: 'inherit' });
  
  // Create test component AFTER models are generated
  createReactTestComponent(appDir);
  
  // Update React entry point to register ORMBridge config
  updateReactEntryPoint(appDir);

  // Update tsconfig.json for better compatibility
  updateTsConfig(appDir);
  
  console.log('✅ React test app with Vite generated successfully!');
  return appDir;
}

function createReactTestComponent(appDir) {
  // Create ORMBridgeTest.tsx with the proper import path to the generated models
  const testComponent = `
import React from 'react';
import { useReactLiveView } from '@statezero/core';
import { DummyModel } from '../models/backend1'

function ORMBridgeTest() {
  // Use the hook directly, getting the data, query and loading state
  const [items, liveQuery, isLoading] = useReactLiveView(DummyModel.objects.all());
  
  const addItem = async () => {
    if (liveQuery) {
      await liveQuery.create({ name: 'New Item', value: Math.floor(Math.random() * 100) });
    }
  };
  
  const updateAllItems = async () => {
    if (liveQuery) {
      await liveQuery.update({ name: 'Updated Item' });
    }
  };
  
  const deleteAllItems = async () => {
    if (liveQuery) {
      await liveQuery.delete();
    }
  };
  
  return (
    <div className="statezero-test">
      <h1>ORMBridge React Test</h1>
      
      <div className="controls">
        <button id="add-item" onClick={addItem} disabled={isLoading || !liveQuery}>Add Item</button>
        <button id="update-items" onClick={updateAllItems} disabled={isLoading || !liveQuery}>Update All</button>
        <button id="delete-items" onClick={deleteAllItems} disabled={isLoading || !liveQuery}>Delete All</button>
      </div>
      
      <div className="items-container">
        <h2>Items: <span id="item-count">{items.length}</span></h2>
        {isLoading ? (
          <p>Loading...</p>
        ) : (
          <ul id="items-list">
            {items.map((item, index) => (
              <li key={item.id || index} className="item" data-id={item.id}>
                <strong>{item.name}</strong>: {item.value}
              </li>
            ))}
          </ul>
        )}
      </div>
      
      <style>{\`
        .statezero-test {
          font-family: Arial, sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
        }
        
        .controls {
          margin-bottom: 20px;
        }
        
        button {
          margin-right: 10px;
          padding: 8px 16px;
          background-color: #4CAF50;
          color: white;
          border: none;
          border-radius: 4px;
          cursor: pointer;
        }
        
        button:disabled {
          background-color: #cccccc;
          cursor: not-allowed;
        }
        
        .items-container {
          border: 1px solid #ddd;
          padding: 15px;
          border-radius: 4px;
        }
        
        .item {
          padding: 10px;
          margin-bottom: 5px;
          border: 1px solid #ddd;
          border-radius: 4px;
          background-color: #f9f9f9;
        }

        .statezero-error {
          font-family: Arial, sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          color: #721c24;
          background-color: #f8d7da;
          border: 1px solid #f5c6cb;
          border-radius: 4px;
        }
      \`}</style>
    </div>
  );
}

export default ORMBridgeTest;
`;
  writeFile(path.join(appDir, 'src/ORMBridgeTest.tsx'), testComponent);
  
  // Update App.tsx
  const appContent = `
import React from 'react';
import './App.css';
import ORMBridgeTest from './ORMBridgeTest';

function App() {
  return (
    <div className="App">
      <ORMBridgeTest />
    </div>
  );
}

export default App;
`;
  writeFile(path.join(appDir, 'src/App.tsx'), appContent);
}

function updateReactEntryPoint(appDir) {
  const entryFilePath = path.join(appDir, 'src', 'main.tsx');
  // Update import path to use config from within src
  const entryContent = `
import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import config from './statezero.config.js';
import { configInstance } from '@statezero/core';
import App from './App';

async function init() {
  configInstance.setConfig(config);
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

init();
`;
  writeFile(entryFilePath, entryContent);
}

function updateTsConfig(appDir) {
  const tsConfigPath = path.join(appDir, 'tsconfig.json');
  const tsConfig = {
    "compilerOptions": {
      "target": "ES2020",
      "useDefineForClassFields": true,
      "lib": ["ES2020", "DOM", "DOM.Iterable"],
      "module": "ESNext",
      "skipLibCheck": true,
      
      /* Bundler mode */
      "moduleResolution": "bundler",
      "allowImportingTsExtensions": true,
      "resolveJsonModule": true,
      "isolatedModules": true,
      "noEmit": true,
      "jsx": "react-jsx",
      
      /* Type Checking */
      "strict": false,
      "noImplicitAny": false,
      "noUnusedLocals": false,
      "noUnusedParameters": false,
      "noFallthroughCasesInSwitch": false,
      "allowSyntheticDefaultImports": true,
      
      /* Output */
      "outDir": "dist"
    },
    "include": ["src"]
  };
  
  writeFile(tsConfigPath, JSON.stringify(tsConfig, null, 2));
  
  // Add tsconfig.node.json with composite flag
  const tsNodeConfigPath = path.join(appDir, 'tsconfig.node.json');
  const tsNodeConfig = {
    "compilerOptions": {
      "composite": true,
      "skipLibCheck": true,
      "module": "ESNext",
      "moduleResolution": "bundler",
      "allowSyntheticDefaultImports": true
    },
    "include": ["vite.config.ts"]
  };
  
  writeFile(tsNodeConfigPath, JSON.stringify(tsNodeConfig, null, 2));
  
  // Update vite.config.ts to ensure proper build output directory
  const viteConfigPath = path.join(appDir, 'vite.config.ts');
  const viteConfig = `
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
})
  `;
  
  writeFile(viteConfigPath, viteConfig);
}
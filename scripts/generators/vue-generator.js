import path from 'path';
import { execSync } from 'child_process';
import { writeFile, createORMBridgeConfig } from '../utils.js';
import fs from 'fs-extra';
const { ensureDirSync } = fs;

export function generateVueApp(testAppsDir) {
  const appDir = path.join(testAppsDir, 'vue-app');
  const parentDir = path.dirname(appDir);
  const appDirName = path.basename(appDir);

  console.log(`Generating Vue test app in ${appDir}...`);

  // Ensure parent directory exists
  ensureDirSync(parentDir);

  // Execute Vue CLI in parent directory with relative path
  execSync(`cd "${parentDir}" && npm create vue@latest ${appDirName} -- --default`, { stdio: 'inherit', shell: true });

  // Install ORMBridge
  execSync(`npm install github:statezero/statezero-client`, { cwd: appDir, stdio: 'inherit' });

  // Create ORMBridge config
  createORMBridgeConfig(appDir);

  // Run statezero sync-models command
  console.log('Syncing models...');
  execSync('npx statezero sync-models', { cwd: appDir, stdio: 'inherit' });

  // Create test component
  createVueTestComponent(appDir);

  // Update Vue main entrypoint to use top-level await
  updateVueMain(appDir);

  console.log('✅ Vue test app generated successfully!');
  return appDir;
}

function createVueTestComponent(appDir) {
  // Create ORMBridgeTest.vue
  const testComponent = `
<template>
  <div class="statezero-test">
    <h1>ORMBridge Vue Test</h1>
    
    <div class="controls">
      <button id="add-item" @click="addItem" :disabled="isLoading || !liveQuery">Add Item</button>
      <button id="update-items" @click="updateAllItems" :disabled="isLoading || !liveQuery">Update All</button>
      <button id="delete-items" @click="deleteAllItems" :disabled="isLoading || !liveQuery">Delete All</button>
    </div>
    
    <div class="items-container">
      <h2>Items: <span id="item-count">{{ items.length }}</span></h2>
      <p v-if="isLoading">Loading...</p>
      <ul v-else id="items-list">
        <li v-for="item in items" :key="item.id" class="item" :data-id="item.id">
          <strong>{{ item.name }}</strong>: {{ item.value }}
        </li>
      </ul>
    </div>
  </div>
</template>

<script>
import { defineComponent, ref, shallowRef } from 'vue';
import { createVueLiveView } from '@statezero/core';
import { DummyModel } from '../../models/backend1';

export default defineComponent({
  name: 'ORMBridgeTest',
  setup() {
    const items = ref([]);
    const liveQuery = shallowRef(null);
    const isLoading = ref(true);
    
    // Initialize data using promises
    createVueLiveView(DummyModel.objects.all(), items)
      .then(query => {
        liveQuery.value = query;
        isLoading.value = false;
      })
      .catch(error => {
        console.error("Failed to initialize query:", error);
        isLoading.value = false;
      });
    
    const addItem = async () => {
      if (liveQuery.value) {
        await liveQuery.value.create({ name: 'New Item', value: Math.floor(Math.random() * 100) });
      }
    };
    
    const updateAllItems = async () => {
      if (liveQuery.value) {
        await liveQuery.value.update({ name: 'Updated Item' });
      }
    };
    
    const deleteAllItems = async () => {
      if (liveQuery.value) {
        await liveQuery.value.delete();
      }
    };
    
    return {
      items,
      liveQuery,
      isLoading,
      addItem,
      updateAllItems,
      deleteAllItems
    };
  },
  beforeUnmount() {
    if (this.liveQuery) {
      this.liveQuery.destroy();
    }
  }
});
</script>

<style scoped>
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
</style>
`;
  writeFile(path.join(appDir, 'src/components/ORMBridgeTest.vue'), testComponent);
  
  // Update App.vue to use Suspense
  const appContent = `
<template>
  <div id="app">
    <Suspense>
      <template #default>
        <ORMBridgeTest />
      </template>
      <template #fallback>
        <div>Loading ORMBridge...</div>
      </template>
    </Suspense>
  </div>
</template>

<script>
import { defineComponent } from 'vue';
import ORMBridgeTest from './components/ORMBridgeTest.vue';

export default defineComponent({
  name: 'App',
  components: {
    ORMBridgeTest
  }
});
</script>
`;
  writeFile(path.join(appDir, 'src/App.vue'), appContent);
}

function updateVueMain(appDir) {
  const mainFilePath = path.join(appDir, 'src', 'main.js');
  const mainContent = `
import './assets/main.css';
import config from '../statezero.config.js';
import { configInstance } from '@statezero/core';
import { createApp } from 'vue';
import App from './App.vue';

configInstance.setConfig(config);

createApp(App).mount('#app');
`;
  writeFile(mainFilePath, mainContent);
}

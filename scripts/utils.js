import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import pkg from 'fs-extra';
const { ensureDirSync } = pkg;

/**
 * Create ORMBridge configuration file as a CommonJS module.
 * @param {string} appDir - The directory of the app
 */
export function createORMBridgeConfig(appDir) {
  console.log('Creating ORMBridge configuration...');
  
  const configContent = `// Export the AppConfig object
export default {
  backendConfigs: {
    default: {
      API_URL: 'http://127.0.0.1:8000/ormbridge',
      GENERATED_TYPES_DIR: './models/backend1',
      getAuthHeaders: () => ({
        'Authorization': 'Token testtoken123'
      }),
      eventInterceptor: (event) => {
        return event;
      },
      events: {
        type: "pusher",
        pusher: {
          clientOptions: {
            appKey: '31f0a279ab07525d29ba',
            cluster: 'eu',
            forceTLS: true,
            authEndpoint: 'http://127.0.0.1:8000/ormbridge/events/auth/'
          }
        }
      }
    },
    
    microservice: {
      API_URL: 'http://127.0.0.1:8000/ormbridge',
      GENERATED_TYPES_DIR: './models/backend2',
      getAuthHeaders: () => ({
        'Authorization': 'Bearer your_microservice_token'
      }),
      eventInterceptor: (event) => {
        return event;
      },
      events: {
        type: "pusher",
        pusher: {
          clientOptions: {
            appKey: '31f0a279ab07525d29ba',
            cluster: 'eu',
            forceTLS: true,
            authEndpoint: 'http://127.0.0.1:8000/ormbridge/events/auth/'
          }
        }
      }
    }
  }
};`;
  
  // Write config file as a standard js file (.js)
  writeFile(path.join(appDir, 'ormbridge.config.js'), configContent);
  console.log('✅ ORMBridge config created successfully');
}

/**
 * Write file, ensuring the directory exists
 * @param {string} filePath - The path to the file
 * @param {string} content - The content to write
 */
export function writeFile(filePath, content) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
}
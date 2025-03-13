import { cosmiconfigSync } from 'cosmiconfig';
import { configInstance } from '../config.js';

/**
 * Loads configuration from file using cosmiconfig and sets it into the global config singleton.
 *
 * The function searches for a configuration file (e.g. ormbridge.config.js, .modelsynrc, etc.)
 * and checks if an environment variable (ORMBRIDGE_CONFIG_PATH) overrides the default search path.
 * If a configuration file is found, it is validated and set via configInstance.setConfig().
 *
 * @returns {void}
 */
export function loadConfigFromFile() {
  const explorerSync = cosmiconfigSync('ormbridge', {
    searchPlaces: [
      'ormbridge.config.js',
      'src/ormbridge.config.js',
      '.modelsynrc',
      '.modelsynrc.json',
      '.modelsynrc.yaml',
      '.modelsynrc.yml',
      '.modelsynrc.js',
      'package.json'
    ],
    transform: (result) => {
      if (!result) {
        console.log('No configuration file found.');
        return null;
      }
      console.log(`Successfully loaded config from: ${result.filepath}`);
      
      // Handle ESM modules with default export
      if (result.config && result.config.__esModule && result.config.default) {
        result.config = result.config.default;
      }
      
      // Parse any stringified values back to their original format
      const parseNestedValues = (obj) => {
        if (!obj || typeof obj !== 'object') return obj;
        
        Object.keys(obj).forEach(key => {
          const value = obj[key];
          
          // Don't try to parse functions
          if (typeof value === 'string' && !value.includes('Function')) {
            try {
              // Check if it's a stringified value
              if ((value.startsWith('"') && value.endsWith('"')) || 
                  (value === 'true' || value === 'false')) {
                obj[key] = JSON.parse(value);
              }
            } catch (e) {
              // If parsing fails, keep the original value
            }
          }
          
          // Recursively parse nested objects
          if (value && typeof value === 'object') {
            parseNestedValues(value);
          }
        });
        
        return obj;
      };
      
      // Parse any stringified values in the config
      if (result.config && typeof result.config === 'object') {
        parseNestedValues(result.config);
      }
      
      return result;
    }
  });

  const envConfigPath = process.env.ORMBRIDGE_CONFIG_PATH;
  let result = null;
  
  if (envConfigPath) {
    console.log(`Attempting to load config from environment path: ${envConfigPath}`);
    try {
      result = explorerSync.load(envConfigPath);
    } catch (error) {
      console.log(`Failed to load from environment path: ${error.message}`);
    }
  }
  
  if (!result) {
    console.log('Searching for ormbridge configuration files...');
    result = explorerSync.search();
  }
  
  if (result && result.config) {
    // Apply the configuration
    configInstance.setConfig(result.config);
    console.log(`Configuration set from ${result.filepath}`);
  } else {
    console.log('Could not find configuration, using default empty config');
    configInstance.setConfig({ backendConfigs: {} });
  }
}
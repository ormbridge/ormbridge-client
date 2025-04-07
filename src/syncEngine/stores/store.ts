import { Model } from '../../flavours/django/model';
import { configInstance } from '../../config.js';
import { IndexedDBStorage } from '../persistence/IndexedDBStorage';
import { ModelStore, FetchFunction as ModelFetchFunction } from './ModelStore'
import { QuerysetStore, FetchFunction as QsFetchFunction } from './QuerysetStore.js';
import hash from 'object-hash';

/**
 * Interface for a model registry
 */
interface ModelRegistry {
  [modelName: string]: typeof Model;
}


/**
 * Interface for response data
 */
interface ResponseData {
    data: T[] | T;
    included: object
}

/**
 * Interface for an api response
 */
interface Response {
    data: ResponseData
}

/**
 * Simple store that just provides access to a single IndexedDBStorage instance
 * for a specific backend
 */
export class Store {
  public registry: ModelRegistry;
  private storage: IndexedDBStorage;
  public modelFetchFn: ModelFetchFunction<T>;
  public qsFetchFn: QsFetchFunction<T>;
  public modelStores: Map<string, ModelStore<T>> = new Map();
  public querysetStores: Map<string, QuerysetStore<T>> = new Map();

  /**
   * Create a new Store instance for a specific backend
   * @param registry - The model registry mapping names to classes
   * @param backendName - The name of the backend to load
   * @param modelFetchFn - Function to fetch single models
   * @param qsFetchFn - Function to fetch querysets
   */
  constructor(registry: ModelRegistry, backendName: string, modelFetchFn: ModelFetchFunction<T>, qsFetchFn: QsFetchFunction<T>) { // <--- Corrected qsFetchFn parameter name
    // Assign the provided registry directly
    this.registry = registry;

    // Initialize one storage instance for this backend
    this.storage = new IndexedDBStorage({
      dbName: `modelsync_${backendName}`,
      storeName: 'cache'
    });
    this.modelFetchFn = modelFetchFn
    this.qsFetchFn = qsFetchFn

    // Get the configuration
    const config = configInstance.getConfig();

    // Check if the backend exists in config (optional check, good practice)
    if (!config.backendConfigs[backendName]) {
      // Consider throwing an error instead of just logging
      console.error(`Backend "${backendName}" not found in configuration`);
      throw new Error(`Backend "${backendName}" not found in configuration`);
      // return; // Remove return if throwing error
    }
    // Check if registry was provided (important if constructor allows optional)
    if (!this.registry || Object.keys(this.registry).length === 0) {
        console.error(`Registry provided for backend "${backendName}" is empty or invalid.`);
        // Optionally throw an error
        // throw new Error(`Registry provided for backend "${backendName}" is empty or invalid.`);
    } else {
        console.log(`Using provided model registry for backend ${backendName}`);
    }
  }

  /**
   * Get or create model store
   */
  _getOrCreateModelStore(modelClass: any | undefined){
    if (!modelClass) throw new Error("Cannot get/create model store: modelClass is undefined. Check registry.");
    if (!this.modelStores.has(modelClass.modelName)){
        this.modelStores[modelClass.modelName] = new ModelStore(modelClass, this.modelFetchFn, this.storage)
    }
    return this.modelStores[modelClass.modelName]
  }

  getModelStore(modelClass) {
    const realStore = this._getOrCreateModelStore(modelClass);
    
    // Return a proxy that queues operations if not ready
    return new Proxy(realStore, {
      get: (target, prop) => {
        if (typeof target[prop] === 'function') {
          return (...args) => {
            if (target.isReady) {
              return target[prop](...args);
            } else {
              // Queue the operation
              return target.whenReady().then(() => target[prop](...args));
            }
          };
        }
        return target[prop];
      }
    });
  }

  /**
   * Get queryset store
   */
  _getOrCreateQuerysetStore(ast: any, modelClass: any | undefined){
    // hashed form of the ast for lookups
    if (!modelClass) throw new Error("Cannot get/create queryset store: modelClass is undefined. Check registry.");
    let astHash = hash(ast)
    if (!this.querysetStores.has(astHash)){
        this.querysetStores[astHash] = new QuerysetStore(modelClass, this.qsFetchFn, ast, this.storage)
    }
    return this.querysetStores[astHash]
  }

  getQuerysetStore(ast: any, modelClass: any) {
    // Hashed form of the ast for lookups
    const astHash = hash(ast);
    
    if (!this.querysetStores.has(astHash)) {
      const store = new QuerysetStore(modelClass, this.qsFetchFn, ast, this.storage);
      this.querysetStores.set(astHash, store);
    }
    
    const realStore = this.querysetStores.get(astHash);
    
    // Return a proxy that queues operations if not ready
    return new Proxy(realStore, {
      get: (target, prop) => {
        if (typeof target[prop] === 'function') {
          return (...args) => {
            if (target.isReady) {
              return target[prop](...args);
            } else {
              // Queue the operation until ready
              return target.whenReady().then(() => target[prop](...args));
            }
          };
        }
        return target[prop];
      }
    });
  }

  /**
   * Store models
   */
  storeModels(responseData) {
    // add the full included models to the store
    let store;
    let modelClass;
    for (let [mName, instances] of Object.entries(responseData.included || {})) {
      modelClass = this.registry![mName];
      store = this.getModelStore(modelClass);
      console.log(`storing:`, Object.values(instances))
      store.addToGroundTruth(Object.values(instances));
    }
  }

  /**
   * Get queryset
   */
  getQueryset(ast: Object, modelClass: Model){
    let querysetStore = this.getQuerysetStore(ast, modelClass)
    return querysetStore.render()
  }

  /**
   * Get models
   */
  getModels(pks= null, modelClass: Model){
    let modelStore = this.getModelStore(modelClass)
    let result = modelStore.render(pks)
    return result
  }

  /**
   * Store queryset
   */
  storeQueryset(responseData, ast) {    
    // convert the response data from a list of instances into a list of pks
    let modelClass;
    try {
      modelClass = Array.isArray(responseData.data) 
        ? this.registry![responseData.data[0].type] 
        : this.registry![responseData.data.type];
    } catch (error) {
      console.error('Error getting model class:', error);
      throw error;
    }
    
    let toAdd = Array.isArray(responseData.data) ? responseData.data : [responseData.data];
    
    let querysetStore = this.getQuerysetStore(ast, modelClass);
    const pks = toAdd.map(instance => {
      const pk = instance[modelClass.primaryKeyField];
      return pk;
    });
    console.log(`storing queryset:`, pks)

    querysetStore.setGroundTruth(pks);
  }

  /**
   * Load a backend response into the store
   */
  injestResponse(response, ast) {    
    let metrics = ['sum', 'min', 'max', 'avg', 'count'];
  
    if (!ast.materialized || metrics.includes(ast.type)) {
      console.warn('injestResponse only stores model queryset responses');
    }
  
    if (response.data) {
      this.storeModels(response.data);
      this.storeQueryset(response.data, ast);
    } else {
      console.log('Response has no data!', response);
    }
  }
}

// Singleton store factory
const storeInstances: { [backendName: string]: Store } = {};

/**
 * Factory function to get or create a Store instance
 * @param backendName - The name of the backend to load
 * @returns The Store instance for the specified backend
 */
export function getStore<T extends Record<string, any>>(
    backendName: string,
    modelFetchFn: ModelFetchFunction<T>,
    qsFetchFn: QsFetchFunction<T>
  ): Store<T> {
    if (!storeInstances[backendName]) {
      storeInstances[backendName] = new Store<T>(backendName, modelFetchFn, qsFetchFn);
    }
    return storeInstances[backendName];
  }
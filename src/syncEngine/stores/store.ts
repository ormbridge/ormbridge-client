import { Model } from '../../flavours/django/model';
import { configInstance } from '../../config.js';
import { IndexedDBStorage } from '../persistence/IndexedDBStorage';
import { ModelStore, FetchFunction as ModelFetchFunction, Operation as ModelOperation } from './ModelStore'
import { QuerysetStore, FetchFunction as QsFetchFunction, Operation as QuerysetOperation } from './QuerysetStore.js';
import { getStoreKey } from './utils'; // Assuming utils.ts exists
import hash from 'object-hash';

/**
 * Interface for a model registry mapping model names to model classes.
 */
interface ModelRegistry {
  [modelName: string]: typeof Model;
}

/**
 * Interface for the structure of included data or primary data within an API response.
 */
interface ResponseData<T> {
    data: T[] | T; // Can be a single object or an array of objects
    included: object // Typically related objects keyed by model name
}

/**
 * Interface for a standard API response structure containing data and included objects.
 */
interface Response<T> {
    data: ResponseData<T>
}

/**
 * Manages data persistence and access for models and querysets for a specific backend.
 * Provides access to ModelStore and QuerysetStore instances, backed by IndexedDB.
 */
export class Store<T extends Record<string, any>> {
  public registry: ModelRegistry;
  private storage: IndexedDBStorage;
  public modelFetchFn: ModelFetchFunction<T>;
  public qsFetchFn: QsFetchFunction<T>;
  public modelStores: Map<string, ModelStore<T>> = new Map();
  public querysetStores: Map<string, QuerysetStore<T>> = new Map();
  // Cache to hold data loaded from IndexedDB during initialization
  private _preloadedCache: Map<string, { id: string, data: any }> = new Map();
  // Promise that resolves once the initial data load from storage is complete
  private _initPromise: Promise<void>;

  /**
   * Creates a new Store instance.
   * Initializes IndexedDB storage and begins loading any persisted data.
   *
   * @param registry - The model registry mapping model names to model classes.
   * @param backendName - The unique name for the backend, used for IndexedDB database naming.
   * @param modelFetchFn - The function used to fetch individual model data from the backend.
   * @param qsFetchFn - The function used to fetch queryset data from the backend.
   */
  constructor(registry: ModelRegistry, backendName: string, modelFetchFn: ModelFetchFunction<T>, qsFetchFn: QsFetchFunction<T>) {
    this.registry = registry;
    this.storage = new IndexedDBStorage({
      dbName: `modelsync_${backendName}`,
      storeName: 'cache'
    });
    this.modelFetchFn = modelFetchFn;
    this.qsFetchFn = qsFetchFn;
    this._initPromise = this._initialize();
  }

  /**
   * Initializes the store by loading all data from IndexedDB into an in-memory cache.
   * This is called by the constructor.
   */
  private async _initialize(): Promise<void> {
    const allData = await this.storage.loadAll();
    for (const item of allData) {
        // Basic check for valid item structure expected from storage
        if (item && item.id) {
            this._preloadedCache.set(item.id, item);
        }
    }
  }

  /**
   * Returns a promise that resolves when the store's initial data load from
   * IndexedDB is complete. Ensures subsequent operations have access to cached data.
   *
   * @returns A promise that resolves when the store is ready.
   */
  public async whenReady(): Promise<void> {
      return this._initPromise;
  }

  /**
   * Retrieves an existing ModelStore for a given model class or creates a new one
   * if it doesn't exist. Initializes the store with preloaded data if available.
   * (Internal use, ensures readiness before proceeding).
   *
   * @param modelClass - The model class (e.g., User, Product).
   * @returns A promise resolving to the ModelStore instance.
   * @throws If modelClass is undefined.
   */
  async getModelStore(modelClass: any | undefined): Promise<ModelStore<T>> {
    if (!modelClass) throw new Error("Cannot get/create model store: modelClass is undefined. Check registry.");

    await this.whenReady(); // Wait for initial data load

    const modelName = modelClass.modelName; // Use unique model name from the class as the key
    if (!this.modelStores.has(modelName)){
        // Calculate keys to look up in preloaded cache
        const storeKey = getStoreKey(modelClass);
        const operationsKey = `modelstore::${storeKey}::operations`;
        const groundTruthKey = `modelstore::${storeKey}::groundtruth`;

        // Retrieve preloaded data from the cache, defaulting to empty arrays if not found
        const initialOperations = this._preloadedCache.get(operationsKey)?.data || [];
        const initialGroundTruth = this._preloadedCache.get(groundTruthKey)?.data || [];

        // Pass initial data to the ModelStore constructor
        const newStore = new ModelStore<T>(
            modelClass,
            this.modelFetchFn,
            this.storage,
            initialGroundTruth,
            initialOperations
        );
        this.modelStores.set(modelName, newStore); // Store the new instance in the map
    }
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.modelStores.get(modelName)!; // Return the existing or newly created store
  }

  /**
   * Retrieves an existing QuerysetStore for a given AST and model class, or creates
   * a new one. Initializes the store with preloaded data if available.
   * (Internal use, ensures readiness before proceeding).
   *
   * @param ast - The Abstract Syntax Tree representing the queryset query.
   * @param modelClass - The model class the queryset applies to.
   * @returns A promise resolving to the QuerysetStore instance.
   * @throws If modelClass is undefined.
   */
  async getQuerysetStore(ast: any, modelClass: any | undefined): Promise<QuerysetStore<T>> {
    if (!modelClass) throw new Error("Cannot get/create queryset store: modelClass is undefined. Check registry.");

    await this.whenReady(); // Wait for initial data load

    const astHash = hash(ast); // Use a hash of the AST as the unique key
    if (!this.querysetStores.has(astHash)){
        // Calculate keys for storage lookup based on model and AST hash
        const storeKeyBase = getStoreKey(modelClass);
        const storeKey = `${storeKeyBase}::querysetstore::${astHash}`;
        const operationsKey = `${storeKey}::operations`;
        const groundTruthKey = `${storeKey}::groundtruth`;

        // Retrieve preloaded data from the cache, defaulting to empty arrays if not found
        const initialOperations = this._preloadedCache.get(operationsKey)?.data || [];
        const initialGroundTruthPks = this._preloadedCache.get(groundTruthKey)?.data || [];

        // Pass initial data to the QuerysetStore constructor
        const newStore = new QuerysetStore<T>(
            modelClass,
            this.qsFetchFn,
            ast,
            this.storage,
            initialGroundTruthPks,
            initialOperations
        );
        this.querysetStores.set(astHash, newStore); // Store the new instance
    }
     // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.querysetStores.get(astHash)!; // Return the existing or newly created store
  }

  /**
   * Stores model instances found in the `included` section of API response data.
   * Adds these instances to the ground truth of their respective ModelStores.
   *
   * @param responseData - The `data` part of an API response, containing `included` models.
   */
  async storeModels(responseData: ResponseData<T>) {
    let store;
    let modelClass;
    // Iterate over included models grouped by model name (mName)
    for (let [mName, instances] of Object.entries(responseData.included || {})) {
      modelClass = this.registry![mName]; // Find the corresponding model class in the registry
      store = await this.getModelStore(modelClass);
      
      // Extract the actual model instances - just get the values from the object
      const instancesArray = Object.values(instances);      
      // Add to ground truth
      store.addToGroundTruth(instancesArray);
    }
  }

  /**
   * Retrieves and renders the current state of a queryset based on its AST.
   *
   * @param ast - The Abstract Syntax Tree representing the queryset query.
   * @param modelClass - The model class the queryset applies to.
   * @returns A promise resolving to an array of rendered model instances (or potentially other data types depending on render logic).
   */
  async getQueryset(ast: Object, modelClass: typeof Model): Promise<Number[] | String[]> {
    let querysetStore = await this.getQuerysetStore(ast, modelClass);
    let result = querysetStore.render();
    return result
  }

  /**
   * Retrieves and renders specific model instances by their primary keys,
   * or all known models of a class if no primary keys are provided.
   *
   * @param pks - A Set of primary keys to retrieve, or null/undefined to retrieve all models.
   * @param modelClass - The model class to retrieve instances of.
   * @returns A promise resolving to an array of rendered model instances.
   */
  async getModels(pks: Set<any> | null = null, modelClass: typeof Model): Promise<T[]> {
    let modelStore = await this.getModelStore(modelClass);
    let result = modelStore.render(pks);
    return result;
  }

  /**
   * Stores the primary keys of the main data returned for a specific queryset query (AST).
   * Updates the ground truth (list of primary keys) for the corresponding QuerysetStore.
   *
   * @param responseData - The `data` part of an API response, containing the primary data array/object.
   * @param ast - The Abstract Syntax Tree representing the queryset query this data corresponds to.
   * @throws If the model type cannot be determined from the response data or found in the registry.
   */
  async storeQueryset(responseData: ResponseData<T>, ast: object) {
    if (!Array.isArray(responseData.data)) return;
    
    let modelType = responseData.data[0].type
    
    if (!modelType) throw new Error(`Response data ${responseData.data[0]} has no model type!`)
    
    let modelClass = this.registry![modelType]
    let querysetStore = await this.getQuerysetStore(ast, modelClass);
    let pks = responseData.data.map(instance => instance[modelClass.primaryKeyField])

    // Set the ground truth for the queryset store to this new list of PKs
    console.log('qs storing', pks)
    querysetStore.setGroundTruth(pks);
  }


  /**
   * Processes a full API response, storing both the included models and the
   * primary keys of the main queryset data. Skips processing for non-materialized
   * or metric-based responses based on AST properties.
   *
   * @param response - The full API response object.
   * @param ast - The Abstract Syntax Tree representing the original query.
   */
  async injestResponse(response: Response<T>, ast: any) {
    // Determine if the response should be stored based on AST properties.
    const isMaterialized = ast?.materialized === true;
    const isMetric = ['sum', 'min', 'max', 'avg', 'count'].includes(ast?.type);
  
    if (!isMaterialized || isMetric) return;
  
    if (!response?.data) {
      console.log('Response has no data or unexpected structure!', response);
      return
    }

    await this.storeModels(response.data);
    if (!Array.isArray(response.data.data)) return;
    await this.storeQueryset(response.data, ast);
  }

}

// Singleton store management: Holds one Store instance per backendName.
const storeInstances: { [backendName: string]: Store<any> } = {}; // Use Store<any> to allow different T for different backends

/**
 * Factory function to get a singleton Store instance for a specific backend.
 * Creates a new Store if one doesn't exist for the given backend name.
 *
 * @param backendName - The unique name of the backend.
 * @param registry - The model registry for this backend.
 * @param modelFetchFn - The function to fetch single models for this backend.
 * @param qsFetchFn - The function to fetch querysets for this backend.
 * @returns The singleton Store instance for the specified backend.
 */
export function getStore<T extends Record<string, any>>(
    backendName: string,
    registry: ModelRegistry,
    modelFetchFn: ModelFetchFunction<T>,
    qsFetchFn: QsFetchFunction<T>
  ): Store<T> {
    if (!storeInstances[backendName]) {
      // Create and store a new instance if one doesn't exist for this backend
      storeInstances[backendName] = new Store<T>(registry, backendName, modelFetchFn, qsFetchFn);
    }
    // Return the existing or newly created instance.
    // Type assertion might be needed if strict type checking is enforced across different T usages,
    // ensuring the returned store matches the expected generic type T.
    return storeInstances[backendName] as Store<T>;
  }
/**
 * ModelSyncManager - Centralized data handling system with three main stores:
 * 1. ModelStore: Manages model instances by type and ID
 * 2. MetricStore: Manages calculated metrics for querysets
 * 3. QuerysetStore: Manages collections of model IDs with relationship resolution
 */
class ModelSyncManager {
  constructor() {
    this.modelStore = {};     // {modelName: {id1: modelInstance, id2: modelInstance}}
    this.metricStore = {};    // {'queryset::metric::field': value}
    this.querysetStore = {};  // {querysetId: {ast: [id1, id2, id3], modelName: 'name'}}
    this.proxies = new WeakMap(); // Keep track of created proxies to avoid duplication
  }

  /**
   * Load a model from an API response and return a proxy for it
   * @param {Object} apiResponse - API response with data and included
   * @returns {ModelProxy} - A proxy for the model instance
   */
  loadModel(apiResponse) {
    const { data, included } = apiResponse;
    
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('API response does not contain a valid model instance');
    }
    
    // Update model store with included data
    this._updateStoreFromIncluded(included);
    
    // Get model type and ID
    const { type, id } = data;
    
    // Add or update this model in the store
    if (!this.modelStore[type]) {
      this.modelStore[type] = {};
    }
    this.modelStore[type][id] = data;
    
    // Return a proxy for the model
    return new ModelProxy(this, type, id);
  }
  
  /**
   * Load a queryset from an API response and return a proxy for it
   * @param {Object} apiResponse - API response with data and included
   * @param {string} querysetId - Optional ID for the queryset, defaults to auto-generated ID
   * @returns {QuerysetProxy} - A proxy for the queryset
   */
  loadQueryset(apiResponse, querysetId = null) {
    const { data, included } = apiResponse;
    
    if (!data || !Array.isArray(data) || data.length === 0) {
      throw new Error('API response does not contain a valid queryset');
    }
    
    // Update model store with included data
    this._updateStoreFromIncluded(included);
    
    // Get model type and IDs from the data array
    const modelName = data[0].type;
    const ids = data.map(item => item.id);
    
    // Generate a querysetId if not provided
    const qid = querysetId || `queryset_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    
    // Add the queryset to the store
    this.querysetStore[qid] = { ast: ids, modelName };
    
    // Return a proxy for the queryset
    return new QuerysetProxy(this, qid);
  }
  
  /**
   * Load metrics from an API response
   * @param {Object} apiResponse - API response with metrics data
   * @param {string} querysetId - ID of the queryset the metrics belong to
   * @returns {MetricProxy} - A proxy for the metrics
   */
  loadMetrics(apiResponse, querysetId) {
    const { data } = apiResponse;
    
    if (!data || typeof data !== 'object') {
      throw new Error('API response does not contain valid metrics data');
    }
    
    // Process metrics data and add to metric store
    for (const [metricName, value] of Object.entries(data)) {
      if (typeof value === 'object' && value !== null) {
        // Handle metrics with field-specific values
        for (const [fieldName, fieldValue] of Object.entries(value)) {
          this.setMetric(querysetId, metricName, fieldName, fieldValue);
        }
      } else {
        // Handle metrics with a single value
        this.setMetric(querysetId, metricName, 'value', value);
      }
    }
    
    // Return a metric proxy for the queryset
    return new MetricProxy(this, querysetId);
  }
  
  /**
   * Update model store from the included data in an API response
   * @param {Object} included - Included data from API response
   * @private
   */
  _updateStoreFromIncluded(included) {
    if (!included || typeof included !== 'object') {
      return;
    }
    
    // Process included data and update model store
    for (const [modelName, instances] of Object.entries(included)) {
      if (!this.modelStore[modelName]) {
        this.modelStore[modelName] = {};
      }
      
      // Add or update each instance in the model store
      for (const [id, instance] of Object.entries(instances)) {
        this.modelStore[modelName][id] = instance;
      }
    }
  }

  /**
   * Create a proxy for a model instance that resolves relationships on-demand
   * @param {string} modelName - The type of the model
   * @param {string|number} id - The ID of the model
   * @returns {Proxy} - A proxy that resolves relationships
   */
  createModelProxy(modelName, id) {
    // Check if the model and ID exist
    if (!this.modelStore[modelName] || !this.modelStore[modelName][id]) {
      throw new Error(`Model ${modelName} with id ${id} not found in store`);
    }

    const model = this.modelStore[modelName][id];
    const proxyKey = `${modelName}:${id}`;
    
    // Check if we already have a proxy for this model
    const existingProxy = this.proxies.get(model);
    if (existingProxy) {
      return existingProxy;
    }

    // Create a proxy that will handle relationship resolution
    const proxy = new Proxy(model, {
      get: (target, prop) => {
        const value = target[prop];
        
        // If the property is an object with type and id, it's a relationship
        if (value && typeof value === 'object') {
          if (value.type && value.id !== undefined) {
            // This is a reference to another model
            return this.createModelProxy(value.type, value.id);
          } else if (Array.isArray(value)) {
            // Handle array of relationships
            return value.map(item => {
              if (item && item.type && item.id !== undefined) {
                return this.createModelProxy(item.type, item.id);
              }
              return item;
            });
          }
        }
        
        return value;
      }
    });
    
    // Store the proxy in our WeakMap for future reuse
    this.proxies.set(model, proxy);
    
    return proxy;
  }

  /**
   * Get a metric from the store or calculate it if needed
   * @param {string} querysetId - The ID of the queryset
   * @param {string} metricName - The name of the metric
   * @param {string} fieldName - The field to calculate the metric on
   * @returns {any} - The metric value
   */
  getMetric(querysetId, metricName, fieldName) {
    const key = `${querysetId}::${metricName}::${fieldName}`;
    
    // Return cached metric if available
    if (this.metricStore[key] !== undefined) {
      return this.metricStore[key];
    }
    
    // Otherwise we'd need to calculate it
    // This would typically involve calling a backend API or computing locally
    throw new Error(`Metric ${key} not found and calculation not implemented`);
  }

  /**
   * Set a metric value in the store
   * @param {string} querysetId - The ID of the queryset
   * @param {string} metricName - The name of the metric
   * @param {string} fieldName - The field the metric is calculated on
   * @param {any} value - The metric value
   */
  setMetric(querysetId, metricName, fieldName, value) {
    const key = `${querysetId}::${metricName}::${fieldName}`;
    this.metricStore[key] = value;
  }
  
  /**
   * Get all metrics for a queryset
   * @param {string} querysetId - The ID of the queryset
   * @returns {Object} - Object with all metrics for the queryset
   */
  getAllMetrics(querysetId) {
    const metrics = {};
    const prefix = `${querysetId}::`;
    
    Object.entries(this.metricStore).forEach(([key, value]) => {
      if (key.startsWith(prefix)) {
        const [, metricName, fieldName] = key.split('::');
        
        if (!metrics[metricName]) {
          metrics[metricName] = {};
        }
        
        metrics[metricName][fieldName] = value;
      }
    });
    
    return metrics;
  }

  /**
   * Get a queryset proxy that resolves model references automatically
   * @param {string} querysetId - The ID of the queryset
   * @returns {Array} - Array of model proxies
   */
  getQuerysetProxy(querysetId) {
    if (!this.querysetStore[querysetId]) {
      throw new Error(`Queryset ${querysetId} not found in store`);
    }
    
    const { ast, modelName } = this.querysetStore[querysetId];
    
    // Map each ID in the AST to a model proxy
    return ast.map(id => this.createModelProxy(modelName, id));
  }

  /**
   * Create a new queryset from a list of model IDs
   * @param {string} querysetId - The ID to assign to the queryset
   * @param {string} modelName - The type of models in the queryset
   * @param {Array} ids - Array of model IDs
   */
  createQueryset(querysetId, modelName, ids) {
    this.querysetStore[querysetId] = { ast: ids, modelName };
  }

  /**
   * Update the model store with new or modified instances
   * @param {Object} data - The data to update with
   */
  updateModelStore(data) {
    for (const [modelName, instances] of Object.entries(data)) {
      if (!this.modelStore[modelName]) {
        this.modelStore[modelName] = {};
      }
      
      for (const [id, instance] of Object.entries(instances)) {
        this.modelStore[modelName][id] = instance;
      }
    }
  }
}

/**
 * ModelProxy - A convenience class for working with model proxies
 */
class ModelProxy {
  constructor(manager, modelName, id) {
    this.manager = manager;
    this.modelName = modelName;
    this.id = id;
    this.proxy = manager.createModelProxy(modelName, id);
  }
  
  /**
   * Get the underlying proxy object with automatically resolved relationships
   * @returns {Object} - The denormalized model with resolved relationships
   */
  get() {
    return this.proxy;
  }
  
  /**
   * Get a reference to a related model
   * @param {string} relationField - Name of the relation field
   * @returns {ModelProxy} - Proxy for the related model
   */
  getRelated(relationField) {
    const relation = this.proxy[relationField];
    if (!relation) {
      throw new Error(`Relation field ${relationField} not found on ${this.modelName}`);
    }
    
    if (Array.isArray(relation)) {
      // Many-relation, return array of proxies
      return relation.map(item => {
        if (typeof item !== 'object' || !item.type || !item.id) {
          throw new Error(`Invalid relation reference in ${relationField}`);
        }
        return new ModelProxy(this.manager, item.type, item.id);
      });
    } else {
      // Single-relation, return a single proxy
      if (typeof relation !== 'object' || !relation.type || !relation.id) {
        throw new Error(`Invalid relation reference in ${relationField}`);
      }
      return new ModelProxy(this.manager, relation.type, relation.id);
    }
  }
  
  /**
   * Get the raw data for this model without resolving relationships
   * @returns {Object} - The raw model data
   */
  getRaw() {
    return this.manager.modelStore[this.modelName][this.id];
  }
}

/**
 * MetricProxy - Provides access to metrics for a specific queryset
 */
class MetricProxy {
  constructor(manager, querysetId) {
    this.manager = manager;
    this.querysetId = querysetId;
  }
  
  /**
   * Get a metric value
   * @param {string} metricName - The name of the metric
   * @param {string} fieldName - The field to calculate the metric on
   * @returns {any} - The metric value
   */
  get(metricName, fieldName) {
    return this.manager.getMetric(this.querysetId, metricName, fieldName);
  }
  
  /**
   * Set a metric value
   * @param {string} metricName - The name of the metric
   * @param {string} fieldName - The field to calculate the metric on
   * @param {any} value - The value to set
   */
  set(metricName, fieldName, value) {
    this.manager.setMetric(this.querysetId, metricName, fieldName, value);
  }
  
  /**
   * Get all metrics for this queryset
   * @returns {Object} - Object with all metrics
   */
  getAll() {
    return this.manager.getAllMetrics(this.querysetId);
  }
  
  /**
   * Get all values for a specific metric
   * @param {string} metricName - Name of the metric
   * @returns {Object} - Object with all values for the metric
   */
  getMetric(metricName) {
    const allMetrics = this.getAll();
    return allMetrics[metricName] || {};
  }
  
  /**
   * Check if a metric exists
   * @param {string} metricName - Name of the metric
   * @param {string} fieldName - Optional field name
   * @returns {boolean} - True if the metric exists
   */
  has(metricName, fieldName = null) {
    try {
      if (fieldName) {
        return this.manager.getMetric(this.querysetId, metricName, fieldName) !== undefined;
      } else {
        const allMetrics = this.getAll();
        return metricName in allMetrics;
      }
    } catch (error) {
      return false;
    }
  }
}

/**
 * QuerysetProxy - Provides access to a collection of models
 */
class QuerysetProxy {
  constructor(manager, querysetId) {
    this.manager = manager;
    this.querysetId = querysetId;
  }
  
  /**
   * Get the models in the queryset as proxies
   * @returns {Array} - Array of denormalized model objects with resolved relationships
   */
  get() {
    return this.manager.getQuerysetProxy(this.querysetId);
  }
  
  /**
   * Get a metric proxy for this queryset
   * @returns {MetricProxy} - A metric proxy for this queryset
   */
  metrics() {
    return new MetricProxy(this.manager, this.querysetId);
  }
  
  /**
   * Get array of model proxies that can be used for more control
   * @returns {Array<ModelProxy>} - Array of model proxy instances
   */
  getProxies() {
    const { ast, modelName } = this.manager.querysetStore[this.querysetId];
    return ast.map(id => new ModelProxy(this.manager, modelName, id));
  }
  
  /**
   * Get a model by position in the queryset
   * @param {number} index - Position in the queryset (0-based)
   * @returns {Object} - Denormalized model with resolved relationships
   */
  at(index) {
    const { ast, modelName } = this.manager.querysetStore[this.querysetId];
    if (index < 0 || index >= ast.length) {
      throw new Error(`Index ${index} out of bounds for queryset of length ${ast.length}`);
    }
    return this.manager.createModelProxy(modelName, ast[index]);
  }
  
  /**
   * Get a model proxy by position in the queryset
   * @param {number} index - Position in the queryset (0-based)
   * @returns {ModelProxy} - Model proxy for the model at the given position
   */
  getProxy(index) {
    const { ast, modelName } = this.manager.querysetStore[this.querysetId];
    if (index < 0 || index >= ast.length) {
      throw new Error(`Index ${index} out of bounds for queryset of length ${ast.length}`);
    }
    return new ModelProxy(this.manager, modelName, ast[index]);
  }
  
  /**
   * Get the length of the queryset
   * @returns {number} - Number of models in the queryset
   */
  length() {
    return this.manager.querysetStore[this.querysetId].ast.length;
  }
  
  /**
   * Map a function over each model in the queryset
   * @param {Function} callback - Function to apply to each model
   * @returns {Array} - Array of results
   */
  map(callback) {
    return this.get().map(callback);
  }
  
  /**
   * Filter the queryset by a predicate function
   * @param {Function} predicate - Function that returns true for models to keep
   * @returns {Array} - Filtered array of models
   */
  filter(predicate) {
    return this.get().filter(predicate);
  }
}
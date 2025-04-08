import { ModelStore } from '../stores/modelStore';

class ModelStoreRegistry {
    constructor() {
      this._stores = new Map();
    }

    clear(){
      this._stores = new Map();
    }
  
    getStore(modelClass) {
      const key = `${modelClass.configKey}::${modelClass.modelName}`;
      if (!this._stores.has(key)) {
        // Create a new ModelStore on demand
        const fetchModels = async ({ pks, modelClass }) => {
          return await modelClass.objects.filter({
            [`${modelClass.primaryKeyField}__in`]: pks
          }).fetch();
        };
        this._stores.set(key, new ModelStore(modelClass, fetchModels, [], []));
      }
      return this._stores.get(key);
    }
  
    // Get a single entity from the store
    getEntity(modelClass, pk) {
      if (!modelClass) throw new Error("modelClass is required")
      if (!pk) throw new Error("pk is required")
      if (pk[modelClass.primaryKeyField]) throw new Error("getEntity should be called with a pk")
      const store = this.getStore(modelClass);
      const renderedData = store.render([pk]);
      return renderedData[0] || null;
    }
  
    // Add or update an entity in the store
    setEntity(modelClass, pk, data) {
      if (!modelClass) throw new Error("modelClass is required")
      if (!pk) throw new Error("pk is required")
      if (!pk) return;
      const store = this.getStore(modelClass);
      store.addToGroundTruth([data]);
      return data;
    }
  }
  
// Export singleton instance
export const modelStoreRegistry = new ModelStoreRegistry();
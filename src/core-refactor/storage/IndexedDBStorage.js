import { openDB, deleteDB } from 'idb';

export class IndexedDBStorage {
    constructor(options) {
      this.dbName = options.dbName || 'modelsync_cache';
      this.storeName = options.storeName || 'query_state';
      this.version = options.version || 1;
      this.dbPromise = null; // Store the promise for the DB connection
      this._isClosing = false; // Flag to track closing state
      this._operationCounter = 0; // Track active operations
    }

    /**
     * Initialize the database connection (returns a promise for the DB)
     * Uses idb's openDB function.
     * @returns {Promise<IDBPDatabase>}
     */
    async _getDb() {
      if (this._isClosing) {
        throw new Error('Cannot access database during close operation');
      }
      
      if (!this.dbPromise) {
        const storeName = this.storeName; // Capture for upgrade function
        
        this.dbPromise = openDB(this.dbName, this.version, {
          upgrade(db, oldVersion, newVersion, transaction) {
            // This runs if the DB version changes or the DB doesn't exist
            console.log(`Upgrading DB from version ${oldVersion} to ${newVersion}`);
            if (!db.objectStoreNames.contains(storeName)) {
              db.createObjectStore(storeName, { keyPath: 'id' });
              console.log(`Object store ${storeName} created.`);
            }
          },
          blocked() {
            console.warn(`IndexedDB open blocked for ${this.dbName}. Close other tabs/connections.`);
          },
          blocking() {
            console.warn(`IndexedDB connection is blocking version upgrade for ${this.dbName}.`);
          },
          terminated() {
            console.warn(`IndexedDB connection terminated unexpectedly for ${this.dbName}.`);
            this.dbPromise = null;
          }
        });
      }
      
      try {
        return await this.dbPromise;
      } catch (error) {
        this.dbPromise = null; // Reset on error
        throw error;
      }
    }

    /**
     * Save data to IndexedDB with timeout
     */
    async save(data) {
      if (this._isClosing) {
        throw new Error('Cannot save during database close operation');
      }
      
      this._operationCounter++;
      try {
        const db = await this._getDb();
        
        // Add timeout protection
        const saveOperation = db.put(this.storeName, data);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Save operation timed out")), 3000)
        );
        
        const key = await Promise.race([saveOperation, timeoutPromise]);
        return key;
      } catch (error) {
        console.error("IDB Save Error:", error);
        throw error;
      } finally {
        this._operationCounter--;
      }
    }

    /**
     * Load data from IndexedDB with timeout
     */
    async load(id) {
      if (this._isClosing) {
        throw new Error('Cannot load during database close operation');
      }
      
      this._operationCounter++;
      try {
        const db = await this._getDb();
        
        // Add timeout protection
        const loadOperation = db.get(this.storeName, id);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Load operation timed out")), 3000)
        );
        
        const data = await Promise.race([loadOperation, timeoutPromise]);
        return data;
      } catch (error) {
        console.error("IDB Load Error:", error);
        throw error;
      } finally {
        this._operationCounter--;
      }
    }

    /**
     * Delete data from IndexedDB with timeout
     */
    async delete(id) {
      if (this._isClosing) {
        throw new Error('Cannot delete during database close operation');
      }
      
      this._operationCounter++;
      try {
        const db = await this._getDb();
        
        // Add timeout protection
        const deleteOperation = db.delete(this.storeName, id);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Delete operation timed out")), 3000)
        );
        
        await Promise.race([deleteOperation, timeoutPromise]);
      } catch (error) {
        console.error("IDB Delete Error:", error);
        throw error;
      } finally {
        this._operationCounter--;
      }
    }

    /**
     * Close the database connection with improved logic
     */
    async close() {
      if (this._isClosing) {
        return;
      }
      
      if (!this.dbPromise) {
        return;
      }
      
      this._isClosing = true;
      
      // Wait for pending operations to complete (with timeout)
      const waitStart = Date.now();
      while (this._operationCounter > 0) {
        
        // Add timeout to prevent infinite waiting
        if (Date.now() - waitStart > 2000) {
          console.warn(`Timed out waiting for ${this._operationCounter} operations to complete`);
          break;
        }
        
        // Small delay before checking again
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      try {
        const db = await this.dbPromise;
        db.close();
      } catch (error) {
      } finally {
        // Always clean up regardless of success
        this.dbPromise = null;
        this._isClosing = false;
      }
    }

    /**
     * Static method to delete the database with timeout
     */
    static async deleteDatabase(dbName) {
      try {        
        const deleteOp = deleteDB(dbName, {
          blocked() {
            console.warn(`Attempt to delete database '${dbName}' is blocked.`);
          }
        });
        
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error(`Delete database '${dbName}' timed out`)), 3000)
        );
        
        await Promise.race([deleteOp, timeoutPromise]);
      } catch (error) {
        console.error(`Error deleting database '${dbName}':`, error);
        throw error;
      }
    }
}
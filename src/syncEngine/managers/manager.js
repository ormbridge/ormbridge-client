import hash from 'object-hash';
import { ModelStore } from '../stores/modelStore';
import { QuerysetStore } from '../stores/querysetStore';
import { Model } from '../../react-entry';
import { Operation } from 'mutative/dist/interface';
import { v7 as uuidv7 } from 'uuid'

modelStoreRegistry = new Map()
querysetStoreRegistry = new Map()

const opTypes = {
    read: new Set(['list', 'read', 'first', 'last']),
    mutate: new Set(['create', 'update', 'delete', 'create_or_update', 'get_or_create']),
    agg: new Set(['count', 'sum', 'min', 'max'])
}

class QuerysetManager {
    constructor(queryset, optimistic = true){
        this.queryset = queryset
        this.optimistic = optimistic
    }

    _executeRemote(queryset, query){
        // execution logic
    }

    async _fetchModels({ pks, modelClass }){
        // function to refresh the models
        return await modelClass.objects.filter({[`${modelClass.primaryKeyField}__in`]: pks})
    }

    async _fetchQueryset({ ast, modelClass }){
        // function to refresh the qs
        ast.serializerOptions.depth = 0 // set to zero
        ast.serializerOptions.fields = [modelClass.primaryKeyField] // just grab the pk, its faster
        return this._executeRemote(null, ast)
    }

    _getModelStore(model){
        // singleton pattern
        let existing = modelStoreRegistry.get(`${model.configKey}::${model.modelName}`)
        if (!existing){
            existing = new ModelStore(model, this._fetchModels, [], [])
            modelStoreRegistry.set(`${model.configKey}::${model.modelName}`) = existing
        }        
        return existing
    }

    _getQsStore(model, queryset, query){
        // singleton pattern
        let existing = querysetStoreRegistry.get(`${model.configKey}::${hash(query)}`)
        if (!existing){
            existing = QuerysetStore(model, this._fetchQueryset, query, [], [])
            querysetStoreRegistry.set(`${model.configKey}::${hash(query)}`)
        }
        return existing
    }

    async _executeWrite(operationId, queryset, query, stores){
        try {
            let response = await this._executeRemote(queryset, query)
        } catch (error) {
            stores.forEach((store) => {
                store.reject(operationId)
            })
        }
        stores.forEach((store) => {
            store.confirm(operationId, response)
        })
        return response
    }

    async handleWrite(queryset, query){
        let modelStore = _getModelStore(queryset.ModelClass)
        let qsStore = this._getQsStore(queryset.ModelClass, queryset, query)

        let operationId = `${uuidv7()}`
        let tempPk = {[queryset.ModelClass.primaryKeyField]: operationId}
        let operation = new Operation(operationId, query.type, 'inflight', {...query.data, ...tempPk })
        
        [modelStore, qsStore].forEach((store) => {
            store.addOperation(operation)
        })
        
        if (!this.optimistic){
            let result = await this._executeRemote(queryset, query)
            modelStore.addToGroundTruth(result)
            return result
        }
        // don't await, return immediately
        this._executeWrite(operationId, queryset, query, [modelStore, qsStore])
        return modelStore.render(operationId)
    }

    handleRead(queryset, query){
        let store = this._getModelStore(queryset.ModelClass)
        let operationId = `${uuidv7}`
        
        // try and render from the existing

        
    }

    handleAgg(queryset, query){

    }
}
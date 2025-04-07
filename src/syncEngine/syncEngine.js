import { getStore } from './stores/store'
import { OperationType, OperationStatus, OperationData, Operation } from './operation'
import { get } from 'lodash'

class QueryExecutor {

    execute(ast){
        // execute using the existing behaviour of the queryset
    }

    async fetchModels({pks, modelClass }){
        // a function that fetches models, used so the stores can do periodic sync
        return await modelClass.objects.filter({[`${modelClass.primaryKeyField}__in`]: pks}).fetch({ depth: 1 })
    }

    async fetchQs({ ast, modelClass }){
        // this is actually just a standard execute
        return await this.execute(ast)
    }
}


class SyncEngine {

    constructor(optimistic = true){
        this.optimistic = optimistic
    }

    handleWrite(queryset: any, ast: object){
        // write operations get optimistically added, then executed

        if (!ast.materialized) throw new Error(`HandleRead called with unmaterialized ast: ${ast}`)

        let operation = new Operation({
            type: ast.type,
            status: 'inflight',
            instances: ast.data
        })
        
        let backendName = queryset.ModelClass.configKey
        let registry = this.registry
        let store = getStore(backendName, registry, QueryExecutor.fetchModels, fetchQs)
        
    }

    handleRead(queryset, ast){
        

    }

    handleMetricAgg(queryset, ast){
        // for now we just execute this and return the simple result

    }

}
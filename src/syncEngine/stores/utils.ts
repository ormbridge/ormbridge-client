export interface ModelClass<T extends Record<string, any>> {
    primaryKeyField: keyof T;
    configKey: string;
    modelName: string;
}

export function getStoreKey(modelClass: ModelClass<any>): string {
    // Hash key for indexdb persistence
    let modelName = modelClass.modelName;
    let configKey = modelClass.configKey;
    return `${modelName}::${configKey}`;
}
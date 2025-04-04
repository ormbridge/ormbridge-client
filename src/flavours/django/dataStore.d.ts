/**
 * Core types for the ModelSync system
 */

// Basic types for identifiers
type ModelName = string;
type ModelId = string | number;
type QuerysetId = string;
type MetricName = string;
type FieldName = string | null;

// Model instance and relationships
interface ModelInstance {
  type: ModelName;
  id: ModelId;
  [key: string]: any; // Additional properties
}

interface ModelReference {
  type: ModelName;
  id: ModelId;
}

// API Response structure
interface ApiResponse {
  data: ModelInstance | ModelInstance[];
  included?: {
    [modelName: string]: {
      [id: string]: ModelInstance;
    };
  };
}

// Store structures
interface ModelStore {
  [modelName: string]: {
    [id: string]: ModelInstance;
  };
}

interface MetricStore {
  [key: string]: any; // 'querysetId::metricName::fieldName' -> value
}

interface QuerysetStore {
  [ast: string]: { // ast is a stringified representation of the query
    instances: ModelId[];
    modelName: ModelName;
  };
}

// Operation types
type OperationType = 'create' | 'update' | 'delete';
type OperationStatus = 'inflight' | 'confirmed' | 'rejected';

interface Operation {
  operationId: string;
  type: OperationType;
  status: OperationStatus;
  instances: ModelInstance[] | ModelId[];
  timestamp: number;
}

// QueryState types
interface QueryState {
  pkField: string;
  ItemClass?: any;
  groundTruth: ModelInstance[];
  operations: Map<string, Operation>;
  version: number;
  lastSyncTime: number;
  isSyncing: boolean;
  
  getGroundTruth(): ModelInstance[];
  subscribe(callback: SubscriberCallback, eventTypes?: string[]): () => void;
}

type SubscriberCallback = (eventType: string, data: any, queryState: QueryState) => void;

// Render engines
interface RenderEngine {
  queryState: QueryState;
  render(params: RenderParams): ModelInstance[];
}

interface RenderParams {
  offset?: number;
  limit?: number | null;
  sortFn?: (a: ModelInstance, b: ModelInstance) => number;
}

// Metric types
interface Metric {
  queryState: QueryState;
  value: any;
  getValue(): any;
}

interface MetricCalculationStrategy {
  calculate(
    groundTruthMetricValue: any,
    filteredGroundTruthDataSlice: ModelInstance[],
    filteredOptimisticDataSlice: ModelInstance[],
    field: FieldName
  ): any;
}

interface MetricRenderEngine {
  queryState: QueryState;
  metric: Metric;
  strategy: MetricCalculationStrategy;
  renderEngine: RenderEngine;
  
  render(field?: FieldName): any;
}

// Proxy interfaces
interface ModelProxyInterface {
  manager: ModelSyncManagerInterface;
  modelName: ModelName;
  id: ModelId;
  proxy: any;
  
  get(): ModelInstance;
  getRelated(relationField: string): ModelProxyInterface | ModelProxyInterface[];
  getRaw(): ModelInstance;
}

interface MetricProxyInterface {
  manager: ModelSyncManagerInterface;
  querysetId: QuerysetId;
  
  get(metricName: MetricName, fieldName: FieldName): any;
  set(metricName: MetricName, fieldName: FieldName, value: any): void;
  getAll(): { [metricName: string]: { [fieldName: string]: any } };
}

interface QuerysetProxyInterface {
  manager: ModelSyncManagerInterface;
  querysetId: QuerysetId;
  
  get(): ModelInstance[];
  metrics(): MetricProxyInterface;
  getProxies(): ModelProxyInterface[];
  length(): number;
  map<T>(callback: (model: ModelInstance) => T): T[];
  filter(predicate: (model: ModelInstance) => boolean): ModelInstance[];
}

// Main manager interface
interface ModelSyncManagerInterface {
  modelStore: ModelStore;
  metricStore: MetricStore;
  querysetStore: QuerysetStore;
  proxies: WeakMap<any, any>;
  queryStates: Map<string, QueryState>;
  renderEngines: Map<string, RenderEngine>;
  metricEngines: Map<string, { [metricName: string]: MetricRenderEngine }>;
  
  createModelProxy(modelName: ModelName, id: ModelId): any;
  getMetric(querysetId: QuerysetId, metricName: MetricName, fieldName: FieldName): any;
  setMetric(querysetId: QuerysetId, metricName: MetricName, fieldName: FieldName, value: any): void;
  getQuerysetProxy(querysetId: QuerysetId): ModelInstance[];
  
  registerQueryState(queryId: string, queryState: QueryState, createRenderEngine?: boolean): RenderEngine | null;
  registerMetricEngine(
    queryId: string,
    metricName: MetricName,
    metric: Metric,
    strategy: MetricCalculationStrategy
  ): MetricRenderEngine;
}

// Normalized API Response Example
interface NormalizedApiResponseExample {
  data: {
    type: string;
    id: number | string;
    [key: string]: any;
    author?: ModelReference;
    comments?: ModelReference[];
  };
  included: {
    [modelType: string]: {
      [modelId: string]: {
        type: string;
        id: number | string;
        [key: string]: any;
        author?: ModelReference;
        comments?: ModelReference[];
      }
    }
  }
}

// Example normalized API response structure with relationships
/*
const exampleResponse: NormalizedApiResponseExample = {
  data: {
    type: "blog.post",
    id: 10,
    title: "My First Blog Post",
    content: "This is the content of the post.",
    repr: { str: "Post object (10)", img: null },
    author: { type: "blog.user", id: 1 },
    comments: [
      { type: "blog.comment", id: 101 },
      { type: "blog.comment", id: 102 }
    ]
  },
  included: {
    "blog.user": {
      "1": {
        type: "blog.user", 
        id: 1,
        username: "alice",
        email: "alice@example.com",
        repr: { str: "alice", img: "/path/to/alice.jpg" }
      },
      "2": {
        type: "blog.user",
        id: 2,
        username: "bob",
        email: "bob@example.com",
        repr: { str: "bob", img: null }
      }
    },
    "blog.comment": {
      "101": {
        type: "blog.comment",
        id: 101,
        text: "Great post!",
        repr: { str: "Comment object (101)", img: null },
        author: { type: "blog.user", id: 2 },
        post: { type: "blog.post", id: 10 }
      },
      "102": {
        type: "blog.comment",
        id: 102,
        text: "I agree!",
        repr: { str: "Comment object (102)", img: null },
        author: { type: "blog.user", id: 1 },
        post: { type: "blog.post", id: 10 }
      }
    }
  }
}
*/
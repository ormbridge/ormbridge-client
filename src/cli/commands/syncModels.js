import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import cliProgress from 'cli-progress';
import Handlebars from 'handlebars';
import _ from 'lodash-es';
import { configInstance } from '../../config.js';  // Global config singleton
import { loadConfigFromFile } from '../configFileLoader.js';

// --------------------
// JSDoc Type Definitions
// --------------------

/**
 * @typedef {Object} GenerateArgs
 * // Additional arguments for generation if needed.
 */

/**
 * @typedef {Object} SchemaProperty
 * @property {string} type
 * @property {string} [format]
 * @property {SchemaProperty} [items]
 * @property {Object.<string, SchemaProperty>} [properties]
 * @property {string[]} [required]
 * @property {string[]} [enum]
 * @property {string} [description]
 * @property {boolean} [nullable]
 * @property {any} [default]
 * @property {string} [ref]
 */

/**
 * @typedef {Object} RelationshipData
 * @property {string} type
 * @property {string} model - e.g. "django_app.deepmodellevel1"
 * @property {string} class_name - e.g. "DeepModelLevel1"
 * @property {string} primary_key_field
 */

/**
 * @typedef {Object} SchemaDefinition
 * @property {string} type
 * @property {Object.<string, SchemaProperty>} properties
 * @property {string[]} [required]
 * @property {string} [description]
 * @property {Object.<string, SchemaDefinition>} [definitions]
 * @property {string} model_name
 * @property {string} class_name
 * @property {string} [primary_key_field]
 * @property {Object.<string, RelationshipData>} [relationships]
 */

/**
 * @typedef {Object} PropertyDefinition
 * @property {string} name
 * @property {string} type
 * @property {boolean} required
 * @property {string} defaultValue
 * @property {boolean} [isRelationship]
 * @property {string} [relationshipClassName]
 * @property {boolean} [isArrayRelationship]
 * @property {string} [relationshipPrimaryKeyField]
 * @property {boolean} [isString]
 * @property {boolean} [isNumber]
 * @property {boolean} [isBoolean]
 * @property {boolean} [isDate]
 * @property {boolean} [isPrimaryKey]
 */

/**
 * @typedef {Object} TemplateData
 * @property {string} modulePath           - Dynamic module path for imports.
 * @property {string} className            - Exported full model class name (from schema.class_name).
 * @property {string} interfaceName        - Full model fields interface name (e.g. DeepModelLevel1Fields).
 * @property {string} summaryClassName     - Generated summary class name (e.g. DeepModelLevel1Summary).
 * @property {string} summaryInterfaceName - Generated summary interface name (e.g. DeepModelLevel1SummaryFields).
 * @property {string} modelName            - Raw schema.model_name (including app label path).
 * @property {PropertyDefinition[]} properties
 * @property {string} [description]
 * @property {string[]} [definitions]
 * @property {string[]} [jsImports]        - For JS generation: full class imports.
 * @property {string[]} [tsImports]        - For TS generation: type imports (Fields and SummaryFields).
 * @property {string} configKey            - The backend config key.
 * @property {string} primaryKeyField      - Primary key field from schema.
 */

/**
 * @typedef {Object} BackendConfig
 * @property {string} NAME
 * @property {string} API_URL
 * @property {string} GENERATED_TYPES_DIR
 */

/**
 * @typedef {Object} SelectedModel
 * @property {BackendConfig} backend
 * @property {string} model
 */

// --------------------
// Handlebars Templates & Helpers
// --------------------

// Template for JavaScript implementation
const JS_MODEL_TEMPLATE = `/**
 * This file was auto-generated. Do not make direct changes to the file.
{{#if description}}
 * {{description}}
{{/if}}
 */

import _ from 'lodash-es';
import { Model, Manager, QuerySet } from '{{modulePath}}';
import { createModelInstance } from '{{modulePath}}';
import schemaData from './{{className}}.schema.json';
{{#if jsImports}}
{{#each jsImports}}
{{{this}}}
{{/each}}
{{/if}}

/**
 * Model-specific QuerySet implementation
 */
export class {{className}}QuerySet extends QuerySet {
  // QuerySet implementation with model-specific typing
}

/**
 * Model-specific Manager implementation
 */
export class {{className}}Manager extends Manager {
  constructor(ModelClass) {
    super(ModelClass, {{className}}QuerySet);
  }
  
  newQuerySet() {
    return new {{className}}QuerySet(this.ModelClass);
  }
}

/**
 * Implementation of the {{className}} model
 */
export class {{className}} extends Model {
  // Bind this model to its backend
  static configKey = '{{configKey}}';
  static modelName = '{{modelName}}';
  static primaryKeyField = '{{primaryKeyField}}';
  static objects = new {{className}}Manager({{className}});
  static fields = [{{#each properties}}'{{name}}'{{#unless @last}}, {{/unless}}{{/each}}];
  static schema = schemaData;

  constructor(data) {
    {{className}}.validateFields(data);
    super(data);
{{#each properties}}
  {{#if isRelationship}}
    {{#if isArrayRelationship}}
    this.{{name}} = data.{{name}} 
      ? data.{{name}}.map(item => createModelInstance({{relationshipClassName}}, {{relationshipClassName}}Summary, item))
      : data.{{name}};
    {{else}}
    this.{{name}} = data.{{name}} 
      ? createModelInstance({{relationshipClassName}}, {{relationshipClassName}}Summary, data.{{name}})
      : data.{{name}};
    {{/if}}
  {{else}}
    this.{{name}} = data.{{name}};
  {{/if}}
{{/each}}
  }

  // Serialize only the allowed fields
  serialize() {
    const data = {};
    {{#each properties}}
      {{#if isRelationship}}
        {{#if isArrayRelationship}}
    // For array relationships (many-to-many)
    data.{{name}} = this.{{name}} 
      ? this.{{name}}.map(item => item?.['{{relationshipPrimaryKeyField}}'] || item)
      : this.{{name}};
        {{else}}
    // For single relationships
    data.{{name}} = this.{{name}}?.['{{relationshipPrimaryKeyField}}'] || this.{{name}};
        {{/if}}
      {{else}}
    data.{{name}} = this.{{name}};
      {{/if}}
    {{/each}}
    return data;
  }
}

// --------------------
// Summary Model
// --------------------
import { ModelSummary } from '{{modulePath}}';

export class {{summaryClassName}} extends ModelSummary {
  static configKey = '{{configKey}}';
  static modelName = '{{modelName}}';
  static primaryKeyField = '{{primaryKeyField}}';
  static fullModelConstructor = {{className}};

  constructor(data) {
    super(data);
  }
}
`;

// Updated TS_DECLARATION_TEMPLATE with improved relationship handling
const TS_DECLARATION_TEMPLATE = `/**
 * This file was auto-generated. Do not make direct changes to the file.
{{#if description}}
 * {{description}}
{{/if}}
 */

import { Model, Manager, ModelSummary, ModelSummaryFields } from '{{modulePath}}';
import { StringOperators, NumberOperators, BooleanOperators, DateOperators } from '{{modulePath}}';
import { QuerySet, LiveQuerySet, LiveQuerySetOptions, MetricResult, ResultTuple, SerializerOptions, NestedPaths } from '{{modulePath}}';

// Re-export the real Manager for runtime use
import { Manager as RuntimeManager } from '{{modulePath}}';
{{#if tsImports}}
{{#each tsImports}}
{{{this}}}
{{/each}}
{{/if}}

/**
 * Base fields interface - defines the shape of a model instance
 * This is the single source of truth for the model's data structure
 */
export interface {{interfaceName}} {
{{#each properties}}
  {{name}}{{#unless required}}?{{/unless}}: {{{type}}};
{{/each}}
}

/**
 * Type for creating new instances
 * Similar to base fields but makes ID fields optional
 */
export type {{className}}CreateData = {
{{#each properties}}
  {{name}}{{#unless isPrimaryKey}}{{#unless required}}?{{/unless}}{{else}}?{{/unless}}: {{{type}}};
{{/each}}
};

/**
 * Type for updating instances
 * All fields are optional since updates can be partial
 */
export type {{className}}UpdateData = Partial<{{interfaceName}}>;

/**
 * Type for filtering with field lookups
 * Supports advanced filtering with operators like __gte, __contains, etc.
 */
export interface {{className}}FilterData {
{{#each properties}}
  {{#if isRelationship}}
    {{#if isArrayRelationship}}
  // Many-to-many relationship field
  {{name}}?: number;  // Exact match by ID
  {{name}}__in?: number[];  // Match any of these IDs
  {{name}}__isnull?: boolean;  // Check if relation exists
    {{else}}
  // Foreign key relationship field
  {{name}}?: number;  // Exact match by ID
  {{name}}__isnull?: boolean;  // Check if relation exists
    {{/if}}
  {{else}}
    {{#if isString}}
  {{name}}?: string | StringOperators;
  {{name}}__contains?: string;
  {{name}}__icontains?: string;
  {{name}}__startswith?: string;
  {{name}}__istartswith?: string;
  {{name}}__endswith?: string;
  {{name}}__iendswith?: string;
  {{name}}__exact?: string;
  {{name}}__iexact?: string;
  {{name}}__in?: string[];
  {{name}}__isnull?: boolean;
    {{/if}}
    {{#if isNumber}}
  {{name}}?: number | NumberOperators;
  {{name}}__gt?: number;
  {{name}}__gte?: number;
  {{name}}__lt?: number;
  {{name}}__lte?: number;
  {{name}}__exact?: number;
  {{name}}__in?: number[];
  {{name}}__isnull?: boolean;
    {{/if}}
    {{#if isBoolean}}
  {{name}}?: boolean | BooleanOperators;
  {{name}}__exact?: boolean;
  {{name}}__isnull?: boolean;
    {{/if}}
    {{#if isDate}}
  {{name}}?: Date | DateOperators;
  {{name}}__gt?: Date;
  {{name}}__gte?: Date;
  {{name}}__lt?: Date;
  {{name}}__lte?: Date;
  {{name}}__exact?: Date;
  {{name}}__in?: Date[];
  {{name}}__isnull?: boolean;
    {{/if}}
  {{/if}}
{{/each}}
  // Support for nested filtering on related fields
  [key: string]: any;
  
  // Support for Q objects
  Q?: Array<any>;
}

/**
 * Model-specific QuerySet with strictly typed methods
 */
export declare class {{className}}QuerySet extends QuerySet<any> {
  // Chain methods
  filter(conditions: {{className}}FilterData): {{className}}QuerySet;
  exclude(conditions: {{className}}FilterData): {{className}}QuerySet;
  orderBy(...fields: Array<keyof {{interfaceName}} | string>): {{className}}QuerySet;
  selectRelated(...fields: Array<string>): {{className}}QuerySet;
  prefetchRelated(...fields: Array<string>): {{className}}QuerySet;
  search(searchQuery: string, searchFields?: Array<string>): {{className}}QuerySet;
  
  // Terminal methods
  get(filters?: {{className}}FilterData, serializerOptions?: SerializerOptions): Promise<{{className}}>;
  first(serializerOptions?: SerializerOptions): Promise<{{className}} | null>;
  last(serializerOptions?: SerializerOptions): Promise<{{className}} | null>;
  all(): {{className}}QuerySet;
  count(field?: string): Promise<number>;
  update(updates: {{className}}UpdateData): Promise<[number, Record<string, number>]>;
  delete(): Promise<[number, Record<string, number>]>;
  exists(): Promise<boolean>;
  fetch(serializerOptions?: SerializerOptions): Promise<{{className}}[]>;
}

/**
 * Model-specific Manager with strictly typed methods
 */
export declare class {{className}}Manager extends Manager {
  newQuerySet(): {{className}}QuerySet;
  filter(conditions: {{className}}FilterData): {{className}}QuerySet;
  exclude(conditions: {{className}}FilterData): {{className}}QuerySet;
  all(): {{className}}QuerySet;
  get(filters?: {{className}}FilterData, serializerOptions?: SerializerOptions): Promise<{{className}}>;
  create(data: {{className}}CreateData): Promise<{{className}}>;
  delete(): Promise<[number, Record<string, number>]>;
}

/**
 * Model-specific LiveQuerySet with strictly typed methods
 */
export declare class {{className}}LiveQuerySet extends LiveQuerySet {
  // Data access
  get data(): {{className}}[];
  
  // Chain methods
  filter(conditions: {{className}}FilterData): {{className}}LiveQuerySet;
  
  // Terminal methods
  fetch(serializerOptions?: SerializerOptions): Promise<{{className}}[]>;
  get(filters?: {{className}}FilterData, serializerOptions?: SerializerOptions): Promise<{{className}}>;
  create(item: {{className}}CreateData): Promise<{{className}}>;
  update(updates: {{className}}UpdateData): Promise<{{className}}[]>;
  delete(): Promise<void>;
  count(field?: string): Promise<MetricResult<number>>;
  sum(field: string): Promise<MetricResult<number>>;
  avg(field: string): Promise<MetricResult<number>>;
  min(field: string): Promise<MetricResult<any>>;
  max(field: string): Promise<MetricResult<any>>;
}

/**
 * Enhanced RuntimeManager to provide TypeScript typings
 * This creates a concrete class that both extends RuntimeManager and matches type expectations
 */
export class {{className}}Manager extends RuntimeManager {
  filter(conditions: {{className}}FilterData): ReturnType<RuntimeManager['filter']> {
    return super.filter(conditions as any);
  }
  
  get(filters?: {{className}}FilterData, serializerOptions?: SerializerOptions): Promise<{{className}}> {
    return super.get(filters as any, serializerOptions);
  }
  
  all() {
    return super.all();
  }
  
  create(data: {{className}}CreateData): Promise<{{className}}> {
    return super.create(data);
  }
  
  update(data: {{className}}UpdateData): Promise<any> {
    return super.update(data);
  }
}

export interface {{summaryInterfaceName}} extends ModelSummaryFields {
  {{primaryKeyField}}: number;
  repr: {
    str: string;
    img?: string;
  };
}

// Class declarations
export declare class {{className}} extends Model implements {{interfaceName}} {
{{#each properties}}
  {{name}}{{#unless required}}?:{{else}}:{{/unless}} {{{type}}};
{{/each}}

  static configKey: string;
  static modelName: string;
  static primaryKeyField: string;
  
  // Use model-specific manager class instead of generic manager
  static objects: {{className}}Manager;

  constructor(data: Partial<{{interfaceName}}>);
  serialize(): Partial<{{interfaceName}}>;
}

export declare class {{summaryClassName}} extends ModelSummary implements {{summaryInterfaceName}} {
  static configKey: string;
  static modelName: string;
  static primaryKeyField: string;
  static fullModelConstructor: typeof {{className}};

  {{primaryKeyField}}: number;
  repr: {
    str: string;
    img?: string;
  };

  constructor(data: Partial<{{summaryInterfaceName}}>);
}

/**
 * Runtime initialization
 */
{{className}}.objects = new {{className}}Manager({{className}});
`;

// --------------------
// Handlebars Helpers
// --------------------
Handlebars.registerHelper('ifDefaultProvided', function(defaultValue, options) {
  if (defaultValue !== "null") {
    return options.fn(this);
  } else {
    return options.inverse(this);
  }
});

Handlebars.registerHelper('isRequired', function(required) {
  return required ? '' : '?';
});

const jsTemplate = Handlebars.compile(JS_MODEL_TEMPLATE);
const dtsTemplate = Handlebars.compile(TS_DECLARATION_TEMPLATE);

// --------------------
// Core Generation Functions
// --------------------

/**
 * Generates the schema for a given model.
 * @param {BackendConfig} backend
 * @param {string} model
 * @returns {Promise<{model: string, relativePath: string}>}
 */
async function generateSchemaForModel(backend, model) {
  const schemaUrl = `${backend.API_URL}/${model}/get-schema/`;
  const schemaResponse = await axios.get(schemaUrl);

  /** @type {SchemaDefinition} */
  let schema;
  if (schemaResponse.data.components?.schemas?.[model]) {
    schema = schemaResponse.data.components.schemas[model];
  } else if (schemaResponse.data.properties) {
    schema = schemaResponse.data;
  } else {
    console.error('Unexpected schema structure for model:', model);
    throw new Error(`Invalid schema structure for model: ${model}`);
  }

  if (!schema.model_name) {
    console.error(`Missing model_name attribute in schema for model: ${model}`);
    process.exit(1);
  }
  const rawModelName = schema.model_name;
  const className = schema.class_name;
  const interfaceName = `${className}Fields`;
  const summaryClassName = `${className}Summary`;
  const summaryInterfaceName = `${className}SummaryFields`;

  const parts = model.split('.');
  const currentApp = parts.length > 1 ? parts[0] : '';

  const modulePath = process.env.NODE_ENV === 'test'
    ? '../../../src'
    : '@ormbridge/core';

  const templateData = prepareTemplateData(
    modulePath,
    className,
    interfaceName,
    summaryClassName,
    summaryInterfaceName,
    rawModelName,
    schema,
    currentApp,
    backend.NAME
  );

  let outDir = backend.GENERATED_TYPES_DIR;
  if (parts.length > 1) {
    outDir = path.join(outDir, ...parts.slice(0, -1).map(p => p.toLowerCase()));
  }
  await fs.mkdir(outDir, { recursive: true });

  const schemaFilePath = path.join(outDir, `${className.toLowerCase()}.schema.json`);
  await fs.writeFile(schemaFilePath, JSON.stringify(schema, null, 2));

  const jsContent = jsTemplate(templateData);
  const baseName = parts[parts.length - 1].toLowerCase();
  const jsFilePath = path.join(outDir, `${baseName}.js`);
  await fs.writeFile(jsFilePath, jsContent);

  const dtsContent = dtsTemplate(templateData);
  const dtsFilePath = path.join(outDir, `${baseName}.d.ts`);
  await fs.writeFile(dtsFilePath, dtsContent);

  const relativePath = './' + path.relative(backend.GENERATED_TYPES_DIR, jsFilePath)
    .replace(/\\/g, '/')
    .replace(/\.js$/, '');
  return { model, relativePath };
}

/**
 * Given a related model string (e.g. "django_app.deepmodellevel1"),
 * extract the app label and model name to construct an import path.
 * @param {string} currentApp
 * @param {string} relModel
 * @returns {string}
 */
function getImportPath(currentApp, relModel) {
  const parts = relModel.split('.');
  const appLabel = parts[0];
  const fileName = parts[parts.length - 1].toLowerCase();
  return currentApp === appLabel ? `./${fileName}` : `../${appLabel}/${fileName}`;
}

/**
 * Prepares template data for Handlebars.
 * @param {string} modulePath
 * @param {string} className
 * @param {string} interfaceName
 * @param {string} summaryClassName
 * @param {string} summaryInterfaceName
 * @param {string} rawModelName
 * @param {SchemaDefinition} schema
 * @param {string} currentApp
 * @param {string} configKey
 * @returns {TemplateData}
 */
/**
 * Prepares template data for Handlebars.
 * @param {string} modulePath
 * @param {string} className
 * @param {string} interfaceName
 * @param {string} summaryClassName
 * @param {string} summaryInterfaceName
 * @param {string} rawModelName
 * @param {SchemaDefinition} schema
 * @param {string} currentApp
 * @param {string} configKey
 * @returns {TemplateData}
 */
function prepareTemplateData(
  modulePath,
  className,
  interfaceName,
  summaryClassName,
  summaryInterfaceName,
  rawModelName,
  schema,
  currentApp,
  configKey
) {
  /** @type {PropertyDefinition[]} */
  const properties = [];
  const usedDefs = new Set();

  for (const [propName, prop] of Object.entries(schema.properties)) {
    const propType = generateTypeForProperty(prop, schema.definitions, schema.relationships, propName);
    const isRelationship = schema.relationships && schema.relationships[propName] !== undefined;
    const isString = prop.type === 'string';
    const isNumber = prop.type === 'integer' || prop.type === 'number';
    const isBoolean = prop.type === 'boolean';
    const isDate = prop.type === 'string' && prop.format === 'date-time';
    const isPrimaryKey = schema.primary_key_field === propName;
    
    const propDef = {
      name: propName,
      type: propType,
      required: schema.required?.includes(propName) ?? false,
      defaultValue: getDefaultValueForType(prop),
      isRelationship,
      isArrayRelationship: isRelationship ? propType.startsWith('Array<') : false,
      isString,
      isNumber, 
      isBoolean,
      isDate,
      isPrimaryKey
    };
    
    if (isRelationship) {
      const relData = schema.relationships[propName];
      propDef.relationshipClassName = relData.class_name;
      propDef.relationshipPrimaryKeyField = relData.primary_key_field;
    }
    
    properties.push(propDef);
    
    const match = propType.match(/^(\w+)Fields$/);
    if (match && schema.definitions && schema.definitions[match[1]]) {
      usedDefs.add(match[1]);
    }
    const arrMatch = propType.match(/^Array<(\w+)Fields>$/);
    if (arrMatch && schema.definitions && schema.definitions[arrMatch[1]]) {
      usedDefs.add(arrMatch[1]);
    }
  }

  const definitionsTs = [];
  if (schema.definitions) {
    for (const [defKey, defSchema] of Object.entries(schema.definitions)) {
      if (!usedDefs.has(defKey)) continue;
      let tsInterface = `export interface ${defKey}Fields {`;
      const req = defSchema.required || [];
      for (const [propName, prop] of Object.entries(defSchema.properties)) {
        tsInterface += `\n  ${propName}${req.includes(propName) ? '' : '?'}: ${generateTypeForProperty(prop, schema.definitions)};`;
      }
      tsInterface += `\n}`;
      definitionsTs.push(tsInterface);
    }
  }

  // Use Sets to ensure unique imports
  const jsImportSet = new Set();
  const tsImportSet = new Set();
  
  if (schema.relationships) {
    for (const [propName, rel] of Object.entries(schema.relationships)) {
      const importPath = getImportPath(currentApp, rel.model);
      jsImportSet.add(`import { ${rel.class_name}, ${rel.class_name}Summary } from '${importPath}';`);
      tsImportSet.add(`import { ${rel.class_name}Fields, ${rel.class_name}SummaryFields, ${rel.class_name}QuerySet, ${rel.class_name}LiveQuerySet } from '${importPath}';`);
    }
  }

  // Convert Sets to Arrays
  const jsImports = Array.from(jsImportSet);
  const tsImports = Array.from(tsImportSet);

  let primaryKeyField = 'id';
  if (schema.primary_key_field !== undefined) {
    primaryKeyField = schema.primary_key_field;
  }

  return {
    modulePath,
    className,
    interfaceName,
    summaryClassName,
    summaryInterfaceName,
    modelName: rawModelName,
    properties,
    description: schema.description,
    definitions: definitionsTs.length > 0 ? definitionsTs : undefined,
    jsImports,
    tsImports,
    configKey,
    primaryKeyField
  };
}

/**
 * Generates a TypeScript type for a property.
 * @param {SchemaProperty} prop
 * @param {Object.<string, SchemaDefinition>} [definitions]
 * @param {Object.<string, RelationshipData>} [relationships]
 * @param {string} [propName]
 * @returns {string}
 */
function generateTypeForProperty(
  prop,
  definitions,
  relationships,
  propName
) {
  if (relationships && propName && relationships[propName]) {
    const relData = relationships[propName];
    const idType = (prop.type === 'integer' || prop.type === 'number')
      ? 'number'
      : (prop.type === 'string' ? 'string' : 'any');
    return prop.format === 'many-to-many'
      ? `Array<${relData.class_name}Fields | ${relData.class_name}SummaryFields | ${idType}>`
      : `${relData.class_name}Fields | ${relData.class_name}SummaryFields | ${idType}`;
  }

  if (prop.ref && prop.ref.startsWith("#/components/schemas/")) {
    const defName = prop.ref.split("/").pop() || prop.ref;
    return `${defName}Fields`;
  }

  if (prop.ref) {
    return prop.format === 'many-to-many'
      ? `Array<${prop.ref}Fields>`
      : `${prop.ref}Fields`;
  }

  let tsType;
  switch (prop.type) {
    case 'string':
      tsType = prop.enum ? prop.enum.map(v => `'${v}'`).join(' | ') : 'string';
      break;
    case 'number':
    case 'integer':
      tsType = 'number';
      break;
    case 'boolean':
      tsType = 'boolean';
      break;
    case 'array':
      tsType = prop.items
        ? `Array<${generateTypeForProperty(prop.items, definitions)}>`
        : 'any[]';
      break;
    case 'object':
      if (prop.format === 'json') {
        tsType = 'any';
      } else if (prop.properties) {
        const nestedProps = Object.entries(prop.properties).map(([key, value]) => {
          const isRequired = prop.required?.includes(key) ? '' : '?';
          return `${key}${isRequired}: ${generateTypeForProperty(value, definitions)}`;
        });
        tsType = `{ ${nestedProps.join('; ')} }`;
      } else {
        tsType = 'Record<string, any>';
      }
      break;
    default:
      tsType = 'any';
      break;
  }
  if (prop.nullable) {
    tsType = `${tsType} | null`;
  }
  return tsType;
}

/**
 * Gets the default value for a property.
 * @param {SchemaProperty} prop
 * @returns {string}
 */
function getDefaultValueForType(prop) {
  return prop.default !== undefined ? JSON.stringify(prop.default) : "null";
}

/**
 * Generates app-level index files and a root index file that imports from app indexes.
 * @param {Array<{model: string, relativePath: string, backend: string}>} generatedFiles
 * @param {Object.<string, BackendConfig>} backendConfigs
 * @returns {Promise<void>}
 */
async function generateAppLevelIndexFiles(generatedFiles, backendConfigs) {
  // Group files by backend and app
  const filesByBackendAndApp = generatedFiles.reduce((acc, file) => {
    const backend = file.backend;
    const parts = file.model.split('.');
    const app = parts.length > 1 ? parts[0] : 'root'; // Use 'root' for models without an app
    
    acc[backend] = acc[backend] || {};
    acc[backend][app] = acc[backend][app] || [];
    acc[backend][app].push(file);
    
    return acc;
  }, {});

  const indexTemplate = Handlebars.compile(
    `{{#each files}}
export * from '{{this.relativePath}}';
{{/each}}`
  );

  // Generate app-level index files for each backend and app
  for (const [backendName, appGroups] of Object.entries(filesByBackendAndApp)) {
    const backend = backendConfigs[backendName];
    const rootExports = [];
    
    for (const [app, files] of Object.entries(appGroups)) {
      if (app === 'root') {
        // Handle models without an app prefix
        for (const file of files) {
          rootExports.push(`export * from '${file.relativePath}';`);
        }
      } else {
        // Create app-level index files with proper relative paths
        const appDir = path.join(backend.GENERATED_TYPES_DIR, app.toLowerCase());
        
        // Create relative paths for imports within the app directory
        // These should be relative to the app directory, not the backend root
        const appFiles = files.map(file => {
          // Get the last part of the path (the actual file name without extension)
          const fileName = path.basename(file.relativePath);
          return {
            ...file,
            relativePath: './' + fileName
          };
        });
        
        const indexContent = indexTemplate({ files: appFiles });
        await fs.writeFile(
          path.join(appDir, 'index.js'),
          indexContent.trim()
        );
        await fs.writeFile(
          path.join(appDir, 'index.d.ts'),
          indexContent.trim()
        );
        
        // Add an export for this app's index to the backend root index
        rootExports.push(`export * from './${app.toLowerCase()}/index';`);
      }
    }
    
    // Write the backend root index file
    await fs.writeFile(
      path.join(backend.GENERATED_TYPES_DIR, 'index.js'),
      rootExports.join('\n')
    );
    await fs.writeFile(
      path.join(backend.GENERATED_TYPES_DIR, 'index.d.ts'),
      rootExports.join('\n')
    );
  }
}

// --------------------
// Main Runner: Fetch models and prompt selection
// --------------------

// Update main function to use this new approach
async function main() {
  // Load configuration from file (CLI-only or tests) before any other operations.
  loadConfigFromFile();

  // Retrieve the validated configuration from the global config singleton.
  const configData = configInstance.getConfig();
  const backendConfigs = configData.backendConfigs;

  const inquirer = (await import('inquirer')).default;
  const fetchPromises = Object.keys(backendConfigs).map(async key => {
    const backend = backendConfigs[key];
    backend.NAME = key;
    try {
      const response = await axios.get(`${backend.API_URL}/models/`);
      return { backend, models: response.data };
    } catch (error) {
      console.error(`Error fetching models from backend ${backend.NAME}:`, error.message);
      return { backend, models: [] };
    }
  });

  const backendModels = await Promise.all(fetchPromises);
  const choices = [];
  for (const { backend, models } of backendModels) {
    choices.push(new inquirer.Separator(`\n=== ${backend.NAME} ===\n`));
    for (const model of models) {
      choices.push({
        name: model,
        value: { backend, model },
        checked: true
      });
    }
  }

  if (choices.length === 0) {
    console.log('No models to synchronise');
    process.exit(0);
  }

  const { selectedModels } = await inquirer.prompt([
    {
      type: 'checkbox',
      name: 'selectedModels',
      message: 'Select models to synchronise:',
      choices,
      pageSize: 20
    },
  ]);

  if (!selectedModels || selectedModels.length === 0) {
    console.log('No models selected. Exiting.');
    process.exit(0);
  }

  const modelsByBackend = selectedModels.reduce((acc, item) => {
    const key = item.backend.NAME;
    acc[key] = acc[key] || { backend: item.backend, models: [] };
    acc[key].models.push(item.model);
    return acc;
  }, {});

  const allGeneratedFiles = [];
  for (const group of Object.values(modelsByBackend)) {
    console.log(`\nProcessing backend: ${group.backend.NAME}`);
    const progressBar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
    progressBar.start(group.models.length, 0);

    for (const model of group.models) {
      try {
        const result = await generateSchemaForModel(group.backend, model);
        allGeneratedFiles.push({ ...result, backend: group.backend.NAME });
      } catch (error) {
        console.error(`Error generating schema for model ${model} from backend ${group.backend.NAME}:`, error.message);
      }
      progressBar.increment();
    }
    progressBar.stop();
  }

  // Use the new app-level index file generator
  await generateAppLevelIndexFiles(allGeneratedFiles, backendConfigs);

  console.log(`✨ Generated JavaScript files with TypeScript declarations for ${selectedModels.length} models across ${Object.keys(backendConfigs).length} backends.`);
}

/**
 * Main exported function to generate schema.
 * @param {GenerateArgs} args
 * @returns {Promise<void>}
 */
export async function generateSchema(args) {
  await main();
}
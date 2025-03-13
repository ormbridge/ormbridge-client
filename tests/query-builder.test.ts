import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  Model,
  APIManager,
  APIQuerySet,
  Q,
  DoesNotExist,
  MultipleObjectsReturned
} from '../src';

// Example test models
// Note: We now use "id" as the primary key field.
interface TestUserFields {
  id: number;
  name: string;
  email: string;
  address: {
    city: string;
    country: string;
  };
  orders: Array<{
    id: number;
    total: number;
    status: 'pending' | 'completed';
  }>;
}

// Create test model class
class TestUser extends Model implements TestUserFields {
  // The actual storage field is "id". The base Model's getter/setter for pk
  // will use the default static primaryKeyField ("id").
  id!: number;
  name!: string;
  email!: string;
  address!: { city: string; country: string };
  orders!: Array<{ id: number; total: number; status: 'pending' | 'completed' }>;

  static objects = new APIManager<TestUser>(TestUser);

  constructor(data: Partial<TestUserFields>) {
    super(data);
    // Set default values if needed. We assume data.id is provided when available.
    this.id = data.id!;
    this.name = data.name || '';
    this.email = data.email || '';
    this.address = data.address || { city: '', country: '' };
    this.orders = data.orders || [];
  }
}

describe('Query Builder', () => {
  it('should build basic filter query', () => {
    const query = TestUser.objects.filter({
      name: 'John',
      'address__city': 'New York'
    }).build();

    expect(query).toEqual({
      filter: {
        type: 'filter',
        conditions: {
          name: 'John',
          'address__city': 'New York'
        }
      },
      aggregations: [],
      selectRelated: [],
      serializerOptions: {},
      prefetchRelated: [],
      orderBy: undefined,
      limit: undefined,
      offset: undefined
    });
  });

  it('should handle complex Q objects', () => {
    const query = TestUser.objects.filter({
      Q: [
        Q('OR',
          { 'address__country': 'USA' },
          { 'address__country': 'Canada' }
        ),
        { email: 'test@example.com' }
      ]
    }).build();

    expect(query).toEqual({
      filter: {
        type: 'and',
        children: [
          {
            type: 'or',
            children: [
              {
                type: 'filter',
                conditions: { 'address__country': 'USA' }
              },
              {
                type: 'filter',
                conditions: { 'address__country': 'Canada' }
              }
            ]
          },
          {
            type: 'filter',
            conditions: { email: 'test@example.com' }
          }
        ]
      },
      aggregations: [],
      selectRelated: [],
      prefetchRelated: [],
      serializerOptions: {},
      orderBy: undefined,
      limit: undefined,
      offset: undefined
    });
  });

  it('should handle exclude conditions', () => {
    const query = TestUser.objects
      .filter({ 'address__country': 'USA' })
      .exclude({
        Q: [
          Q('OR',
            { 'orders__status': 'pending' },
            { 'orders__total__lt': 100 }
          )
        ]
      })
      .build();

    expect(query).toEqual({
      filter: {
        type: 'and',
        children: [
          {
            type: 'filter',
            conditions: { 'address__country': 'USA' }
          },
          {
            type: 'not',
            children: [{
              type: 'and',
              children: [{
                type: 'or',
                children: [
                  {
                    type: 'filter',
                    conditions: { 'orders__status': 'pending' }
                  },
                  {
                    type: 'filter',
                    conditions: { 'orders__total__lt': 100 }
                  }
                ]
              }]
            }]
          }
        ]
      },
      aggregations: [],
      selectRelated: [],
      prefetchRelated: [],
      serializerOptions: {},
      orderBy: undefined,
      limit: undefined,
      offset: undefined
    });
  });

  it('should handle filtering and ordering', () => {
    const query = TestUser.objects
      .filter({ 'orders__status': 'completed' })
      .orderBy('-orders__total')
      .build();
  
    expect(query).toEqual({
      aggregations: [],
      filter: {
        type: 'filter',
        conditions: { 'orders__status': 'completed' }
      },
      selectRelated: [],
      serializerOptions: {},
      prefetchRelated: [],
      orderBy: [{ field: 'orders__total', direction: 'desc' }]
    });
  });
});

describe('Manager Operations', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should get a single object', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'get') {
        return [{
          id: 1,
          name: 'Alice',
          email: 'alice@example.com',
          address: { city: 'NY', country: 'USA' },
          orders: []
        }];
      }
      return {};
    });
    const obj = await TestUser.objects.get({ pk: 1 });
    expect(obj).toBeInstanceOf(TestUser);
    expect(obj.pk).toEqual(1); // gets the value from the "id" field
    spy.mockRestore();
  });

  it('should throw DoesNotExist if no object found', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'get') {
        return [];
      }
      return {};
    });
    await expect(TestUser.objects.get({ pk: 999 })).rejects.toThrow(DoesNotExist);
    spy.mockRestore();
  });

  it('should throw MultipleObjectsReturned if multiple objects found', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'get') {
        return [
          { id: 1, name: 'Alice', email: 'alice@example.com', address: { city: 'NY', country: 'USA' }, orders: [] },
          { id: 2, name: 'Bob', email: 'bob@example.com', address: { city: 'LA', country: 'USA' }, orders: [] }
        ];
      }
      return {};
    });
    await expect(TestUser.objects.get({ email: 'test@example.com' })).rejects.toThrow(MultipleObjectsReturned);
    spy.mockRestore();
  });

  it('should create a new object', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'create') {
        const data = query.data;
        return {
          id: 3,
          name: data.name,
          email: data.email,
          address: data.address,
          orders: data.orders,
        };
      }
      return {};
    });
    const newUser = await TestUser.objects.create({
      name: 'Charlie',
      email: 'charlie@example.com',
      address: { city: 'Chicago', country: 'USA' },
      orders: []
    });
    expect(newUser).toBeInstanceOf(TestUser);
    expect(newUser.pk).toEqual(3); // pk getter returns the value from "id"
    expect(newUser.name).toEqual('Charlie');
    spy.mockRestore();
  });

  it('should get existing object with get_or_create', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      // Now expect an atomic get_or_create query
      if (query.type === 'get_or_create') {
        return {
          object: {
            id: 4,
            name: 'Dana',
            email: 'dana@example.com',
            address: { city: 'Boston', country: 'USA' },
            orders: []
          },
          created: false
        };
      }
      return {};
    });
    const result = await TestUser.objects.getOrCreate(
      { email: 'dana@example.com' },
      { defaults: { name: 'Dana' } }
    );
    expect(result.created).toBe(false);
    expect(result.object.pk).toEqual(4);
    spy.mockRestore();
  });

  it('should create new object with get_or_create when not found', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'get_or_create') {
        return {
          object: {
            id: 6,
            name: 'Eva',
            email: 'eva@example.com',
            address: { city: '', country: '' },
            orders: []
          },
          created: true
        };
      }
      return {};
    });
    const result = await TestUser.objects.getOrCreate(
      { email: 'eva@example.com' },
      { defaults: { name: 'Eva' } }
    );
    expect(result.created).toBe(true);
    expect(result.object.pk).toEqual(6);
    expect(result.object.email).toEqual('eva@example.com');
    expect(result.object.name).toEqual('Eva');
    spy.mockRestore();
  });

  it('should update existing object with update_or_create', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'update_or_create') {
        return {
          object: {
            id: 7,
            name: 'Frank Updated',
            email: 'frank@example.com',
            address: { city: 'Seattle', country: 'USA' },
            orders: []
          },
          created: false
        };
      }
      return {};
    });
    const result = await TestUser.objects.updateOrCreate(
      { email: 'frank@example.com' },
      { defaults: { name: 'Frank Updated' } }
    );
    expect(result.created).toBe(false);
    expect(result.object.name).toEqual('Frank Updated');
    spy.mockRestore();
  });

  it('should create new object with update_or_create when not found', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'update_or_create') {
        return {
          object: {
            id: 8,
            name: 'George',
            email: 'george@example.com',
            address: { city: '', country: '' },
            orders: []
          },
          created: true
        };
      }
      return {};
    });
    const result = await TestUser.objects.updateOrCreate(
      { email: 'george@example.com' },
      { defaults: { name: 'George' } }
    );
    expect(result.created).toBe(true);
    expect(result.object.pk).toEqual(8);
    expect(result.object.email).toEqual('george@example.com');
    expect(result.object.name).toEqual('George');
    spy.mockRestore();
  });
});

describe('Model Operations', () => {
  let originalExecuteQuery: typeof APIQuerySet.prototype.executeQuery;

  beforeEach(() => {
    originalExecuteQuery = APIQuerySet.prototype.executeQuery;
  });

  afterEach(() => {
    APIQuerySet.prototype.executeQuery = originalExecuteQuery;
    vi.restoreAllMocks();
  });

  it('should save a new model (create)', async () => {
    const user = new TestUser({
      name: 'Helen',
      email: 'helen@example.com',
      address: { city: 'Denver', country: 'USA' },
      orders: []
    });
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'create') {
        const data = query.data;
        return {
          id: 9,
          name: data.name,
          email: data.email,
          address: data.address,
          orders: data.orders,
        };
      }
      return {};
    });
    await user.save();
    expect(user.pk).toEqual(9);
    spy.mockRestore();
  });

  it('should save an existing model (update)', async () => {
    const user = new TestUser({
      id: 10,
      name: 'Ian',
      email: 'ian@example.com',
      address: { city: 'Austin', country: 'USA' },
      orders: []
    });
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'update') {
        return {
          id: 10,
          name: query.data.name,
          email: query.data.email,
          address: query.data.address,
          orders: query.data.orders,
        };
      }
      return {};
    });
    user.name = 'Ian Updated';
    await user.save();
    expect(user.name).toEqual('Ian Updated');
    spy.mockRestore();
  });

  it('should throw error when deleting unsaved model', async () => {
    const user = new TestUser({
      name: 'Jack',
      email: 'jack@example.com',
      address: { city: 'Miami', country: 'USA' },
      orders: []
    });
    await expect(user.delete()).rejects.toThrow('Cannot delete unsaved instance');
  });

  it('should delete a saved model', async () => {
    const user = new TestUser({
      id: 11,
      name: 'Karen',
      email: 'karen@example.com',
      address: { city: 'San Francisco', country: 'USA' },
      orders: []
    });
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'delete') {
        return {};
      }
      return {};
    });
    await user.delete();
    spy.mockRestore();
  });

  it('should refresh model from database', async () => {
    const user = new TestUser({
      id: 12,
      name: 'Leo',
      email: 'leo@example.com',
      address: { city: 'Las Vegas', country: 'USA' },
      orders: []
    });
    // Override the static get method for this test.
    const getSpy = vi.spyOn(TestUser.objects, 'get').mockImplementation(async (filters) => {
      return new TestUser({
        id: 12,
        name: 'Leo Updated',
        email: 'leo@example.com',
        address: { city: 'Las Vegas', country: 'USA' },
        orders: []
      });
    });
    await user.refreshFromDb();
    expect(user.name).toEqual('Leo Updated');
    getSpy.mockRestore();
  });

  it('should throw error when refreshing unsaved model', async () => {
    const user = new TestUser({
      name: 'Mia',
      email: 'mia@example.com',
      address: { city: 'Orlando', country: 'USA' },
      orders: []
    });
    await expect(user.refreshFromDb()).rejects.toThrow('Cannot refresh unsaved instance');
  });
});
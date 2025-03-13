import { describe, it, expect, vi } from 'vitest';
import { Model, APIManager, Q, APIQuerySet } from '../src';

// Test Model setup
interface TestUserFields {
  id: number;
  name: string;
  email: string;
  age: number;
  status: 'active' | 'inactive';
  address: {
    street: string;
    city: string;
    country: string;
    postalCode: string;
  };
  tags: string[];
  metadata: Record<string, any>;
}

class TestUser extends Model implements TestUserFields {
  id!: number;
  name!: string;
  email!: string;
  age!: number;
  status!: 'active' | 'inactive';
  address!: {
    street: string;
    city: string;
    country: string;
    postalCode: string;
  };
  tags!: string[];
  metadata!: Record<string, any>;

  static objects = new APIManager<TestUser>(TestUser);

  constructor(data: Partial<TestUserFields>) {
    super(data);
  }
}

describe('Query Builder AST Generation', () => {
  describe('Single Condition AST', () => {
    it('should generate correct AST for exact match', () => {
      const query = TestUser.objects
        .filter({ name: 'John' })
        .build();

      expect(query.filter).toEqual({
        type: 'filter',
        conditions: { name: 'John' }
      });
    });

    it('should generate correct AST for null check', () => {
      const query = TestUser.objects
        .filter({ 'email__isnull': true })
        .build();

      expect(query.filter).toEqual({
        type: 'filter',
        conditions: { 'email__isnull': true }
      });
    });

    it('should generate correct AST for numeric comparisons', () => {
      const query = TestUser.objects
        .filter({ 
          'age__gt': 18,
          'age__lte': 65
        })
        .build();

      expect(query.filter).toEqual({
        type: 'filter',
        conditions: { 
          'age__gt': 18,
          'age__lte': 65
        }
      });
    });
  });

  describe('Nested Field AST', () => {
    it('should generate correct AST for nested field queries', () => {
      const query = TestUser.objects
        .filter({
          'address__city': 'New York',
          'address__country__iexact': 'usa'
        })
        .build();

      expect(query.filter).toEqual({
        type: 'filter',
        conditions: {
          'address__city': 'New York',
          'address__country__iexact': 'usa'
        }
      });
    });

    it('should generate correct AST for deeply nested comparisons', () => {
      const query = TestUser.objects
        .filter({
          'metadata__stats__views__gt': 1000,
          'metadata__settings__enabled': true
        })
        .build();

      expect(query.filter).toEqual({
        type: 'filter',
        conditions: {
          'metadata__stats__views__gt': 1000,
          'metadata__settings__enabled': true
        }
      });
    });
  });

  describe('Complex Q Objects AST', () => {
    it('should generate correct AST for OR conditions', () => {
      const query = TestUser.objects
        .filter({
          Q: [
            Q('OR',
              { status: 'active' },
              { 'age__gte': 21 }
            )
          ]
        })
        .build();

      expect(query.filter).toEqual({
        type: 'and',
        children: [{
          type: 'or',
          children: [
            {
              type: 'filter',
              conditions: { status: 'active' }
            },
            {
              type: 'filter',
              conditions: { 'age__gte': 21 }
            }
          ]
        }]
      });
    });

    it('should generate correct AST for nested AND/OR combinations', () => {
      const query = TestUser.objects
        .filter({
          Q: [
            Q('OR',
              { 'address__country': 'USA' },
              { 'address__country': 'Canada' }
            ),
            Q('AND',
              { 'age__gte': 18 },
              { status: 'active' }
            )
          ]
        })
        .build();

      expect(query.filter).toEqual({
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
            type: 'and',
            children: [
              {
                type: 'filter',
                conditions: { 'age__gte': 18 }
              },
              {
                type: 'filter',
                conditions: { status: 'active' }
              }
            ]
          }
        ]
      });
    });
  });

  describe('Exclude Operation AST', () => {
    it('should generate correct AST for simple exclude', () => {
      const query = TestUser.objects
        .exclude({ status: 'inactive' })
        .build();

      expect(query.filter).toEqual({
        type: 'not',
        children: [{
          type: 'filter',
          conditions: { status: 'inactive' }
        }]
      });
    });

    it('should generate correct AST for complex exclude with Q objects', () => {
      const query = TestUser.objects
        .filter({ 'address__country': 'USA' })
        .exclude({
          Q: [
            Q('OR',
              { 'age__lt': 18 },
              { status: 'inactive' }
            )
          ]
        })
        .build();

      expect(query.filter).toEqual({
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
                    conditions: { 'age__lt': 18 }
                  },
                  {
                    type: 'filter',
                    conditions: { status: 'inactive' }
                  }
                ]
              }]
            }]
          }
        ]
      });
    });
  });

  describe('Combined Operations AST', () => {
    it('should generate correct AST for filter + exclude + Q combinations', () => {
      const query = TestUser.objects
        .filter({
          'address__country': 'USA',
          Q: [
            Q('OR',
              { 'age__gte': 21 },
              { status: 'active' }
            )
          ]
        })
        .exclude({
          Q: [
            Q('AND',
              { 'metadata__banned': true },
              { 'age__lt': 18 }
            )
          ]
        })
        .build();

      expect(query.filter).toEqual({
        type: 'and',
        children: [
          {
            type: 'filter',
            conditions: { 'address__country': 'USA' }
          },
          {
            type: 'and',
            children: [{
              type: 'or',
              children: [
                {
                  type: 'filter',
                  conditions: { 'age__gte': 21 }
                },
                {
                  type: 'filter',
                  conditions: { status: 'active' }
                }
              ]
            }]
          },
          {
            type: 'not',
            children: [{
              type: 'and',
              children: [{
                type: 'and',
                children: [
                  {
                    type: 'filter',
                    conditions: { 'metadata__banned': true }
                  },
                  {
                    type: 'filter',
                    conditions: { 'age__lt': 18 }
                  }
                ]
              }]
            }]
          }
        ]
      });
    });
  });
});

describe('Terminal Methods AST Generation', () => {
  it('should generate correct AST for first() method', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      // Simulate backend returning an array with a single record.
      return [{
        id: 1,
        name: 'John',
        email: 'john@example.com',
        age: 30,
        status: 'active',
        address: { street: '123 Main', city: 'New York', country: 'USA', postalCode: '10001' },
        tags: [],
        metadata: {}
      }];
    });
    const result = await TestUser.objects.filter({ name: 'John' }).first();
    expect(spy).toHaveBeenCalled();
    const queryArg = spy.mock.calls[0][0];
    expect(queryArg.type).toEqual('first');
    expect(result).toBeInstanceOf(TestUser);
    expect(result!.id).toEqual(1);
    spy.mockRestore();
  });

  it('should generate correct AST for last() method', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      // Simulate backend returning multiple records.
      return [
        {
          id: 2,
          name: 'Alice',
          email: 'alice@example.com',
          age: 25,
          status: 'active',
          address: { street: '456 Main', city: 'Los Angeles', country: 'USA', postalCode: '90001' },
          tags: [],
          metadata: {}
        },
        {
          id: 3,
          name: 'Bob',
          email: 'bob@example.com',
          age: 35,
          status: 'active',
          address: { street: '789 Main', city: 'Chicago', country: 'USA', postalCode: '60601' },
          tags: [],
          metadata: {}
        }
      ];
    });
    const result = await TestUser.objects.filter({ status: 'active' }).last();
    expect(spy).toHaveBeenCalled();
    const queryArg = spy.mock.calls[0][0];
    expect(queryArg.type).toEqual('last');
    expect(result).toBeInstanceOf(TestUser);
    expect(result!.id).toEqual(3);
    spy.mockRestore();
  });

  it('should generate correct AST for exists() method', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      // Simulate backend returning a boolean.
      return true;
    });
    const result = await TestUser.objects.filter({ email: 'test@example.com' }).exists();
    expect(spy).toHaveBeenCalled();
    const queryArg = spy.mock.calls[0][0];
    expect(queryArg.type).toEqual('exists');
    expect(result).toBe(true);
    spy.mockRestore();
  });
});

describe('Atomic Operations AST Generation', () => {
  it('should generate correct AST for get_or_create when object exists', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'get_or_create') {
        return {
          object: {
            id: 100,
            name: 'Existing',
            email: 'existing@example.com',
            age: 30,
            status: 'active',
            address: { street: '123 Main', city: 'City', country: 'Country', postalCode: '12345' },
            tags: [],
            metadata: {}
          },
          created: false
        };
      }
      return {};
    });

    const result = await TestUser.objects.getOrCreate(
      { email: 'existing@example.com' },
      { defaults: { name: 'Existing' } }
    );
    expect(result.created).toBe(false);
    expect(result.object).toBeInstanceOf(TestUser);
    expect(result.object.id).toEqual(100);
    spy.mockRestore();
  });

  it('should generate correct AST for get_or_create when object does not exist', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'get_or_create') {
        return {
          object: {
            id: 101,
            name: 'New',
            email: 'new@example.com',
            age: 25,
            status: 'active',
            address: { street: '456 Main', city: 'City2', country: 'Country2', postalCode: '54321' },
            tags: [],
            metadata: {}
          },
          created: true
        };
      }
      return {};
    });

    const result = await TestUser.objects.getOrCreate(
      { email: 'new@example.com' },
      { defaults: { name: 'New' } }
    );
    expect(result.created).toBe(true);
    expect(result.object).toBeInstanceOf(TestUser);
    expect(result.object.id).toEqual(101);
    spy.mockRestore();
  });

  it('should generate correct AST for update_or_create when object exists', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'update_or_create') {
        return {
          object: {
            id: 102,
            name: 'Updated',
            email: 'update@example.com',
            age: 40,
            status: 'active',
            address: { street: '789 Main', city: 'City3', country: 'Country3', postalCode: '11111' },
            tags: [],
            metadata: {}
          },
          created: false
        };
      }
      return {};
    });

    const result = await TestUser.objects.updateOrCreate(
      { email: 'update@example.com' },
      { defaults: { name: 'Updated' } }
    );
    expect(result.created).toBe(false);
    expect(result.object).toBeInstanceOf(TestUser);
    expect(result.object.id).toEqual(102);
    spy.mockRestore();
  });

  it('should generate correct AST for update_or_create when object does not exist', async () => {
    const spy = vi.spyOn(APIQuerySet.prototype, 'executeQuery').mockImplementation(async (query) => {
      if (query.type === 'update_or_create') {
        return {
          object: {
            id: 103,
            name: 'CreatedNew',
            email: 'created@example.com',
            age: 35,
            status: 'active',
            address: { street: '101 Main', city: 'City4', country: 'Country4', postalCode: '22222' },
            tags: [],
            metadata: {}
          },
          created: true
        };
      }
      return {};
    });

    const result = await TestUser.objects.updateOrCreate(
      { email: 'created@example.com' },
      { defaults: { name: 'CreatedNew' } }
    );
    expect(result.created).toBe(true);
    expect(result.object).toBeInstanceOf(TestUser);
    expect(result.object.id).toEqual(103);
    spy.mockRestore();
  });
});
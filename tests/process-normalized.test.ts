import { describe, test, expect, beforeEach, vi } from 'vitest';

import { processNormalized } from '../src/flavours/django/processNormalized'
import { modelStoreRegistry } from '../src/syncEngine/registries/modelStoreRegistry';

// Mock the modelStoreRegistry
vi.mock('../src/syncEngine/registries/modelStoreRegistry', () => ({
  modelStoreRegistry: {
    setEntity: vi.fn(),
  }
}));

// Mock model classes
class DummyModel {
  constructor(data) {
    Object.assign(this, data);
  }
  
  static from(data) {
    return new DummyModel(data);
  }
}

class DummyRelatedModel {
  constructor(data) {
    Object.assign(this, data);
  }
  
  static from(data) {
    return new DummyRelatedModel(data);
  }
}

describe('processNormalized', () => {
  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
  });

  test('should handle null data response', () => {
    const response = { data: null };
    const result = processNormalized(response, DummyModel);
    
    expect(result).toBeNull();
    expect(modelStoreRegistry.setEntity).not.toHaveBeenCalled();
  });

  test('should process a single entity response', () => {
    const response = {
      data: {
        id: 4333,
        repr: { str: "Related: ValidRelated", img: "/img/related/ValidRelated.png" },
        name: "ValidRelated"
      },
      included: {
        "django_app.dummyrelatedmodel": {
          "4333": {
            id: 4333,
            repr: { str: "Related: ValidRelated", img: "/img/related/ValidRelated.png" },
            name: "ValidRelated"
          }
        }
      }
    };
    
    const result = processNormalized(response, DummyRelatedModel);
    
    // Verify the result is a model instance with correct data
    expect(result).toBeInstanceOf(DummyRelatedModel);
    expect(result.id).toBe(4333);
    expect(result.name).toBe("ValidRelated");
    
    // Verify included entities were added to registry
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledTimes(1);
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyRelatedModel,
      4333,
      expect.objectContaining({
        id: 4333,
        name: "ValidRelated"
      })
    );
  });

  test('should process a response with related entities', () => {
    const response = {
      data: {
        id: 11606,
        repr: { str: "DummyModel Test2", img: "/img/Test2.png" },
        related: { type: "django_app.dummyrelatedmodel", id: 4333 },
        name: "Test2",
        value: 20
      },
      included: {
        "django_app.dummyrelatedmodel": {
          "4333": {
            id: 4333,
            repr: { str: "Related: ValidRelated", img: "/img/related/ValidRelated.png" }
          }
        },
        "django_app.dummymodel": {
          "11606": {
            id: 11606,
            repr: { str: "DummyModel Test2", img: "/img/Test2.png" },
            related: { type: "django_app.dummyrelatedmodel", id: 4333 },
            name: "Test2",
            value: 20
          }
        }
      }
    };
    
    const result = processNormalized(response, DummyModel);
    
    // Verify the result is a model instance with correct data
    expect(result).toBeInstanceOf(DummyModel);
    expect(result.id).toBe(11606);
    expect(result.name).toBe("Test2");
    expect(result.value).toBe(20);
    expect(result.related).toEqual({ type: "django_app.dummyrelatedmodel", id: 4333 });
    
    // Verify included entities were added to registry
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledTimes(2);
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyModel,
      4333,
      expect.objectContaining({ id: 4333 })
    );
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyModel,
      11606,
      expect.objectContaining({ id: 11606, name: "Test2", value: 20 })
    );
  });

  test('should process an array of entities', () => {
    const response = {
      data: [
        { type: "django_app.dummymodel", id: 11609 },
        { type: "django_app.dummymodel", id: 11606 },
        { type: "django_app.dummymodel", id: 11607 }
      ],
      included: {
        "django_app.dummyrelatedmodel": {
          "4333": {
            id: 4333,
            repr: { str: "Related: ValidRelated", img: "/img/related/ValidRelated.png" }
          }
        },
        "django_app.dummymodel": {
          "11606": {
            id: 11606,
            repr: { str: "DummyModel Test2", img: "/img/Test2.png" },
            related: { type: "django_app.dummyrelatedmodel", id: 4333 },
            name: "Test2",
            value: 20
          },
          "11607": {
            id: 11607,
            repr: { str: "DummyModel Test1", img: "/img/Test1.png" },
            related: { type: "django_app.dummyrelatedmodel", id: 4333 },
            name: "Test1",
            value: 10
          },
          "11609": {
            id: 11609,
            repr: { str: "DummyModel Test3", img: "/img/Test3.png" },
            related: { type: "django_app.dummyrelatedmodel", id: 4333 },
            name: "Test3",
            value: 30
          }
        }
      }
    };
    
    const result = processNormalized(response, DummyModel);
    
    // Verify the result is an array of model instances
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(3);
    
    // Verify each item in the array is a model instance with correct id
    expect(result[0]).toBeInstanceOf(DummyModel);
    expect(result[0].id).toBe(11609);
    
    expect(result[1]).toBeInstanceOf(DummyModel);
    expect(result[1].id).toBe(11606);
    
    expect(result[2]).toBeInstanceOf(DummyModel);
    expect(result[2].id).toBe(11607);
    
    // Verify included entities were added to registry
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledTimes(4);
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyModel,
      4333,
      expect.any(Object)
    );
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyModel,
      11606,
      expect.any(Object)
    );
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyModel,
      11607,
      expect.any(Object)
    );
    expect(modelStoreRegistry.setEntity).toHaveBeenCalledWith(
      DummyModel,
      11609,
      expect.any(Object)
    );
  });

  test('should process response without included entities', () => {
    const response = {
      data: {
        id: 11615,
        repr: { str: "DummyModel SameValue2", img: "/img/SameValue2.png" },
        name: "SameValue2",
        value: 50
      }
    };
    
    const result = processNormalized(response, DummyModel);
    
    // Verify the result is a model instance with correct data
    expect(result).toBeInstanceOf(DummyModel);
    expect(result.id).toBe(11615);
    expect(result.name).toBe("SameValue2");
    expect(result.value).toBe(50);
    
    // Verify no entities were added to registry (no included section)
    expect(modelStoreRegistry.setEntity).not.toHaveBeenCalled();
  });

  test('should handle non-object data', () => {
    const response = {
      data: "string data"
    };
    
    const result = processNormalized(response, DummyModel);
    
    // Should return original data
    expect(result).toBe("string data");
    expect(modelStoreRegistry.setEntity).not.toHaveBeenCalled();
  });
});
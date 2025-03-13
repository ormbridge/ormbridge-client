import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { getConfig } from '../src/config';
import { DummyModel } from '../models/backend1/django_app/dummymodel.ts';
import * as configModule from '../src/config'; // for spying on getConfig

// Since DummyModel already has APIManager bound, we can use DummyModel.objects.newQuerySet().
vi.mock('axios');
const mockedAxios = axios as unknown as { post: ReturnType<typeof vi.fn> };

// Fake configuration to be returned by getConfig.
const fakeConfig = {
  backendConfigs: {
    default: {
      API_URL: 'http://example.com/api',
      GENERATED_TYPES_DIR: '/fake/dir',
      getAuthHeaders: () => ({ Authorization: 'Bearer testtoken' }),
    },
  },
};

describe('APIQuerySet.executeQuery', () => {
  beforeEach(() => {
    // Spy on getConfig and make it return our fake configuration.
    vi.spyOn(configModule, 'getConfig').mockReturnValue(fakeConfig);
    mockedAxios.post.mockReset();
  });

  it('should call axios.post with the correct parameters', async () => {
    // Arrange: simulate a successful axios call.
    const fakeResponseData = { success: true, object: { id: 1, name: 'Test' } };
    mockedAxios.post.mockResolvedValueOnce({ data: fakeResponseData });

    // Create a QuerySet via the model's manager.
    const qs = DummyModel.objects.newQuerySet();
    const query = { type: 'get', filter: null };

    // Act.
    const result = await qs.executeQuery(query);

    // Assert.
    expect(mockedAxios.post).toHaveBeenCalledWith(
      fakeConfig.backendConfigs.default.API_URL,
      query,
      { headers: { Authorization: 'Bearer testtoken' } }
    );
    expect(result).toEqual(fakeResponseData);
  });

  it('should throw an error when backend configuration is missing', async () => {
    // Arrange: simulate a configuration missing the "default" backend.
    vi.spyOn(configModule, 'getConfig').mockReturnValueOnce({
      backendConfigs: {} // no "default" key
    });
    const qs = DummyModel.objects.newQuerySet();
    const query = { type: 'get', filter: null };

    // Act & Assert.
    await expect(qs.executeQuery(query)).rejects.toThrow(
      /No backend configuration found for key: default/
    );
  });

  it('should propagate errors from axios', async () => {
    // Arrange: simulate axios rejecting (e.g. network error).
    const axiosError = new Error('Network error');
    mockedAxios.post.mockRejectedValueOnce(axiosError);
    const qs = DummyModel.objects.newQuerySet();
    const query = { type: 'get', filter: null };

    // Act & Assert.
    await expect(qs.executeQuery(query)).rejects.toThrow(
      /API call failed: Network error/
    );
  });
});
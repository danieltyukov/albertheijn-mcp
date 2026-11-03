import { afterEach, describe, expect, it, vi } from 'vitest';
import { favoriteLists } from '../src/ah/favorites.js';
import { mockApi, signedInContext } from './helpers.js';

afterEach(() => vi.restoreAllMocks());

describe('favourite lists', () => {
  it('lists every list through GraphQL with an empty id list', async () => {
    const ctx = await signedInContext();
    const calls = mockApi({
      'gql:favoriteListV2': {
        favoriteListV2: [
          { id: '0b6c4f1e-2d3a-4c5b-9e8f-1a2b3c4d5e6f', description: 'Mijn favorieten', totalSize: 3 },
        ],
      },
    });
    await expect(favoriteLists(ctx)).resolves.toEqual({
      lists: [{ id: '0b6c4f1e-2d3a-4c5b-9e8f-1a2b3c4d5e6f', name: 'Mijn favorieten', items: 3 }],
    });
    const call = calls.find((c) => c.operation === 'favoriteListV2')!;
    expect((call.body as { variables: unknown }).variables).toEqual({ ids: [] });
    expect(call.headers.get('authorization')).toBe('Bearer user-token');
  });
});

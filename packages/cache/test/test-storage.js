// @ts-check
// Must be first to set up globals
import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';
import { makeScalarBigMapStore } from '@agoric/vat-data';
import { makeChainStorageRoot } from '@agoric/vats/src/lib-chainStorage.js';

import { makeCache } from '../src/cache.js';
import { makeScalarStoreCoordinator } from '../src/store.js';
import { withChainStorage } from '../src/storage.js';
// eslint-disable-next-line import/no-extraneous-dependencies -- XXX
import { makeFakeMarshaller } from '@agoric/notifier/tools/testSupports.js';

test('withStorage', async t => {
  const output = [];
  const chainStorage = makeChainStorageRoot(
    message => output.push(message),
    'swingset',
    'cache',
  );
  const marshaller = makeFakeMarshaller();
  const store = withChainStorage(
    makeScalarBigMapStore('cache'),
    chainStorage,
    marshaller,
  );
  const coordinator = makeScalarStoreCoordinator(store);
  const cache = makeCache(coordinator);

  t.is(await cache('baz', 'barbosa'), 'barbosa');
  t.deepEqual(output, [
    {
      key: 'cache',
      method: 'set',
      value:
        '{"{\\"body\\":\\"\\\\\\"baz\\\\\\"\\",\\"slots\\":[]}":{"generation":{"@qclass":"bigint","digits":"1"},"value":"barbosa"}}',
    },
  ]);

  // One-time initialization (of 'frotz')
  t.is(await cache('frotz', 'default'), 'default');
  t.deepEqual(output, [
    {
      key: 'cache',
      method: 'set',
      value:
        '{"{\\"body\\":\\"\\\\\\"baz\\\\\\"\\",\\"slots\\":[]}":{"generation":{"@qclass":"bigint","digits":"1"},"value":"barbosa"}}',
    },
    {
      key: 'cache',
      method: 'set',
      value:
        '{"{\\"body\\":\\"\\\\\\"frotz\\\\\\"\\",\\"slots\\":[]}":{"generation":{"@qclass":"bigint","digits":"1"},"value":"default"}}',
    },
  ]);
  t.is(await cache('frotz', 'ignored'), 'default');
  // no change
  t.deepEqual(output, [
    {
      key: 'cache',
      method: 'set',
      value:
        '{"{\\"body\\":\\"\\\\\\"baz\\\\\\"\\",\\"slots\\":[]}":{"generation":{"@qclass":"bigint","digits":"1"},"value":"barbosa"}}',
    },
    {
      key: 'cache',
      method: 'set',
      value:
        '{"{\\"body\\":\\"\\\\\\"frotz\\\\\\"\\",\\"slots\\":[]}":{"generation":{"@qclass":"bigint","digits":"1"},"value":"default"}}',
    },
  ]);
});

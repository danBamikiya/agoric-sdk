// @ts-check
// Must be first to set up globals
// import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';
// eslint-disable-next-line import/no-extraneous-dependencies -- XXX
import '@agoric/swingset-vat/tools/prepare-test-env.js';

import test from 'ava';
import { makeScalarBigMapStore } from '@agoric/vat-data';
import { makeChainStorageRoot } from '@agoric/vats/src/lib-chainStorage.js';

// eslint-disable-next-line import/no-extraneous-dependencies -- XXX
import { makeFakeMarshaller } from '@agoric/notifier/tools/testSupports.js';
import { makeCache } from '../src/cache.js';
import { makeChainStorageCoordinator } from '../src/store.js';

/**
 * What's important is to retrieve the information from that cache that you put
 * in, by way of chain storage.
 *
 *
 *
 */
test('makeChainStorageCoordinator', async t => {
  const offchainState = {};
  const chainStorage = makeChainStorageRoot(
    // If the message is `set` then update the key
    // TODO If the message is anything else, throw an error
    message => {
      console.log('DEBUG message handler', message);
      offchainState[message.key] = message.value;
    },
    'swingset',
    'cache',
  );
  const marshaller = makeFakeMarshaller();
  const coordinator = makeChainStorageCoordinator(
    makeScalarBigMapStore('cache'),
    chainStorage,
    marshaller,
  );
  const cache = makeCache(coordinator);

  t.is(await cache('baz', 'barbosa'), 'barbosa');
  console.log('DEBUG', { offchainState }, JSON.stringify(offchainState));
  // t.deepEqual(offchainState, {}); ???
  return;

  // One-time initialization (of 'frotz')
  t.is(await cache('frotz', 'default'), 'default');
  t.deepEqual(offchainState, [
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
  t.deepEqual(offchainState, [
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

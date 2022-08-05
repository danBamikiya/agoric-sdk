// @ts-check
// Must be first to set up globals
// import { test } from '@agoric/zoe/tools/prepare-test-env-ava.js';
// eslint-disable-next-line import/no-extraneous-dependencies -- XXX
import '@agoric/swingset-vat/tools/prepare-test-env.js';

import test from 'ava';
import { makeChainStorageRoot } from '@agoric/vats/src/lib-chainStorage.js';

// eslint-disable-next-line import/no-extraneous-dependencies -- XXX
import { makeFakeMarshaller } from '@agoric/notifier/tools/testSupports.js';
import { Far } from '@endo/marshal';
import { makeCache } from '../src/cache.js';
import { makeChainStorageCoordinator } from '../src/store.js';

test('makeChainStorageCoordinator with non-remote values', async t => {
  const storageNodeState = {};
  const chainStorage = makeChainStorageRoot(
    message => {
      assert(message.key === 'cache');
      assert(message.method === 'set');
      storageNodeState.cache = message.value;
    },
    'swingset',
    'cache',
  );
  const cache = makeCache(
    makeChainStorageCoordinator(chainStorage, makeFakeMarshaller()),
  );

  t.is(await cache('brandName', 'barbosa'), 'barbosa');
  t.deepEqual(Object.keys(storageNodeState), ['cache']);
  t.deepEqual(JSON.parse(storageNodeState.cache), {
    '{"body":"\\"brandName\\"","slots":[]}': {
      body: '{"generation":{"@qclass":"bigint","digits":"1"},"value":"barbosa"}',
      slots: [],
    },
  });

  // One-time initialization (of 'frotz')
  t.is(await cache('frotz', 'default'), 'default');
  const afterFirstFrotz = {
    '{"body":"\\"brandName\\"","slots":[]}': {
      body: '{"generation":{"@qclass":"bigint","digits":"1"},"value":"barbosa"}',
      slots: [],
    },
    '{"body":"\\"frotz\\"","slots":[]}': {
      body: '{"generation":{"@qclass":"bigint","digits":"1"},"value":"default"}',
      slots: [],
    },
  };
  t.deepEqual(JSON.parse(storageNodeState.cache), afterFirstFrotz);
  // no change
  t.is(await cache('frotz', 'ignored'), 'default');
  t.deepEqual(JSON.parse(storageNodeState.cache), afterFirstFrotz);

  // cache more complex Passable
  const complexPassable = {
    str: 'string',
    big: 1n,
    num: 53,
    arr: ['hi', 'there'],
  };
  t.deepEqual(
    await cache(['complex', 'passable'], complexPassable),
    complexPassable,
  );
  t.deepEqual(JSON.parse(storageNodeState.cache), {
    ...afterFirstFrotz,
    '{"body":"[\\"complex\\",\\"passable\\"]","slots":[]}': {
      body: '{"generation":{"@qclass":"bigint","digits":"1"},"value":{"arr":["hi","there"],"big":{"@qclass":"bigint","digits":"1"},"num":53,"str":"string"}}',
      slots: [],
    },
  });
});

test('makeChainStorageCoordinator with remote values', async t => {
  const storageNodeState = {};
  const chainStorage = makeChainStorageRoot(
    message => {
      assert(message.key === 'cache');
      assert(message.method === 'set');
      storageNodeState.cache = message.value;
    },
    'swingset',
    'cache',
  );

  const cache = makeCache(
    makeChainStorageCoordinator(chainStorage, makeFakeMarshaller()),
  );

  const farThing = Far('farThing', { getAllegedName: () => 'dollaz' });

  t.is(await cache('brand', farThing), farThing);
  t.deepEqual(Object.keys(storageNodeState), ['cache']);
  t.deepEqual(JSON.parse(storageNodeState.cache), {
    '{"body":"\\"brand\\"","slots":[]}': {
      body: '{"generation":{"@qclass":"bigint","digits":"1"},"value":{"@qclass":"slot","iface":"Alleged: farThing","index":0}}',
      slots: [1],
    },
  });
});

test.todo(
  'a second cache coordinator (mock casting client) that can read what went into the storageNode',
);
// chainStorage needs a way to read the values that were stored
// make a pretent chainStorage that has the ability to read (pretend because something in casting will eventually be made that delivers )
// MAYBE add `getValue` to storageNode
// but probably easier to make somethign just for this test
// have to make the cache read use the `convertSlotToVal` for marshaller (if it works with this test one it'll work with others)

// test('casting client spike', async t => {});

// eslint-disable-next-line import/order
import { test } from '../tools/prepare-test-env-ava.js';

import { buildManualTimer } from '../tools/manual-timer.js';

test('buildManualTimer', async t => {
  const mt = buildManualTimer();
  const p = mt.wakeAt(10n);
  mt.advanceTo(15n);
  const result = await p;
  t.is(result, 10n);

  const p2 = mt.wakeAt(16n);
  mt.tick('msg1');
  t.is(await p2, 16n);
});

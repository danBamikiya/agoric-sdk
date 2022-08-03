/* global setImmediate */
import { Far } from '@endo/marshal';
import { makeScalarMapStore } from '@agoric/store';
import { buildRootObject } from '../src/vats/timer/vat-timer.js';

// adapted from 'setup()' in test-vat-timer.js

function setup() {
  const state = {
    now: 0n, // current time, updated during test
    currentWakeup: undefined,
    currentHandler: undefined,
  };
  const deviceMarker = harden({});
  const timerDeviceFuncs = harden({
    getLastPolled: () => state.now,
    setWakeup: (when, handler) => {
      assert.equal(state.currentWakeup, undefined, 'one at a time');
      assert.equal(state.currentHandler, undefined, 'one at a time');
      if (state.currentWakeup !== undefined) {
        assert(
          state.currentWakeup > state.now,
          `too late: ${state.currentWakeup} <= ${state.now}`,
        );
      }
      state.currentWakeup = when;
      state.currentHandler = handler;
      return when;
    },
    removeWakeup: _handler => {
      state.currentWakeup = undefined;
      state.currentHandler = undefined;
    },
  });
  function D(node) {
    assert.equal(node, deviceMarker, 'fake D only supports devices.timer');
    return timerDeviceFuncs;
  }
  const vatPowers = { D };

  const vatParameters = {};
  // const baggage = makeScalarBigMapStore();
  const baggage = makeScalarMapStore();

  const root = buildRootObject(vatPowers, vatParameters, baggage);
  const timerService = root.createTimerService(deviceMarker);

  return { timerService, state };
}

function wait() {
  if (setImmediate) {
    return new Promise((res, _rej) => setImmediate(res));
  } else {
    throw Error('set doWait:false to use buildManualTimer inside a vat');
  }
}

/**
 * A fake TimerService, for unit tests that do not use a real
 * kernel. You can make time pass by calling `tick()` or
 * `advanceTo(when)`.
 *
 * The promise it returns will fire after all wakeup handlers have had
 * a chance to fire (it uses setImmediate to sense when the promise
 * queue is empty).  If, for some reason, you need to use this service
 * from within a vat (where setImmediate is not available), provide
 * the `doWait: false` option to disable that feature.
 *
 * The first argument is ignored (it used to provide a logging
 * function).
 *
 * @param {unknown} log
 * @typedef {object} ManualTimerOptions
 * @property {Timestamp} [startValue=0n]
 * @property {RelativeTime} [timeStep=1n]
 * @property {boolean} [doWait=false]
 * @param {ManualTimerOptions} [options]
 * @returns {ManualTimer}
 */
export function buildManualTimer(log, options = {}) {
  const { startValue = 0n, timeStep = 1n, doWait = true } = options;
  const { timerService, state } = setup();
  assert.typeof(startValue, 'bigint');
  state.now = startValue;

  function wake() {
    if (state.currentHandler) {
      state.currentHandler.wake(state.now);
    }
  }

  function advanceTo(when) {
    assert.typeof(when, 'bigint');
    assert(when > state.now, `advanceTo(${when}) < current ${state.now}`);
    state.now = when;
    wake();
  }

  async function tick() {
    state.now += timeStep;
    wake();
    // that schedules a wakeup, but it won't fire until a later turn
    if (doWait) {
      await wait();
    }
  }

  async function tickN(nTimes) {
    assert(nTimes >= 1, 'invariant nTimes >= 1');
    for (let i = 0; i < nTimes; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }
  }

  return Far('manual timer', {
    ...timerService,
    advanceTo,
    tick,
    tickN,
  });
}

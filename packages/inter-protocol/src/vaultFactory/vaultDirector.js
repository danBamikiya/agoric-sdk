// @ts-check

import '@agoric/zoe/exported.js';
import '@agoric/zoe/src/contracts/exported.js';

import { E } from '@endo/eventual-send';
import '@agoric/governance/src/exported.js';

import { fit, keyEQ, M, makeScalarMap } from '@agoric/store';
import {
  assertProposalShape,
  getAmountOut,
  getAmountIn,
} from '@agoric/zoe/src/contractSupport/index.js';
import { makeRatioFromAmounts } from '@agoric/zoe/src/contractSupport/ratio.js';
import { Far } from '@endo/marshal';

import { AmountMath } from '@agoric/ertp';
import { assertKeywordName } from '@agoric/zoe/src/cleanProposal.js';
import { defineKindMulti } from '@agoric/vat-data';
import { makeSubscriptionKit, observeIteration } from '@agoric/notifier';
import { makeVaultManager } from './vaultManager.js';
import { makeMakeCollectFeesInvitation } from '../collectFees.js';
import {
  makeVaultParamManager,
  RECORDING_PERIOD_KEY,
  CHARGING_PERIOD_KEY,
  vaultParamPattern,
  SHORTFALL_INVITATION_KEY,
} from './params.js';

const { details: X } = assert;

/**
 * @typedef {{
 * collaterals: Brand[],
 * rewardPoolAllocation: AmountKeywordRecord,
 * }} MetricsNotification
 *
 * @typedef {Readonly<{
 * debtMint: ZCFMint<'nat'>,
 * collateralTypes: Store<Brand,VaultManager>,
 * directorParamManager: import('@agoric/governance/src/contractGovernance/typedParamManager').TypedParamManager<import('./params.js').VaultDirectorParams>,
 * metricsPublication: IterationObserver<MetricsNotification>
 * metricsSubscription: Subscription<MetricsNotification>
 * mintSeat: ZCFSeat,
 * rewardPoolSeat: ZCFSeat,
 * vaultParamManagers: Store<Brand, import('./params.js').VaultParamManager>,
 * zcf: import('./vaultFactory.js').VaultFactoryZCF,
 * shortfallInvitation: Invitation,
 * shortfallReporter: import('../reserve/assetReserve.js').ShortfallReporter,
 * }>} ImmutableState
 *
 * @typedef {{
 *  burnDebt: BurnDebt,
 *  getGovernedParams: () => import('./vaultManager.js').GovernedParamGetters,
 *  mintAndReallocate: MintAndReallocate,
 *  getShortfallReporter: () => Promise<import('../reserve/assetReserve.js').ShortfallReporter>,
 * }} FactoryPowersFacet
 *
 * @typedef {Readonly<{
 *   state: ImmutableState;
 *   facets: import('@agoric/vat-data/src/types').KindFacets<typeof behavior>;
 * }>} MethodContext
 */

/**
 * @param {ERef<ZoeService>} zoe
 * @param {ImmutableState['directorParamManager']} paramMgr
 * @param {unknown} [oldShortfallReporter]
 * @param {ERef<Invitation>} [oldInvitation]
 */
const updateShortfallReporter = async (
  zoe,
  paramMgr,
  oldShortfallReporter,
  oldInvitation,
) => {
  const newInvitation = paramMgr.getInternalParamValue(
    SHORTFALL_INVITATION_KEY,
  );

  if (newInvitation !== oldInvitation) {
    return {
      shortfallReporter: E(E(zoe).offer(newInvitation)).getOfferResult(),
      shortfallInvitation: newInvitation,
    };
  } else {
    return {
      shortfallReporter: oldShortfallReporter,
      shortfallInvitation: oldInvitation,
    };
  }
};

/**
 * @param {ImmutableState['zcf']} zcf
 * @param {ImmutableState['directorParamManager']} directorParamManager
 * @param {ImmutableState['debtMint']} debtMint
 */
const initState = (zcf, directorParamManager, debtMint) => {
  /** For temporary staging of newly minted tokens */
  const { zcfSeat: mintSeat } = zcf.makeEmptySeatKit();
  const { zcfSeat: rewardPoolSeat } = zcf.makeEmptySeatKit();

  const collateralTypes = makeScalarMap('brand');

  const vaultParamManagers = makeScalarMap('brand');

  const { publication: metricsPublication, subscription: metricsSubscription } =
    makeSubscriptionKit();

  return {
    collateralTypes,
    debtMint,
    directorParamManager,
    metricsSubscription,
    metricsPublication,
    mintSeat,
    rewardPoolSeat,
    vaultParamManagers,
    shortfallReporter: undefined,
    shortfallInvitation: undefined,
    zcf,
  };
};

/**
 * Make a loan in the vaultManager based on the collateral type.
 *
 * @deprecated
 * @param {MethodContext} context
 */
const makeVaultInvitation = ({ state }) => {
  const { collateralTypes, zcf } = state;

  /** @param {ZCFSeat} seat */
  const makeVaultHook = async seat => {
    assertProposalShape(seat, {
      give: { Collateral: null },
      want: { Minted: null },
    });
    const {
      give: { Collateral: collateralAmount },
      want: { Minted: requestedAmount },
    } = seat.getProposal();
    const { brand: brandIn } = collateralAmount;
    assert(
      collateralTypes.has(brandIn),
      X`Not a supported collateral type ${brandIn}`,
    );

    assert(
      AmountMath.isGTE(
        requestedAmount,
        state.directorParamManager.getMinInitialDebt(),
      ),
      X`The request must be for at least ${
        state.directorParamManager.getMinInitialDebt().value
      }. ${requestedAmount.value} is too small`,
    );

    /** @type {VaultManager} */
    const mgr = collateralTypes.get(brandIn);
    return mgr.makeVaultKit(seat);
  };
  return zcf.makeInvitation(makeVaultHook, 'MakeVault');
};

// TODO put on machineFacet for use again in publicFacet
/**
 * Make a loan in the vaultManager based on the collateral type.
 *
 * @deprecated
 * @param {MethodContext} context
 */
const getCollaterals = async ({ state }) => {
  const { collateralTypes } = state;
  // should be collateralTypes.map((vm, brand) => ({
  return harden(
    Promise.all(
      [...collateralTypes.entries()].map(async ([brand, vm]) => {
        const priceQuote = await vm.getCollateralQuote();
        return {
          brand,
          interestRate: vm.getGovernedParams().getInterestRate(),
          liquidationMargin: vm.getGovernedParams().getLiquidationMargin(),
          stabilityFee: vm.getGovernedParams().getLoanFee(),
          marketPrice: makeRatioFromAmounts(
            getAmountOut(priceQuote),
            getAmountIn(priceQuote),
          ),
        };
      }),
    ),
  );
};
/**
 * @param {ImmutableState['directorParamManager']} directorParamManager
 */
const getLiquidationConfig = directorParamManager => ({
  install: directorParamManager.getLiquidationInstall(),
  terms: directorParamManager.getLiquidationTerms(),
});

/**
 *
 * @param {ImmutableState['directorParamManager']} govParams
 * @param {VaultManager} vaultManager
 * @param {*} oldInstall
 * @param {*} oldTerms
 */
const watchGovernance = (govParams, vaultManager, oldInstall, oldTerms) => {
  const subscription = govParams.getSubscription();
  void observeIteration(subscription, {
    updateState(_paramUpdate) {
      const { install, terms } = getLiquidationConfig(govParams);
      if (install === oldInstall && keyEQ(terms, oldTerms)) {
        return;
      }
      oldInstall = install;
      oldTerms = terms;
      vaultManager
        .setupLiquidator(install, terms)
        .catch(e => console.error('Failed to setup liquidator', e));
    },
  });
};

/** @type {import('@agoric/vat-data/src/types').FunctionsPlusContext<VaultFactory>} */
const machineBehavior = {
  // TODO move this under governance #3924
  /**
   * @param {MethodContext} context
   * @param {Issuer} collateralIssuer
   * @param {Keyword} collateralKeyword
   * @param {VaultManagerParamValues} initialParamValues
   */
  addVaultType: async (
    { state, facets },
    collateralIssuer,
    collateralKeyword,
    initialParamValues,
  ) => {
    const {
      debtMint,
      collateralTypes,
      mintSeat,
      rewardPoolSeat,
      vaultParamManagers,
      directorParamManager,
      zcf,
    } = state;
    fit(collateralIssuer, M.remotable());
    assertKeywordName(collateralKeyword);
    fit(initialParamValues, vaultParamPattern);
    await zcf.saveIssuer(collateralIssuer, collateralKeyword);
    const collateralBrand = zcf.getBrandForIssuer(collateralIssuer);
    // We create only one vault per collateralType.
    assert(
      !collateralTypes.has(collateralBrand),
      `Collateral brand ${collateralBrand} has already been added`,
    );

    /** a powerful object; can modify parameters */
    const vaultParamManager = makeVaultParamManager(initialParamValues);
    vaultParamManagers.init(collateralBrand, vaultParamManager);

    const { timerService } = zcf.getTerms();
    const startTimeStamp = await E(timerService).getCurrentTimestamp();

    /**
     * We provide an easy way for the vaultManager to add rewards to
     * the rewardPoolSeat, without directly exposing the rewardPoolSeat to them.
     *
     * @type {MintAndReallocate}
     */
    const mintAndReallocate = (toMint, fee, seat, ...otherSeats) => {
      const kept = AmountMath.subtract(toMint, fee);
      debtMint.mintGains(harden({ Minted: toMint }), mintSeat);
      try {
        rewardPoolSeat.incrementBy(
          mintSeat.decrementBy(harden({ Minted: fee })),
        );
        seat.incrementBy(mintSeat.decrementBy(harden({ Minted: kept })));
        zcf.reallocate(rewardPoolSeat, mintSeat, seat, ...otherSeats);
      } catch (e) {
        console.error('mintAndReallocate caught', e);
        mintSeat.clear();
        rewardPoolSeat.clear();
        // Make best efforts to burn the newly minted tokens, for hygiene.
        // That only relies on the internal mint, so it cannot fail without
        // there being much larger problems. There's no risk of tokens being
        // stolen here because the staging for them was already cleared.
        debtMint.burnLosses(harden({ Minted: toMint }), mintSeat);
        throw e;
      } finally {
        // Note that if this assertion may fail because of an error in the
        // try{} block, but that error won't be thrown because this executes
        // before the catch that rethrows it.
        assert(
          Object.values(mintSeat.getCurrentAllocation()).every(a =>
            AmountMath.isEmpty(a),
          ),
          X`Stage should be empty of Minted`,
        );
      }
      facets.machine.updateMetrics();
    };

    /**
     * @param {Amount<'nat'>} toBurn
     * @param {ZCFSeat} seat
     */
    const burnDebt = (toBurn, seat) => {
      debtMint.burnLosses(harden({ Minted: toBurn }), seat);
    };

    const { loanTimingParams } = zcf.getTerms();

    const factoryPowers = Far('vault factory powers', {
      getGovernedParams: () => ({
        ...vaultParamManager.readonly(),
        getChargingPeriod: () => loanTimingParams[CHARGING_PERIOD_KEY].value,
        getRecordingPeriod: () => loanTimingParams[RECORDING_PERIOD_KEY].value,
      }),
      mintAndReallocate,
      getShortfallReporter: async () => {
        const reporterKit = await updateShortfallReporter(
          zcf.getZoeService(),
          directorParamManager,
          state.shortfallReporter,
          state.shortfallInvitation,
        );
        return reporterKit.shortfallReporter;
      },
      burnDebt,
    });

    const vm = makeVaultManager(
      zcf,
      debtMint,
      collateralBrand,
      zcf.getTerms().priceAuthority,
      // @ts-expect-error promise issues?
      factoryPowers,
      timerService,
      startTimeStamp,
    );
    collateralTypes.init(collateralBrand, vm);
    const { install, terms } = getLiquidationConfig(directorParamManager);
    await vm.setupLiquidator(install, terms);
    watchGovernance(directorParamManager, vm, install, terms);
    facets.machine.updateMetrics();
    return vm;
  },
  getCollaterals,
  /** @param {MethodContext} context */
  makeCollectFeesInvitation: ({ state }) => {
    const { debtMint, rewardPoolSeat, zcf } = state;
    return makeMakeCollectFeesInvitation(
      zcf,
      rewardPoolSeat,
      debtMint.getIssuerRecord().brand,
      'Minted',
    ).makeCollectFeesInvitation();
  },
  /** @param {MethodContext} context */
  getContractGovernor: ({ state }) => state.zcf.getTerms().electionManager,
  /** @param {MethodContext} context */
  updateMetrics: ({ state }) => {
    /** @type {MetricsNotification} */
    const metrics = harden({
      collaterals: Array.from(state.collateralTypes.keys()),
      rewardPoolAllocation: state.rewardPoolSeat.getCurrentAllocation(),
    });
    state.metricsPublication.updateState(metrics);
  },

  // XXX accessors for tests
  /** @param {MethodContext} context */
  getRewardAllocation: ({ state }) =>
    state.rewardPoolSeat.getCurrentAllocation(),
};

const creatorBehavior = {
  /** @param {MethodContext} context */
  getParamMgrRetriever: ({
    state: { directorParamManager, vaultParamManagers },
  }) =>
    Far('paramManagerRetriever', {
      /** @param {VaultFactoryParamPath} paramPath */
      get: paramPath => {
        if (paramPath.key === 'governedParams') {
          return directorParamManager;
        } else if (paramPath.key.collateralBrand) {
          return vaultParamManagers.get(paramPath.key.collateralBrand);
        } else {
          assert.fail('Unsupported paramPath');
        }
      },
    }),
  /**
   * @param {MethodContext} context
   * @param {string} name
   */
  getInvitation: ({ state }, name) =>
    state.directorParamManager.getInternalParamValue(name),
  /** @param {MethodContext} context */
  getLimitedCreatorFacet: context => context.facets.machine,
  getGovernedApis: () => harden({}),
  getGovernedApiNames: () => harden({}),
};

const publicBehavior = {
  /**
   * @param {MethodContext} context
   * @param {Brand} brandIn
   */
  getCollateralManager: ({ state }, brandIn) => {
    const { collateralTypes } = state;
    assert(
      collateralTypes.has(brandIn),
      X`Not a supported collateral type ${brandIn}`,
    );
    /** @type {VaultManager} */
    return collateralTypes.get(brandIn).getPublicFacet();
  },
  /**
   * @param {MethodContext} context
   */
  getMetrics: ({ state }) => state.metricsSubscription,

  /** @deprecated use getCollateralManager and then makeVaultInvitation instead */
  makeLoanInvitation: makeVaultInvitation,
  /** @deprecated use getCollateralManager and then makeVaultInvitation instead */
  makeVaultInvitation,
  getCollaterals,
  /** @param {MethodContext} context */
  getRunIssuer: ({ state }) => state.debtMint.getIssuerRecord().issuer,
  /**
   * subscription for the paramManager for a particular vaultManager
   *
   * @param {MethodContext} context
   */
  getSubscription:
    ({ state }) =>
    paramDesc =>
      state.vaultParamManagers.get(paramDesc.collateralBrand).getSubscription(),
  /**
   * subscription for the paramManager for the vaultFactory's electorate
   *
   * @param {MethodContext} context
   */
  getElectorateSubscription: ({ state }) =>
    state.directorParamManager.getSubscription(),
  /**
   * @param {MethodContext} context
   * @param {{ collateralBrand: Brand }} selector
   */
  getGovernedParams: ({ state }, { collateralBrand }) =>
    // TODO use named getters of TypedParamManager
    state.vaultParamManagers.get(collateralBrand).getParams(),
  /**
   * @param {MethodContext} context
   * @returns {Promise<GovernorPublic>}
   */
  getContractGovernor: ({ state: { zcf } }) =>
    // PERF consider caching
    E(zcf.getZoeService()).getPublicFacet(zcf.getTerms().electionManager),
  /**
   * @param {MethodContext} context
   * @param {string} name
   */
  getInvitationAmount: ({ state }, name) =>
    state.directorParamManager.getInvitationAmount(name),
};

const behavior = {
  creator: creatorBehavior,
  machine: machineBehavior,
  public: publicBehavior,
};

/** @param {MethodContext} context */
const finish = async ({ state }) => {
  const { shortfallReporter, shortfallInvitation } =
    await updateShortfallReporter(
      state.zcf.getZoeService(),
      state.directorParamManager,
    );
  // @ts-expect-error write once
  state.shortfallReporter = shortfallReporter;
  // @ts-expect-error write once
  state.shortfallInvitation = shortfallInvitation;
};

/**
 * "Director" of the vault factory, overseeing "vault managers".
 *
 * @param {ZCF<GovernanceTerms<{}> & {
 *   ammPublicFacet: AutoswapPublicFacet,
 *   liquidationInstall: Installation<import('./liquidateMinimum.js').start>,
 *   loanTimingParams: {ChargingPeriod: ParamRecord<'nat'>, RecordingPeriod: ParamRecord<'nat'>},
 *   reservePublicFacet: AssetReservePublicFacet,
 *   timerService: TimerService,
 *   priceAuthority: ERef<PriceAuthority>
 * }>} zcf
 * @param {import('@agoric/governance/src/contractGovernance/typedParamManager').TypedParamManager<import('./params.js').VaultDirectorParams>} directorParamManager
 * @param {ZCFMint<"nat">} debtMint
 */
const makeVaultDirector = defineKindMulti(
  'VaultDirector',
  initState,
  behavior,
  // @ts-expect-error type is undefined on one branch
  { finish },
);

harden(makeVaultDirector);
export { makeVaultDirector };
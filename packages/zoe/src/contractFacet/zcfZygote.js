// @ts-check

import { E } from '@endo/eventual-send';
import { Far, Remotable, passStyleOf } from '@endo/marshal';
import { AssetKind } from '@agoric/ertp';
import { makePromiseKit } from '@endo/promise-kit';
import { assertPattern } from '@agoric/store';
import {
  makeScalarBigMapStore,
  provideDurableMapStore,
  canBeDurable,
  vivifyKind,
} from '@agoric/vat-data';

import { cleanProposal } from '../cleanProposal.js';
import { evalContractBundle } from './evalContractCode.js';
import { makeExitObj } from './exit.js';
import { defineDurableHandle } from '../makeHandle.js';
import { provideIssuerStorage } from '../issuerStorage.js';
import { createSeatManager } from './zcfSeat.js';
import { makeInstanceRecordStorage } from '../instanceRecordStorage.js';
import { handlePKitWarning } from '../handleWarning.js';
import { makeOfferHandlerStorage } from './offerHandlerStorage.js';
import { makeZCFMintFactory } from './zcfMint.js';

import '../../exported.js';
import '../internal-types.js';
import './internal-types.js';

import '@agoric/swingset-vat/src/types-ambient.js';

const { details: X, makeAssert } = assert;

/**
 * Make the ZCF vat in zygote-usable form. First, a generic ZCF is
 * made, then the contract code is evaluated, then a particular
 * instance is made.
 *
 * @param {VatPowers} powers
 * @param {ERef<ZoeService>} zoeService
 * @param {Issuer} invitationIssuer
 * @param {TestJigSetter} testJigSetter
 * @param {BundleCap} contractBundleCap
 * @param {import('@agoric/vat-data').Baggage} zcfBaggage
 * @returns {Promise<ZCFZygote>}
 */
export const makeZCFZygote = async (
  powers,
  zoeService,
  invitationIssuer,
  testJigSetter,
  contractBundleCap,
  zcfBaggage = makeScalarBigMapStore('zcfBaggage', { durable: true }),
) => {
  const makeSeatHandle = defineDurableHandle(zcfBaggage, 'Seat');
  /** @type {PromiseRecord<ZoeInstanceAdmin>} */
  const zoeInstanceAdminPromiseKit = makePromiseKit();
  const zoeInstanceAdmin = zoeInstanceAdminPromiseKit.promise;

  const {
    storeIssuerRecord,
    getAssetKindByBrand,
    getBrandForIssuer,
    getIssuerForBrand,
    instantiate: instantiateIssuerStorage,
  } = provideIssuerStorage(zcfBaggage);

  /** @type {ShutdownWithFailure} */
  const shutdownWithFailure = reason => {
    E(zoeInstanceAdmin).failAllSeats(reason);
    // eslint-disable-next-line no-use-before-define
    dropAllReferences();
    // https://github.com/Agoric/agoric-sdk/issues/3239
    powers.exitVatWithFailure(reason);
  };

  const { makeZCFSeat, reallocate, reallocateForZCFMint, dropAllReferences } =
    createSeatManager(
      zoeInstanceAdmin,
      getAssetKindByBrand,
      shutdownWithFailure,
      zcfBaggage,
    );

  const { storeOfferHandler, takeOfferHandler } =
    makeOfferHandlerStorage(zcfBaggage);

  // Make the instanceRecord
  const {
    addIssuerToInstanceRecord,
    getTerms,
    assertUniqueKeyword,
    getInstanceRecord,
    instantiate: instantiateInstanceRecordStorage,
  } = makeInstanceRecordStorage(zcfBaggage);

  const recordIssuer = (keyword, issuerRecord) => {
    addIssuerToInstanceRecord(keyword, issuerRecord);
    storeIssuerRecord(issuerRecord);
  };

  const makeEmptySeatKit = (exit = undefined) => {
    const initialAllocation = harden({});
    const proposal = cleanProposal(harden({ exit }), getAssetKindByBrand);
    const userSeatPromiseKit = makePromiseKit();
    handlePKitWarning(userSeatPromiseKit);
    const seatHandle = makeSeatHandle();

    const seatData = harden({
      proposal,
      initialAllocation,
      seatHandle,
    });
    const zcfSeat = makeZCFSeat(seatData);

    const exitObj = makeExitObj(seatData.proposal, zcfSeat);

    E(zoeInstanceAdmin)
      .makeNoEscrowSeatKit(initialAllocation, proposal, exitObj, seatHandle)
      .then(({ userSeat }) => userSeatPromiseKit.resolve(userSeat));

    return { zcfSeat, userSeat: userSeatPromiseKit.promise };
  };

  const zcfMintFactory = await makeZCFMintFactory(
    zcfBaggage,
    recordIssuer,
    getAssetKindByBrand,
    makeEmptySeatKit,
    reallocateForZCFMint,
  );

  /**
   * @template {AssetKind} [K='nat']
   * @param {Keyword} keyword
   * @param {K} [assetKind]
   * @param {AdditionalDisplayInfo=} displayInfo
   * @returns {Promise<ZCFMint<K>>}
   */
  const makeZCFMint = async (
    keyword,
    // @ts-expect-error possible different subtype
    assetKind = AssetKind.NAT,
    displayInfo,
  ) => {
    assertUniqueKeyword(keyword);

    const zoeMint = await E(zoeInstanceAdmin).makeZoeMint(
      keyword,
      assetKind,
      displayInfo,
    );
    return zcfMintFactory.makeZCFMintInternal(keyword, zoeMint);
  };

  /** @type {ZCFRegisterFeeMint} */
  const registerFeeMint = async (keyword, feeMintAccess) => {
    assertUniqueKeyword(keyword);

    const zoeMint = await E(zoeInstanceAdmin).registerFeeMint(
      keyword,
      feeMintAccess,
    );
    return zcfMintFactory.makeZCFMintInternal(keyword, zoeMint);
  };

  /** @type {ZCF} */
  const zcf = Remotable('Alleged: zcf', undefined, {
    // Using Remotable rather than Far because too many complications
    // imposing checking wrappers: makeInvitation and setJig want to
    // accept raw functions. assert cannot be a valid passable!
    reallocate,
    assertUniqueKeyword,
    saveIssuer: async (issuerP, keyword) => {
      // TODO: The checks of the keyword for uniqueness are
      // duplicated. Assess how waiting on promises to resolve might
      // affect those checks and see if one can be removed.
      assertUniqueKeyword(keyword);
      const record = await E(zoeInstanceAdmin).saveIssuer(issuerP, keyword);
      // AWAIT ///
      recordIssuer(keyword, record);
      return record;
    },
    makeInvitation: (
      offerHandler = Far('default offer handler', () => {}),
      description,
      customProperties = harden({}),
      proposalSchema = undefined,
    ) => {
      assert.typeof(
        description,
        'string',
        X`invitations must have a description string: ${description}`,
      );
      if (proposalSchema !== undefined) {
        assertPattern(proposalSchema);
      }

      const invitationHandle = storeOfferHandler(offerHandler);
      /** @type {Promise<Payment>} */
      const invitationP = E(zoeInstanceAdmin).makeInvitation(
        invitationHandle,
        description,
        customProperties,
        proposalSchema,
      );
      return invitationP;
    },
    // Shutdown the entire vat and give payouts
    shutdown: completion => {
      E(zoeInstanceAdmin).exitAllSeats(completion);
      dropAllReferences();
      powers.exitVat(completion);
    },
    shutdownWithFailure,
    assert: makeAssert(shutdownWithFailure),
    stopAcceptingOffers: () => E(zoeInstanceAdmin).stopAcceptingOffers(),
    makeZCFMint,
    registerFeeMint,
    makeEmptySeatKit,

    // The methods below are pure and have no side-effects //
    getZoeService: () => zoeService,
    getInvitationIssuer: () => invitationIssuer,
    getTerms,
    getBrandForIssuer,
    getIssuerForBrand,
    getAssetKind: getAssetKindByBrand,
    /** @type {SetTestJig} */
    setTestJig: (testFn = () => ({})) => {
      if (testJigSetter) {
        testJigSetter({ ...testFn(), zcf });
      }
    },
    getInstance: () => getInstanceRecord().instance,
    setOfferFilter: E(zoeInstanceAdmin).setOfferFilter,
  });

  // handleOfferObject gives Zoe the ability to notify ZCF when a new seat is
  // added in offer(). ZCF responds with the exitObj and offerResult.
  const makeHandleOfferObj = vivifyKind(
    zcfBaggage,
    'handleOfferObj',
    () => ({}),
    {
      handleOffer: (_context, invitationHandle, seatData) => {
        const zcfSeat = makeZCFSeat(seatData);
        // TODO: provide a details that's a better diagnostic for the
        // ephemeral offerHandler that did not survive upgrade.
        const offerHandler = takeOfferHandler(invitationHandle);
        const offerResultP =
          typeof offerHandler === 'function'
            ? E(offerHandler)(zcfSeat, seatData.offerArgs)
            : E(offerHandler).handle(zcfSeat, seatData.offerArgs);

        const offerResultPromise = offerResultP.catch(reason => {
          if (reason === undefined) {
            const newErr = new Error(
              `If an offerHandler throws, it must provide a reason of type Error, but the reason was undefined. Please fix the contract code to specify a reason for throwing.`,
            );
            throw zcfSeat.fail(newErr);
          }
          throw zcfSeat.fail(reason);
        });
        const exitObj = makeExitObj(seatData.proposal, zcfSeat);
        /** @type {HandleOfferResult} */
        return harden({ offerResultPromise, exitObj });
      },
    },
  );
  const handleOfferObj = makeHandleOfferObj();

  const evaluateContract = () => {
    let bundle;
    if (passStyleOf(contractBundleCap) === 'remotable') {
      const bundleCap = contractBundleCap;
      // @ts-expect-error vatPowers is not typed correctly: https://github.com/Agoric/agoric-sdk/issues/3239
      bundle = powers.D(bundleCap).getBundle();
    } else {
      bundle = contractBundleCap;
    }
    return evalContractBundle(bundle);
  };
  // evaluate the contract (either the first version, or an upgrade)
  const { start, buildRootObject, vivify } = await evaluateContract();

  if (start === undefined && vivify === undefined) {
    assert(
      buildRootObject === undefined,
      'Did you provide a vat bundle instead of a contract bundle?',
    );
    assert.fail('unrecognized contract exports');
  }
  assert(
    !start || !vivify,
    'contract must provide exactly one of "start" and "vivify"',
  );

  // snapshot zygote here //////////////////
  // the zygote object below will be created now, but its methods won't be
  // invoked until after the snapshot is taken.

  const contractBaggage = provideDurableMapStore(zcfBaggage, 'contractBaggage');

  /**
   * A zygote is a pre-image of a vat that can quickly be instantiated because
   * the code has already been evaluated. SwingSet doesn't support zygotes yet.
   * Once it does the code will be evaluated once when creating the zcfZygote,
   * then the start() function will be called each time an instance is started.
   *
   * Currently, Zoe's buildRootObject calls makeZCFZygote, evaluateContract, and
   * startContract every time a contract instance is created.
   *
   * @type {ZCFZygote}
   */
  const zcfZygote = {
    // wire zcf up to zoe instance-specific interfaces
    startContract: async (
      instanceAdminFromZoe,
      instanceRecordFromZoe,
      issuerStorageFromZoe,
      privateArgs = undefined,
    ) => {
      zoeInstanceAdminPromiseKit.resolve(instanceAdminFromZoe);
      zcfBaggage.init('instanceAdmin', instanceAdminFromZoe);
      instantiateInstanceRecordStorage(instanceRecordFromZoe);
      instantiateIssuerStorage(issuerStorageFromZoe);

      const startFn = start || vivify;
      // start a contract for the first time
      return E.when(
        startFn(zcf, privateArgs, contractBaggage),
        ({
          creatorFacet = undefined,
          publicFacet = undefined,
          creatorInvitation = undefined,
        }) => {
          const allDurable = [
            creatorFacet,
            publicFacet,
            creatorInvitation,
          ].every(canBeDurable);
          if (vivify || allDurable) {
            zcfBaggage.init('creatorFacet', creatorFacet);
            zcfBaggage.init('publicFacet', publicFacet);
            zcfBaggage.init('creatorInvitation', creatorInvitation);
          }

          return harden({
            creatorFacet,
            publicFacet,
            creatorInvitation,
            handleOfferObj,
          });
        },
      );
    },

    restartContract: async (privateArgs = undefined) => {
      const instanceAdmin = zcfBaggage.get('instanceAdmin');
      zoeInstanceAdminPromiseKit.resolve(instanceAdmin);
      assert(vivify, 'vivify must be defined to upgrade a contract');

      // restart an upgradeable contract
      return E.when(
        vivify(zcf, privateArgs, contractBaggage),
        ({
          creatorFacet = undefined,
          publicFacet = undefined,
          creatorInvitation = undefined,
        }) => {
          const priorCreatorFacet = zcfBaggage.get('creatorFacet');
          const priorPublicFacet = zcfBaggage.get('publicFacet');
          const priorCreatorInvitation = zcfBaggage.get('creatorInvitation');

          assert(
            priorCreatorFacet === creatorFacet &&
              priorPublicFacet === publicFacet &&
              priorCreatorInvitation === creatorInvitation,
            'restartContract failed: facets returned by contract changed identity',
          );
          return harden({
            creatorFacet,
            publicFacet,
            creatorInvitation,
            handleOfferObj,
          });
        },
      );
    },
  };
  return harden(zcfZygote);
};

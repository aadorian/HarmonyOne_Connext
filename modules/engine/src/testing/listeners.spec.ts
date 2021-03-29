import { WithdrawCommitment, VectorChainService } from "@connext/vector-contracts";
import {
  Address,
  ChainAddresses,
  ChannelUpdateEvent,
  FullTransferState,
  IChannelSigner,
  ProtocolEventName,
  ProtocolEventPayloadsMap,
  Result,
  UpdateType,
  WithdrawalCreatedPayload,
  WITHDRAWAL_CREATED_EVENT,
  WithdrawCommitmentJson,
  WithdrawResolver,
  WithdrawState,
  WITHDRAWAL_RESOLVED_EVENT,
  WithdrawStateEncoding,
  WithdrawResolverEncoding,
  RegisteredTransfer,
  TransferNames,
  IVectorChainService,
  FullChannelState,
  ChainError,
  EngineParams,
  WithdrawalResolvedPayload,
} from "@connext/vector-types";
import {
  getTestLoggers,
  getRandomChannelSigner,
  mkAddress,
  expect,
  delay,
  MemoryStoreService,
  createTestChannelStateWithSigners,
  getRandomBytes32,
  createCoreTransferState,
  hashTransferState,
  createTestChannelState,
  mkHash,
  MemoryMessagingService,
  PartialFullChannelState,
  ChannelSigner,
  mkSig,
} from "@connext/vector-utils";
import { Vector } from "@connext/vector-protocol";
import { Evt } from "evt";
import Sinon from "sinon";
import { AddressZero } from "@ethersproject/constants";
import { BigNumber } from "@ethersproject/bignumber";
import { hexlify } from "@ethersproject/bytes";
import { randomBytes } from "@ethersproject/random";

import { getWithdrawalQuote, resolveExistingWithdrawals, setupEngineListeners } from "../listeners";
import * as utils from "../utils";
const { getEngineEvtContainer } = utils;

import { env } from "./env";
import { WithdrawQuoteError } from "../errors";

const testName = "Engine listeners unit";
const { log } = getTestLoggers(testName, env.logLevel);

describe(testName, () => {
  // Get env constants
  const chainId = parseInt(Object.keys(env.chainProviders)[0]);
  const withdrawAddress = mkAddress("0xdefff");
  const chainAddresses: ChainAddresses = {
    [chainId]: {
      channelFactoryAddress: env.chainAddresses[chainId].channelFactoryAddress,
      transferRegistryAddress: env.chainAddresses[chainId].transferRegistryAddress,
    },
  };

  // Get test constants
  const alice: IChannelSigner = getRandomChannelSigner();
  const bob: IChannelSigner = getRandomChannelSigner();
  const container = getEngineEvtContainer();
  const withdrawTransactionHash = getRandomBytes32();
  const withdrawRegisteredInfo: RegisteredTransfer = {
    definition: withdrawAddress,
    resolverEncoding: "resolve",
    stateEncoding: "state",
    name: TransferNames.Withdraw,
    encodedCancel: "encodedCancel",
  };

  // Declare mocks
  let store: Sinon.SinonStubbedInstance<MemoryStoreService>;
  let chainService: Sinon.SinonStubbedInstance<VectorChainService>;
  let messaging: Sinon.SinonStubbedInstance<MemoryMessagingService>;
  let acquireRestoreLockStub: Sinon.SinonStub;
  let releaseRestoreLockStub: Sinon.SinonStub;

  // Create an EVT to post to, that can be aliased as a
  // vector instance
  const evt = Evt.create<ChannelUpdateEvent>();
  // Set vector stub to interact with this EVT instance
  const on = (
    event: ProtocolEventName,
    callback: (payload: ProtocolEventPayloadsMap[typeof event]) => void | Promise<void>,
    filter: (payload) => boolean = () => true,
  ) => evt.pipe(filter).attach(callback);

  let vector: Sinon.SinonStubbedInstance<Vector>;

  beforeEach(() => {
    // Create the mocked instances
    store = Sinon.createStubInstance(MemoryStoreService);
    // By default withdraw submission succeeds
    chainService = Sinon.createStubInstance(VectorChainService, {
      sendWithdrawTx: Promise.resolve(
        Result.ok({
          hash: withdrawTransactionHash,
          wait: () => Promise.resolve({ transactionHash: withdrawTransactionHash }),
        }),
      ) as any,
      getRegisteredTransferByName: Promise.resolve(Result.ok(withdrawRegisteredInfo)),
    });

    vector = Sinon.createStubInstance(Vector);
    messaging = Sinon.createStubInstance(MemoryMessagingService);
    vector.on = on as any;

    // By default acquire/release for restore succeeds
    acquireRestoreLockStub = Sinon.stub().resolves(Result.ok(undefined));
    releaseRestoreLockStub = Sinon.stub().resolves(Result.ok(undefined));
  });

  afterEach(() => {
    // Restore all mocks
    Sinon.restore();

    // Remove all evt listeners
    evt.detach();
  });

  describe.skip("setup", () => {
    it("should work", async () => {});
    it("should not emit for other events", () => {});
  });
  describe.skip("deposit", () => {
    it("should work", async () => {});
    it("should not emit for other events", () => {});
  });
  describe.skip("transfer creation", () => {
    it("should not emit if there is no transfer", () => {});
    it("should not handle withdrawals", () => {});
    it("should work if chainService.getRegisteredTransferByDefinition fails", () => {});
  });
  describe.skip("transfer resolution", () => {
    it("should work", () => {});
    it("should not handle withdrawals", () => {});
    it("should work if chainService.getRegisteredTransferByDefinition fails", () => {});
  });
  describe.skip("withdrawal creation", () => {
    it("should not handle transfers", () => {});
    it("should fail if getting transfer from store fails", () => {});
    it("should work for initiator", () => {});
    it("should fail if responder cannot sign commitment", () => {});
    it("should fail if responder cannot save signed commitment", () => {});
    it("should work if responder is alice (submit withdraw to chain + resolve transfer)", () => {});
    it("should work if responder is bob (DONT submit withdraw to chain + resolve transfer)", () => {});
  });
  describe.skip("withdrawal resolution", () => {
    it("should not handle transfers", () => {});
    it("should fail if getting transfer from store fails", () => {});
    it("should fail if there is no transfer in store", () => {});
    it("should work for initiator", () => {});
    it("should fail if responder cannot addSignatures to commitment", () => {});
    it("should fail if responder cannot save commitment", () => {});
    it("should should work if responder is alice (submit withdraw to chain)", () => {});
    it("should should work if responder is bob (DONT submit withdraw to chain)", () => {});
  });

  describe("withdrawals", () => {
    // Create a helper to generate withdrawal test constants
    const getWithdrawalCommitment = async (
      initiator: IChannelSigner,
      responder: IChannelSigner,
      overrides: Partial<WithdrawCommitmentJson> = {},
    ): Promise<{
      transfer: FullTransferState;
      resolver: WithdrawResolver;
      commitment: WithdrawCommitmentJson;
    }> => {
      // Generate commitment
      const fee = BigNumber.from(3);
      const withdrawalAmount = BigNumber.from(4);
      const commitment = await WithdrawCommitment.fromJson({
        channelAddress: mkAddress("0xccc"),
        alice: alice.address,
        bob: bob.address,
        recipient: alice.address,
        assetId: mkAddress(),
        amount: withdrawalAmount.toString(),
        nonce: getRandomBytes32(),
        callTo: AddressZero,
        callData: "0x",
        ...overrides,
      });

      // Generate signatures
      const initiatorSignature = await initiator.signMessage(commitment.hashToSign());
      const responderSignature = await responder.signMessage(commitment.hashToSign());

      // Generate state
      const balance = {
        to: [commitment.recipient, commitment.bob],
        amount: [fee.add(commitment.amount).toString(), "0"],
      };
      const initialState: WithdrawState = {
        initiatorSignature,
        initiator: initiator.address,
        responder: responder.address,
        data: hexlify(randomBytes(32)),
        nonce: commitment.nonce,
        fee: fee.toString(),
        callTo: AddressZero,
        callData: "0x",
      };
      const stateEncoding = WithdrawStateEncoding;
      const resolverEncoding = WithdrawResolverEncoding;
      const initialStateHash = hashTransferState(initialState, stateEncoding);

      // Generate transfer
      const json: WithdrawCommitmentJson = commitment.toJson();
      const transfer = {
        channelFactoryAddress: chainAddresses[chainId].channelFactoryAddress,
        chainId,
        transferEncodings: [stateEncoding, resolverEncoding],
        transferState: { balance, ...initialState },
        transferResolver: undefined,
        meta: { test: "meta" },
        inDispute: false,
        channelNonce: 4,
        initiatorIdentifier: initiator.publicIdentifier,
        responderIdentifier: responder.publicIdentifier,
        ...createCoreTransferState({
          balance,
          assetId: commitment.assetId,
          channelAddress: commitment.channelAddress,
          transferDefinition: withdrawAddress,
          initialStateHash,
          initiator: initiator.address,
          responder: responder.address,
        }),
      };

      return { resolver: { responderSignature }, transfer, commitment: json };
    };

    // Create a helper to run the withdrawal create listener tests
    const runWithdrawalCreationTest = async (
      signer: IChannelSigner = bob,
      withdrawer: IChannelSigner = alice,
      withdrawalRecipient: Address = alice.address,
      gasSubsidyPercentage = 100,
    ) => {
      // Create the withdrawal data
      // Responder is always the withdrawer's counterparty
      const responder = withdrawer.address === bob.address ? alice : bob;
      const { transfer, resolver, commitment } = await getWithdrawalCommitment(withdrawer, responder, {
        recipient: withdrawalRecipient,
      });

      const updatedChannelState = createTestChannelStateWithSigners([alice, bob], UpdateType.create, {
        channelAddress: commitment.channelAddress,
        latestUpdate: {
          assetId: commitment.assetId,
          fromIdentifier: withdrawer.publicIdentifier,
          toIdentifier: responder.publicIdentifier,
          details: {
            transferDefinition: transfer.transferDefinition,
            transferInitialState: transfer.transferState,
            transferEncodings: transfer.transferEncodings,
            transferId: transfer.transferId,
          },
        },
        assetIds: [commitment.assetId],
        networkContext: {
          chainId,
        },
      });

      // Set the resolve mock to return a result
      // NOTE: this result isn't really used, but should be correctly
      // structured
      vector.resolve.resolves(
        Result.ok(
          createTestChannelState(UpdateType.resolve, {
            latestUpdate: {
              fromIdentifier: responder.publicIdentifier,
              toIdentifier: withdrawer.publicIdentifier,
            },
          }).channel,
        ),
      );

      // Set the store mock to return a result
      store.getTransferState.resolves(transfer);

      // Begin the test
      // Setup the listeners
      await setupEngineListeners(
        container,
        chainService as IVectorChainService,
        vector,
        messaging,
        signer,
        store,
        chainAddresses,
        log,
        () => Promise.resolve(Result.ok({} as any)),
        acquireRestoreLockStub,
        releaseRestoreLockStub,
        gasSubsidyPercentage,
      );

      // Create a promise that will resolve once the event is emitted
      // + some time for the handler to complete
      const createdEvent = new Promise<WithdrawalCreatedPayload>((resolve) =>
        container[WITHDRAWAL_CREATED_EVENT].attachOnce(5000, (data) => delay(500).then(() => resolve(data))),
      );

      // Post to the evt
      evt.post({ updatedChannelState, updatedTransfer: transfer, updatedTransfers: [transfer] });

      // Get the emitted event
      const emitted = await createdEvent;

      // Verify the emitted event
      expect(emitted).to.containSubset({
        assetId: commitment.assetId,
        amount: commitment.amount,
        recipient: alice.address,
        fee: transfer.transferState.fee,
        transfer,
        channelBalance:
          updatedChannelState.balances[updatedChannelState.assetIds.findIndex((a) => a === commitment.assetId)],
        channelAddress: updatedChannelState.channelAddress,
      });

      // If the signer is the initiator, they would not be able to do
      // anything until they have received the responders signature on
      // the withdrawal commitment.
      const isWithdrawalInitiator = signer.address === transfer.initiator;
      const isAlice = signer.address === updatedChannelState.alice;

      // Verify the store calls were correctly executed
      expect(store.saveWithdrawalCommitment.callCount).to.be.eq(isWithdrawalInitiator ? 0 : 1);
      // If the call was executed, verify arguments
      if (store.saveWithdrawalCommitment.callCount) {
        const [storeTransferId, withdrawCommitment] = store.saveWithdrawalCommitment.args[0];
        expect(storeTransferId).to.be.eq(transfer.transferId);
        expect(withdrawCommitment.aliceSignature).to.be.ok;
        expect(withdrawCommitment.bobSignature).to.be.ok;
      }

      // Verify the transaction submission was correctly executed
      expect(chainService.sendWithdrawTx.callCount).to.be.eq(!isWithdrawalInitiator && isAlice ? 1 : 0);
      // If the call was executed, verify arguments
      if (chainService.sendWithdrawTx.callCount) {
        // Withdraw responder is alice, and she tried to submit tx
        const [channelState, minTx] = chainService.sendWithdrawTx.args[0];
        expect(channelState).to.be.deep.eq(updatedChannelState);
        expect(minTx).to.be.ok;
      }

      // Verify the resolve call was correctly executed
      expect(vector.resolve.callCount).to.be.eq(isWithdrawalInitiator ? 0 : 1);
      // If the call was executed, verify arguments
      if (vector.resolve.callCount) {
        const { transferResolver, channelAddress, transferId, meta } = vector.resolve.args[0][0];
        expect(transferResolver).to.be.deep.eq(resolver);
        expect(channelAddress).to.be.eq(updatedChannelState.channelAddress);
        expect(transferId).to.be.eq(transfer.transferId);
        // Verify transaction hash in meta if withdraw attempted
        chainService.sendWithdrawTx.callCount &&
          expect(meta).to.containSubset({ transactionHash: withdrawTransactionHash });
      }
    };

    // Create a helper to run the withdrawal resolve listener tests
    const runWithdrawalResolveTest = async (
      signer: IChannelSigner = bob,
      withdrawer: IChannelSigner = alice,
      withdrawalRecipient: Address = alice.address,
      channelOverrides: PartialFullChannelState<typeof UpdateType.resolve> = {},
    ) => {
      // Create the withdrawal data
      // Responder is always the withdrawer's counterparty
      const responder = withdrawer.address === bob.address ? alice : bob;
      const { transfer, resolver, commitment } = await getWithdrawalCommitment(withdrawer, responder, {
        recipient: withdrawalRecipient,
      });

      // Create the event data
      const updatedChannelState = createTestChannelStateWithSigners([alice, bob], UpdateType.resolve, {
        channelAddress: commitment.channelAddress,
        latestUpdate: {
          assetId: commitment.assetId,
          fromIdentifier: responder.publicIdentifier,
          toIdentifier: withdrawer.publicIdentifier,
          details: {
            transferDefinition: transfer.transferDefinition,
            transferResolver: resolver,
            transferId: transfer.transferId,
            merkleRoot: mkHash(),
          },
        },
        assetIds: [commitment.assetId],
        networkContext: {
          chainId,
        },
        ...channelOverrides,
      });

      // Set the store to return the resolved transfer
      store.getTransferState.resolves({ ...transfer, transferResolver: resolver });

      // Begin the test
      // Setup the listeners
      await setupEngineListeners(
        container,
        chainService as IVectorChainService,
        vector,
        messaging,
        signer,
        store,
        chainAddresses,
        log,
        () => Promise.resolve(Result.ok({} as any)),
        acquireRestoreLockStub,
        releaseRestoreLockStub,
        50,
      );

      // Create a promise that will resolve once the event is emitted
      // + some time for the handler to complete
      const resolvedEvent = new Promise<WithdrawalResolvedPayload>((resolve) =>
        container[WITHDRAWAL_RESOLVED_EVENT].attachOnce(5000, (data) => delay(500).then(() => resolve(data))),
      );

      // Post to the evt
      evt.post({ updatedChannelState, updatedTransfer: { ...transfer, transferResolver: resolver } });

      // Get the emitted event
      const emitted = await resolvedEvent;

      // Verify the emitted event
      expect(emitted).to.containSubset({
        assetId: commitment.assetId,
        amount: commitment.amount,
        recipient: alice.address,
        fee: transfer.transferState.fee,
        transfer: { ...transfer, transferResolver: resolver },
        channelBalance:
          updatedChannelState.balances[updatedChannelState.assetIds.findIndex((a) => a === commitment.assetId)],
        channelAddress: updatedChannelState.channelAddress,
        transaction: {
          to: commitment.channelAddress,
          value: 0,
        },
      });
      expect(emitted.transaction.data).to.be.ok;

      // When getting resolve events, withdrawers will always save the
      // double signed commitment to their store. If the withdrawer is
      // alice, she will try to submit the transaction to chain
      const isWithdrawer = signer.address === withdrawer.address;

      // Verify the store call was correctly executed
      expect(store.saveWithdrawalCommitment.callCount).to.be.eq(isWithdrawer ? 1 : 0);
      if (store.saveWithdrawalCommitment.callCount) {
        const [storeTransferId, withdrawCommitment] = store.saveWithdrawalCommitment.args[0];
        expect(storeTransferId).to.be.eq(transfer.transferId);
        expect(withdrawCommitment.aliceSignature).to.be.ok;
        expect(withdrawCommitment.bobSignature).to.be.ok;
      }

      // Verify the transaction submission was correctly executed
      expect(chainService.sendWithdrawTx.callCount).to.be.eq(
        isWithdrawer && signer.address === alice.address && updatedChannelState.networkContext.chainId !== 1 ? 1 : 0,
      );
      if (chainService.sendWithdrawTx.callCount) {
        const [channelState, minTx] = chainService.sendWithdrawTx.args[0];
        expect(channelState).to.be.deep.eq(updatedChannelState);
        expect(minTx).to.be.ok;
      }
    };

    it("should properly respond to create event with bob withdrawing eth (alice resolves + submits)", async () => {
      await runWithdrawalCreationTest(alice, bob);
    });

    it("should properly respond to create event with alice withdrawing eth (bob resolves)", async () => {
      await runWithdrawalCreationTest();
    });

    it("should properly respond to resolve event with bob withdrawing eth (alice resolves with hash, bob stores)", async () => {
      await runWithdrawalResolveTest(alice, bob);
    });

    it("should properly respond to resolve event with alice withdrawing eth (bob, alice stores + submits)", async () => {
      await runWithdrawalResolveTest();
    });

    it("should not submit withdrawals to chain IFF alice is withdrawing on mainnet", async () => {
      await runWithdrawalResolveTest(undefined, undefined, undefined, { networkContext: { chainId: 1 } });
    });

    it("resolveExistingWithdrawals should work", async () => {
      const initiator = getRandomChannelSigner();
      const responder = getRandomChannelSigner();
      const { commitment, resolver, transfer } = await getWithdrawalCommitment(initiator, responder);
      const channel = createTestChannelStateWithSigners([initiator, responder], UpdateType.deposit, {
        channelAddress: commitment.channelAddress,
        networkContext: { chainId },
        latestUpdate: { details: transfer.transferId } as any,
      });

      // create unresolved withdrawal transfer states
      vector.getActiveTransfers.resolves([transfer]);
      store.getTransferState.resolves(transfer);
      chainService.getRegisteredTransferByName.resolves(Result.ok(withdrawRegisteredInfo));
      vector.resolve.resolves(Result.ok(channel));

      await resolveExistingWithdrawals(
        channel,
        responder,
        store,
        vector,
        chainAddresses,
        chainService as IVectorChainService,
        getEngineEvtContainer(),
        log,
        50,
      );

      expect(vector.resolve.getCall(0).args[0]).to.containSubset({
        transferResolver: resolver,
        transferId: transfer.transferId,
        channelAddress: channel.channelAddress,
        meta: transfer.meta,
      });
    });
  });

  describe("getWithdrawalQuote", () => {
    // Declare mocks
    let store: Sinon.SinonStubbedInstance<MemoryStoreService>;
    let signer: Sinon.SinonStubbedInstance<ChannelSigner>;
    let chainService: Sinon.SinonStubbedInstance<IVectorChainService>;
    let normalizeFeeStub: Sinon.SinonStub;

    // Test constants
    const gasPrice = BigNumber.from(125);
    const normalizedFee = BigNumber.from(4500);
    const withdrawAmount = BigNumber.from(130);

    beforeEach(() => {
      store = Sinon.createStubInstance(MemoryStoreService);
      signer = Sinon.createStubInstance(ChannelSigner);
      chainService = Sinon.createStubInstance(VectorChainService);
      normalizeFeeStub = Sinon.stub(utils, "normalizeGasFees");
    });

    afterEach(() => Sinon.restore());

    const setupMocks = (
      channel: FullChannelState = createTestChannelState(UpdateType.deposit, { networkContext: { chainId: 1 } })
        .channel,
      _withdrawAmount = withdrawAmount,
    ) => {
      // Store methods
      store.getChannelState.resolves(channel);

      // Chain service methods
      chainService.getCode.resolves(Result.ok(getRandomBytes32()));
      chainService.getGasPrice.resolves(Result.ok(gasPrice));
      chainService.getDecimals.resolves(Result.ok(18));
      chainService.estimateGas.resolves(Result.ok(BigNumber.from(150_000)));

      // Signer methods
      signer.signMessage.resolves(mkSig());

      // normalizeFee
      normalizeFeeStub.resolves(Result.ok(normalizedFee));

      // generate request
      const request = {
        channelAddress: channel.channelAddress,
        amount: _withdrawAmount.toString(),
        assetId: AddressZero,
      };
      return { channel, request };
    };

    const runErrorTest = async (
      request: EngineParams.GetWithdrawalQuote,
      errorMessage: string,
      contextSubset: any = {},
    ) => {
      const result = await getWithdrawalQuote(request, 45, signer, store, chainService as IVectorChainService, log);
      expect(result.isError).to.be.true;
      expect(result.getError()?.message).to.be.eq(errorMessage);
      expect(result.getError()?.context).to.containSubset(contextSubset);
    };

    it("should fail if channel does not exist", async () => {
      const { request } = setupMocks();
      store.getChannelState.resolves(undefined);

      await runErrorTest(request, WithdrawQuoteError.reasons.ChannelNotFound);
    });

    it("should fail if chainService.getCode fails", async () => {
      const { request } = setupMocks();
      chainService.getCode.resolves(Result.fail(new ChainError("fail")));

      await runErrorTest(request, WithdrawQuoteError.reasons.ChainServiceFailure, { chainServiceMethod: "getCode" });
    });

    it("should fail if chainService.getGasPrice fails", async () => {
      const { request } = setupMocks();
      chainService.getGasPrice.resolves(Result.fail(new ChainError("fail")));

      await runErrorTest(request, WithdrawQuoteError.reasons.ChainServiceFailure, {
        chainServiceMethod: "getGasPrice",
      });
    });

    it("should fail if chainService.getDecimals fails", async () => {
      const { request } = setupMocks();
      chainService.getDecimals.resolves(Result.fail(new ChainError("fail")));

      await runErrorTest(request, WithdrawQuoteError.reasons.ChainServiceFailure, {
        chainServiceMethod: "getDecimals",
      });
    });

    it("should fail if normalizeFee fails", async () => {
      const { request } = setupMocks();
      normalizeFeeStub.resolves(Result.fail(new Error("fail")));

      await runErrorTest(request, WithdrawQuoteError.reasons.ExchangeRateError);
    });

    it("should fail if signer.signMessage", async () => {
      const { request } = setupMocks();
      signer.signMessage.rejects(new Error("fail"));

      await runErrorTest(request, WithdrawQuoteError.reasons.SignatureFailure);
    });

    it("should return zero-valued signed quote if gasSubsidyPercentage is 100", async () => {
      const { request } = setupMocks();
      const result = await getWithdrawalQuote(request, 100, signer, store, chainService as IVectorChainService, log);
      expect(result.isError).to.be.false;
      expect(result.getValue()).to.containSubset({
        ...request,
        fee: "0",
      });
    });

    it("should return zero-valued signed quote if chain is not fee-compatible", async () => {
      const channel = createTestChannelState(UpdateType.deposit, { networkContext: { chainId: 1234567 } }).channel;
      const { request } = setupMocks(channel);
      const result = await getWithdrawalQuote(request, 100, signer, store, chainService as IVectorChainService, log);
      expect(result.isError).to.be.false;
      expect(result.getValue()).to.containSubset({
        ...request,
        fee: "0",
      });
    });

    it("should return nonzero-valued signed quote if gasSubsidyPercentage != 100 and chain is fee-compatible when fee is gt amount", async () => {
      const { request } = setupMocks();
      const result = await getWithdrawalQuote(request, 50, signer, store, chainService as IVectorChainService, log);
      expect(result.getError()).to.be.undefined;
      expect(result.getValue()).to.containSubset({
        ...request,
        amount: "0",
        fee: normalizedFee.div(2).toString(),
      });
    });

    it("should return nonzero-valued signed quote if gasSubsidyPercentage != 100 and chain is fee-compatible when fee is lt amount", async () => {
      const { request } = setupMocks(undefined, normalizedFee);
      const result = await getWithdrawalQuote(request, 50, signer, store, chainService as IVectorChainService, log);
      expect(result.getError()).to.be.undefined;
      expect(result.getValue()).to.containSubset({
        ...request,
        amount: BigNumber.from(request.amount).sub(normalizedFee.div(2)).toString(),
        fee: normalizedFee.div(2).toString(),
      });
    });
  });
});

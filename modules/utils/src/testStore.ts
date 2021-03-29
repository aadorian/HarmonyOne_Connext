import {
  Balance,
  ChannelUpdate,
  EngineEvent,
  EngineEvents,
  ResolveUpdateDetails,
  StoredTransactionStatus,
  TransactionReason,
  UpdateType,
  WithdrawCommitmentJson,
  IEngineStore,
  IServerNodeStore,
} from "@connext/vector-types";
import {
  createTestChannelState,
  mkBytes32,
  mkHash,
  expect,
  getRandomBytes32,
  getRandomIdentifier,
  getSignerAddressFromPublicIdentifier,
  createTestTxResponse,
  createTestChannelUpdate,
  mkPublicIdentifier,
  mkAddress,
  delay,
  getRandomChannelSigner,
  mkSig,
} from ".";
// import { delay } from "ts-nats/lib/util";

export const testStore = <T extends IEngineStore>(name: string, makeStore: () => T, isBrowserStore: boolean = false) => {
  describe(name, () => {
    let store: T;
  
    before(async () => {
      store = makeStore();
    });
  
    beforeEach(async () => {
      await store.clear();
    });
  
    after(async () => {
      await store.disconnect();
    });
  
    describe("saveChannelStateAndTransfers", () => {
      it("saveChannelStateAndTransfers removes previous state", async () => {
        const { channel, transfer } = createTestChannelState(
          "create",
          { nonce: 10 },
          {
            transferId: mkHash("0x111"),
            meta: { routingId: mkBytes32("0xddd") },
          },
        );
        await store.saveChannelState(channel, transfer);
        const fromStore = await store.getChannelState(channel.channelAddress);
        expect(fromStore).to.deep.eq(channel);
  
        const { channel: newChannel, transfer: newTransfer } = createTestChannelState(
          "create",
          { nonce: 9 },
          {
            transferId: mkHash("0x111"),
            meta: { routingId: mkBytes32("0xddd") },
          },
        );
        await store.saveChannelStateAndTransfers(newChannel, [newTransfer]);
        const afterRestore = await store.getChannelState(channel.channelAddress);
        expect(afterRestore).to.deep.eq(newChannel);
      });
  
      it("saveChannelStateAndTransfers should work when provided with transfers", async () => {
        const { channel, transfer } = createTestChannelState(
          "create",
          {},
          {
            transferId: mkHash("0x111"),
            meta: { routingId: mkBytes32("0xddd") },
          },
        );
        const starting = transfer.channelNonce;
        const transfers = Array(5)
          .fill(0)
          .map((_, idx) => {
            return {
              ...transfer,
              transferId: getRandomBytes32(),
              channelNonce: starting + idx,
              meta: { routingId: getRandomBytes32() },
            };
          });
  
        // Test with transfers
        await store.saveChannelStateAndTransfers(channel, transfers);
  
        // Verify channel
        const retrieved = await store.getChannelState(channel.channelAddress);
        expect(retrieved).to.be.deep.eq(channel);
  
        for (const t of transfers) {
          const retrieved = await store.getTransferState(t.transferId);
          expect(retrieved).to.be.deep.eq(t);
        }
        expect(
          (await store.getActiveTransfers(channel.channelAddress)).sort((a, b) => a.channelNonce - b.channelNonce),
        ).to.be.deep.eq(transfers.sort((a, b) => a.channelNonce - b.channelNonce));
  
        // Verify it works if the transfers/channel are overridden
        const secondChannel = { ...channel, nonce: 30 };
        const secondTransfers = transfers
          .map((t, idx) => {
            return {
              ...t,
              channelNonce: 30 + idx,
              meta: { routingId: getRandomBytes32() },
            };
          })
          .slice(0, 3);
  
        // Test with transfers
        await store.saveChannelStateAndTransfers(secondChannel, secondTransfers);
  
        // Verify channel
        const retrieved2 = await store.getChannelState(secondChannel.channelAddress);
        expect(retrieved2).to.be.deep.eq(secondChannel);
  
        for (const t2 of secondTransfers) {
          const retrieved = await store.getTransferState(t2.transferId);
          expect(retrieved).to.be.deep.eq(t2);
        }
        expect(
          (await store.getActiveTransfers(secondChannel.channelAddress)).sort((a, b) => a.channelNonce - b.channelNonce),
        ).to.be.deep.eq(secondTransfers.sort((a, b) => a.channelNonce - b.channelNonce));
      });
  
      it("saveChannelStateAndTransfers should work when provided with no active transfers", async () => {
        const { channel } = createTestChannelState("create", undefined, {
          transferId: mkHash("0x111"),
          meta: { routingId: mkBytes32("0xddd") },
        });
  
        // Test with transfers
        await store.saveChannelStateAndTransfers(channel, []);
  
        // Verify channel
        const retrieved = await store.getChannelState(channel.channelAddress);
        expect(retrieved).to.be.deep.eq(channel);
      });
    });
  
    describe("getActiveTransfers", () => {
      it("should get active transfers for different channels", async () => {
        const channel1 = mkAddress("0xaaa");
        const transfer1State = createTestChannelState(
          "create",
          {
            channelAddress: channel1,
          },
          { transferId: mkHash("0x123"), meta: { routingId: mkHash("0x123") } },
        );
        await store.saveChannelState(transfer1State.channel, transfer1State.transfer);
  
        const transfer2State = createTestChannelState(
          "create",
          {
            channelAddress: channel1,
            nonce: transfer1State.channel.nonce + 1,
          },
          { transferId: mkHash("0x456"), meta: { routingId: mkHash("0x456") } },
        );
        await store.saveChannelState(transfer2State.channel, transfer2State.transfer);
  
        const channel2 = mkAddress("0xbbb");
        const transfer3State = createTestChannelState(
          "create",
          {
            channelAddress: channel2,
            bob: mkAddress("0xbaba"),
            bobIdentifier: mkPublicIdentifier("vectorABCD"),
          },
          { transferId: mkHash("0x789"), meta: { routingId: mkHash("0x789") } },
        );
        await store.saveChannelState(transfer3State.channel, transfer3State.transfer);
  
        const channelFromStore = await store.getChannelState(transfer1State.channel.channelAddress);
        expect(channelFromStore).to.deep.eq(transfer2State.channel);
  
        const transfersChannel1 = await store.getActiveTransfers(transfer1State.channel.channelAddress);
        expect(transfersChannel1.length).eq(2);
        const t1 = transfersChannel1.find((t) => t.transferId === transfer1State.transfer.transferId);
        const t2 = transfersChannel1.find((t) => t.transferId === transfer2State.transfer.transferId);
        expect(t1).to.deep.eq(transfer1State.transfer);
        expect(t2).to.deep.eq(transfer2State.transfer);
  
        const transfersChannel2 = await store.getActiveTransfers(transfer3State.channel.channelAddress);
        const t3 = transfersChannel2.find((t) => t.transferId === transfer3State.transfer.transferId);
        expect(t3).to.deep.eq(transfer3State.transfer);
      });
  
      it("should consider resolved transfers", async () => {
        const channel1 = mkAddress("0xaaa");
        const transfer1State = createTestChannelState(
          "create",
          {
            channelAddress: channel1,
          },
          { transferId: mkHash("0x123"), meta: { routingId: mkHash("0x123") } },
        );
        await store.saveChannelState(transfer1State.channel, transfer1State.transfer);
  
        const transfer2Create = createTestChannelState(
          "create",
          {
            channelAddress: channel1,
            nonce: transfer1State.channel.nonce + 1,
          },
          { transferId: mkHash("0x456"), meta: { routingId: mkHash("0x456") } },
        );
        await store.saveChannelState(transfer2Create.channel, transfer2Create.transfer);
  
        const transfer2Resolve = createTestChannelState(
          "resolve",
          {
            channelAddress: channel1,
            nonce: transfer2Create.channel.nonce + 1,
          },
          { transferId: mkHash("0x456"), meta: { routingId: mkHash("0x456") } },
        );
        await store.saveChannelState(transfer2Resolve.channel, transfer2Resolve.transfer);
  
        const channel2 = mkAddress("0xbbb");
        const transfer3State = createTestChannelState(
          "create",
          {
            channelAddress: channel2,
            bob: mkAddress("0xbaba"),
            bobIdentifier: mkPublicIdentifier("vectorABCD"),
          },
          { transferId: mkHash("0x789"), meta: { routingId: mkHash("0x789") } },
        );
        await store.saveChannelState(transfer3State.channel, transfer3State.transfer);
  
        const channelFromStore = await store.getChannelState(transfer1State.channel.channelAddress);
        expect(channelFromStore).to.deep.eq(transfer2Resolve.channel);
  
        const transfersChannel1 = await store.getActiveTransfers(transfer1State.channel.channelAddress);
        expect(transfersChannel1.length).eq(1);
        const t1 = transfersChannel1.find((t) => t.transferId === transfer1State.transfer.transferId);
        expect(t1).to.deep.eq(transfer1State.transfer);
  
        const transfersChannel2 = await store.getActiveTransfers(transfer3State.channel.channelAddress);
        const t3 = transfersChannel2.find((t) => t.transferId === transfer3State.transfer.transferId);
        expect(t3).to.deep.eq(transfer3State.transfer);
      });
    });
  
    describe("getTransfers", () => {
      it("should work with and without filter", async () => {
        const channel1 = mkAddress("0xaaa");
        const transfer1State = createTestChannelState(
          "create",
          {
            channelAddress: channel1,
          },
          { transferId: mkHash("0x123"), transferDefinition: mkAddress("0xabc"), meta: { routingId: mkHash("0x123") } },
        );
        await store.saveChannelState(transfer1State.channel, transfer1State.transfer);
  
        await delay(100);
        const firstDelay = new Date();
        await delay(100);
  
        const transfer2Create = createTestChannelState(
          "create",
          {
            channelAddress: channel1,
            nonce: transfer1State.channel.nonce + 1,
          },
          { transferId: mkHash("0x456"), meta: { routingId: mkHash("0x456") } },
        );
        await store.saveChannelState(transfer2Create.channel, transfer2Create.transfer);
  
        const transfer2Resolve = createTestChannelState(
          "resolve",
          {
            channelAddress: channel1,
            nonce: transfer2Create.channel.nonce + 1,
          },
          { transferId: mkHash("0x456"), meta: { routingId: mkHash("0x456") } },
        );
        await store.saveChannelState(transfer2Resolve.channel, transfer2Resolve.transfer);
  
        await delay(100);
        const secondDelay = new Date();
        await delay(100);
  
        const channel2 = mkAddress("0xbbb");
        const transfer3State = createTestChannelState(
          "create",
          {
            channelAddress: channel2,
            bob: mkAddress("0xbaba"),
            bobIdentifier: mkPublicIdentifier("vectorABCD"),
          },
          { transferId: mkHash("0x789"), meta: { routingId: mkHash("0x789") } },
        );
        await store.saveChannelState(transfer3State.channel, transfer3State.transfer);
  
        // no filter, get transfers across all channels
        const transfers = await store.getTransfers();
        expect(transfers.length).to.eq(3);
        expect(transfers).to.deep.contain(transfer1State.transfer);
        expect(transfers).to.deep.contain({
          ...transfer2Create.transfer,
          transferResolver: transfer2Resolve.transfer.transferResolver,
        });
        expect(transfers).to.deep.contain(transfer3State.transfer);
  
        const channelFiltered = await store.getTransfers({ channelAddress: channel1 });
        expect(channelFiltered.length).to.eq(2);
        expect(channelFiltered).to.deep.contain(transfer1State.transfer);
        expect(channelFiltered).to.deep.contain({
          ...transfer2Create.transfer,
          transferResolver: transfer2Resolve.transfer.transferResolver,
        });
  
        const startDateFiltered = await store.getTransfers({ startDate: secondDelay });
        expect(startDateFiltered.length).to.eq(1);
        expect(startDateFiltered).to.deep.contain(transfer3State.transfer);
  
        const endDateFiltered = await store.getTransfers({ endDate: firstDelay });
        expect(endDateFiltered.length).to.eq(1);
        expect(endDateFiltered).to.deep.contain(transfer1State.transfer);
  
        const startAndEndDateFiltered = await store.getTransfers({ startDate: firstDelay, endDate: secondDelay });
        expect(startAndEndDateFiltered.length).to.eq(1);
        expect(startAndEndDateFiltered).to.deep.contain({
          ...transfer2Create.transfer,
          transferResolver: transfer2Resolve.transfer.transferResolver,
        });
  
        const definitionFiltered = await store.getTransfers({
          transferDefinition: transfer1State.transfer.transferDefinition,
        });
        expect(definitionFiltered.length).to.be.eq(1);
        expect(definitionFiltered[0]).to.be.deep.eq(transfer1State.transfer);
      });
    });
  
    describe("getChannelStateByParticipants", () => {
      it("should work (regardless of order)", async () => {
        const channel = createTestChannelState("deposit").channel;
        await store.saveChannelState(channel);
  
        expect(
          await store.getChannelStateByParticipants(
            channel.aliceIdentifier,
            channel.bobIdentifier,
            channel.networkContext.chainId,
          ),
        ).to.be.deep.eq(channel);
  
        expect(
          await store.getChannelStateByParticipants(
            channel.bobIdentifier,
            channel.aliceIdentifier,
            channel.networkContext.chainId,
          ),
        ).to.be.deep.eq(channel);
      });
    });
  
    describe("getTransferByRoutingId", () => {
      it("should work", async () => {
        const state = createTestChannelState("create", {}, { meta: { routingId: getRandomBytes32() } });
        await store.saveChannelState(state.channel, state.transfer);
  
        expect(
          await store.getTransferByRoutingId(state.channel.channelAddress, state.transfer.meta!.routingId),
        ).to.be.deep.eq(state.transfer);
      });
    });
  
    describe("getChannelStates", () => {
      it("should return all channel states", async () => {
        const c1 = createTestChannelState("deposit", {
          channelAddress: mkAddress("0xccc1111"),
          aliceIdentifier: mkPublicIdentifier("vectorA"),
          alice: mkAddress("0xa"),
        }).channel;
        c1.latestUpdate.channelAddress = mkAddress("0xccc1111");
        const c2 = createTestChannelState("deposit", {
          channelAddress: mkAddress("0xccc2222"),
          aliceIdentifier: mkPublicIdentifier("vectorB"),
          alice: mkAddress("0xb"),
        }).channel;
        c2.latestUpdate.channelAddress = mkAddress("0xccc2222");
        await Promise.all(
          [c1, c2].map((c) => {
            return store.saveChannelState(c);
          }),
        );
        const retrieved = await store.getChannelStates();
        expect(retrieved).to.be.deep.include(c1);
        expect(retrieved).to.be.deep.include(c2);
        expect(retrieved.length).to.be.eq(2);
      });
    });

    describe("getWithdrawalCommitment / getWithdrawalCommitmentByTransactionHash / saveWithdrawalCommitment", () => {
      // Here we process this test differently based on whether it's a BrowserStore we're testing or the PrismaStore
      // from server-node. There are also a few tests unique to each, and a few that they share.
      if (isBrowserStore) {
        // BrowserNode tests.
        const alice = getRandomChannelSigner();
        const bob = getRandomChannelSigner();
        const transferId = getRandomBytes32();
        const commitment: WithdrawCommitmentJson = {
          channelAddress: mkAddress("0xcc"),
          amount: "10",
          alice: alice.address,
          bob: bob.address,
          assetId: mkAddress(),
          aliceSignature: mkSig("0xaaa"),
          bobSignature: mkSig("0xbbb"),
          recipient: mkAddress("0xrrr"),
          nonce: "12",
          callData: "0x",
          callTo: mkAddress(),
          transactionHash: mkHash("0xttt"),
        };
    
        beforeEach(async () => {
          await store.saveWithdrawalCommitment(transferId, commitment);
        });
    
        it("getWithdrawalCommitment should work", async () => {
          expect(await store.getWithdrawalCommitment(transferId)).to.be.deep.eq(commitment);
        });
    
        it("getWithdrawalCommitmentByTransactionHash should work", async () => {
          expect(await store.getWithdrawalCommitmentByTransactionHash(commitment.transactionHash!)).to.be.deep.eq(
            commitment,
          );
        });
      } else {
        // ServerNode tests.
        let resolveUpdate: ChannelUpdate<"resolve">;
        let createUpdate: ChannelUpdate<"create">;
        const alice = getRandomChannelSigner();
        const bob = getRandomChannelSigner();
        const transferId = getRandomBytes32();
        const commitment: WithdrawCommitmentJson = {
          channelAddress: mkAddress("0xcc"),
          amount: "10",
          alice: alice.address,
          bob: bob.address,
          assetId: mkAddress(),
          aliceSignature: mkSig("0xaaa"),
          bobSignature: mkSig("0xbbb"),
          recipient: mkAddress("0xrrr"),
          nonce: "12",
          callData: "0x",
          callTo: mkAddress(),
          transactionHash: mkHash("0xttt"),
        };

        beforeEach(async () => {
          resolveUpdate = createTestChannelUpdate(UpdateType.resolve, {
            channelAddress: commitment.channelAddress,
            details: {
              transferId,
              transferResolver: { responderSignature: commitment.bobSignature },
              meta: { transactionHash: commitment.transactionHash },
            },
            fromIdentifier: bob.publicIdentifier,
            toIdentifier: alice.publicIdentifier,
            assetId: commitment.assetId,
            nonce: 5,
          });

          createUpdate = createTestChannelUpdate(UpdateType.create, {
            channelAddress: commitment.channelAddress,
            details: {
              transferId,
              balance: { amount: [commitment.amount, "0"], to: [commitment.recipient, bob.address] },
              transferInitialState: {
                initiatorSignature: commitment.aliceSignature,
                initiator: commitment.alice,
                responder: commitment.bob,
                nonce: commitment.nonce,
                callTo: commitment.callTo,
                callData: commitment.callData,
                fee: "0",
              },
            },
            fromIdentifier: alice.publicIdentifier,
            toIdentifier: bob.publicIdentifier,
            assetId: commitment.assetId,
            nonce: 4,
          });

          const { channel: createChannel, transfer } = createTestChannelState(UpdateType.create, {
            channelAddress: commitment.channelAddress,
            alice: commitment.alice,
            bob: commitment.bob,
            aliceIdentifier: alice.publicIdentifier,
            bobIdentifier: bob.publicIdentifier,
            latestUpdate: { ...createUpdate },
          });
          await store.saveChannelState(createChannel, { ...transfer, balance: createUpdate.balance });

          const resolveChannel = createTestChannelState(UpdateType.resolve, {
            channelAddress: commitment.channelAddress,
            alice: commitment.alice,
            bob: commitment.bob,
            aliceIdentifier: alice.publicIdentifier,
            bobIdentifier: bob.publicIdentifier,
            latestUpdate: { ...resolveUpdate },
          }).channel;
          await store.saveChannelState(
            { ...resolveChannel, latestUpdate: resolveUpdate },
            {
              ...transfer,
              transferResolver: { responderSignature: commitment.bobSignature },
              balance: createUpdate.balance,
            },
          );
          await store.saveWithdrawalCommitment(transferId, commitment);
        });

        it("should update transfer resolver", async () => {
          const transferId = mkBytes32("0xabcde");
          const createState = createTestChannelState("create", {}, { transferId });
          await store.saveChannelState(createState.channel, createState.transfer);
          let transferFromStore = await store.getTransferState(createState.transfer.transferId);
          expect(transferFromStore).to.deep.eq({
            ...createState.transfer,
            transferState: {
              balance: (createState.channel.latestUpdate as ChannelUpdate<typeof UpdateType.create>).details.balance,
              ...createState.transfer.transferState,
            },
          });
        });

        it("should create an event subscription", async () => {
          const pubId = mkPublicIdentifier();
          const subs = {
            [EngineEvents.CONDITIONAL_TRANSFER_CREATED]: "sub1",
            [EngineEvents.CONDITIONAL_TRANSFER_RESOLVED]: "sub2",
            [EngineEvents.DEPOSIT_RECONCILED]: "sub3",
          };
          const servernodestore = store as unknown as IServerNodeStore;
          await servernodestore.registerSubscription(pubId, EngineEvents.CONDITIONAL_TRANSFER_CREATED, "othersub");
    
          const other = await servernodestore.getSubscription(pubId, EngineEvents.CONDITIONAL_TRANSFER_CREATED);
          expect(other).to.eq("othersub");
    
          for (const [event, url] of Object.entries(subs)) {
            await servernodestore.registerSubscription(pubId, event as EngineEvent, url);
          }
    
          const all = await servernodestore.getSubscriptions(pubId);
          expect(all).to.deep.eq(subs);
        });
      }

      // Shared tests.
      it("should save transaction responses and receipts", async () => {
        // Load store with channel
        const setupState = createTestChannelState("setup").channel;
        await store.saveChannelState(setupState);
    
        const response = createTestTxResponse();
    
        // save response
        await store.saveTransactionResponse(setupState.channelAddress, TransactionReason.depositA, response);
    
        // verify response
        const storedResponse = await store.getTransactionByHash(response.hash);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { wait, confirmations, hash, ...sanitizedResponse } = response;
        expect(storedResponse).to.containSubset({
          ...sanitizedResponse,
          status: StoredTransactionStatus.submitted,
          channelAddress: setupState.channelAddress,
          transactionHash: hash,
          gasLimit: response.gasLimit.toString(),
          gasPrice: response.gasPrice.toString(),
          value: response.value.toString(),
        });
    
        // save receipt
        const receipt = await response.wait();
        await store.saveTransactionReceipt(setupState.channelAddress, receipt);
    
        // verify receipt
        const storedReceipt = await store.getTransactionByHash(response.hash);
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { confirmations: receiptConfs, ...sanitizedReceipt } = receipt;
        expect(storedReceipt).to.containSubset({
          ...sanitizedResponse,
          ...sanitizedReceipt,
          channelAddress: setupState.channelAddress,
          transactionHash: hash,
          gasLimit: response.gasLimit.toString(),
          gasPrice: response.gasPrice.toString(),
          value: response.value.toString(),
          cumulativeGasUsed: receipt.cumulativeGasUsed.toString(),
          gasUsed: receipt.gasUsed.toString(),
          status: StoredTransactionStatus.mined,
        });
    
        // save failing response
        const failed = createTestTxResponse({ hash: mkHash("0x13754"), nonce: 65 });
        await store.saveTransactionResponse(setupState.channelAddress, TransactionReason.depositB, failed);
        // save error
        await store.saveTransactionFailure(setupState.channelAddress, failed.hash, "failed to send");
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { wait: fWait, confirmations: fConf, hash: fHash, ...sanitizedFailure } = failed;
        const storedFailure = await store.getTransactionByHash(fHash);
        expect(storedFailure).to.containSubset({
          ...sanitizedFailure,
          transactionHash: fHash,
          gasLimit: failed.gasLimit.toString(),
          gasPrice: failed.gasPrice.toString(),
          value: failed.value.toString(),
          status: StoredTransactionStatus.failed,
          error: "failed to send",
        });
      });
    
      it("should save and retrieve all update types and keep updating the channel", async () => {
        const setupState = createTestChannelState("setup").channel;
        await store.saveChannelState(setupState);
    
        let fromStore = await store.getChannelState(setupState.channelAddress);
        expect(fromStore).to.deep.eq(setupState);
    
        const updatedBalanceForDeposit: Balance = { amount: ["10", "20"], to: setupState.balances[0].to };
        const depositState = createTestChannelState("deposit", {
          nonce: setupState.nonce + 1,
          defundNonces: setupState.defundNonces,
          balances: [updatedBalanceForDeposit, setupState.balances[0]],
          networkContext: setupState.networkContext,
        }).channel;
        await store.saveChannelState(depositState);
    
        fromStore = await store.getChannelState(setupState.channelAddress);
        expect(fromStore).to.deep.eq(depositState);
    
        const createState = createTestChannelState(
          "create",
          {
            channelAddress: setupState.channelAddress,
            nonce: depositState.nonce + 1,
            defundNonces: setupState.defundNonces,
            networkContext: setupState.networkContext,
          },
          {
            transferId: mkHash("0x111"),
            meta: { routingId: mkBytes32("0xddd") },
          },
        );
        await store.saveChannelState(createState.channel, createState.transfer);
    
        fromStore = await store.getChannelState(setupState.channelAddress);
        expect(fromStore).to.deep.eq(createState.channel);
    
        const resolveState = createTestChannelState(
          "resolve",
          {
            nonce: createState.channel.nonce + 1,
            defundNonces: setupState.defundNonces,
            networkContext: setupState.networkContext,
          },
          {
            transferId: mkHash("0x111"),
          },
        );
        await store.saveChannelState(resolveState.channel, resolveState.transfer);
    
        fromStore = await store.getChannelState(setupState.channelAddress);
        expect(fromStore).to.deep.eq(resolveState.channel);
      });
    
      it("should update transfer resolver", async () => {
        const transferId = mkBytes32("0xabcde");
        const createState = createTestChannelState("create", {}, { transferId });
        await store.saveChannelState(createState.channel, createState.transfer);
        let transferFromStore = await store.getTransferState(createState.transfer.transferId);
        expect(transferFromStore).to.deep.eq(createState.transfer);
    
        const resolveState = createTestChannelState("resolve", { nonce: createState.channel.nonce + 1 }, { transferId });
    
        await store.saveChannelState(resolveState.channel, resolveState.transfer);
        const fromStore = await store.getChannelState(resolveState.channel.channelAddress);
        expect(fromStore).to.deep.eq(resolveState.channel);
    
        transferFromStore = await store.getTransferState(resolveState.transfer.transferId);
        expect(transferFromStore!.transferResolver).to.deep.eq(
          (resolveState.channel.latestUpdate.details as ResolveUpdateDetails).transferResolver,
        );
      });
    
      it("should create multiple active transfers", async () => {
        const createState = createTestChannelState(
          "create",
          {},
          {
            transferId: mkHash("0x111"),
            meta: { routingId: mkBytes32("0xddd") },
            balance: { to: [mkAddress("0xaaa"), mkAddress("0xbbb")], amount: ["5", "0"] },
          },
        );
        await store.saveChannelState(createState.channel, createState.transfer);
    
        const updatedState = createTestChannelState(
          "create",
          {
            nonce: createState.channel.nonce + 1,
          },
          {
            transferId: mkHash("0x112"),
            meta: { routingId: mkBytes32("0xeee") },
            balance: { to: [mkAddress("0xaaa"), mkAddress("0xbbb")], amount: ["5", "0"] },
          },
        );
        await store.saveChannelState(updatedState.channel, updatedState.transfer);
    
        const channelFromStore = await store.getChannelState(createState.channel.channelAddress);
        expect(channelFromStore).to.deep.eq(updatedState.channel);
    
        const transfers = await store.getActiveTransfers(createState.channel.channelAddress);
    
        expect(transfers.length).eq(2);
        const t1 = transfers.find((t) => t.transferId === createState.transfer.transferId);
        const t2 = transfers.find((t) => t.transferId === updatedState.transfer.transferId);
        expect(t1).to.deep.eq(createState.transfer);
        expect(t2).to.deep.eq(updatedState.transfer);
      });
    
      it("should get multiple transfers by routingId", async () => {
        const routingId = mkBytes32("0xddd");
        const alice = getRandomIdentifier();
        const bob1 = getRandomIdentifier();
        const createState = createTestChannelState(
          "create",
          {
            aliceIdentifier: alice,
            alice: getSignerAddressFromPublicIdentifier(alice),
            bobIdentifier: bob1,
            bob: getSignerAddressFromPublicIdentifier(bob1),
          },
          {
            transferId: mkHash("0x111"),
            meta: { routingId },
            balance: {
              to: [getSignerAddressFromPublicIdentifier(alice), getSignerAddressFromPublicIdentifier(bob1)],
              amount: ["7", "0"],
            },
            responder: getSignerAddressFromPublicIdentifier(alice),
            initiator: getSignerAddressFromPublicIdentifier(bob1),
          },
        );
    
        await store.saveChannelState(createState.channel, createState.transfer);
    
        const newBob = getRandomIdentifier();
        const createState2 = createTestChannelState(
          "create",
          {
            aliceIdentifier: alice,
            alice: getSignerAddressFromPublicIdentifier(alice),
            channelAddress: getRandomBytes32(),
            bob: getSignerAddressFromPublicIdentifier(newBob),
            bobIdentifier: newBob,
          },
          {
            transferId: mkHash("0x122"),
            meta: { routingId },
            balance: {
              to: [getSignerAddressFromPublicIdentifier(alice), getSignerAddressFromPublicIdentifier(newBob)],
              amount: ["7", "0"],
            },
            initiator: getSignerAddressFromPublicIdentifier(alice),
            responder: getSignerAddressFromPublicIdentifier(newBob),
          },
        );
    
        await store.saveChannelState(createState2.channel, createState2.transfer);
    
        const transfers = await store.getTransfersByRoutingId(routingId);
        expect(transfers.length).to.eq(2);
    
        const t1 = transfers.find((t) => t.transferId === createState.transfer.transferId);
        const t2 = transfers.find((t) => t.transferId === createState2.transfer.transferId);
        expect(t1).to.deep.eq(createState.transfer);
        expect(t2).to.deep.eq(createState2.transfer);
      });
    });
  });
}

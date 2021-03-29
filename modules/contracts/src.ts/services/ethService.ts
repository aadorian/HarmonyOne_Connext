import {
  FullChannelState,
  IVectorChainService,
  MinimalTransaction,
  ChainError,
  Result,
  ERC20Abi,
  IChainServiceStore,
  TransactionReason,
  FullTransferState,
  UINT_MAX,
  jsonifyError,
  EngineEvents,
  TransactionEvent,
  TransactionEventMap,
  StringifiedTransactionReceipt,
  StringifiedTransactionResponse,
  TransactionResponseWithResult,
  getConfirmationsForChain,
} from "@connext/vector-types";
import {
  bufferify,
  delay,
  encodeTransferResolver,
  encodeTransferState,
  getRandomBytes32,
  hashCoreTransferState,
} from "@connext/vector-utils";
import { Interface } from "@ethersproject/abi";
import { Signer } from "@ethersproject/abstract-signer";
import { BigNumber } from "@ethersproject/bignumber";
import { Contract } from "@ethersproject/contracts";
import { JsonRpcProvider, TransactionReceipt, TransactionResponse } from "@ethersproject/providers";
import { keccak256 } from "@ethersproject/keccak256";
import { Wallet } from "@ethersproject/wallet";
import { BaseLogger } from "pino";
import PriorityQueue from "p-queue";
import { AddressZero, HashZero } from "@ethersproject/constants";
import { MerkleTree } from "merkletreejs";
import { Evt } from "evt";

import { ChannelFactory, VectorChannel } from "../artifacts";

import { EthereumChainReader } from "./ethReader";

export const EXTRA_GAS = 50_000;
export const BIG_GAS_LIMIT = BigNumber.from(1_000_000); // 1M gas should cover all Connext txs

export const waitForTransaction = async (
  provider: JsonRpcProvider,
  transactionHash: string,
  confirmations?: number,
  timeout?: number,
): Promise<Result<TransactionReceipt, ChainError>> => {
  try {
    const receipt = await provider.waitForTransaction(transactionHash, confirmations, timeout);
    if (receipt.status === 0) {
      return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
    }
    return Result.ok(receipt);
  } catch (e) {
    return Result.fail(e);
  }
};
export class EthereumChainService extends EthereumChainReader implements IVectorChainService {
  private signers: Map<number, Signer> = new Map();
  private queue: PriorityQueue = new PriorityQueue({ concurrency: 1 });
  private evts: { [eventName in TransactionEvent]: Evt<TransactionEventMap[eventName]> } = {
    [EngineEvents.TRANSACTION_SUBMITTED]: new Evt(),
    [EngineEvents.TRANSACTION_MINED]: new Evt(),
    [EngineEvents.TRANSACTION_FAILED]: new Evt(),
  };
  constructor(
    private readonly store: IChainServiceStore,
    chainProviders: { [chainId: string]: JsonRpcProvider },
    signer: string | Signer,
    log: BaseLogger,
    private readonly defaultRetries = 1,
  ) {
    super(chainProviders, log.child({ module: "EthereumChainService" }));
    Object.entries(chainProviders).forEach(([chainId, provider]) => {
      this.signers.set(
        parseInt(chainId),
        typeof signer === "string" ? new Wallet(signer, provider) : (signer.connect(provider) as Signer),
      );
    });
  }

  async sendDisputeChannelTx(
    channelState: FullChannelState,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!channelState.latestUpdate.aliceSignature || !channelState.latestUpdate.bobSignature) {
      return Result.fail(new ChainError(ChainError.reasons.MissingSigs));
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.disputeChannel,
      () => {
        const channel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
        return channel.disputeChannel(
          channelState,
          channelState.latestUpdate.aliceSignature,
          channelState.latestUpdate.bobSignature,
        );
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  async sendDefundChannelTx(
    channelState: FullChannelState,
    assetsToDefund: string[] = channelState.assetIds,
    indices: string[] = [],
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!channelState.latestUpdate.aliceSignature || !channelState.latestUpdate.bobSignature) {
      return Result.fail(new ChainError(ChainError.reasons.MissingSigs));
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.defundChannel,
      () => {
        const channel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
        return channel.defundChannel(channelState, assetsToDefund, indices);
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  async sendDisputeTransferTx(
    transferIdToDispute: string,
    activeTransfers: FullTransferState[],
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    // Make sure transfer is active
    const transferState = activeTransfers.find((t) => t.transferId === transferIdToDispute);
    if (!transferState) {
      return Result.fail(
        new ChainError(ChainError.reasons.TransferNotFound, {
          transfer: transferIdToDispute,
          active: activeTransfers.map((t) => t.transferId),
        }),
      );
    }

    // Get signer
    const signer = this.signers.get(transferState.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    // Generate merkle root
    const hashes = activeTransfers.map((t) => bufferify(hashCoreTransferState(t)));
    const hash = bufferify(hashCoreTransferState(transferState));
    const merkle = new MerkleTree(hashes, keccak256);

    return this.sendTxWithRetries(
      transferState.channelAddress,
      transferState.chainId,
      TransactionReason.disputeTransfer,
      () => {
        const channel = new Contract(transferState.channelAddress, VectorChannel.abi, signer);
        return channel.disputeTransfer(transferState, merkle.getHexProof(hash));
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  async sendDefundTransferTx(
    transferState: FullTransferState,
    responderSignature: string = HashZero,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(transferState.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (!transferState.transferResolver) {
      return Result.fail(new ChainError(ChainError.reasons.ResolverNeeded));
    }

    const encodedState = encodeTransferState(transferState.transferState, transferState.transferEncodings[0]);
    const encodedResolver = encodeTransferResolver(transferState.transferResolver, transferState.transferEncodings[1]);

    return this.sendTxWithRetries(
      transferState.channelAddress,
      transferState.chainId,
      TransactionReason.defundTransfer,
      () => {
        const channel = new Contract(transferState.channelAddress, VectorChannel.abi, signer);
        return channel.defundTransfer(transferState, encodedState, encodedResolver, responderSignature);
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendDeployChannelTx(
    channelState: FullChannelState,
    gasPrice: BigNumber,
    deposit?: { amount: string; assetId: string }, // Included IFF createChannelAndDepositAlice
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const method = "sendDeployChannelTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    // check if multisig must be deployed
    const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);

    if (multisigRes.isError) {
      return Result.fail(multisigRes.getError()!);
    }

    if (multisigRes.getValue() !== `0x`) {
      return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
    }

    const channelFactory = new Contract(channelState.networkContext.channelFactoryAddress, ChannelFactory.abi, signer);

    // If there is no deposit information, just create the channel
    if (!deposit) {
      // Deploy multisig tx
      this.log.info(
        { channelAddress: channelState.channelAddress, sender, method, methodId },
        "Deploying channel without deposit",
      );
      const result = await this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.deploy,
        async () => {
          const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
          if (multisigRes.isError) {
            return Result.fail(multisigRes.getError()!);
          }
          if (multisigRes.getValue() !== `0x`) {
            return undefined;
          }
          return channelFactory.createChannel(channelState.alice, channelState.bob, {
            gasPrice,
            gasLimit: BIG_GAS_LIMIT,
          });
        },
      );
      if (result.isError) {
        return result as Result<any, ChainError>;
      }
      if (!result.getValue()) {
        return Result.fail(new ChainError(ChainError.reasons.MultisigDeployed));
      }
      return result as Result<TransactionResponseWithResult>;
    }

    // Deploy a channel with a deposit (only alice can do this)
    if (sender !== channelState.alice) {
      return Result.fail(
        new ChainError(ChainError.reasons.FailedToDeploy, {
          message: "Sender is not alice",
          sender,
          alice: channelState.alice,
          channel: channelState.channelAddress,
        }),
      );
    }

    const { assetId, amount } = deposit;

    const balanceRes = await this.getOnchainBalance(assetId, channelState.alice, channelState.networkContext.chainId);
    if (balanceRes.isError) {
      return Result.fail(balanceRes.getError()!);
    }
    const balance = balanceRes.getValue();
    if (balance.lt(amount)) {
      return Result.fail(
        new ChainError(ChainError.reasons.NotEnoughFunds, {
          balance: balance.toString(),
          amount,
          assetId,
          chainId: channelState.networkContext.chainId,
        }),
      );
    }
    this.log.info(
      { balance: balance.toString(), method, methodId, assetId, chainId: channelState.networkContext.chainId },
      "Onchain balance sufficient",
    );

    // Handle eth deposits
    if (assetId === AddressZero) {
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.deployWithDepositAlice,
        async () => {
          const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
          if (multisigRes.isError) {
            return Result.fail(multisigRes.getError()!);
          }
          if (multisigRes.getValue() !== `0x`) {
            // multisig deployed, just send deposit
            return this.sendDepositATx(channelState, amount, AddressZero, gasPrice);
          }
          // otherwise deploy with deposit
          const data = new Interface(ChannelFactory.abi).encodeFunctionData("createChannelAndDepositAlice", [
            channelState.alice,
            channelState.bob,
            assetId,
            amount,
          ]);
          return channelFactory.createChannelAndDepositAlice(channelState.alice, channelState.bob, assetId, amount, {
            value: amount,
            gasPrice,
            gasLimit: BIG_GAS_LIMIT,
          });
        },
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    }

    // Must be token deposit, first approve the token transfer
    this.log.info({ assetId, amount, channel: channelState.channelAddress, sender }, "Approving tokens");
    const approveRes = await this.approveTokens(
      channelState.channelAddress,
      channelState.networkContext.channelFactoryAddress,
      sender,
      amount,
      assetId,
      channelState.networkContext.chainId,
      gasPrice,
    );
    if (approveRes.isError) {
      return Result.fail(approveRes.getError()!);
    }
    if (approveRes.getValue()) {
      const receipt = await approveRes.getValue()!.wait(getConfirmationsForChain(channelState.networkContext.chainId));
      if (receipt.status === 0) {
        return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
      }
      this.log.info({ txHash: receipt.transactionHash, method, assetId }, "Token approval confirmed");
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.deployWithDepositAlice,
      async () => {
        const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);
        if (multisigRes.isError) {
          return Result.fail(multisigRes.getError()!);
        }
        if (multisigRes.getValue() !== `0x`) {
          // multisig deployed, just send deposit (will check allowance)
          return this.sendDepositATx(channelState, amount, assetId, gasPrice);
        }
        return channelFactory.createChannelAndDepositAlice(channelState.alice, channelState.bob, assetId, amount, {
          gasPrice,
          gasLimit: BIG_GAS_LIMIT,
        });
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendWithdrawTx(
    channelState: FullChannelState,
    minTx: MinimalTransaction,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const method = "sendWithdrawTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    if (channelState.alice !== sender && channelState.bob !== sender) {
      return Result.fail(new ChainError(ChainError.reasons.SenderNotInChannel));
    }

    // check if multisig must be deployed
    const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);

    if (multisigRes.isError) {
      return Result.fail(multisigRes.getError()!);
    }

    const gasPriceRes = await this.getGasPrice(channelState.networkContext.chainId);
    if (gasPriceRes.isError) {
      Result.fail(gasPriceRes.getError()!);
    }
    const gasPrice = gasPriceRes.getValue();
    this.log.info(
      {
        channelAddress: channelState.channelAddress,
        sender,
        method,
        methodId,
        gasPrice: gasPrice.toString(),
        chainId: channelState.networkContext.chainId,
      },
      "Got gas price",
    );

    if (multisigRes.getValue() === `0x`) {
      // Deploy multisig tx
      this.log.info({ channelAddress: channelState.channelAddress, sender, method, methodId }, "Deploying channel");
      const txRes = await this.sendDeployChannelTx(channelState, gasPrice);
      if (txRes.isError && txRes.getError()?.message !== ChainError.reasons.MultisigDeployed) {
        return Result.fail(
          new ChainError(ChainError.reasons.FailedToDeploy, {
            method,
            error: txRes.getError()!.message,
            channel: channelState.channelAddress,
          }),
        );
      }
      const deployTx = txRes.isError ? undefined : txRes.getValue();
      if (deployTx) {
        this.log.info({ method, methodId, deployTx: deployTx.hash }, "Deploy tx broadcast");
        try {
          this.log.debug(
            {
              method,
              methodId,
            },
            "Waiting for event to be emitted",
          );
          const receipt = await deployTx.wait(getConfirmationsForChain(channelState.networkContext.chainId));
          if (receipt.status === 0) {
            return Result.fail(
              new ChainError(ChainError.reasons.TxReverted, {
                receipt,
                deployTx: deployTx.hash,
                channel: channelState.channelAddress,
                chainId: channelState.networkContext.chainId,
              }),
            );
          }
        } catch (e) {
          this.log.error({ method, methodId, error: jsonifyError(e) }, "Caught error waiting for tx");
          return Result.fail(
            new ChainError(ChainError.reasons.FailedToDeploy, {
              error: e.message,
              deployTx: deployTx.hash,
              channel: channelState.channelAddress,
              chainId: channelState.networkContext.chainId,
            }),
          );
        }
        this.log.debug({ method, methodId }, "Deploy tx mined");
      } else {
        this.log.info({ method, methodId }, "Multisig already deployed");
      }
    }

    this.log.info({ sender, method, methodId, channel: channelState.channelAddress }, "Sending withdraw tx to chain");
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.withdraw,
      async () => {
        return signer.sendTransaction({ ...minTx, gasPrice, gasLimit: BIG_GAS_LIMIT, from: sender });
      },
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  public async sendDepositTx(
    channelState: FullChannelState,
    sender: string,
    amount: string,
    assetId: string,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const method = "sendDepositTx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    if (channelState.alice !== sender && channelState.bob !== sender) {
      return Result.fail(new ChainError(ChainError.reasons.SenderNotInChannel));
    }

    const toDeposit = BigNumber.from(amount);
    if (toDeposit.isNegative()) {
      return Result.fail(new ChainError(ChainError.reasons.NegativeDepositAmount));
    }

    // first check if multisig is needed to deploy
    const multisigRes = await this.getCode(channelState.channelAddress, channelState.networkContext.chainId);

    if (multisigRes.isError) {
      return Result.fail(multisigRes.getError()!);
    }

    this.log.info(
      {
        method,
        methodId,
        chainId: channelState.networkContext.chainId,
      },
      "Getting gas price",
    );

    const gasPriceRes = await this.getGasPrice(channelState.networkContext.chainId);
    if (gasPriceRes.isError) {
      Result.fail(gasPriceRes.getError()!);
    }
    const gasPrice = gasPriceRes.getValue();
    this.log.info(
      {
        channelAddress: channelState.channelAddress,
        sender,
        method,
        methodId,
        gasPrice: gasPrice.toString(),
        chainId: channelState.networkContext.chainId,
      },
      "Got gas price",
    );

    const multisigCode = multisigRes.getValue();
    // alice needs to deploy the multisig
    if (multisigCode === `0x` && sender === channelState.alice) {
      this.log.info(
        {
          method,
          methodId,
          channelAddress: channelState.channelAddress,
          assetId,
          amount,
          senderAddress: await signer.getAddress(),
        },
        `Deploying channel with deposit`,
      );
      return this.sendDeployChannelTx(channelState, gasPrice, { amount, assetId });
    }

    const balanceRes = await this.getOnchainBalance(assetId, sender, channelState.networkContext.chainId);
    if (balanceRes.isError) {
      return Result.fail(balanceRes.getError()!);
    }
    const balance = balanceRes.getValue();
    if (balance.lt(amount)) {
      return Result.fail(
        new ChainError(ChainError.reasons.NotEnoughFunds, {
          balance: balance.toString(),
          amount,
          assetId,
          chainId: channelState.networkContext.chainId,
        }),
      );
    }
    this.log.info(
      { balance: balance.toString(), method, methodId, assetId, chainId: channelState.networkContext.chainId },
      "Onchain balance sufficient",
    );

    this.log.info({ method, methodId, assetId, amount }, "Channel is deployed, sending deposit");
    if (sender === channelState.alice) {
      this.log.info(
        { method, sender, alice: channelState.alice, bob: channelState.bob },
        "Detected participant A, sending tx",
      );
      const txRes = await this.sendDepositATx(channelState, amount, assetId, gasPrice);
      if (txRes.isError) {
        this.log.error({ method, error: txRes.getError()?.message }, "Error sending tx");
      } else {
        this.log.info({ method, txHash: txRes.getValue().hash }, "Submitted tx");
      }
      return txRes;
    } else {
      this.log.info(
        { method, sender, alice: channelState.alice, bob: channelState.bob },
        "Detected participant B, sendng tx",
      );
      const txRes = await this.sendDepositBTx(channelState, amount, assetId, gasPrice);
      if (txRes.isError) {
        this.log.error({ method, error: txRes.getError()?.message }, "Error sending tx");
      } else {
        this.log.info({ method, txHash: txRes.getValue().hash }, "Submitted tx");
      }
      return txRes;
    }
  }

  ////////////////////////////
  /// CHAIN SERVICE EVENTS
  public on<T extends TransactionEvent>(
    event: T,
    callback: (payload: TransactionEventMap[T]) => void | Promise<void>,
    filter: (payload: TransactionEventMap[T]) => boolean = () => true,
  ): void {
    (this.evts[event].pipe(filter) as Evt<TransactionEventMap[T]>).attach(callback);
  }

  public once<T extends TransactionEvent>(
    event: T,
    callback: (payload: TransactionEventMap[T]) => void | Promise<void>,
    filter: (payload: TransactionEventMap[T]) => boolean = () => true,
  ): void {
    (this.evts[event].pipe(filter) as Evt<TransactionEventMap[T]>).attachOnce(callback);
  }

  public off<T extends TransactionEvent>(event?: T): void {
    if (event) {
      this.evts[event].detach();
      return;
    }
    Object.values(this.evts).forEach((evt) => evt.detach());
  }

  public waitFor<T extends TransactionEvent>(
    event: T,
    timeout: number,
    filter: (payload: TransactionEventMap[T]) => boolean = () => true,
  ): Promise<TransactionEventMap[T]> {
    return this.evts[event].pipe(filter).waitFor(timeout) as Promise<TransactionEventMap[T]>;
  }

  ////////////////////////////
  /// PRIVATE METHODS
  private async sendTxWithRetries(
    channelAddress: string,
    chainId: number,
    reason: TransactionReason,
    // should return undefined IFF tx didnt send based on validation in
    // fn
    txFn: () => Promise<undefined | TransactionResponse>,
  ): Promise<Result<TransactionResponseWithResult | undefined, ChainError>> {
    const method = "sendTxWithRetries";
    const methodId = getRandomBytes32();
    const errors = [];
    for (let attempt = 1; attempt++; attempt < this.defaultRetries) {
      this.log.info(
        {
          method,
          methodId,
          retries: this.defaultRetries,
          attempt,
          channelAddress,
          reason,
        },
        "Attempting to send tx",
      );
      const response = await this.sendTxAndParseResponse(channelAddress, chainId, reason, txFn);
      if (!response.isError) {
        return response;
      }
      // Otherwise, handle error
      const error = response.getError()!;
      if (!error.canRetry) {
        this.log.error(
          { error: error.message, channelAddress, reason, stack: error.stack, method, methodId },
          "Failed to send tx, will not retry",
        );
        return response;
      }
      // wait before retrying
      errors.push(error);
      this.log.warn(
        { error: error.message, channelAddress, attempt, retries: this.defaultRetries, method, methodId },
        "Tx failed, waiting before retry",
      );
      await delay(1000);
    }
    return Result.fail(
      new ChainError(ChainError.reasons.FailedToSendTx, {
        errors: errors.map((e) => e.message).toString(),
        retries: this.defaultRetries,
        channelAddress,
        reason,
      }),
    );
  }

  private async sendTxAndParseResponse(
    channelAddress: string,
    chainId: number,
    reason: TransactionReason,
    txFn: () => Promise<undefined | TransactionResponse>,
  ): Promise<Result<TransactionResponseWithResult | undefined, ChainError>> {
    // TODO: add retries on specific errors #347
    try {
      const response = await this.queue.add(async () => {
        const response = await txFn();

        if (!response) {
          this.log.warn({ channelAddress, reason }, "Did not attempt tx");
          return response;
        }

        // save to store
        await this.store.saveTransactionResponse(channelAddress, reason, response);
        this.evts[EngineEvents.TRANSACTION_SUBMITTED].post({
          response: Object.fromEntries(
            Object.entries(response).map(([key, value]) => {
              return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
            }),
          ) as StringifiedTransactionResponse,
          channelAddress,
          reason,
        });

        // Register callbacks for saving tx, then return
        response
          .wait(getConfirmationsForChain(chainId))
          .then(async (receipt) => {
            if (receipt.status === 0) {
              this.log.error({ method: "sendTxAndParseResponse", receipt }, "Transaction reverted");
              await this.store.saveTransactionFailure(channelAddress, response.hash, "Tx reverted");
              this.evts[EngineEvents.TRANSACTION_FAILED].post({
                receipt: Object.fromEntries(
                  Object.entries(receipt).map(([key, value]) => {
                    return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
                  }),
                ) as StringifiedTransactionReceipt,
                channelAddress,
                reason,
              });
            } else {
              await this.store.saveTransactionReceipt(channelAddress, receipt);
              this.evts[EngineEvents.TRANSACTION_MINED].post({
                receipt: Object.fromEntries(
                  Object.entries(receipt).map(([key, value]) => {
                    return [key, BigNumber.isBigNumber(value) ? value.toString() : value];
                  }),
                ) as StringifiedTransactionReceipt,
                channelAddress,
                reason,
              });
            }
          })
          .catch(async (e) => {
            this.log.error({ method: "sendTxAndParseResponse", error: jsonifyError(e) }, "Transaction reverted");
            await this.store.saveTransactionFailure(channelAddress, response.hash, e.message);
            this.evts[EngineEvents.TRANSACTION_FAILED].post({
              error: e,
              channelAddress,
              reason,
            });
          });
        return response;
      });

      if (!response) {
        return Result.ok(response);
      }

      // add completed function
      return Result.ok({
        ...response,
        completed: async (confirmations?: number) => {
          try {
            const receipt = await response.wait(confirmations);
            if (receipt.status === 0) {
              return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
            }
            return Result.ok(receipt);
          } catch (e) {
            return Result.fail(new ChainError(e.message, { stack: e.stack, channelAddress, reason }));
          }
        },
      });
    } catch (e) {
      // Don't save tx if it failed to submit, only if it fails to mine
      let error = e;
      if (e.message.includes("sender doesn't have enough funds")) {
        error = new ChainError(ChainError.reasons.NotEnoughFunds);
      }
      return Result.fail(error);
    }
  }

  private async approveTokens(
    channelAddress: string,
    spender: string,
    owner: string,
    depositAmount: string,
    assetId: string,
    chainId: number,
    gasPrice: BigNumber,
    approvalAmount: string = UINT_MAX,
  ): Promise<Result<TransactionResponseWithResult | undefined, ChainError>> {
    const method = "approveTokens";
    this.log.debug(
      {
        method,
        channelAddress,
        spender,
        owner,
        approvalAmount,
        depositAmount,
        assetId,
        chainId,
        gasPrice: gasPrice.toString(),
      },
      "Method started",
    );
    const signer = this.signers.get(chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    this.log.info({ method, assetId, spender, owner, channelAddress }, "Checking allowance");
    const erc20 = new Contract(assetId, ERC20Abi, signer);
    const allowanceRes = await this.getTokenAllowance(assetId, owner, spender, chainId);
    if (allowanceRes.isError) {
      this.log.error(
        {
          method,
          spender,
          owner,
          assetId,
          error: allowanceRes.getError()?.message,
        },
        "Error checking approved tokens for deposit A",
      );
      return Result.fail(allowanceRes.getError()!);
    }
    const allowance = allowanceRes.getValue();
    this.log.info(
      { method, assetId, spender, owner, channelAddress, allowance: allowance.toString(), depositAmount },
      "Retrieved allowance",
    );

    if (BigNumber.from(allowanceRes.getValue()).gte(depositAmount)) {
      this.log.info(
        {
          method,
          assetId,
          channelAddress,
        },
        "Allowance is sufficient",
      );
      return Result.ok(undefined);
    }
    this.log.info(
      {
        method,
        assetId,
        channelAddress,
        spender,
        owner,
        approvalAmount,
      },
      "Approving tokens",
    );
    const approveRes = await this.sendTxWithRetries(channelAddress, chainId, TransactionReason.approveTokens, () =>
      erc20.approve(spender, approvalAmount, { gasPrice }),
    );
    if (approveRes.isError) {
      this.log.error(
        {
          method,
          spender,
          owner,
          assetId,
          approvalAmount,
          allowance: allowance.toString(),
          error: approveRes.getError()?.message,
        },
        "Error approving tokens for deposit A",
      );
      return approveRes;
    }
    const approveTx = approveRes.getValue();
    this.log.info({ txHash: approveTx!.hash, method, assetId, approvalAmount }, "Approve token tx submitted");
    return approveRes;
  }

  private async sendDepositATx(
    channelState: FullChannelState,
    amount: string,
    assetId: string,
    gasPrice: BigNumber,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const method = "sendDepositATx";
    const methodId = getRandomBytes32();
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }

    const vectorChannel = new Contract(channelState.channelAddress, VectorChannel.abi, signer);
    if (assetId !== AddressZero) {
      // need to approve
      this.log.info({ method, methodId, assetId, channelAddress: channelState.channelAddress }, "Approving token");
      const approveRes = await this.approveTokens(
        channelState.channelAddress,
        channelState.channelAddress,
        channelState.alice,
        amount,
        assetId,
        channelState.networkContext.chainId,
        gasPrice,
      );
      if (approveRes.isError) {
        this.log.error(
          {
            method,
            methodId,
            channelAddress: channelState.channelAddress,
            error: approveRes.getError()?.message,
          },
          "Error approving tokens for deposit A",
        );
        return Result.fail(approveRes.getError()!);
      }
      const approveTx = approveRes.getValue();
      if (approveTx) {
        const receipt = await approveTx.wait();
        if (receipt.status === 0) {
          return Result.fail(new ChainError(ChainError.reasons.TxReverted, { receipt }));
        }
      }
      this.log.info({ txHash: approveTx?.hash, method, methodId, assetId }, "Token approval confirmed");
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositA,
        () => vectorChannel.depositAlice(assetId, amount, { gasPrice }),
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    }
    return this.sendTxWithRetries(
      channelState.channelAddress,
      channelState.networkContext.chainId,
      TransactionReason.depositA,
      () => vectorChannel.depositAlice(assetId, amount, { value: amount, gasPrice }),
    ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
  }

  private async sendDepositBTx(
    channelState: FullChannelState,
    amount: string,
    assetId: string,
    gasPrice: BigNumber,
  ): Promise<Result<TransactionResponseWithResult, ChainError>> {
    const signer = this.signers.get(channelState.networkContext.chainId);
    if (!signer?._isSigner) {
      return Result.fail(new ChainError(ChainError.reasons.SignerNotFound));
    }
    const sender = await signer.getAddress();

    if (assetId === AddressZero) {
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositB,
        () =>
          signer.sendTransaction({
            data: "0x",
            to: channelState.channelAddress,
            value: BigNumber.from(amount),
            chainId: channelState.networkContext.chainId,
            gasPrice,
            from: sender,
          }),
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    } else {
      const erc20 = new Contract(channelState.networkContext.channelFactoryAddress, ERC20Abi, signer);
      return this.sendTxWithRetries(
        channelState.channelAddress,
        channelState.networkContext.chainId,
        TransactionReason.depositB,
        () => erc20.transfer(channelState.channelAddress, amount, { gasPrice }),
      ) as Promise<Result<TransactionResponseWithResult, ChainError>>;
    }
  }
}

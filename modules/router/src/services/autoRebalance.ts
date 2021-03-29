import { VectorChainReader } from "@connext/vector-contracts";
import {
  AllowedSwap,
  HydratedProviders,
  jsonifyError,
  Result,
  TAddress,
  TBytes32,
  TIntegerString,
  MinimalTransaction,
  CheckStatusParams,
  getConfirmationsForChain,
} from "@connext/vector-types";
import { getRandomBytes32 } from "@connext/vector-utils";
import { BigNumber } from "@ethersproject/bignumber";
import { parseUnits } from "@ethersproject/units";
import { Wallet } from "@ethersproject/wallet";
import { Type, Static } from "@sinclair/typebox";
import axios from "axios";
import { BaseLogger } from "pino";

import { getConfig } from "../config";
import { AutoRebalanceServiceError } from "../errors";
import { parseBalanceToNumber, rebalancedTokens } from "../metrics";
import { IRouterStore, RouterRebalanceStatus } from "./store";

const config = getConfig();

const DEFAULT_REBALANCE_THRESHOLD = 20;
const MIN_INTERVAL = 1_800_000;

// copied from chain-rebalancer-fastify
export const RebalanceParamsSchema = Type.Object({
  amount: TIntegerString,
  assetId: TAddress,
  signer: TAddress,
  txHash: Type.Optional(TBytes32),
  fromProvider: Type.String({ format: "uri" }),
  toProvider: Type.String({ format: "uri" }),
  fromChainId: Type.Number(),
  toChainId: Type.Number(),
});
export type RebalanceParams = Static<typeof RebalanceParamsSchema>;

export const startAutoRebalanceTask = (
  interval: number,
  logger: BaseLogger,
  wallet: Wallet,
  chainService: VectorChainReader,
  hydratedProviders: HydratedProviders,
  store: IRouterStore,
): void => {
  if (interval < MIN_INTERVAL) {
    throw new Error(`Interval ${interval} must be at least ${MIN_INTERVAL}`);
  }
  setInterval(() => {
    autoRebalanceTask(logger, wallet, chainService, hydratedProviders, store);
  }, interval);
};

export const autoRebalanceTask = async (
  logger: BaseLogger,
  wallet: Wallet,
  chainService: VectorChainReader,
  hydratedProviders: HydratedProviders,
  store: IRouterStore,
): Promise<void> => {
  const method = "autoRebalanceTask";
  const methodId = getRandomBytes32();
  logger.info({ method, methodId, allowedSwaps: config.allowedSwaps }, "Start task");
  for (const swap of config.allowedSwaps) {
    const rebalanced = await rebalanceIfNeeded(swap, logger, wallet, chainService, hydratedProviders, store);
    if (rebalanced.isError) {
      logger.error({ swap, error: jsonifyError(rebalanced.getError()!) }, "Error auto rebalancing");
      return;
    }
    logger.info({ res: rebalanced.getValue() }, "Rebalance completed");
  }
};

export const rebalanceIfNeeded = async (
  swap: AllowedSwap,
  logger: BaseLogger,
  wallet: Wallet,
  chainService: VectorChainReader,
  hydratedProviders: HydratedProviders,
  store: IRouterStore,
): Promise<Result<undefined, AutoRebalanceServiceError>> => {
  const method = "rebalanceIfNeeded";
  const methodId = getRandomBytes32();
  if (!swap.rebalancerUrl) {
    logger.debug({ method, intervalId: methodId, swap }, "No rebalancer configured for swap, doing nothing");
    return Result.ok(undefined);
  }
  logger.info({ method, intervalId: methodId, swap }, "Checking if rebalance is needed");
  const rebalanceThreshold = swap.rebalanceThresholdPct ? swap.rebalanceThresholdPct : DEFAULT_REBALANCE_THRESHOLD;

  const fromAssetBalance = await chainService.getOnchainBalance(swap.fromAssetId, wallet.address, swap.fromChainId);
  if (fromAssetBalance.isError) {
    return Result.fail(
      new AutoRebalanceServiceError(
        AutoRebalanceServiceError.reasons.CouldNotGetAssetBalance,
        swap.fromChainId,
        swap.fromAssetId,
        { getOnchainBalanceError: jsonifyError(fromAssetBalance.getError()!), methodId, method },
      ),
    );
  }
  const fromAssetBalanceNumber = await parseBalanceToNumber(
    fromAssetBalance.getValue(),
    swap.fromChainId.toString(),
    swap.fromAssetId,
  );

  const toAssetBalance = await chainService.getOnchainBalance(swap.toAssetId, wallet.address, swap.toChainId);
  if (toAssetBalance.isError) {
    return Result.fail(
      new AutoRebalanceServiceError(
        AutoRebalanceServiceError.reasons.CouldNotGetAssetBalance,
        swap.toChainId,
        swap.toAssetId,
        { getOnchainBalanceError: jsonifyError(toAssetBalance.getError()!), methodId, method },
      ),
    );
  }
  const toAssetBalanceNumber = await parseBalanceToNumber(
    toAssetBalance.getValue(),
    swap.toChainId.toString(),
    swap.toAssetId,
  );

  // should be within 1/2 of total balance + threshold
  const totalBalance = fromAssetBalanceNumber + toAssetBalanceNumber;
  const midpoint = totalBalance / 2;
  const threshold = midpoint * (1 + rebalanceThreshold / 100);

  logger.info(
    {
      method,
      intervalId: methodId,
      fromAssetBalanceNumber,
      toAssetBalanceNumber,
      rebalanceThreshold,
      totalBalance,
      threshold,
      midpoint,
    },
    "Calculated numbers",
  );

  if (fromAssetBalanceNumber <= threshold) {
    logger.info(
      {
        method,
        intervalId: methodId,
        swap,
      },
      "No rebalance required",
    );
    return Result.ok(undefined);
  }

  const amountToSendNumber = fromAssetBalanceNumber - midpoint;
  const amountToSend = parseUnits(
    amountToSendNumber.toString(),
    rebalancedTokens[swap.fromChainId][swap.fromAssetId].decimals!,
  );
  logger.info(
    {
      method,
      intervalId: methodId,
      amountToSendNumber,
      amountToSend,
    },
    "Rebalance required",
  );

  // on each rebalance interval, check rebalance thresholds for allowedSwaps
  // if out of threshold, check if active rebalance for that swap exists
  // if it does not, create one and go through the approve/execute flow
  // if it does exist, check status. if status == {completed: true} and if there is a tx in the response (is the case with matic withdraw), send the tx, and mark as completed. if no tx in the response, mark as completed immediately
  // if it is not completed, wait for next poll

  // check if an active rebalance is in progress
  let latest = await store.getLatestRebalance(swap);
  if (!latest) {
    // set dummy value
    latest = {
      status: RouterRebalanceStatus.COMPLETE,
      swap,
      approveHash: undefined,
      executeHash: undefined,
      id: getRandomBytes32(), // dummy value, set by db
    };
  }

  if (latest.status === RouterRebalanceStatus.COMPLETE) {
    // approve rebalance
    const approveHash = await approveRebalance(amountToSend, swap, hydratedProviders, wallet, logger, methodId);
    if (approveHash.isError) {
      return Result.fail(approveHash.getError()!);
    }
    // save status
    latest = {
      ...latest,
      status: RouterRebalanceStatus.APPROVED,
      approveHash: approveHash.getValue(),
    };
    await store.saveRebalance(latest);
  }

  if (latest.status === RouterRebalanceStatus.APPROVED) {
    const executeHash = await executeRebalance(amountToSend, swap, hydratedProviders, wallet, logger, methodId);
    if (executeHash.isError) {
      return Result.fail(executeHash.getError()!);
    }
    // save status
    latest = {
      ...latest,
      status: RouterRebalanceStatus.EXECUTED,
      executeHash: executeHash.getValue(),
    };
    await store.saveRebalance(latest);
  }

  if (latest.status === RouterRebalanceStatus.EXECUTED) {
    if (!latest.executeHash) {
      return Result.fail(
        new AutoRebalanceServiceError(
          AutoRebalanceServiceError.reasons.ExecutedWithoutHash,
          swap.fromChainId,
          swap.fromAssetId,
          { method, methodId, latest },
        ),
      );
    }
    const completedHash = await completeRebalance(
      amountToSend,
      latest.executeHash,
      swap,
      hydratedProviders,
      wallet,
      logger,
      methodId,
    );
    if (completedHash.isError) {
      return Result.fail(completedHash.getError()!);
    }
    if (!completedHash.getValue().complete) {
      return Result.ok(undefined);
    }
    // save status
    latest = {
      ...latest,
      status: RouterRebalanceStatus.COMPLETE,
      completeHash: completedHash.getValue().transactionHash,
    };
    await store.saveRebalance(latest);
  }
  return Result.ok(undefined);
};

// TODO: add rebalance txs to metrics/db
export const approveRebalance = async (
  amount: BigNumber,
  swap: AllowedSwap,
  hydratedProviders: HydratedProviders,
  wallet: Wallet,
  logger: BaseLogger,
  methodId: string = getRandomBytes32(),
): Promise<Result<string | undefined, AutoRebalanceServiceError>> => {
  const method = "approveRebalance";
  logger.debug({ method, methodId, swap, amount: amount.toString() }, "Method started");

  try {
    const approveRes = await axios.post(`${swap.rebalancerUrl}/approval`, {
      amount: amount.toString(),
      assetId: swap.fromAssetId,
      fromProvider: config.chainProviders[swap.fromChainId],
      fromChainId: swap.fromChainId,
      toProvider: config.chainProviders[swap.toChainId],
      toChainId: swap.toChainId,
      signer: wallet.address,
    } as RebalanceParams);
    logger.info(
      {
        method,
        methodId,
        approveRes: approveRes.data,
        status: approveRes.data.status,
      },
      "Approval request complete",
    );
    if (!approveRes.data.transaction) {
      logger.info(
        {
          method,
          methodId,
          allowance: approveRes.data.allowance,
          status: approveRes.data.status,
        },
        "Approval not needed",
      );
      return Result.ok(undefined);
    }
    logger.info(
      {
        method,
        methodId,
        transaction: approveRes.data.transaction,
      },
      "Approval required",
    );
    const transactionHash = await sendTransaction(
      swap.fromChainId,
      approveRes.data.transaction,
      wallet,
      hydratedProviders,
      logger,
      method,
      methodId,
    );
    return Result.ok(transactionHash);
  } catch (e) {
    return Result.fail(
      new AutoRebalanceServiceError(
        AutoRebalanceServiceError.reasons.CouldNotCompleteApproval,
        swap.fromChainId,
        swap.fromAssetId,
        { methodId, method, error: jsonifyError(e) },
      ),
    );
  }
};

// TODO: add rebalance txs to metrics/db
export const executeRebalance = async (
  amount: BigNumber,
  swap: AllowedSwap,
  hydratedProviders: HydratedProviders,
  wallet: Wallet,
  logger: BaseLogger,
  methodId: string = getRandomBytes32(),
): Promise<Result<string, AutoRebalanceServiceError>> => {
  // execute rebalance
  const method = "executeRebalance";
  logger.debug({ method, methodId, swap, amount: amount.toString() }, "Method started");
  try {
    const rebalanceRes = await axios.post(`${swap.rebalancerUrl}/execute`, {
      amount: amount.toString(),
      assetId: swap.fromAssetId,
      fromProvider: config.chainProviders[swap.fromChainId],
      fromChainId: swap.fromChainId,
      toProvider: config.chainProviders[swap.toChainId],
      toChainId: swap.toChainId,
      signer: wallet.address,
    } as RebalanceParams);
    logger.info(
      {
        method,
        intervalId: methodId,
        rebalanceRes: rebalanceRes.data,
        status: rebalanceRes.status,
      },
      "Rebalance request sent",
    );
    if (!rebalanceRes.data.transaction) {
      return Result.fail(
        new AutoRebalanceServiceError(
          AutoRebalanceServiceError.reasons.CouldNotCompleteRebalance,
          swap.fromChainId,
          swap.fromAssetId,
          { methodId, method, error: "No transaction data available", data: rebalanceRes.data },
        ),
      );
    }

    const transactionHash = await sendTransaction(
      swap.fromChainId,
      rebalanceRes.data.transaction,
      wallet,
      hydratedProviders,
      logger,
      method,
      methodId,
    );
    return Result.ok(transactionHash);
  } catch (e) {
    return Result.fail(
      new AutoRebalanceServiceError(
        AutoRebalanceServiceError.reasons.CouldNotExecuteRebalance,
        swap.fromChainId,
        swap.fromAssetId,
        { methodId, method, error: jsonifyError(e) },
      ),
    );
  }
};

// TODO: add rebalance txs to metrics/db
// NOTE: only l2 --> l1 withdrawals have a completion tx
export const completeRebalance = async (
  amount: BigNumber,
  executedHash: string,
  swap: AllowedSwap,
  hydratedProviders: HydratedProviders,
  wallet: Wallet,
  logger: BaseLogger,
  methodId: string = getRandomBytes32(),
): Promise<Result<{ transactionHash?: string; complete: boolean }, AutoRebalanceServiceError>> => {
  // complete/check rebalance status
  const method = "completeRebalance";
  logger.debug({ method, methodId, swap, amount: amount.toString() }, "Method started");
  try {
    // check status
    const statusRes = await axios.post(`${swap.rebalancerUrl}/status`, {
      txHash: executedHash,
      fromProvider: config.chainProviders[swap.fromChainId],
      fromChainId: swap.fromChainId,
      toProvider: config.chainProviders[swap.toChainId],
      toChainId: swap.toChainId,
      signer: wallet.address,
    } as CheckStatusParams);
    logger.info(
      {
        method,
        intervalId: methodId,
        rebalanceRes: statusRes.data,
      },
      "Status request sent",
    );
    const {
      status: { completed },
      transaction,
    } = statusRes.data;
    if (!completed) {
      return Result.ok({ complete: false });
    }
    // is completed, check if tx is needed
    if (!transaction) {
      return Result.ok({ complete: false });
    }
    // need to send tx to complete rebalance
    const transactionHash = await sendTransaction(
      swap.fromChainId,
      transaction,
      wallet,
      hydratedProviders,
      logger,
      method,
      methodId,
    );
    return Result.ok({ transactionHash, complete: true });
  } catch (e) {
    return Result.fail(
      new AutoRebalanceServiceError(
        AutoRebalanceServiceError.reasons.CouldNotCompleteRebalance,
        swap.fromChainId,
        swap.fromAssetId,
        { methodId, method, error: jsonifyError(e) },
      ),
    );
  }
};

const sendTransaction = async (
  chainId: number,
  transaction: MinimalTransaction,
  wallet: Wallet,
  providers: HydratedProviders,
  logger: BaseLogger,
  method: string = "sendTransaction",
  methodId: string = getRandomBytes32(),
): Promise<string> => {
  const fromProvider = providers[chainId];
  if (!fromProvider) {
    throw new Error(`No provider for chain ${chainId}, cannot send tx`);
  }
  logger.info(
    {
      method,
      methodId,
    },
    "Sending tx",
  );
  const response = await wallet
    .connect(fromProvider)
    .sendTransaction({ to: transaction.to, value: transaction.value, data: transaction.data });
  logger.info(
    {
      method,
      intervalId: methodId,
      hash: response.hash,
    },
    "Tx sent",
  );
  const receipt = await response.wait(getConfirmationsForChain(chainId));
  logger.info(
    {
      method,
      intervalId: methodId,
      hash: response.hash,
    },
    "Tx mined",
  );
  return receipt.transactionHash;
};

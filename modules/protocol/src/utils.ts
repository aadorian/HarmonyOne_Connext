import {
  Balance,
  ChannelUpdate,
  CoreChannelState,
  CreateTransferParams,
  CreateUpdateDetails,
  DepositParams,
  FullChannelState,
  FullTransferState,
  IChannelSigner,
  IVectorChainReader,
  IVectorStore,
  ResolveTransferParams,
  ResolveUpdateDetails,
  Result,
  SetupParams,
  SetupUpdateDetails,
  UpdateParams,
  UpdateParamsMap,
  UpdateType,
  ChainError,
} from "@connext/vector-types";
import { getAddress } from "@ethersproject/address";
import { BigNumber } from "@ethersproject/bignumber";
import { hashChannelCommitment, validateChannelUpdateSignatures } from "@connext/vector-utils";
import Ajv from "ajv";
import { BaseLogger, Level } from "pino";

const ajv = new Ajv();

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export const validateSchema = (obj: any, schema: any): undefined | string => {
  const validate = ajv.compile(schema);
  const valid = validate(obj);
  if (!valid) {
    return validate.errors?.map((e) => e.message).join();
  }
  return undefined;
};

// NOTE: If you do *NOT* use this function within the protocol, it becomes
// very difficult to write proper unit tests. When the same utility is imported
// as:
// `import { validateChannelUpdateSignatures } from "@connext/vector-utils"`
// it does not properly register as a mock.
// Is this a silly function? yes. Are tests silly? no.
// Another note: if you move this into the `validate` file, you will have
// problems properly mocking the fn in the validation unit tests. This likely
// has to do with destructuring, but it is unclear.
export async function validateChannelSignatures(
  state: FullChannelState,
  aliceSignature: string | undefined,
  bobSignature: string | undefined,
  requiredSigners: "alice" | "bob" | "both",
  logger?: BaseLogger,
): Promise<Result<void, Error>> {
  return validateChannelUpdateSignatures(state, aliceSignature, bobSignature, requiredSigners, logger);
}

export const extractContextFromStore = async (
  storeService: IVectorStore,
  channelAddress: string,
): Promise<
  Result<
    {
      activeTransfers: FullTransferState[];
      channelState: FullChannelState | undefined;
    },
    Error
  >
> => {
  // First, pull all information out from the store
  let activeTransfers: FullTransferState[];
  let channelState: FullChannelState | undefined;
  let storeMethod = "getChannelState";
  try {
    // will always need the previous state
    channelState = await storeService.getChannelState(channelAddress);
    // will only need active transfers for create/resolve
    storeMethod = "getActiveTransfers";
    activeTransfers = await storeService.getActiveTransfers(channelAddress);
  } catch (e) {
    return Result.fail(new Error(`${storeMethod} failed: ${e.message}`));
  }

  return Result.ok({
    activeTransfers,
    channelState,
  });
};

// Channels store `ChannelUpdate<T>` types as the `latestUpdate` field, which
// must be converted to the `UpdateParams<T> when syncing
export function getParamsFromUpdate<T extends UpdateType = any>(
  update: ChannelUpdate<T>,
): Result<UpdateParams<T>, Error> {
  const { channelAddress, type, details, toIdentifier, assetId } = update;
  let paramDetails: SetupParams | DepositParams | CreateTransferParams | ResolveTransferParams;
  switch (type) {
    case "setup": {
      const { networkContext, timeout, meta } = details as SetupUpdateDetails;
      const params: SetupParams = {
        networkContext: { ...networkContext },
        timeout,
        counterpartyIdentifier: toIdentifier,
        meta: meta ?? {},
      };
      paramDetails = params;
      break;
    }
    case "deposit": {
      const params: DepositParams = {
        channelAddress,
        assetId,
        meta: details.meta ?? {},
      };
      paramDetails = params;
      break;
    }
    case "create": {
      // The balance in the update for create is the *channel* balance after
      // the update has been applied. The balance in the params is the
      // *initial balance* of the transfer
      const {
        balance,
        transferInitialState,
        transferDefinition,
        transferTimeout,
        meta,
      } = details as CreateUpdateDetails;
      const params: CreateTransferParams = {
        balance,
        channelAddress,
        assetId,
        transferDefinition,
        transferInitialState,
        timeout: transferTimeout,
        meta: meta ?? {},
      };
      paramDetails = params;
      break;
    }
    case "resolve": {
      const { transferResolver, transferId, meta } = details as ResolveUpdateDetails;
      const params: ResolveTransferParams = {
        channelAddress,
        transferId,
        transferResolver,
        meta: meta ?? {},
      };
      paramDetails = params;
      break;
    }
    default: {
      return Result.fail(new Error(`Invalid update type ${type}`));
    }
  }
  return Result.ok({
    channelAddress,
    type,
    details: paramDetails as UpdateParamsMap[T],
  });
}

// This function signs the state after the update is applied,
// not for the update that exists
export async function generateSignedChannelCommitment(
  newState: FullChannelState,
  signer: IChannelSigner,
  aliceSignature?: string,
  bobSignature?: string,
  logger?: BaseLogger,
): Promise<Result<{ core: CoreChannelState; aliceSignature?: string; bobSignature?: string }, Error>> {
  const log = (msg: string, details: any = {}, level: Level = "info") => {
    if (!logger) {
      return;
    }
    logger[level](details, msg);
  };
  const { networkContext, ...core } = newState;
  const hash = hashChannelCommitment(core);

  if (aliceSignature && bobSignature) {
    log("Double signed, doing nothing", { aliceSignature, bobSignature, hash });
    // No need to sign, we have already signed
    return Result.ok({
      core,
      aliceSignature,
      bobSignature,
    });
  }

  // Only counterparty has signed
  try {
    log("Signing hash", { hash, signer: signer.address, state: newState }, "debug");
    const sig = await signer.signMessage(hash);
    const isAlice = signer.address === newState.alice;
    return Result.ok({
      core,
      aliceSignature: isAlice ? sig : aliceSignature,
      bobSignature: isAlice ? bobSignature : sig,
    });
  } catch (e) {
    return Result.fail(e);
  }
}

export const reconcileDeposit = async (
  channelAddress: string,
  chainId: number,
  initialBalance: Balance,
  processedDepositA: string,
  processedDepositB: string,
  assetId: string,
  chainReader: IVectorChainReader,
): Promise<Result<{ balance: Balance; totalDepositsAlice: string; totalDepositsBob: string }, ChainError>> => {
  // First get totalDepositsAlice and totalDepositsBob
  const totalDepositedARes = await chainReader.getTotalDepositedA(channelAddress, chainId, assetId);
  if (totalDepositedARes.isError) {
    return Result.fail(totalDepositedARes.getError()!);
  }
  const totalDepositsAlice = totalDepositedARes.getValue();

  const totalDepositedBRes = await chainReader.getTotalDepositedB(channelAddress, chainId, assetId);
  if (totalDepositedBRes.isError) {
    return Result.fail(totalDepositedBRes.getError()!);
  }
  const totalDepositsBob = totalDepositedBRes.getValue();

  // Now calculate the amount deposited that has not yet been reconciled
  const depositsToReconcile = [
    BigNumber.from(totalDepositsAlice).sub(processedDepositA),
    BigNumber.from(totalDepositsBob).sub(processedDepositB),
  ];

  // Lastly, calculate the new balance

  const balance = {
    ...initialBalance,
    amount: [
      BigNumber.from(initialBalance.amount[0]).add(depositsToReconcile[0]).toString(),
      BigNumber.from(initialBalance.amount[1]).add(depositsToReconcile[1]).toString(),
    ],
  };

  return Result.ok({
    balance,
    totalDepositsAlice: totalDepositsAlice.toString(),
    totalDepositsBob: totalDepositsBob.toString(),
  });
};

export const getUpdatedChannelBalance = (
  type: typeof UpdateType.create | typeof UpdateType.resolve,
  assetId: string,
  balanceToReconcile: Balance,
  state: FullChannelState,
  initiator: string,
): Balance => {
  // Get the existing balances to update
  const assetIdx = state.assetIds.findIndex((a) => getAddress(a) === getAddress(assetId));
  if (assetIdx === -1) {
    throw new Error(`Asset id not found in channel ${assetId}`);
  }
  const existing = state.balances[assetIdx] || { to: [state.alice, state.bob], amount: ["0", "0"] };

  // Create a helper to update some existing balance amount
  // based on the transfer amount using the update type
  const updateExistingAmount = (existingBalance: string, transferBalance: string): string => {
    return type === UpdateType.create
      ? BigNumber.from(existingBalance).sub(transferBalance).toString()
      : BigNumber.from(existingBalance).add(transferBalance).toString();
  };

  // NOTE: in the transfer.balance, there is no guarantee that the
  // `transfer.to` corresponds to the `channel.balances[assetIdx].to`
  // (i.e. an external withdrawal recipient). However, the transfer
  // will always have an initiator and responder that will correspond
  // to the values of `channel.balances[assetIdx].to`

  // Get the transfer amounts that correspond to channel participants
  const aliceTransferAmount = initiator === state.alice ? balanceToReconcile.amount[0] : balanceToReconcile.amount[1];
  const bobTransferAmount = initiator === state.bob ? balanceToReconcile.amount[0] : balanceToReconcile.amount[1];

  // Return the updated channel balance object
  // NOTE: you should *always* use the existing balance because you are
  // reconciling a transfer balance with a channel balance. The reconciled
  // balance `to` ordering should correspond to the existing state ordering
  // not the transfer.to ordering
  return {
    to: [...existing.to],
    amount: [
      updateExistingAmount(existing.amount[0], aliceTransferAmount),
      updateExistingAmount(existing.amount[1], bobTransferAmount),
    ],
  };
};

// NOTE: prior to v0.1.8-beta.6 there were inconsistent checks
// with checksummed and non-checksummed assetIds resulting in
// some channels having 2 assetId entries (one lowercase and one
// checksum, for example) for the same asset. calling `mergeAssets`
// will create the correct balance/processed deposit entries for
// all duplicated assetIds. This function will merge all assetIds that are
// duplicates and update all existing channel state arrays
export const mergeAssetIds = (channel: FullChannelState): FullChannelState => {
  const assetIds: string[] = [];
  const processedDepositsA: string[] = [];
  const processedDepositsB: string[] = [];
  const balances: Balance[] = [];
  const defundNonces: string[] = [];
  // get index of all duplicated assetids
  channel.assetIds.forEach((asset, idx) => {
    const duplicates = channel.assetIds.filter((a, i) => a.toLowerCase() === asset.toLowerCase() && i !== idx);
    const checkSummed = getAddress(asset);
    if (duplicates.length === 0) {
      // there are no duplicates for this asset, update
      // all arrays to have existing value at existing idx
      assetIds[idx] = checkSummed;
      processedDepositsA[idx] = channel.processedDepositsA[idx];
      processedDepositsB[idx] = channel.processedDepositsB[idx];
      balances[idx] = channel.balances[idx];
      defundNonces[idx] = channel.defundNonces[idx];
      return;
    }

    // there *are* duplicates, reduce the arrays
    const unprocessedAsset = (a: string) => {
      // unprocessed iff asset isnt in updated arrays and matches asset
      // in question
      return a.toLowerCase() === asset.toLowerCase() && !assetIds.includes(checkSummed);
    };
    const processedAForAsset = channel.processedDepositsA.reduce((prev, curr, currIdx) => {
      return BigNumber.from(prev)
        .add(unprocessedAsset(channel.assetIds[currIdx]) ? curr : "0")
        .toString();
    }, "0");
    const processedBForAsset = channel.processedDepositsB.reduce((prev, curr, currIdx) => {
      return BigNumber.from(prev)
        .add(unprocessedAsset(channel.assetIds[currIdx]) ? curr : "0")
        .toString();
    }, "0");
    const balanceForAsset = channel.balances.reduce(
      (prev, curr, currIdx) => {
        if (unprocessedAsset(channel.assetIds[currIdx])) {
          // make update
          const amount = [
            BigNumber.from(prev.amount[0]).add(curr.amount[0]),
            BigNumber.from(prev.amount[1]).add(curr.amount[1]),
          ].map((v) => v.toString());
          return { to: prev.to, amount };
        }
        // dont make any updates
        return prev;
      },
      { to: [channel.alice, channel.bob], amount: ["0", "0"] },
    );
    const defundNonceForAsset = channel.defundNonces.reduce((prev, curr, currIdx) => {
      return unprocessedAsset(channel.assetIds[currIdx]) && prev > curr ? prev : curr;
    }, "0");

    // only update value once
    if (!unprocessedAsset(asset)) {
      return;
    }
    assetIds[idx] = getAddress(asset);
    processedDepositsA[idx] = processedAForAsset;
    processedDepositsB[idx] = processedBForAsset;
    balances[idx] = balanceForAsset;
    defundNonces[idx] = defundNonceForAsset;

    return;
  });

  return {
    ...channel,
    assetIds,
    processedDepositsA,
    processedDepositsB,
    balances,
    defundNonces,
  };
};

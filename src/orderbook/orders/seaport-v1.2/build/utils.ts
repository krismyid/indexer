import { AddressZero, HashZero } from "@ethersproject/constants";
import * as Sdk from "@nftearth/sdk";
import { BaseBuildParams } from "@nftearth/sdk/dist/seaport-v1.2/builders/base";
import { generateSourceBytes, getRandomBytes } from "@nftearth/sdk/dist/utils";

import { redb } from "@/common/db";
import { baseProvider } from "@/common/provider";
import { bn, now } from "@/common/utils";
import { config } from "@/config/index";

export interface BaseOrderBuildOptions {
  maker: string;
  contract?: string;
  weiPrice: string;
  orderbook: "opensea" | "reservoir";
  orderType?: Sdk.SeaportV12.Types.OrderType;
  currency?: string;
  quantity?: number;
  nonce?: string;
  fee?: number[];
  feeRecipient?: string[];
  listingTime?: number;
  expirationTime?: number;
  salt?: string;
  automatedRoyalties?: boolean;
  excludeFlaggedTokens?: boolean;
  source?: string;
}

type OrderBuildInfo = {
  params: BaseBuildParams;
  kind: "erc721" | "erc1155";
};

export const padSourceToSalt = (source: string, salt: string) => {
  const sourceHash = generateSourceBytes(source);
  const saltHex = bn(salt)._hex.slice(6);
  return bn(`0x${sourceHash}${saltHex}`).toString();
};

export const getBuildInfo = async (
  options: BaseOrderBuildOptions,
  collection: string,
  side: "sell" | "buy"
): Promise<OrderBuildInfo> => {
  const collectionResult = await redb.oneOrNone(
    `
      SELECT
        contracts.kind,
        collections.royalties,
        collections.new_royalties
      FROM collections
      JOIN contracts
        ON collections.contract = contracts.address
      WHERE collections.id = $/collection/
      LIMIT 1
    `,
    { collection }
  );
  if (!collectionResult) {
    throw new Error("Could not fetch collection");
  }

  const exchange = new Sdk.SeaportV12.Exchange(config.chainId);

  const buildParams: BaseBuildParams = {
    offerer: options.maker,
    side,
    tokenKind: collectionResult.kind,
    contract: options.contract!,
    price: options.weiPrice,
    amount: options.quantity,
    paymentToken: options.currency
      ? options.currency
      : side === "buy"
      ? Sdk.Common.Addresses.Weth[config.chainId]
      : Sdk.Common.Addresses.Eth[config.chainId],
    fees: [],
    // Use OpenSea's pausable zone when posting to OpenSea
    zone:
      options.orderbook === "opensea"
        ? Sdk.SeaportV12.Addresses.PausableZone[config.chainId] ?? AddressZero
        : AddressZero,
    // Use OpenSea's conduit for sharing approvals (where available)
    conduitKey: Sdk.SeaportV12.Addresses.OpenseaConduitKey[config.chainId] ?? HashZero,
    startTime: options.listingTime || now() - 1 * 60,
    endTime: options.expirationTime || now() + 6 * 30 * 24 * 3600,
    salt: options.source
      ? padSourceToSalt(options.source, options.salt ?? getRandomBytes(16).toString())
      : undefined,
    counter: (await exchange.getCounter(baseProvider, options.maker)).toString(),
    orderType: options.orderType,
  };

  // Keep track of the total amount of fees
  let totalFees = bn(0);

  if (options.automatedRoyalties) {
    // Include the royalties
    const royalties =
      options.orderbook === "opensea"
        ? collectionResult.new_royalties?.opensea
        : collectionResult.royalties;
    for (const { recipient, bps } of royalties || []) {
      if (recipient && Number(bps) > 0) {
        const fee = bn(bps).mul(options.weiPrice).div(10000).toString();
        buildParams.fees!.push({
          recipient,
          amount: fee,
        });

        totalFees = totalFees.add(fee);
      }
    }
  }

  if (options.orderbook === "opensea") {
    if (!options.fee || !options.feeRecipient) {
      options.fee = [];
      options.feeRecipient = [];
    }

    options.fee.push(250);
    // OpenSea's Seaport fee recipient
    options.feeRecipient.push("0x0000a26b00c1f0df003000390027140000faa719");
  }

  if (options.fee && options.feeRecipient) {
    for (let i = 0; i < options.fee.length; i++) {
      if (Number(options.fee[i]) > 0) {
        const fee = bn(options.fee[i]).mul(options.weiPrice).div(10000).toString();
        buildParams.fees!.push({
          recipient: options.feeRecipient[i],
          amount: fee,
        });
        totalFees = totalFees.add(fee);
      }
    }
  }

  // If the order is a listing, subtract the fees from the price.
  // Otherwise, keep them (since the taker will pay them from the
  // amount received from the maker).
  if (side === "sell") {
    buildParams.price = bn(buildParams.price).sub(totalFees);
  } else {
    buildParams.price = bn(buildParams.price);
  }

  return {
    params: buildParams,
    kind: collectionResult.kind,
  };
};

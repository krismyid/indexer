import { getStateChange } from "@georgeroman/evm-tx-simulator";
import { Common } from "@nftearth/sdk";

import { config } from "@/config/index";
import { getEventData } from "@/events-sync/data";
import { EnhancedEvent, OnChainData } from "@/events-sync/handlers/utils";
import * as utils from "@/events-sync/utils";
import { getUSDAndNativePrices } from "@/utils/prices";

export const handleEvents = async (events: EnhancedEvent[], onChainData: OnChainData) => {
  // Handle the events
  for (const { subKind, baseEventParams, log } of events) {
    const eventData = getEventData([subKind])[0];
    switch (subKind) {
      case "superrare-listing-filled": {
        const { args } = eventData.abi.parseLog(log);
        const contract = args["_originContract"].toLowerCase();
        const maker = args["_buyer"].toLowerCase();
        const taker = args["_seller"].toLowerCase();
        const currencyPrice = args["_amount"].toString();
        const tokenId = args["_tokenId"].toString();

        // Superrare works only with ERC721
        const amount = "1";
        const orderSide = "sell";
        let currency = Common.Addresses.Eth[config.chainId];

        const txTrace = await utils.fetchTransactionTrace(baseEventParams.txHash);
        if (!txTrace) {
          // Skip any failed attempts to get the trace
          break;
        }

        const state = getStateChange(txTrace.calls);

        for (const token of Object.keys(state[taker].tokenBalanceState)) {
          if (token.startsWith("erc20") || token.startsWith("native")) {
            currency = token.split(":")[1];
          }
        }

        const priceData = await getUSDAndNativePrices(
          currency,
          currencyPrice.toString(),
          baseEventParams.timestamp
        );
        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        const orderKind = "superrare";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind
        );

        onChainData.fillEvents.push({
          orderKind,
          currency,
          orderSide,
          maker,
          taker,
          price: priceData.nativePrice,
          currencyPrice,
          usdPrice: priceData.usdPrice,
          contract,
          tokenId,
          amount,
          orderSourceId: attributionData.orderSource?.id,
          aggregatorSourceId: attributionData.aggregatorSource?.id,
          fillSourceId: attributionData.fillSource?.id,
          baseEventParams,
        });

        onChainData.fillInfos.push({
          context: `superrare-${contract}-${tokenId}-${baseEventParams.txHash}`,
          orderSide,
          contract,
          tokenId,
          amount,
          price: priceData.nativePrice,
          timestamp: baseEventParams.timestamp,
          maker,
          taker,
        });

        break;
      }

      case "superrare-sold": {
        const { args } = eventData.abi.parseLog(log);
        const contract = args["_originContract"].toLowerCase();
        const maker = args["_buyer"].toLowerCase();
        const taker = args["_seller"].toLowerCase();
        const currency = args["_currencyAddress"].toLowerCase();
        const currencyPrice = args["_amount"].toString();
        const tokenId = args["_tokenId"].toString();

        // Superrare works only with ERC721
        const amount = "1";
        const orderSide = "sell";

        const priceData = await getUSDAndNativePrices(
          currency,
          currencyPrice.toString(),
          baseEventParams.timestamp
        );

        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        const orderKind = "superrare";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind
        );

        onChainData.fillEvents.push({
          orderKind,
          currency,
          orderSide,
          maker,
          taker,
          price: priceData.nativePrice,
          currencyPrice,
          usdPrice: priceData.usdPrice,
          contract,
          tokenId,
          amount,
          orderSourceId: attributionData.orderSource?.id,
          aggregatorSourceId: attributionData.aggregatorSource?.id,
          fillSourceId: attributionData.fillSource?.id,
          baseEventParams,
        });

        onChainData.fillInfos.push({
          context: `superrare-${contract}-${tokenId}-${baseEventParams.txHash}`,
          orderSide,
          contract,
          tokenId,
          amount,
          price: priceData.nativePrice,
          timestamp: baseEventParams.timestamp,
          maker,
          taker,
        });

        break;
      }

      case "superrare-accept-offer": {
        const { args } = eventData.abi.parseLog(log);
        const contract = args["_originContract"].toLowerCase();
        const maker = args["_bidder"].toLowerCase();
        const taker = args["_seller"].toLowerCase();
        const currency = args["_currencyAddress"].toLowerCase();
        const currencyPrice = args["_amount"].toString();
        const tokenId = args["_tokenId"].toString();

        // Superrare works only with ERC721
        const amount = "1";
        const orderSide = "buy";

        const priceData = await getUSDAndNativePrices(
          currency,
          currencyPrice.toString(),
          baseEventParams.timestamp
        );

        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        const orderKind = "superrare";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind
        );

        onChainData.fillEvents.push({
          orderKind,
          currency,
          orderSide,
          maker,
          taker,
          price: priceData.nativePrice,
          currencyPrice,
          usdPrice: priceData.usdPrice,
          contract,
          tokenId,
          amount,
          orderSourceId: attributionData.orderSource?.id,
          aggregatorSourceId: attributionData.aggregatorSource?.id,
          fillSourceId: attributionData.fillSource?.id,
          baseEventParams,
        });

        onChainData.fillInfos.push({
          context: `superrare-${contract}-${tokenId}-${baseEventParams.txHash}`,
          orderSide,
          contract,
          tokenId,
          amount,
          price: priceData.nativePrice,
          timestamp: baseEventParams.timestamp,
          maker,
          taker,
        });

        break;
      }

      case "superrare-auction-settled": {
        const { args } = eventData.abi.parseLog(log);
        const contract = args["_contractAddress"].toLowerCase();
        const maker = args["_bidder"].toLowerCase();
        const taker = args["_seller"].toLowerCase();
        const currency = args["_currencyAddress"].toLowerCase();
        const currencyPrice = args["_amount"].toString();
        const tokenId = args["_tokenId"].toString();

        // Superrare works only with ERC721
        const amount = "1";
        const orderSide = "sell";

        const priceData = await getUSDAndNativePrices(
          currency,
          currencyPrice.toString(),
          baseEventParams.timestamp
        );

        if (!priceData.nativePrice) {
          // We must always have the native price
          break;
        }

        const orderKind = "superrare";
        const attributionData = await utils.extractAttributionData(
          baseEventParams.txHash,
          orderKind
        );

        onChainData.fillEvents.push({
          orderKind,
          currency,
          orderSide,
          maker,
          taker,
          price: priceData.nativePrice,
          currencyPrice,
          usdPrice: priceData.usdPrice,
          contract,
          tokenId,
          amount,
          orderSourceId: attributionData.orderSource?.id,
          aggregatorSourceId: attributionData.aggregatorSource?.id,
          fillSourceId: attributionData.fillSource?.id,
          baseEventParams,
        });

        onChainData.fillInfos.push({
          context: `superrare-${contract}-${tokenId}-${baseEventParams.txHash}`,
          orderSide,
          contract,
          tokenId,
          amount,
          price: priceData.nativePrice,
          timestamp: baseEventParams.timestamp,
          maker,
          taker,
        });

        break;
      }
    }
  }
};

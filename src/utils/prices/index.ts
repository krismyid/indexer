import { AddressZero } from "@ethersproject/constants";
import { parseUnits } from "@ethersproject/units";
import * as Sdk from "@nftearth/sdk";
import axios from "axios";

import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { bn, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { getNetworkSettings } from "@/config/network";
import { getCurrency } from "@/utils/currencies";

const USD_DECIMALS = 6;
// TODO: This should be a per-network setting
const NATIVE_UNIT = bn("1000000000000000000");

export type Price = {
  currency: string;
  timestamp: number;
  value: string;
};

const getUpstreamUSDPrice = async (
  currencyAddress: string,
  timestamp: number
): Promise<Price | undefined> => {
  try {
    const date = new Date(timestamp * 1000);
    const truncatedTimestamp = Math.floor(date.valueOf() / 1000);

    const currency = await getCurrency(currencyAddress);
    const coingeckoCurrencyId = currency?.metadata?.coingeckoCurrencyId;
    const dexScreenerId = currency?.metadata?.dexScreenerId;

    logger.info("prices", `Trying to get upstream price for currency ${JSON.stringify(currency)}`);

    if (coingeckoCurrencyId) {
      const day = date.getDate();
      const month = date.getMonth() + 1;
      const year = date.getFullYear();

      const url = `https://api.coingecko.com/api/v3/coins/${coingeckoCurrencyId}/history?date=${day}-${month}-${year}`;
      logger.info("prices", `Fetching price from Coingecko: ${url}`);

      const result: {
        market_data: {
          current_price: { [symbol: string]: number };
        };
      } = await axios
        .get(url, {
          timeout: 10 * 1000,
        })
        .then((response) => response.data);

      logger.info("prices", `result price upstream ${url} ${JSON.stringify(result)}`);

      const usdPrice = result?.market_data?.current_price?.["usd"];
      if (usdPrice) {
        const value = parseUnits(usdPrice.toFixed(USD_DECIMALS), USD_DECIMALS).toString();

        await idb.none(
          `
            INSERT INTO usd_prices (
              currency,
              timestamp,
              value
            ) VALUES (
              $/currency/,
              date_trunc('day', to_timestamp($/timestamp/)),
              $/value/
            ) ON CONFLICT DO NOTHING
          `,
          {
            currency: toBuffer(currencyAddress),
            timestamp: truncatedTimestamp,
            value,
          }
        );

        return {
          currency: currencyAddress,
          timestamp: truncatedTimestamp,
          value,
        };
      }
    } else if (dexScreenerId) {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${dexScreenerId}`;
      logger.info("prices", `Fetching price from dexScreener: ${url}`);

      const result: {
        pairs: {
          chainId: string;
          priceNative: string;
          priceUsd: string;
        }[];
      } = await axios
        .get(url, {
          timeout: 10 * 1000,
        })
        .then((response) => response.data);

      logger.info("prices", `result price upstream ${url} ${JSON.stringify(result)}`);

      const usdPrice = result?.pairs?.[0]?.priceUsd;
      if (usdPrice) {
        const value = parseUnits(
          parseFloat(usdPrice).toFixed(USD_DECIMALS),
          USD_DECIMALS
        ).toString();

        await idb.none(
          `
            INSERT INTO usd_prices (
              currency,
              timestamp,
              value
            ) VALUES (
              $/currency/,
              date_trunc('day', to_timestamp($/timestamp/)),
              $/value/
            ) ON CONFLICT DO NOTHING
          `,
          {
            currency: toBuffer(currencyAddress),
            timestamp: truncatedTimestamp,
            value,
          }
        );

        return {
          currency: currencyAddress,
          timestamp: truncatedTimestamp,
          value,
        };
      }
    } else if (getNetworkSettings().whitelistedCurrencies.has(currencyAddress.toLowerCase())) {
      // Whitelisted currencies are 1:1 with USD
      const value = "1";

      await idb.none(
        `
          INSERT INTO usd_prices (
            currency,
            timestamp,
            value
          ) VALUES (
            $/currency/,
            date_trunc('day', to_timestamp($/timestamp/)),
            $/value/
          ) ON CONFLICT DO NOTHING
        `,
        {
          currency: toBuffer(currencyAddress),
          timestamp: truncatedTimestamp,
          value,
        }
      );

      return {
        currency: currencyAddress,
        timestamp: truncatedTimestamp,
        value,
      };
    }
  } catch (error) {
    logger.error(
      "prices",
      `Failed to fetch upstream USD price for ${currencyAddress} and timestamp ${timestamp}: ${error}`
    );
  }

  return undefined;
};

const getCachedUSDPrice = async (
  currencyAddress: string,
  timestamp: number
): Promise<Price | undefined> =>
  idb
    .oneOrNone(
      `
        SELECT
          extract('epoch' from usd_prices.timestamp) AS "timestamp",
          usd_prices.value
        FROM usd_prices
        WHERE usd_prices.currency = $/currency/
          AND usd_prices.timestamp <= date_trunc('day', to_timestamp($/timestamp/))
        ORDER BY usd_prices.timestamp DESC
        LIMIT 1
      `,
      {
        currency: toBuffer(currencyAddress),
        timestamp,
      }
    )
    .then((data) =>
      data
        ? {
            currency: currencyAddress,
            timestamp: data.timestamp,
            value: data.value,
          }
        : undefined
    )
    .catch(() => undefined);

const USD_PRICE_MEMORY_CACHE = new Map<string, Price>();
const getAvailableUSDPrice = async (
  currencyAddress: string,
  timestamp: number,
  acceptStalePrice?: boolean
) => {
  // At the moment, we support day-level granularity for prices
  const DAY = 24 * 3600;

  const normalizedTimestamp = Math.floor(timestamp / DAY);
  const key = `${currencyAddress}-${normalizedTimestamp}`.toLowerCase();
  if (!USD_PRICE_MEMORY_CACHE.has(key)) {
    // If the price is not available in the memory cache, use any available database cached price
    let cachedPrice = await getCachedUSDPrice(currencyAddress, timestamp);
    logger.info(
      "prices",
      `Cached Price USD for currency: ${currencyAddress}  data: ${JSON.stringify(cachedPrice)}`
    );

    // Fetch the latest price from upstream if:
    // - we have no price available
    // - we have a stale price available and stale prices are not accepted
    let fetchFromUpstream = false;
    if (cachedPrice) {
      const isStale = Math.floor(cachedPrice.timestamp / DAY) !== normalizedTimestamp;
      if (isStale && !acceptStalePrice) {
        fetchFromUpstream = true;
      }
    } else {
      fetchFromUpstream = true;
    }

    if (fetchFromUpstream) {
      const upstreamPrice = await getUpstreamUSDPrice(currencyAddress, timestamp);
      if (upstreamPrice) {
        cachedPrice = upstreamPrice;
      }
    }

    if (cachedPrice) {
      USD_PRICE_MEMORY_CACHE.set(key, cachedPrice);
    }
  }

  return USD_PRICE_MEMORY_CACHE.get(key);
};

export type USDAndNativePrices = {
  usdPrice?: string;
  nativePrice?: string;
};

/**
 * Will return USD and price in the native currency of the current chain
 *
 * @param currencyAddress
 * @param price
 * @param timestamp
 * @param options
 */
export const getUSDAndNativePrices = async (
  currencyAddress: string,
  price: string,
  timestamp: number,
  options?: {
    onlyUSD?: boolean;
    acceptStalePrice?: boolean;
  }
): Promise<USDAndNativePrices> => {
  let usdPrice: string | undefined;
  let nativePrice: string | undefined;

  // Only try to get pricing data if the network supports it
  const force =
    config.chainId === 5 &&
    [
      "0x07865c6e87b9f70255377e024ace6630c1eaa37f",
      "0x68b7e050e6e2c7efe11439045c9d49813c1724b8",
    ].includes(currencyAddress);
  if (getNetworkSettings().coingecko?.networkId || force) {
    const currencyUSDPrice = await getAvailableUSDPrice(
      currencyAddress,
      timestamp,
      options?.acceptStalePrice
    );

    let nativeUSDPrice: Price | undefined;
    if (!options?.onlyUSD) {
      nativeUSDPrice = await getAvailableUSDPrice(
        AddressZero,
        timestamp,
        options?.acceptStalePrice
      );
    }

    const currency = await getCurrency(currencyAddress);
    if (currency.decimals && currencyUSDPrice) {
      const currencyUnit = bn(10).pow(currency.decimals);
      usdPrice = bn(price).mul(currencyUSDPrice.value).div(currencyUnit).toString();
      if (nativeUSDPrice) {
        nativePrice = bn(price)
          .mul(currencyUSDPrice.value)
          .mul(NATIVE_UNIT)
          .div(nativeUSDPrice.value)
          .div(currencyUnit)
          .toString();
      }
    }
  }

  // Make sure to handle the case where the currency is the native one (or the wrapped equivalent)
  if (
    [Sdk.Common.Addresses.Eth[config.chainId], Sdk.Common.Addresses.Weth[config.chainId]].includes(
      currencyAddress
    )
  ) {
    nativePrice = price;
  }

  return { usdPrice, nativePrice };
};

/**
 * Convert between currencies
 *
 * @param fromCurrencyAddress
 * @param toCurrency
 * @param price
 * @param timestamp
 * @param options
 */
export const getUSDAndCurrencyPrices = async (
  fromCurrencyAddress: string,
  toCurrency: string,
  price: string,
  timestamp: number,
  options?: {
    onlyUSD?: boolean;
    acceptStalePrice?: boolean;
  }
): Promise<USDAndNativePrices> => {
  let usdPrice: string | undefined;
  let nativePrice: string | undefined;

  // Only try to get pricing data if the network supports it
  if (getNetworkSettings().coingecko?.networkId) {
    // Get the FROM currency price
    const fromCurrencyUSDPrice = await getAvailableUSDPrice(
      fromCurrencyAddress,
      timestamp,
      options?.acceptStalePrice
    );

    let toCurrencyUSDPrice: Price | undefined;
    if (!options?.onlyUSD) {
      toCurrencyUSDPrice = await getAvailableUSDPrice(
        toCurrency,
        timestamp,
        options?.acceptStalePrice
      );
    }

    const currency = await getCurrency(fromCurrencyAddress);

    if (currency.decimals && fromCurrencyUSDPrice) {
      const currencyUnit = bn(10).pow(currency.decimals);
      usdPrice = bn(price).mul(fromCurrencyUSDPrice.value).div(currencyUnit).toString();
      if (toCurrencyUSDPrice) {
        nativePrice = bn(price)
          .mul(fromCurrencyUSDPrice.value)
          .mul(NATIVE_UNIT)
          .div(toCurrencyUSDPrice.value)
          .div(currencyUnit)
          .toString();
      }
    }
  }

  return { usdPrice, nativePrice };
};

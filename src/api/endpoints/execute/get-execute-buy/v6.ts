/* eslint-disable @typescript-eslint/no-explicit-any */

import { BigNumber } from "@ethersproject/bignumber";
import * as Boom from "@hapi/boom";
import { Request, RouteOptions } from "@hapi/hapi";
import * as Sdk from "@nftearth/sdk";
import { ListingDetails } from "@nftearth/sdk/dist/router/v6/types";
import Joi from "joi";

import { inject } from "@/api/index";
import { idb } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { bn, formatPrice, fromBuffer, regex, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import { Sources } from "@/models/sources";
import { OrderKind, generateListingDetailsV6 } from "@/orderbook/orders";
import * as commonHelpers from "@/orderbook/orders/common/helpers";
import * as sudoswap from "@/orderbook/orders/sudoswap";
import * as nftx from "@/orderbook/orders/nftx";
import { getCurrency } from "@/utils/currencies";

const version = "v6";

export const getExecuteBuyV6Options: RouteOptions = {
  description: "Buy tokens",
  tags: ["api", "Router"],
  timeout: {
    server: 20 * 1000,
  },
  plugins: {
    "hapi-swagger": {
      order: 10,
    },
  },
  validate: {
    payload: Joi.object({
      orderIds: Joi.array().items(Joi.string().lowercase()),
      rawOrders: Joi.array().items(
        Joi.object({
          kind: Joi.string()
            .lowercase()
            .valid(
              "nftearth",
              "opensea",
              "looks-rare",
              "zeroex-v4",
              "seaport",
              "x2y2",
              "universe",
              "rarible",
              "infinity",
              "sudoswap",
              "flow",
              "nftx"
            )
            .required(),
          data: Joi.object().required(),
        })
      ),
      tokens: Joi.array()
        .items(Joi.string().lowercase().pattern(regex.token))
        .description(
          "Array of tokens user is buying. Example: `tokens[0]: 0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:704 tokens[1]: 0x8d04a8c79ceb0889bdd12acdf3fa9d207ed3ff63:979`"
        ),
      quantity: Joi.number()
        .integer()
        .positive()
        .description(
          "Quantity of tokens user is buying. Only compatible when buying a single ERC1155 token. Example: `5`"
        ),
      taker: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .required()
        .description(
          "Address of wallet filling the order. Example: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00`"
        ),
      relayer: Joi.string()
        .lowercase()
        .pattern(regex.address)
        .description("Address of wallet relaying the filling transaction"),
      onlyPath: Joi.boolean()
        .default(false)
        .description("If true, only the path will be returned."),
      forceRouter: Joi.boolean().description(
        "If true, all fills will be executed through the router."
      ),
      currency: Joi.string()
        .valid(Sdk.Common.Addresses.Eth[config.chainId])
        .description("Currency to buy all listings in."),
      normalizeRoyalties: Joi.boolean().default(false),
      preferredOrderSource: Joi.string()
        .lowercase()
        .pattern(regex.domain)
        .when("tokens", { is: Joi.exist(), then: Joi.allow(), otherwise: Joi.forbidden() })
        .description(
          "If there are multiple listings with equal best price, prefer this source over others.\nNOTE: if you want to fill a listing that is not the best priced, you need to pass a specific order ID."
        ),
      source: Joi.string()
        .lowercase()
        .pattern(regex.domain)
        .description("Filling source used for attribution. Example: `reservoir.market`"),
      feesOnTop: Joi.array()
        .items(Joi.string().pattern(regex.fee))
        .description(
          "List of fees (formatted as `feeRecipient:feeAmount`) to be taken when filling.\nUnless overridden via the `currency` param, the currency used for any fees on top matches the buy-in currency detected by the backend.\nExample: `0xF296178d553C8Ec21A2fBD2c5dDa8CA9ac905A00:1000000000000000`"
        ),
      partial: Joi.boolean()
        .default(false)
        .description("If true, any off-chain or on-chain errors will be skipped."),
      maxFeePerGas: Joi.string()
        .pattern(regex.number)
        .description("Optional. Set custom gas price."),
      maxPriorityFeePerGas: Joi.string()
        .pattern(regex.number)
        .description("Optional. Set custom gas price."),
      skipBalanceCheck: Joi.boolean()
        .default(false)
        .description("If true, balance check will be skipped."),
      allowInactiveOrderIds: Joi.boolean()
        .default(false)
        .description(
          "If true, do not filter out inactive orders (only relevant for order id filtering)."
        ),
      x2y2ApiKey: Joi.string().description("Override the X2Y2 API key used for filling."),
    }),
  },
  response: {
    schema: Joi.object({
      steps: Joi.array().items(
        Joi.object({
          id: Joi.string().required(),
          action: Joi.string().required(),
          description: Joi.string().required(),
          kind: Joi.string().valid("transaction").required(),
          items: Joi.array()
            .items(
              Joi.object({
                status: Joi.string().valid("complete", "incomplete").required(),
                data: Joi.object(),
              })
            )
            .required(),
        })
      ),
      path: Joi.array().items(
        Joi.object({
          orderId: Joi.string(),
          contract: Joi.string().lowercase().pattern(regex.address),
          tokenId: Joi.string().lowercase().pattern(regex.number),
          quantity: Joi.number().unsafe(),
          source: Joi.string().allow("", null),
          currency: Joi.string().lowercase().pattern(regex.address),
          quote: Joi.number().unsafe(),
          rawQuote: Joi.string().pattern(regex.number),
        })
      ),
    }).label(`getExecuteBuy${version.toUpperCase()}Response`),
    failAction: (_request, _h, error) => {
      logger.error(`get-execute-buy-${version}-handler`, `Wrong response schema: ${error}`);
      throw error;
    },
  },
  handler: async (request: Request) => {
    const payload = request.payload as any;

    try {
      // Handle fees on top
      const feesOnTop: {
        recipient: string;
        amount: string;
      }[] = [];
      for (const fee of payload.feesOnTop ?? []) {
        const [recipient, amount] = fee.split(":");
        feesOnTop.push({ recipient, amount });
      }

      // We need each filled order's source for the path
      const sources = await Sources.getInstance();

      // Keep track of the listings and path to fill
      const listingDetails: ListingDetails[] = [];
      const path: {
        orderId: string;
        contract: string;
        tokenId: string;
        quantity: number;
        source: string | null;
        currency: string;
        quote: number;
        rawQuote: string;
      }[] = [];
      // For handling dynamically-priced listings (eg. from pools like Sudoswap and NFTX)
      const poolPrices: { [pool: string]: string[] } = {};

      const addToPath = async (
        order: {
          id: string;
          kind: OrderKind;
          price: string;
          sourceId: number | null;
          currency: string;
          rawData: any;
          fees?: Sdk.RouterV6.Types.Fee[];
        },
        token: {
          kind: "erc721" | "erc1155";
          contract: string;
          tokenId: string;
          quantity?: number;
        }
      ) => {
        const fees = payload.normalizeRoyalties ? order.fees ?? [] : [];
        const totalFee = fees.map(({ amount }) => bn(amount)).reduce((a, b) => a.add(b), bn(0));

        if (["sudoswap", "nftx"].includes(order.kind)) {
          let poolId: string;
          let priceList: string[];

          if (order.kind === "sudoswap") {
            const rawData = order.rawData as Sdk.Sudoswap.OrderParams;
            poolId = rawData.pair;
            priceList = rawData.extra.prices;
          } else {
            const rawData = order.rawData as Sdk.Nftx.Types.OrderParams;
            poolId = rawData.pool;
            priceList = rawData.extra.prices;
          }

          if (!poolPrices[poolId]) {
            poolPrices[poolId] = [];
          }

          // Fetch the price corresponding to the order's index per pool
          const price = priceList[poolPrices[poolId].length];
          // Save the latest price per pool
          poolPrices[poolId].push(price);
          // Override the order's price
          order.price = price;
        }

        const totalPrice = bn(order.price)
          .add(totalFee)
          .mul(token.quantity ?? 1);
        path.push({
          orderId: order.id,
          contract: token.contract,
          tokenId: token.tokenId,
          quantity: token.quantity ?? 1,
          source: order.sourceId !== null ? sources.get(order.sourceId)?.domain ?? null : null,
          currency: order.currency,
          quote: formatPrice(totalPrice, (await getCurrency(order.currency)).decimals, true),
          rawQuote: totalPrice.toString(),
        });

        listingDetails.push(
          generateListingDetailsV6(
            {
              id: order.id,
              kind: order.kind,
              currency: order.currency,
              rawData: order.rawData,
              // TODO: We don't support ERC20 fees because of potential direct filling which
              // does not work with fees on top. We'll need to integrate permits in order to
              // support ERC20 fees.
              fees: order.currency === Sdk.Common.Addresses.Eth[config.chainId] ? fees : [],
            },
            {
              kind: token.kind,
              contract: token.contract,
              tokenId: token.tokenId,
              amount: token.quantity,
            }
          )
        );
      };

      // Use a default quantity
      if (!payload.quantity) {
        payload.quantity = 1;
      }

      // Scenario 3: pass raw orders that don't yet exist
      if (payload.rawOrders) {
        // Hack: As raw orders are processed, push them to the `orderIds`
        // field so that they will get handled by the next pipeline step
        // of this same API rather than doing anything custom for it.
        payload.orderIds = payload.orderIds || [];

        for (const order of payload.rawOrders) {
          if (order.kind === "sudoswap") {
            // Sudoswap orders cannot be "posted"
            payload.orderIds.push(sudoswap.getOrderId(order.data.pair, "sell", order.data.tokenId));
          } else if (order.kind === "nftx") {
            payload.orderIds.push(
              nftx.getOrderId(order.data.pool, "sell", order.data.specificIds[0])
            );
          } else {
            const response = await inject({
              method: "POST",
              url: `/order/v2`,
              headers: {
                "Content-Type": "application/json",
                "X-Api-Key": request.headers["x-api-key"],
              },
              payload: { order },
            }).then((response) => JSON.parse(response.payload));
            if (response.orderId) {
              payload.orderIds.push(response.orderId);
            } else {
              throw Boom.badData("Raw order failed to get processed");
            }
          }
        }
      }

      // Scenario 2: explicitly passing existing orders to fill
      if (payload.orderIds) {
        for (const orderId of payload.orderIds) {
          const orderResult = await idb.oneOrNone(
            `
              SELECT
                orders.kind,
                contracts.kind AS token_kind,
                coalesce(orders.currency_price, orders.price) AS price,
                orders.raw_data,
                orders.source_id_int,
                orders.currency,
                orders.missing_royalties,
                token_sets_tokens.contract,
                token_sets_tokens.token_id
              FROM orders
              JOIN contracts
                ON orders.contract = contracts.address
              JOIN token_sets_tokens
                ON orders.token_set_id = token_sets_tokens.token_set_id
              WHERE orders.id = $/id/
                AND orders.side = 'sell'
                AND (orders.taker = '\\x0000000000000000000000000000000000000000' OR orders.taker IS NULL)
                AND orders.quantity_remaining >= $/quantity/
                ${
                  payload.allowInactiveOrderIds
                    ? ""
                    : " AND orders.fillability_status = 'fillable' AND orders.approval_status = 'approved'"
                }
                ${
                  // TODO: Add support for buying in ERC20 tokens
                  payload.currency && payload.currency !== Sdk.Common.Addresses.Eth[config.chainId]
                    ? " AND orders.currency = $/currency/"
                    : ""
                }
            `,
            {
              id: orderId,
              quantity: payload.quantity ?? 1,
              currency: payload.currency ? toBuffer(payload.currency) : undefined,
            }
          );
          if (!orderResult) {
            if (!payload.partial) {
              // Return an error if the client does not accept partial fills
              throw Boom.badData(`Order ${orderId} not found or not fillable`);
            } else {
              continue;
            }
          }

          if (payload.quantity > 1) {
            if (orderResult.token_kind !== "erc1155") {
              throw Boom.badRequest("Only ERC1155 orders support a quantity");
            }
            if (payload.orderIds.length > 1) {
              throw Boom.badRequest(
                "When specifying a quantity only a single ERC1155 order can get filled"
              );
            }
          }

          await addToPath(
            {
              id: orderId,
              kind: orderResult.kind,
              price: orderResult.price,
              sourceId: orderResult.source_id_int,
              currency: fromBuffer(orderResult.currency),
              rawData: orderResult.raw_data,
              fees: orderResult.missing_royalties,
            },
            {
              kind: orderResult.token_kind,
              contract: fromBuffer(orderResult.contract),
              tokenId: orderResult.token_id,
              quantity: payload.quantity ?? 1,
            }
          );
        }
      }

      // Scenario 3: passing the tokens and quantity to fill
      if (payload.tokens) {
        const preferredOrderSource = sources.getByDomain(payload.preferredOrderSource)?.id;
        for (const token of payload.tokens) {
          const [contract, tokenId] = token.split(":");

          if (payload.quantity === 1) {
            // Filling a quantity of 1 implies getting the best listing for that token
            const bestOrderResult = await idb.oneOrNone(
              `
                SELECT
                  orders.id,
                  orders.kind,
                  contracts.kind AS token_kind,
                  coalesce(orders.currency_price, orders.price) AS price,
                  orders.raw_data,
                  orders.source_id_int,
                  orders.currency,
                  orders.missing_royalties
                FROM orders
                JOIN contracts
                  ON orders.contract = contracts.address
                WHERE orders.token_set_id = $/tokenSetId/
                  AND orders.side = 'sell'
                  AND orders.fillability_status = 'fillable'
                  AND orders.approval_status = 'approved'
                  AND (orders.taker = '\\x0000000000000000000000000000000000000000' OR orders.taker IS NULL)
                  ${
                    // TODO: Add support for buying in ERC20 tokens
                    payload.currency &&
                    payload.currency !== Sdk.Common.Addresses.Eth[config.chainId]
                      ? " AND orders.currency = $/currency/"
                      : ""
                  }
                ORDER BY
                  ${payload.normalizeRoyalties ? "orders.normalized_value" : "orders.value"},
                  ${
                    preferredOrderSource
                      ? `(
                          CASE
                            WHEN orders.source_id_int = $/sourceId/ THEN 0
                            ELSE 1
                          END
                        )`
                      : "orders.fee_bps"
                  }
                LIMIT 1
              `,
              {
                tokenSetId: `token:${token}`,
                sourceId: preferredOrderSource,
                currency: payload.currency ? toBuffer(payload.currency) : undefined,
              }
            );

            if (bestOrderResult) {
              const {
                id,
                kind,
                token_kind,
                price,
                source_id_int,
                currency,
                missing_royalties,
                raw_data,
              } = bestOrderResult;

              await addToPath(
                {
                  id,
                  kind,
                  price,
                  sourceId: source_id_int,
                  currency: fromBuffer(currency),
                  rawData: raw_data,
                  fees: missing_royalties,
                },
                {
                  kind: token_kind,
                  contract,
                  tokenId,
                }
              );
            } else if (!payload.partial) {
              throw Boom.badRequest("No available orders");
            }
          } else {
            // Fetch all matching orders (limit to 1000 results just for safety)
            const bestOrdersResult = await idb.manyOrNone(
              `
                SELECT
                  orders.id,
                  orders.kind,
                  contracts.kind AS token_kind,
                  coalesce(orders.currency_price, orders.price) AS price,
                  orders.quantity_remaining,
                  orders.source_id_int,
                  orders.currency,
                  orders.missing_royalties,
                  orders.maker,
                  orders.raw_data,
                  contracts.kind AS token_kind,
                  orders.quantity_remaining AS quantity
                FROM orders
                JOIN contracts
                  ON orders.contract = contracts.address
                WHERE orders.token_set_id = $/tokenSetId/
                  AND orders.side = 'sell'
                  AND orders.fillability_status = 'fillable'
                  AND orders.approval_status = 'approved'
                  AND (orders.taker = '\\x0000000000000000000000000000000000000000' OR orders.taker IS NULL)
                  ${
                    // TODO: Add support for buying in ERC20 tokens
                    payload.currency &&
                    payload.currency !== Sdk.Common.Addresses.Eth[config.chainId]
                      ? " AND orders.currency = $/currency/"
                      : ""
                  }
                ORDER BY
                  ${payload.normalizeRoyalties ? "orders.normalized_value" : "orders.value"},
                  ${
                    preferredOrderSource
                      ? `(
                          CASE
                            WHEN orders.source_id_int = $/sourceId/ THEN 0
                            ELSE 1
                          END
                        )`
                      : "orders.fee_bps"
                  }
                LIMIT 1000
              `,
              {
                tokenSetId: `token:${token}`,
                quantity: payload.quantity,
                sourceId: preferredOrderSource,
                currency: payload.currency ? toBuffer(payload.currency) : undefined,
              }
            );

            logger.info("execute-buy-best-order", JSON.stringify(bestOrdersResult));

            if (bestOrdersResult?.length) {
              if (
                bestOrdersResult.length &&
                bestOrdersResult[0].token_kind === "erc1155" &&
                payload.tokens.length > 1
              ) {
                throw Boom.badData(
                  "When specifying a quantity greater than one, only a single ERC1155 token can get filled"
                );
              }

              // Keep track of the balances of each maker as orders are being added to the path.
              // This is needed for covering cases where a maker has multiple orders but filling
              // one of them changes the quantity fillable of the other ones.
              const makerBalances: { [maker: string]: BigNumber } = {};

              let totalQuantityToFill = Number(payload.quantity);
              for (const {
                id,
                kind,
                token_kind,
                quantity_remaining,
                price,
                source_id_int,
                currency,
                missing_royalties,
                maker,
                raw_data,
              } of bestOrdersResult) {
                // As long as the total quantity to fill is not met
                if (totalQuantityToFill <= 0) {
                  break;
                }

                const convertedMaker = fromBuffer(maker);
                if (!makerBalances[convertedMaker]) {
                  makerBalances[convertedMaker] = await commonHelpers.getNftBalance(
                    contract,
                    tokenId,
                    convertedMaker
                  );
                }

                // Minimum between:
                // - the order's fillable quantity
                // - the maker's fillable quantity
                // - the quantity remaining to fill
                const quantityFilled = Math.min(
                  Number(quantity_remaining),
                  makerBalances[convertedMaker].toNumber(),
                  totalQuantityToFill
                );
                totalQuantityToFill -= quantityFilled;

                // Reduce the maker's fillable quantity
                makerBalances[convertedMaker] = makerBalances[convertedMaker].sub(quantityFilled);

                await addToPath(
                  {
                    id,
                    kind,
                    price,
                    sourceId: source_id_int,
                    currency: fromBuffer(currency),
                    rawData: raw_data,
                    fees: missing_royalties,
                  },
                  {
                    kind: token_kind,
                    contract,
                    tokenId,
                    quantity: quantityFilled,
                  }
                );
              }

              // No available orders to fill the requested quantity
              if (!payload.partial && totalQuantityToFill > 0) {
                throw Boom.badRequest("No available orders");
              }
            } else if (!payload.partial) {
              throw Boom.badRequest("No available orders");
            }
          }
        }
      }

      if (!path.length) {
        throw Boom.badRequest("No fillable orders");
      }

      if (payload.quantity > 1) {
        if (!listingDetails.every((d) => d.contractKind === "erc1155")) {
          throw Boom.badData("Only ERC1155 tokens support a quantity greater than one");
        }
      }

      if (payload.onlyPath) {
        // Only return the path if that's what was requested
        return { path };
      }

      let buyInCurrency = payload.currency;
      if (!buyInCurrency) {
        // If no buy-in-currency is specified then we use the following defaults:
        if (path.length === 1) {
          // If a single order is to get filled, we use its currency
          buyInCurrency = path[0].currency;
        } else if (path.every((p) => p.currency === path[0].currency)) {
          // If multiple same-currency orders are to get filled, we use that currency
          buyInCurrency = path[0].currency;
        } else {
          // If multiple different-currency orders are to get filled, we use the native currency
          buyInCurrency = Sdk.Common.Addresses.Eth[config.chainId];
        }
      }

      const router = new Sdk.RouterV6.Router(config.chainId, baseProvider, {
        x2y2ApiKey: payload.x2y2ApiKey ?? config.x2y2ApiKey,
        cbApiKey: config.cbApiKey,
      });
      const { txData, success } = await router.fillListingsTx(
        listingDetails,
        payload.taker,
        buyInCurrency,
        {
          source: payload.source,
          // TODO: Add support for buying any listing via any ERC20 token
          globalFees: buyInCurrency === Sdk.Common.Addresses.Eth[config.chainId] ? feesOnTop : [],
          partial: payload.partial,
          forceRouter: payload.forceRouter,
          directFillingData: {
            conduitKey:
              config.chainId === 1
                ? "0xcd0b087e113152324fca962488b4d9beb6f4caf6f100000000000000000000f1"
                : undefined,
          },
          relayer: payload.relayer,
        }
      );

      logger.info(
        "execute-buy-v6",
        JSON.stringify({
          txData,
          payload,
          listingDetails,
        })
      );

      // Set up generic filling steps
      const steps: {
        id: string;
        action: string;
        description: string;
        kind: string;
        items: {
          status: string;
          data?: any;
        }[];
      }[] = [
        {
          id: "currency-approval",
          action: "Approve exchange contract",
          description: "A one-time setup transaction to enable trading",
          kind: "transaction",
          items: [],
        },
        {
          id: "sale",
          action: "Confirm transaction in your wallet",
          description: "To purchase this item you must confirm the transaction and pay the gas fee",
          kind: "transaction",
          items: [],
        },
      ];

      const taker = payload.taker;
      const relayer = payload.relayer;
      const txSender = relayer ?? taker;

      // Check that the taker has enough funds to fill all requested tokens
      const totalPrice = path.map(({ rawQuote }) => bn(rawQuote)).reduce((a, b) => a.add(b));
      if (buyInCurrency === Sdk.Common.Addresses.Eth[config.chainId]) {
        const balance = await baseProvider.getBalance(txSender);
        if (!payload.skipBalanceCheck && bn(balance).lt(totalPrice)) {
          throw Boom.badData("Balance too low to proceed with transaction");
        }
      } else {
        const erc20 = new Sdk.Common.Helpers.Erc20(baseProvider, buyInCurrency);

        const balance = await erc20.getBalance(txSender);
        if (!payload.skipBalanceCheck && bn(balance).lt(totalPrice)) {
          throw Boom.badData("Balance too low to proceed with transaction");
        }

        let conduit: string;
        if (listingDetails.every((d) => d.kind === "seaport")) {
          // TODO: Have a default conduit for each exchange per chain
          conduit =
            config.chainId === 1
              ? // Use OpenSea's conduit for sharing approvals
                "0x1e0049783f008a0085193e00003d00cd54003c71"
              : Sdk.Seaport.Addresses.Exchange[config.chainId];
        } else if (listingDetails.every((d: any) => d.kind === "nftearth")) {
          conduit = Sdk.NFTEarth.Addresses.Exchange[config.chainId];
        } else if (listingDetails.every((d) => d.kind === "universe")) {
          conduit = Sdk.Universe.Addresses.Exchange[config.chainId];
        } else if (listingDetails.every((d) => d.kind === "rarible")) {
          conduit = Sdk.Rarible.Addresses.Exchange[config.chainId];
        } else {
          throw new Error("Only Seaport, Universe and Rarible ERC20 listings are supported");
        }

        const allowance = await erc20.getAllowance(txSender, conduit);
        if (bn(allowance).lt(totalPrice)) {
          const tx = erc20.approveTransaction(txSender, conduit);
          steps[0].items.push({
            status: "incomplete",
            data: {
              ...tx,
              from: txSender,
              maxFeePerGas: payload.maxFeePerGas
                ? bn(payload.maxFeePerGas).toHexString()
                : undefined,
              maxPriorityFeePerGas: payload.maxPriorityFeePerGas
                ? bn(payload.maxPriorityFeePerGas).toHexString()
                : undefined,
            },
          });
        }
      }

      steps[1].items.push({
        status: "incomplete",
        data: {
          ...txData,
          maxFeePerGas: payload.maxFeePerGas ? bn(payload.maxFeePerGas).toHexString() : undefined,
          maxPriorityFeePerGas: payload.maxPriorityFeePerGas
            ? bn(payload.maxPriorityFeePerGas).toHexString()
            : undefined,
        },
      });

      return {
        steps,
        // Remove any unsuccessfully handled listings from the path
        path: path.filter((_, i) => success[i]),
      };
    } catch (error) {
      logger.error(`get-execute-buy-${version}-handler`, `Handler failure: ${error}`);
      throw error;
    }
  },
};

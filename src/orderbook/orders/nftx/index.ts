import { AddressZero } from "@ethersproject/constants";
import { keccak256 } from "@ethersproject/solidity";
import * as Sdk from "@nftearth/sdk";
import _ from "lodash";
import pLimit from "p-limit";

import { idb, pgp, redb } from "@/common/db";
import { logger } from "@/common/logger";
import { baseProvider } from "@/common/provider";
import { bn, toBuffer } from "@/common/utils";
import { config } from "@/config/index";
import * as ordersUpdateById from "@/jobs/order-updates/by-id-queue";
import { Sources } from "@/models/sources";
import * as commonHelpers from "@/orderbook/orders/common/helpers";
import { DbOrder, OrderMetadata, generateSchemaHash } from "@/orderbook/orders/utils";
import * as tokenSet from "@/orderbook/token-sets";
import * as nftx from "@/utils/nftx";
import * as royalties from "@/utils/royalties";

export type OrderInfo = {
  orderParams: {
    pool: string;
    // Validation parameters (for ensuring only the latest event is relevant)
    txHash: string;
    txTimestamp: number;
    txBlock: number;
    logIndex: number;
  };
  metadata: OrderMetadata;
};

type SaveResult = {
  id: string;
  txHash: string;
  txTimestamp: number;
  status: string;
  triggerKind?: "new-order" | "reprice" | "cancel";
};

export const getOrderId = (pool: string, side: "sell" | "buy", tokenId?: string) =>
  side === "buy"
    ? // Buy orders have a single order id per pool
      keccak256(["string", "address", "string"], ["nftx", pool, side])
    : // Sell orders have multiple order ids per pool (one for each potential token id)
      keccak256(["string", "address", "string", "uint256"], ["nftx", pool, side, tokenId]);

export const save = async (orderInfos: OrderInfo[]): Promise<SaveResult[]> => {
  const results: SaveResult[] = [];
  const orderValues: DbOrder[] = [];

  // Save prices without any slippage
  const slippage = 0;

  const handleOrder = async ({ orderParams }: OrderInfo) => {
    try {
      const pool = await nftx.getNftPoolDetails(orderParams.pool);
      if (!pool) {
        // Return early if no pool was found
        return;
      }

      const nftResult = await idb.oneOrNone(
        `
          SELECT
            contracts.kind
          FROM contracts
          WHERE contracts.address = $/address/
        `,
        { address: toBuffer(pool.nft) }
      );
      if (!nftResult || nftResult.kind !== "erc721") {
        // For now, only ERC721 collections are supported
        return;
      }

      // Handle: fees
      let feeBps = 0;
      const feeBreakdown: {
        kind: string;
        recipient: string;
        bps: number;
      }[] = [];

      const poolFeatures = await Sdk.Nftx.Helpers.getPoolFeatures(orderParams.pool, baseProvider);

      // Handle buy orders
      try {
        const id = getOrderId(orderParams.pool, "buy");

        // Requirements for buy orders:
        // - pool is not shutdown
        // - pool has no eligibility criteria
        // - pool has minting enabled

        if (
          poolFeatures.assetAddress === AddressZero ||
          !poolFeatures.allowAllItems ||
          !poolFeatures.enableMint
        ) {
          await idb.none(
            `
              UPDATE orders SET
                fillability_status = 'cancelled',
                expiration = to_timestamp(${orderParams.txTimestamp}),
                updated_at = now()
              WHERE orders.id = $/id/
                AND lower(orders.valid_between) < to_timestamp(${orderParams.txTimestamp})
            `,
            { id }
          );
          results.push({
            id,
            txHash: orderParams.txHash,
            txTimestamp: orderParams.txTimestamp,
            status: "success",
            triggerKind: "cancel",
          });
        } else {
          const priceList = [];
          for (let index = 0; index < 10; index++) {
            try {
              const poolPrice = await Sdk.Nftx.Helpers.getPoolPrice(
                orderParams.pool,
                index + 1,
                "sell",
                slippage,
                baseProvider
              );
              priceList.push(poolPrice);
            } catch {
              break;
            }
          }

          if (priceList.length) {
            // Handle: prices
            const { price, feeBps: bps } = priceList[0];
            const value = bn(price).sub(bn(price).mul(bps).div(10000)).toString();

            const prices: string[] = [];
            for (const p of priceList) {
              prices.push(
                bn(p.price)
                  .sub(prices.length ? priceList[prices.length - 1].price : 0)
                  .toString()
              );
            }

            // Handle: fees
            feeBps = Number(bps);
            feeBreakdown.push({
              kind: "marketplace",
              recipient: pool.address,
              bps: feeBps,
            });

            // Handle: royalties on top
            const defaultRoyalties = await royalties.getRoyaltiesByTokenSet(
              `contract:${pool.nft}`,
              "default"
            );

            const totalBuiltInBps = 0;
            const totalDefaultBps = defaultRoyalties
              .map(({ bps }) => bps)
              .reduce((a, b) => a + b, 0);

            const missingRoyalties = [];
            let missingRoyaltyAmount = bn(0);
            if (totalBuiltInBps < totalDefaultBps) {
              const validRecipients = defaultRoyalties.filter(
                ({ bps, recipient }) => bps && recipient !== AddressZero
              );
              if (validRecipients.length) {
                const bpsDiff = totalDefaultBps - totalBuiltInBps;
                const amount = bn(price).mul(bpsDiff).div(10000);
                missingRoyaltyAmount = missingRoyaltyAmount.add(amount);

                // Split the missing royalties pro-rata across all royalty recipients
                const totalBps = _.sumBy(validRecipients, ({ bps }) => bps);
                for (const { bps, recipient } of validRecipients) {
                  // TODO: Handle lost precision (by paying it to the last or first recipient)
                  missingRoyalties.push({
                    bps: Math.floor((bpsDiff * bps) / totalBps),
                    amount: amount.mul(bps).div(totalBps).toString(),
                    recipient,
                  });
                }
              }
            }

            const normalizedValue = bn(value).sub(missingRoyaltyAmount);

            // Handle: core sdk order
            const sdkOrder = new Sdk.Nftx.Order(config.chainId, {
              vaultId: pool.vaultId.toString(),
              collection: pool.nft,
              pool: pool.address,
              specificIds: [],
              currency: Sdk.Common.Addresses.Weth[config.chainId],
              path: [pool.address, Sdk.Common.Addresses.Weth[config.chainId]],
              price: price.toString(),
              extra: {
                prices,
              },
            });

            let orderResult = await idb.oneOrNone(
              `
                SELECT
                  orders.token_set_id
                FROM orders
                WHERE orders.id = $/id/
              `,
              { id }
            );
            if (orderResult && !orderResult.token_set_id) {
              // Delete the order since it is an incomplete one resulted from 'partial' insertion of
              // fill events. The issue only occurs for buy orders since sell orders are handled via
              // 'on-chain' fill events which don't insert such incomplete orders.
              await idb.none(`DELETE FROM orders WHERE orders.id = $/id/`, { id });
              orderResult = false;
            }

            if (!orderResult) {
              // Handle: token set
              const schemaHash = generateSchemaHash();
              const [{ id: tokenSetId }] = await tokenSet.contractWide.save([
                {
                  id: `contract:${pool.nft}`,
                  schemaHash,
                  contract: pool.nft,
                },
              ]);

              if (!tokenSetId) {
                throw new Error("No token set available");
              }

              // Handle: source
              const sources = await Sources.getInstance();
              const source = await sources.getOrInsert("nftx.io");

              const validFrom = `date_trunc('seconds', to_timestamp(${orderParams.txTimestamp}))`;
              const validTo = `'Infinity'`;

              orderValues.push({
                id,
                kind: "nftx",
                side: "buy",
                fillability_status: "fillable",
                approval_status: "approved",
                token_set_id: tokenSetId,
                token_set_schema_hash: toBuffer(schemaHash),
                maker: toBuffer(pool.address),
                taker: toBuffer(AddressZero),
                price: price.toString(),
                value,
                currency: toBuffer(Sdk.Common.Addresses.Eth[config.chainId]),
                currency_price: price.toString(),
                currency_value: value,
                needs_conversion: null,
                quantity_remaining: prices.length.toString(),
                valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
                nonce: null,
                source_id_int: source?.id,
                is_reservoir: null,
                contract: toBuffer(pool.nft),
                conduit: null,
                fee_bps: feeBps,
                fee_breakdown: feeBreakdown,
                dynamic: null,
                raw_data: sdkOrder.params,
                expiration: validTo,
                missing_royalties: missingRoyalties,
                normalized_value: normalizedValue.toString(),
                currency_normalized_value: normalizedValue.toString(),
                block_number: orderParams.txBlock ?? null,
                log_index: orderParams.logIndex ?? null,
              });

              results.push({
                id,
                txHash: orderParams.txHash,
                txTimestamp: orderParams.txTimestamp,
                status: "success",
                triggerKind: "new-order",
              });
            } else {
              await idb.none(
                `
                  UPDATE orders SET
                    fillability_status = 'fillable',
                    approval_status = 'approved',
                    price = $/price/,
                    currency_price = $/price/,
                    value = $/value/,
                    currency_value = $/value/,
                    quantity_remaining = $/quantityRemaining/,
                    valid_between = tstzrange(date_trunc('seconds', to_timestamp(${orderParams.txTimestamp})), 'Infinity', '[]'),
                    expiration = 'Infinity',
                    updated_at = now(),
                    raw_data = $/rawData:json/,
                    missing_royalties = $/missingRoyalties:json/,
                    normalized_value = $/normalizedValue/,
                    currency_normalized_value = $/currencyNormalizedValue/,
                    fee_bps = $/feeBps/,
                    fee_breakdown = $/feeBreakdown:json/,
                    currency = $/currency/,
                    block_number = $/blockNumber/,
                    log_index = $/logIndex/
                  WHERE orders.id = $/id/
                    AND lower(orders.valid_between) < to_timestamp(${orderParams.txTimestamp})
                `,
                {
                  id,
                  price,
                  value,
                  rawData: sdkOrder.params,
                  quantityRemaining: prices.length.toString(),
                  missingRoyalties: missingRoyalties,
                  normalizedValue: normalizedValue.toString(),
                  currencyNormalizedValue: normalizedValue.toString(),
                  feeBps,
                  feeBreakdown,
                  currency: toBuffer(Sdk.Common.Addresses.Eth[config.chainId]),
                  blockNumber: orderParams.txBlock,
                  logIndex: orderParams.logIndex,
                }
              );
              results.push({
                id,
                txHash: orderParams.txHash,
                txTimestamp: orderParams.txTimestamp,
                status: "success",
                triggerKind: "reprice",
              });
            }
          } else {
            await idb.none(
              `
                UPDATE orders SET
                  fillability_status = 'no-balance',
                  expiration = to_timestamp(${orderParams.txTimestamp}),
                  updated_at = now()
                WHERE orders.id = $/id/
                  AND lower(orders.valid_between) < to_timestamp(${orderParams.txTimestamp})
              `,
              { id }
            );
            results.push({
              id,
              txHash: orderParams.txHash,
              txTimestamp: orderParams.txTimestamp,
              status: "success",
              triggerKind: "reprice",
            });
          }
        }
      } catch (error) {
        logger.error(
          "orders-nftx-save",
          `Failed to handle buy order with params ${JSON.stringify(orderParams)}: ${error}`
        );
      }

      // Handle sell orders
      try {
        const priceList = [];
        for (let index = 0; index < 10; index++) {
          try {
            const poolPrice = await Sdk.Nftx.Helpers.getPoolPrice(
              orderParams.pool,
              index + 1,
              "buy",
              slippage,
              baseProvider
            );
            priceList.push(poolPrice);
          } catch {
            break;
          }
        }

        const prices: string[] = [];
        for (const p of priceList) {
          prices.push(
            bn(p.price)
              .sub(prices.length ? priceList[prices.length - 1].price : 0)
              .toString()
          );
        }

        // Handle: prices
        const { price, feeBps: bps } = priceList[0];
        const value = price;

        // Handle: fees
        feeBps = Number(bps);
        feeBreakdown.push({
          kind: "marketplace",
          recipient: pool.address,
          bps: feeBps,
        });

        // Fetch all token ids owned by the pool
        const poolOwnedTokenIds = await commonHelpers.getNfts(pool.nft, pool.address);

        const limit = pLimit(50);
        await Promise.all(
          poolOwnedTokenIds.map((tokenId) =>
            limit(async () => {
              try {
                const id = getOrderId(orderParams.pool, "sell", tokenId);

                // Handle: royalties on top
                const defaultRoyalties = await royalties.getRoyaltiesByTokenSet(
                  `token:${pool.nft}:${tokenId}`,
                  "default"
                );
                const totalBuiltInBps = 0;
                const totalDefaultBps = defaultRoyalties
                  .map(({ bps }) => bps)
                  .reduce((a, b) => a + b, 0);

                const missingRoyalties: { bps: number; amount: string; recipient: string }[] = [];
                let missingRoyaltyAmount = bn(0);
                if (totalBuiltInBps < totalDefaultBps) {
                  const validRecipients = defaultRoyalties.filter(
                    ({ bps, recipient }) => bps && recipient !== AddressZero
                  );
                  if (validRecipients.length) {
                    const bpsDiff = totalDefaultBps - totalBuiltInBps;
                    const amount = bn(price).mul(bpsDiff).div(10000);
                    missingRoyaltyAmount = missingRoyaltyAmount.add(amount);

                    // Split the missing royalties pro-rata across all royalty recipients
                    const totalBps = _.sumBy(validRecipients, ({ bps }) => bps);
                    for (const { bps, recipient } of validRecipients) {
                      // TODO: Handle lost precision (by paying it to the last or first recipient)
                      missingRoyalties.push({
                        bps: Math.floor((bpsDiff * bps) / totalBps),
                        amount: amount.mul(bps).div(totalBps).toString(),
                        recipient,
                      });
                    }
                  }
                }

                const normalizedValue = bn(value).add(missingRoyaltyAmount);

                // Requirements for sell orders:
                // - pool has target redeem enabled

                if (!poolFeatures.enableTargetRedeem) {
                  await idb.none(
                    `
                      UPDATE orders SET
                        fillability_status = 'cancelled',
                        expiration = to_timestamp(${orderParams.txTimestamp}),
                        updated_at = now()
                      WHERE orders.id = $/id/
                        AND lower(orders.valid_between) < to_timestamp(${orderParams.txTimestamp})
                    `,
                    { id }
                  );
                  results.push({
                    id,
                    txHash: orderParams.txHash,
                    txTimestamp: orderParams.txTimestamp,
                    status: "success",
                    triggerKind: "cancel",
                  });
                } else {
                  if (!priceList.length) {
                    return;
                  }

                  // Handle: core sdk order
                  const sdkOrder = new Sdk.Nftx.Order(config.chainId, {
                    vaultId: pool.vaultId.toString(),
                    collection: pool.nft,
                    pool: pool.address,
                    specificIds: [tokenId],
                    currency: Sdk.Common.Addresses.Weth[config.chainId],
                    amount: "1",
                    path: [Sdk.Common.Addresses.Weth[config.chainId], pool.address],
                    price: price.toString(),
                    extra: {
                      prices,
                    },
                  });

                  const orderResult = await redb.oneOrNone(
                    `
                      SELECT 1 FROM orders
                      WHERE orders.id = $/id/
                    `,
                    { id }
                  );
                  if (!orderResult && poolFeatures.enableTargetRedeem) {
                    // Handle: token set
                    const schemaHash = generateSchemaHash();
                    const [{ id: tokenSetId }] = await tokenSet.singleToken.save([
                      {
                        id: `token:${pool.nft}:${tokenId}`,
                        schemaHash,
                        contract: pool.nft,
                        tokenId,
                      },
                    ]);
                    if (!tokenSetId) {
                      throw new Error("No token set available");
                    }

                    // Handle: source
                    const sources = await Sources.getInstance();
                    const source = await sources.getOrInsert("nftx.io");

                    const validFrom = `date_trunc('seconds', to_timestamp(${orderParams.txTimestamp}))`;
                    const validTo = `'Infinity'`;
                    orderValues.push({
                      id,
                      kind: "nftx",
                      side: "sell",
                      fillability_status: "fillable",
                      approval_status: "approved",
                      token_set_id: tokenSetId,
                      token_set_schema_hash: toBuffer(schemaHash),
                      maker: toBuffer(pool.address),
                      taker: toBuffer(AddressZero),
                      price: price.toString(),
                      value: value.toString(),
                      currency: toBuffer(Sdk.Common.Addresses.Eth[config.chainId]),
                      currency_price: price.toString(),
                      currency_value: value.toString(),
                      needs_conversion: null,
                      quantity_remaining: "1",
                      valid_between: `tstzrange(${validFrom}, ${validTo}, '[]')`,
                      nonce: null,
                      source_id_int: source?.id,
                      is_reservoir: null,
                      contract: toBuffer(pool.nft),
                      conduit: null,
                      fee_bps: feeBps,
                      fee_breakdown: feeBreakdown,
                      dynamic: null,
                      raw_data: sdkOrder.params,
                      expiration: validTo,
                      missing_royalties: missingRoyalties,
                      normalized_value: normalizedValue.toString(),
                      currency_normalized_value: normalizedValue.toString(),
                      block_number: orderParams.txBlock ?? null,
                      log_index: orderParams.logIndex ?? null,
                    });

                    results.push({
                      id,
                      txHash: orderParams.txHash,
                      txTimestamp: orderParams.txTimestamp,
                      status: "success",
                      triggerKind: "new-order",
                    });
                  } else {
                    await idb.none(
                      `
                        UPDATE orders SET
                          fillability_status = 'fillable',
                          approval_status = 'approved',
                          price = $/price/,
                          currency_price = $/price/,
                          value = $/value/,
                          currency_value = $/value/,
                          quantity_remaining = 1,
                          valid_between = tstzrange(date_trunc('seconds', to_timestamp(${orderParams.txTimestamp})), 'Infinity', '[]'),
                          expiration = 'Infinity',
                          updated_at = now(),
                          raw_data = $/rawData:json/,
                          missing_royalties = $/missingRoyalties:json/,
                          normalized_value = $/normalizedValue/,
                          currency_normalized_value = $/currencyNormalizedValue/,
                          fee_bps = $/feeBps/,
                          fee_breakdown = $/feeBreakdown:json/,
                          currency = $/currency/,
                          block_number = $/blockNumber/,
                          log_index = $/logIndex/
                        WHERE orders.id = $/id/
                          AND lower(orders.valid_between) < to_timestamp(${orderParams.txTimestamp})
                      `,
                      {
                        id,
                        price,
                        value,
                        rawData: sdkOrder.params,
                        missingRoyalties: missingRoyalties,
                        normalizedValue: normalizedValue.toString(),
                        currencyNormalizedValue: normalizedValue.toString(),
                        feeBps,
                        feeBreakdown,
                        currency: toBuffer(Sdk.Common.Addresses.Eth[config.chainId]),
                        blockNumber: orderParams.txBlock,
                        logIndex: orderParams.logIndex,
                      }
                    );

                    results.push({
                      id,
                      txHash: orderParams.txHash,
                      txTimestamp: orderParams.txTimestamp,
                      status: "success",
                      triggerKind: "reprice",
                    });
                  }
                }
              } catch {
                // Ignore any errors
              }
            })
          )
        );
      } catch (error) {
        logger.error(
          "orders-nftx-save",
          `Failed to handle sell order with params ${JSON.stringify(orderParams)}: ${error}`
        );
      }
    } catch (error) {
      logger.error(
        "orders-nftx-save",
        `Failed to handle order with params ${JSON.stringify(orderParams)}: ${error}`
      );
    }
  };

  // Process all orders concurrently
  const limit = pLimit(20);
  await Promise.all(orderInfos.map((orderInfo) => limit(() => handleOrder(orderInfo))));

  if (orderValues.length) {
    const columns = new pgp.helpers.ColumnSet(
      [
        "id",
        "kind",
        "side",
        "fillability_status",
        "approval_status",
        "token_set_id",
        "token_set_schema_hash",
        "maker",
        "taker",
        "price",
        "value",
        "currency",
        "currency_price",
        "currency_value",
        "needs_conversion",
        "quantity_remaining",
        { name: "valid_between", mod: ":raw" },
        "nonce",
        "source_id_int",
        "is_reservoir",
        "contract",
        "fee_bps",
        { name: "fee_breakdown", mod: ":json" },
        "dynamic",
        "raw_data",
        { name: "expiration", mod: ":raw" },
        { name: "missing_royalties", mod: ":json" },
        "normalized_value",
        "currency_normalized_value",
        "block_number",
        "log_index",
      ],
      {
        table: "orders",
      }
    );
    await idb.none(pgp.helpers.insert(orderValues, columns) + " ON CONFLICT DO NOTHING");
  }

  await ordersUpdateById.addToQueue(
    results
      .filter(({ status }) => status === "success")
      .map(
        ({ id, txHash, txTimestamp, triggerKind }) =>
          ({
            context: `${triggerKind}-${id}-${txHash}`,
            id,
            trigger: {
              kind: triggerKind,
              txHash: txHash,
              txTimestamp: txTimestamp,
            },
          } as ordersUpdateById.OrderInfo)
      )
  );

  return results;
};

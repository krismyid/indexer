/* eslint-disable @typescript-eslint/no-explicit-any */
import * as Sdk from "@nftearth/sdk";
import axios from "axios";

import { logger } from "@/common/logger";
import { config } from "@/config/index";
import {
  InvalidRequestError,
  RequestWasThrottledError,
} from "@/jobs/orderbook/post-order-external/api/errors";

// Flow default rate limit - 60 requests per minute
export const RATE_LIMIT_REQUEST_COUNT = 60;
export const RATE_LIMIT_INTERVAL = 60;

export async function postOrders(orders: Sdk.Flow.Order[], apiKey: string): Promise<void>;
export async function postOrders(order: Sdk.Flow.Order, apiKey: string): Promise<void>;
export async function postOrders(
  order: Sdk.Flow.Order | Sdk.Flow.Order[],
  apiKey: string
): Promise<void> {
  const url = `https://sv.flow.so/v2/orders`;

  const orders = Array.isArray(order) ? order : [order];
  try {
    await axios.post(
      url,
      JSON.stringify({
        chainId: config.chainId.toString(),
        orders: orders.map((item) => item.getSignedOrder()),
      }),
      {
        headers: {
          "X-Api-Key": apiKey || config.flowApiKey,
        },
      }
    );
  } catch (err: any) {
    if (err?.response) {
      logger.error(
        "flow_orderbook_api",
        `Failed to post order to Flow. order=${JSON.stringify(order)}, status: ${
          err?.response?.status
        }, data:${JSON.stringify(err?.response?.data)}`
      );

      handleErrorResponse(err.response);
    }
    throw new Error(`Failed to post order to Flow`);
  }
}

const handleErrorResponse = (response: any) => {
  switch (response.status) {
    case 429: {
      let delay = RATE_LIMIT_INTERVAL;

      if ("x-ratelimit-reset" in response.headers) {
        delay = parseInt(response.headers["x-ratelimit-reset"], 10) * 1000;
      }
      throw new RequestWasThrottledError("Request was throttled by Flow", delay);
    }
    case 400:
      throw new InvalidRequestError("Request was rejected by Flow");
  }
};

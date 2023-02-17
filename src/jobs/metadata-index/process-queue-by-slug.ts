/* eslint-disable @typescript-eslint/no-explicit-any */

import { Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { redis, extendLock, releaseLock } from "@/common/redis";
import { config } from "@/config/index";
import * as metadataIndexWrite from "@/jobs/metadata-index/write-queue";
import MetadataApi from "@/utils/metadata-api";
import * as metadataIndexFetch from "@/jobs/metadata-index/fetch-queue";
import * as collectionUpdatesMetadata from "@/jobs/collection-updates/metadata-queue";
import _ from "lodash";
import { PendingRefreshTokensBySlug } from "@/models/pending-refresh-tokens-by-slug";
import { Tokens } from "@/models/tokens";

const QUEUE_NAME = "metadata-index-process-queue-by-slug";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "fixed",
      delay: 5000,
    },
    removeOnComplete: 100,
    removeOnFail: 100,
    timeout: 60 * 1000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      const method = "opensea";
      const count = 1; // Default number of tokens to fetch
      let retry = false;

      const countTotal = config.maxParallelTokenCollectionSlugRefreshJobs * count;

      // Get the collection slugs from the list
      const pendingRefreshTokensBySlug = new PendingRefreshTokensBySlug();
      const refreshTokensBySlug = await pendingRefreshTokensBySlug.get(countTotal);

      // If no more collection slugs, release lock
      if (_.isEmpty(refreshTokensBySlug)) {
        await releaseLock(getLockName(method));

        return;
      }
      let rateLimitExpiredIn = 0;
      const metadata: any[] = [];
      await Promise.all(
        refreshTokensBySlug.map(async (refreshTokenBySlug) => {
          try {
            const results = await MetadataApi.getTokensMetadataBySlug(
              refreshTokenBySlug.contract,
              refreshTokenBySlug.slug,
              method,
              refreshTokenBySlug.continuation
            );
            if (results.continuation) {
              retry = true;
              await pendingRefreshTokensBySlug.add(
                {
                  slug: refreshTokenBySlug.slug,
                  contract: refreshTokenBySlug.contract,
                  collection: refreshTokenBySlug.collection,
                  continuation: results.continuation,
                },
                true
              );
            }
            if (results.metadata.length === 0) {
              logger.warn(
                QUEUE_NAME,
                `Method=${method}. Metadata list is empty on collection slug ${refreshTokenBySlug.slug}. Slug might be missing so pushing message to the following queues to update collection metadata and token metadata: ${metadataIndexFetch.QUEUE_NAME}, ${collectionUpdatesMetadata.QUEUE_NAME}`
              );
              const tokenId = await Tokens.getSingleToken(refreshTokenBySlug.collection);
              await Promise.all([
                metadataIndexFetch.addToQueue(
                  [
                    {
                      kind: "full-collection",
                      data: {
                        method,
                        collection: refreshTokenBySlug.collection,
                      },
                    },
                  ],
                  true
                ),
                collectionUpdatesMetadata.addToQueue(
                  refreshTokenBySlug.contract,
                  tokenId,
                  method,
                  0
                ),
              ]);
              return;
            } else {
              metadata.push(...results.metadata);
            }
          } catch (error: any) {
            if (error.response?.status === 429) {
              logger.warn(
                QUEUE_NAME,
                `Too Many Requests. method=${method}, error=${JSON.stringify(error.response.data)}`
              );

              rateLimitExpiredIn = Math.max(rateLimitExpiredIn, error.response.data.expires_in, 5);

              await pendingRefreshTokensBySlug.add(refreshTokenBySlug, true);
            } else if (error.response.status === 400) {
              await metadataIndexFetch.addToQueue(
                [
                  {
                    kind: "full-collection",
                    data: {
                      method,
                      collection: refreshTokenBySlug.contract,
                    },
                  },
                ],
                true
              );
            } else {
              logger.error(
                QUEUE_NAME,
                `Error. method=${method}, error=${JSON.stringify(error.response.data)}`
              );

              if (error.response?.data.error === "Request failed with status code 403") {
                await pendingRefreshTokensBySlug.add(refreshTokenBySlug, true);
                retry = true;
              }
            }
          }
        })
      );

      logger.info(
        QUEUE_NAME,
        `Debug. method=${method}, metadata=${metadata.length}, rateLimitExpiredIn=${rateLimitExpiredIn}`
      );

      await metadataIndexWrite.addToQueue(
        metadata.map((m) => ({
          ...m,
        }))
      );

      // If there are potentially more tokens to process trigger another job
      if (rateLimitExpiredIn || _.size(refreshTokensBySlug) == countTotal || retry) {
        if (await extendLock(getLockName(method), 60 * 5 + rateLimitExpiredIn)) {
          await addToQueue(rateLimitExpiredIn * 1000);
        }
      } else {
        await releaseLock(getLockName(method));
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

export const getLockName = (method: string) => {
  return `${QUEUE_NAME}:${method}`;
};

export const addToQueue = async (delay = 0) => {
  await queue.add(randomUUID(), {}, { delay });
};

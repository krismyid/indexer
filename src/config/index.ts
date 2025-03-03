export const config = {
  version: String(process.env.VERSION),
  port: Number(process.env.PORT),
  chainId: Number(process.env.CHAIN_ID),

  reservoirAPIBase: String(process.env.RESERVOIR_API_BASE),

  adminApiKey: String(process.env.ADMIN_API_KEY),
  bullmqAdminPassword: String(process.env.BULLMQ_ADMIN_PASSWORD),
  arweaveRelayerKey: process.env.ARWEAVE_RELAYER_KEY
    ? String(process.env.ARWEAVE_RELAYER_KEY)
    : undefined,
  oraclePrivateKey: String(process.env.ORACLE_PRIVATE_KEY),
  oracleAwsKmsKeyId: String(process.env.ORACLE_AWS_KMS_KEY_ID),
  oracleAwsKmsKeyRegion: String(process.env.ORACLE_AWS_KMS_KEY_REGION),

  baseNetworkHttpUrl: String(process.env.BASE_NETWORK_HTTP_URL),
  baseNetworkWsUrl: String(process.env.BASE_NETWORK_WS_URL),
  traceNetworkHttpUrl: String(
    process.env.TRACE_NETWORK_HTTP_URL ?? process.env.BASE_NETWORK_HTTP_URL
  ),
  openseaIndexerApiBaseUrl: String(process.env.OPENSEA_INDEXER_API_BASE_URL),
  simpleHashIndexerApiBaseUrl: String(process.env.SIMPLEHASH_INDEXER_API_BASE_URL),

  // When running in liquidity-only mode, all metadata processes are disabled
  liquidityOnly: !process.env.METADATA_API_BASE_URL,
  metadataIndexingMethod: String(process.env.METADATA_INDEXING_METHOD || "opensea"),
  metadataIndexingMethodCollection: String(
    process.env.METADATA_INDEXING_METHOD_COLLECTION ||
      process.env.METADATA_INDEXING_METHOD ||
      "opensea"
  ),
  metadataApiBaseUrl: String(process.env.METADATA_API_BASE_URL),
  metadataApiBaseUrlAlt: String(
    process.env.METADATA_API_BASE_URL_ALT || process.env.METADATA_API_BASE_URL
  ),

  disableRealtimeMetadataRefresh: Boolean(Number(process.env.DISABLE_REALTIME_METADATA_REFRESH)),

  databaseUrl: String(process.env.DATABASE_URL),
  readReplicaDatabaseUrl: String(process.env.READ_REPLICA_DATABASE_URL || process.env.DATABASE_URL),
  writeReplicaDatabaseUrl: String(
    process.env.WRITE_REPLICA_DATABASE_URL || process.env.DATABASE_URL
  ),
  redisUrl: String(process.env.REDIS_URL),
  rateLimitRedisUrl: String(process.env.RATE_LIMIT_REDIS_URL || process.env.REDIS_URL),
  redshiftUrl: String(process.env.REDSHIFT_URL),

  master: Boolean(Number(process.env.MASTER)),
  catchup: Boolean(Number(process.env.CATCHUP)),
  doBackgroundWork: Boolean(Number(process.env.DO_BACKGROUND_WORK)),
  doWebsocketWork: Boolean(Number(process.env.DO_WEBSOCKET_WORK)),
  doWebsocketServerWork: Boolean(Number(process.env.DO_WEBSOCKET_SERVER_WORK)),
  doEventsSyncBackfill: Boolean(Number(process.env.DO_EVENTS_SYNC_BACKFILL)),
  disableOrders: Boolean(Number(process.env.DISABLE_ORDERS)),

  maxTokenSetSize: 100000,

  awsAccessKeyId: String(process.env.AWS_ACCESS_KEY_ID || process.env.FC_AWS_ACCESS_KEY_ID),
  awsSecretAccessKey: String(
    process.env.AWS_SECRET_ACCESS_KEY || process.env.FC_AWS_SECRET_ACCESS_KEY
  ),

  dataExportS3BucketName: String(process.env.DATA_EXPORT_S3_BUCKET_NAME),
  dataExportAwsAccessRole: String(process.env.DATA_EXPORT_AWS_ACCESS_ROLE),
  dataExportAwsS3UploadRole: String(process.env.DATA_EXPORT_AWS_S3_UPLOAD_ROLE),
  dataExportAwsS3UploadExternalId: String(process.env.DATA_EXPORT_AWS_S3_UPLOAD_EXTERNAL_ID),
  dataExportS3ArchiveBucketName: process.env.DATA_EXPORT_S3_ARCHIVE_BUCKET_NAME
    ? String(process.env.DATA_EXPORT_S3_ARCHIVE_BUCKET_NAME)
    : undefined,

  openseaWebsocketEventsAwsFirehoseDeliveryStreamName: String(
    process.env.OPENSEA_WEBSOCKET_EVENTS_AWS_FIREHOSE_DELIVERY_STREAM_NAME
  ),
  openseaWebsocketEventsAwsFirehoseDeliveryStreamRegion: String(
    process.env.OPENSEA_WEBSOCKET_EVENTS_AWS_FIREHOSE_DELIVERY_STREAM_REGION
  ),

  // For forwarding orders to OpenSea
  forwardOpenseaApiKey: String(process.env.FORWARD_OPENSEA_API_KEY),
  forwardReservoirApiKeys: process.env.FORWARD_RESERVOIR_API_KEYS
    ? (JSON.parse(process.env.FORWARD_RESERVOIR_API_KEYS) as string[])
    : [],

  looksRareApiKey: String(process.env.LOOKSRARE_API_KEY),
  openSeaApiKey: String(process.env.OPENSEA_API_KEY),
  x2y2ApiKey: String(process.env.X2Y2_API_KEY),
  cbApiKey: String(process.env.CB_API_KEY),
  infinityApiKey: String(process.env.INFINITY_API_KEY),
  flowApiKey: String(process.env.FLOW_API_KEY),
  simpleHashApiKey: String(process.env.SIMPLEHASH_API_KEY),

  railwayStaticUrl: String(process.env.RAILWAY_STATIC_URL || ""),

  cipherSecret: String(process.env.CIPHER_SECRET),

  slackApiKeyWebhookUrl: String(process.env.SLACK_API_KEY_WEBHOOK_URL),
  // Used to prevent redis from being overloaded in heavy process like backfilling
  redisMaxMemoryGB: Number(process.env.REDIS_MAX_MEMORY_GB || 25),

  websocketServerHost: String(process.env.WEBSOCKET_SERVER_HOST),
  websocketServerAppId: String(process.env.WEBSOCKET_SERVER_APP_ID),
  websocketServerAppKey: String(process.env.WEBSOCKET_SERVER_APP_KEY),
  websocketServerAppSecret: String(process.env.WEBSOCKET_SERVER_APP_SECRET),
  websocketServerEventMaxSizeInKb: String(process.env.WEBSOCKET_SERVER_EVENT_MAX_SIZE_IN_KB || 100),
  websocketServerEventMaxBatchSize: String(process.env.WEBSOCKET_SERVER_EVENT_MAX_BATCH_SIZE || 10),

  maxParallelTokenRefreshJobs: Number(process.env.MAX_PARALLEL_TOKEN_REFRESH_JOBS || 1),
  maxParallelTokenCollectionSlugRefreshJobs: Number(
    process.env.MAX_PARALLEL_TOKEN_COLLECTION_SLUG_REFRESH_JOBS || 1
  ),

  // Backfilling
  doNftTransfersWrite: Boolean(Number(process.env.DO_NFT_TRANSFERS_WRITE)),
  doProcessBackfilling: Boolean(Number(process.env.DO_PROCESS_BACKFILLING)),
  doProcessRealtime: Boolean(Number(process.env.DO_PROCESS_REALTIME)),
};

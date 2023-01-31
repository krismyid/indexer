-- Up Migration
INSERT INTO "contracts"("address","kind") VALUES('\xa95579592078783b409803ddc75bb402c217a924','erc721') ON CONFLICT (address) DO UPDATE SET address=EXCLUDED.address;
INSERT INTO "collections"("id","slug","name","metadata","royalties","community","index_metadata","contract","token_id_range","token_set_id","token_count","minted_timestamp","royalties_bps","verified") VALUES('0xa95579592078783b409803ddc75bb402c217a924','introducing-the-optimism-collective','Introducing the Optimism Collective','{"imageUrl":null,"discordUrl":null,"description":null,"externalUrl":null,"bannerImageUrl":null,"twitterUsername":null}','[]',null,null,'\xa95579592078783b409803ddc75bb402c217a924','(,)','contract:0xa95579592078783b409803ddc75bb402c217a924',0,0,0,'t') ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id, contract=EXCLUDED.contract;
-- Down Migration
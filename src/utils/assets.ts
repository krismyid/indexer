import _ from "lodash";
// import { encrypt } from "@/common/utils";
// import { config } from "@/config/index";

export class Assets {
  public static getLocalAssetsLink(assets: string | string[]) {
    if (_.isEmpty(assets) || assets == "") {
      return undefined;
    }

    return assets;
    //
    // const baseUrl = `${config.reservoirAPIBase}/assets/v1?`;
    //
    // if (_.isArray(assets)) {
    //   const assetsResult = [];
    //   for (const asset of _.filter(assets, (a) => !_.isNull(a))) {
    //     const queryParams = new URLSearchParams();
    //     queryParams.append("asset", encrypt(asset));
    //     assetsResult.push(`${baseUrl}${queryParams.toString()}`);
    //   }
    //
    //   return assetsResult;
    // } else {
    //   const queryParams = new URLSearchParams();
    //   queryParams.append("asset", encrypt(assets));
    //
    //   return `${baseUrl}${queryParams.toString()}`;
    // }
  }
}

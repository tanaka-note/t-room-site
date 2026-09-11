import { lineBrowserResponse } from "../assets/line-browser-worker.mjs";
export default {
  fetch(request, env) {
    return lineBrowserResponse(request) || env.ASSETS.fetch(request);
  }
};

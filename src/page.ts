// The served slideshow page: a static HTML shell that mounts the stage-1
// esbuild bundle of page/main.js (see esbuild.js — the bundle arrives as a
// JSON-escaped string constant, so page source may use backticks freely).

import { PAGE_JS } from "./generated/pageBundle";

export const PAGE: string =
  "<!doctype html>\n" +
  '<html lang="en"><head><meta charset="utf-8"/>' +
  '<meta name="viewport" content="width=device-width, initial-scale=1"/>' +
  "<title>Project Planner</title></head>" +
  '<body><div id="app"></div>' +
  "<script>" +
  PAGE_JS +
  "</script></body></html>\n";

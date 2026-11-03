// Node preload: let server-side modules that `import "server-only"` load outside Next.js.
const Module = require("module");
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "server-only") return {};
  return load.call(this, request, ...rest);
};

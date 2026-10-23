import undici from "undici/index.js";

// The upstream loader's only dynamic dependency is pinned into this bundle.
// Do not fall through to arbitrary modules, CLI installations, or host globals.
export const createRequire = () => (id: string) => {
  if (id !== "undici/index.js") throw new Error("Unsupported memory transport dependency");
  return undici;
};

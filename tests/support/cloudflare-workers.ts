// Test replacement for the `cloudflare:workers` module.
// Reads fall back to process.env; tests may assign bindings such as BUCKET.
const overrides: Record<string, unknown> = {};

export const env: Record<string, unknown> = new Proxy(overrides, {
  get(target, key) {
    if (typeof key !== "string") return undefined;
    return key in target ? target[key] : process.env[key];
  },
  set(target, key, value) {
    target[key as string] = value;
    return true;
  },
  deleteProperty(target, key) {
    delete target[key as string];
    return true;
  },
  has(target, key) {
    return typeof key === "string" && (key in target || key in process.env);
  },
});

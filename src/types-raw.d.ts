/** Vite/vitest `?raw` imports — used by openapi-sync.test.ts to read the YAML
 *  source of truth without pulling node:fs into a Worker typing context. */
declare module "*?raw" {
  const content: string;
  export default content;
}

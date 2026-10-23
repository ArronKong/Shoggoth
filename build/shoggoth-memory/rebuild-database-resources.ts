import { callHost } from "shoggoth-memory-host";
export { MemoryManagerDatabaseContext } from "upstream:extensions/memory-core/src/memory/manager-database-context.ts";

// Connection creation is a Product capability. Context selection, closing the
// awaited shadow, rebuild policy and publication algorithms remain upstream.
export class MemoryIndexDatabase {
  static openShadow(filename: string, allowExtension: boolean) {
    return callHost("openMemoryIndexShadow", filename, allowExtension);
  }
}

import { callHost } from "shoggoth-memory-host";

// Only the pinned recall runner imports this facade. It retains the original
// event projection and persistence/cleanup order; Product owns private file IO.
export default {
  mkdir: (...args: unknown[]) => callHost("makeActiveMemoryTranscriptDirectory", ...args),
  chmod: async (...args: unknown[]) => callHost("setActiveMemoryTranscriptDirectoryMode", ...args),
  writeFile: (...args: unknown[]) => callHost("writeActiveMemoryTranscriptFile", ...args),
};

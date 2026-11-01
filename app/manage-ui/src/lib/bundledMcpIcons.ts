import type { McpIcon } from "../api/mcpConnectors";
import { mcpBrandId } from "./mcpRecommendationCatalog";

// Curated official artwork is bundled so connection cards work without third-party image requests.
// Keep publisher identities exact; an arbitrary server display name must not select a trusted logo.


const artwork = import.meta.glob<string>("../assets/mcp-logos/*.png", { eager: true, query: "?url&no-inline", import: "default" });

export function bundledMcpIcon(identity: string): McpIcon | undefined {
  const id = mcpBrandId(identity);
  const src = artwork[`../assets/mcp-logos/${id}.png`];
  return src ? { src, mimeType: "image/png", sizes: [id === "wind" ? "2570x887" : "128x128"], theme: "light" } : undefined;
}

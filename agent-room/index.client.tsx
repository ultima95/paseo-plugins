import type { PluginClientContext } from "@getpaseo/plugin/client";

/**
 * The room UI lands in a later task. Until then the client contribution does
 * nothing and returns an inert cleanup so the plugin loads cleanly.
 */
export default function contribute(_client: PluginClientContext): () => void {
  return () => undefined;
}

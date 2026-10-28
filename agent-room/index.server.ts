import type { PluginServerContext } from "@getpaseo/plugin/server";

/**
 * The room engine lands in a later task. Until then the server contribution does
 * nothing and returns an inert cleanup so the plugin loads cleanly.
 */
export default function contribute(_server: PluginServerContext): () => void {
  return () => undefined;
}

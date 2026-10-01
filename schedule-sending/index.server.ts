import { randomUUID } from "node:crypto";
import os from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createPaseoGateway, type PaseoLike } from "./server/gateway";
import { createHandlers } from "./server/handlers";
import { consoleLogger } from "./server/logger";
import { createScheduler, type AgentGateway } from "./server/scheduler";
import { createFileStore, resolveDataDir } from "./server/store";
import { addScheduleRpc, cancelScheduleRpc, listScheduleRpc } from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const log = consoleLogger;
  const dir = resolveDataDir(process.env, os.homedir());
  const store = createFileStore({ dir, now: Date.now, log });

  // The server context has no `paseo` of its own: keep the newest one seen in any RPC or hook call.
  let gateway: AgentGateway | null = null;
  const attach = (paseo: PaseoLike): void => {
    gateway = createPaseoGateway(paseo);
  };

  const scheduler = createScheduler({ store, now: Date.now, log, getGateway: () => gateway });

  const ready = store.load().then(() => {
    scheduler.start();
    log.info("started", { dir, pending: store.list().filter((item) => item.status === "pending").length });
  });
  ready.catch((error: unknown) => log.error("failed to load queue", { dir, error: String(error) }));

  const handlers = createHandlers({
    store,
    now: Date.now,
    newId: randomUUID,
    ready,
    attach,
    gatewayFor: createPaseoGateway,
  });
  server.handle(addScheduleRpc, (input, { paseo }) => handlers.add(input, paseo));
  server.handle(listScheduleRpc, (input, { paseo }) => handlers.list(input, paseo));
  server.handle(cancelScheduleRpc, (input, { paseo }) => handlers.cancel(input, paseo));

  // Agent activity is the only thing that can wake a freshly restarted plugin with no app open.
  const wake = (paseo: PaseoLike): void => {
    attach(paseo);
    void ready.then(() => scheduler.tick()).catch(() => undefined);
  };
  server.on("agent.turn_started", (_event, { paseo }) => wake(paseo));
  server.on("agent.turn_ended", (_event, { paseo }) => wake(paseo));
  server.on("agent.created", (_event, { paseo }) => wake(paseo));

  return () => {
    scheduler.stop();
  };
}

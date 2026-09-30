/**
 * Connector registry (Stage 3/4). Base classes live in httpConnectorBase.ts
 * (moved out in Stage 5 to break a circular import). Register real connectors
 * here — the runtime resolves by connectorId.
 */
import type { Connector } from "./types";
import { FixtureRemoteConnector } from "./fixtureRemote";
import { ZhihuOfficialConnector } from "./zhihuOfficial";
import { GenericHttpConnector } from "./genericHttp";
import { RssConnector } from "./rss";
import { BrowserPageConnector } from "./browserPage";

const registry = new Map<string, Connector>();

export function registerConnector(c: Connector): void {
  registry.set(c.metadata.id, c);
}

export function getConnector(id: string): Connector | undefined {
  return registry.get(id);
}

export function listConnectors(): Connector[] {
  return [...registry.values()];
}

let seeded = false;
export function ensureDefaultConnectors(): void {
  if (seeded) return;
  registerConnector(new FixtureRemoteConnector());
  registerConnector(new ZhihuOfficialConnector());
  registerConnector(new GenericHttpConnector());
  registerConnector(new RssConnector());
  registerConnector(new BrowserPageConnector());
  seeded = true;
}

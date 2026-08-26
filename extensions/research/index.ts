import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createResearchStatusHandler,
  noActiveResearchStatusReader,
  type ResearchStatusReader,
} from "./commands/status.js";

export interface ResearchExtensionDependencies {
  readStatus?: ResearchStatusReader;
}

export default function registerResearchExtension(
  pi: ExtensionAPI,
  dependencies: ResearchExtensionDependencies = {},
): void {
  pi.registerCommand("research-status", {
    description: "Show the current scientific research run status",
    handler: createResearchStatusHandler(dependencies.readStatus ?? noActiveResearchStatusReader),
  });
}

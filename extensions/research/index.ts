import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createResearchStatusHandler,
  type ResearchStatusReader,
} from "./commands/status.js";
import { readFoundationStatus } from "./status-reader.js";

export interface ResearchExtensionDependencies {
  readStatus?: ResearchStatusReader;
}

export default function registerResearchExtension(
  pi: ExtensionAPI,
  dependencies: ResearchExtensionDependencies = {},
): void {
  pi.registerCommand("research-status", {
    description: "Verify and show a scientific research run status",
    handler: createResearchStatusHandler(dependencies.readStatus ?? readFoundationStatus),
  });
}

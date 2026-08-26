import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ResearchStatusReader = () => Promise<null>;

export const noActiveResearchStatusReader: ResearchStatusReader = async () => null;

export function createResearchStatusHandler(readStatus: ResearchStatusReader) {
  return async (_args: string, context: Pick<ExtensionCommandContext, "ui">): Promise<void> => {
    const status = await readStatus();
    if (status === null) {
      context.ui.notify("No active research run.", "info");
    }
  };
}

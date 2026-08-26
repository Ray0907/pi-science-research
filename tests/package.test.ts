import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const projectRoot = new URL("../", import.meta.url);

afterEach(() => {
  vi.useRealTimers();
});

describe("Pi package manifest", () => {
  it("advertises only the extension resource that exists", async () => {
    const manifest = JSON.parse(await readFile(new URL("package.json", projectRoot), "utf8")) as {
      keywords?: string[];
      pi?: unknown;
    };

    expect(manifest.keywords).toContain("pi-package");
    expect(manifest.pi).toEqual({ extensions: ["./extensions/research/index.ts"] });
  });
});

describe("research-status command", () => {
  it("registers exactly one read-only command and reports no active run", async () => {
    vi.useFakeTimers();
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-research-status-"));
    const marker = join(cwd, "marker.txt");
    await writeFile(marker, "unchanged", "utf8");
    const before = {
      entries: await readdir(cwd),
      marker: await readFile(marker, "utf8"),
      mtimeMs: (await stat(marker)).mtimeMs,
    };

    try {
      const [{ default: registerResearchExtension }, statusSource, extensionSource] = await Promise.all([
        import("../extensions/research/index.js"),
        readFile(new URL("../extensions/research/commands/status.ts", import.meta.url), "utf8"),
        readFile(new URL("../extensions/research/index.ts", import.meta.url), "utf8"),
      ]);

      const registrations: Array<{
        name: string;
        command: { handler: (args: string, context: unknown) => Promise<unknown> };
      }> = [];
      const api = new Proxy(
        {
          registerCommand(name: string, command: { handler: (args: string, context: unknown) => Promise<unknown> }) {
            registrations.push({ name, command });
          },
        },
        {
          get(target, property, receiver) {
            if (property !== "registerCommand") {
              throw new Error(`Unexpected ExtensionAPI access: ${String(property)}`);
            }
            return Reflect.get(target, property, receiver);
          },
        },
      );
      const notify = vi.fn();
      const readStatus = vi.fn(async () => null);
      const forbiddenServices = {
        write: vi.fn(() => {
          throw new Error("write service called");
        }),
        spawn: vi.fn(() => {
          throw new Error("process service called");
        }),
        invokeModel: vi.fn(() => {
          throw new Error("model service called");
        }),
      };

      registerResearchExtension(api as never, { readStatus, ...forbiddenServices } as never);

      expect(registrations.map(({ name }) => name)).toEqual(["research-status"]);
      const result = await registrations[0]!.command.handler("", {
        cwd,
        ui: { notify },
      });

      expect(result).toBeUndefined();
      expect(readStatus).toHaveBeenCalledOnce();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify).toHaveBeenCalledWith("No active research run.", "info");
      expect(forbiddenServices.write).not.toHaveBeenCalled();
      expect(forbiddenServices.spawn).not.toHaveBeenCalled();
      expect(forbiddenServices.invokeModel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect({
        entries: await readdir(cwd),
        marker: await readFile(marker, "utf8"),
        mtimeMs: (await stat(marker)).mtimeMs,
      }).toEqual(before);

      const forbiddenImports = [
        "node:fs",
        "node:fs/promises",
        "node:child_process",
        "node:timers",
        "node:timers/promises",
        "@earendil-works/pi-ai",
      ];
      for (const specifier of forbiddenImports) {
        expect(`${statusSource}\n${extensionSource}`).not.toContain(`from \"${specifier}\"`);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

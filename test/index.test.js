import { EventEmitter } from "events";
import fs from "fs";
import { mkdir, writeFile } from "fs/promises";
import http from "http";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import logseqDevPlugin from "../dist/index.js";

// Mock dependencies
vi.mock("fs");
vi.mock("fs/promises");
vi.mock("path");
vi.mock("http");

const mockCwd = "/mock/project/root";

describe("vite-plugin-logseq", () => {
  const mockPluginId = "my-logseq-plugin-id";
  let consoleErrorSpy;
  let consoleInfoSpy;

  beforeEach(() => {
    vi.resetAllMocks();

    // Mock process.cwd()
    vi.spyOn(process, "cwd").mockReturnValue(mockCwd);

    // Default mock for path.join and path.resolve
    vi.mocked(path.join).mockImplementation((...args) => args.filter(Boolean).join("/"));
    vi.mocked(path.resolve).mockImplementation((...args) => args.filter(Boolean).join("/"));

    // Mock fs.readFileSync for getLogseqPluginId
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      name: "test-package",
      logseq: {
        id: mockPluginId,
      },
    }));

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleInfoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleInfoSpy.mockRestore();
  });

  describe("Plugin Invocation (Simulating vite.config.js/ts)", () => {
    it("should be correctly invoked as plugin() using default import", () => {
      // In a real vite.config.js or vite.config.ts:
      // import logseq from 'vite-plugin-logseq'; // (your plugin's package name)
      // const instantiatedPlugin = logseq();

      // In this test, `logseqDevPlugin` (imported at the top of this test file)
      // represents the default export of your plugin.
      const instantiatedPlugin = logseqDevPlugin();

      expect(instantiatedPlugin).toBeTypeOf("object");
      expect(instantiatedPlugin.name).toBe("vite:logseq-dev-plugin");
      // Check for the presence of a few key plugin hooks
      expect(instantiatedPlugin).toHaveProperty("config");
      expect(instantiatedPlugin).toHaveProperty("transform");
      expect(instantiatedPlugin).toHaveProperty("buildStart");

      // Also, explicitly verify that the default export itself is a function
      expect(typeof logseqDevPlugin).toBe("function");

      // And ensure there isn't an unnecessary .default property on the function itself,
      // which would indicate a different export structure.
      expect(logseqDevPlugin.default).toBeUndefined();
    });
  });

  describe("Plugin Initialization (getLogseqPluginId)", () => {
    it("should retrieve plugin ID from package.json successfully", () => {
      logseqDevPlugin(); // Initialize
      // Indirectly check: if no error, it means ID was likely found.
      // A direct test would require exporting getLogseqPluginId or checking its usage in transform.
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });

    it("should log an error if package.json is unreadable", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => {
        throw new Error("File read error");
      });
      logseqDevPlugin();
      expect(consoleErrorSpy).toHaveBeenCalledWith("vite:logseq-dev-plugin: failed to get valid package.json");
    });

    it("should log an error if logseq.id is missing in package.json", () => {
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ name: "test-package", logseq: {} }));
      logseqDevPlugin();
      expect(consoleErrorSpy).toHaveBeenCalledWith("vite:logseq-dev-plugin: failed to get valid plugin id");
    });
  });

  describe("Plugin Properties", () => {
    const plugin = logseqDevPlugin();
    it("should have correct name", () => {
      expect(plugin.name).toBe("vite:logseq-dev-plugin");
    });

    it("should have correct enforce order", () => {
      expect(plugin.enforce).toBe("post");
    });
  });

  describe("config hook", () => {
    const plugin = logseqDevPlugin();

    it("should modify config for \"serve\" command", async () => {
      const baseConfig = { server: {} };
      const env = { command: "serve", mode: "development" };
      const modifiedConfig = await plugin.config(JSON.parse(JSON.stringify(baseConfig)), env);

      expect(modifiedConfig.base).toBe("");
      expect(modifiedConfig.server.cors).toBe(true);
      expect(modifiedConfig.server.host).toBe("localhost");
      expect(modifiedConfig.server.hmr.host).toBe("localhost");
      expect(modifiedConfig.server.open).toBe(false);
    });

    it("should only set base for \"build\" command", async () => {
      const baseConfig = { server: { cors: false } };
      const env = { command: "build", mode: "production" };
      const modifiedConfig = await plugin.config(JSON.parse(JSON.stringify(baseConfig)), env);

      expect(modifiedConfig.base).toBe("");
      expect(modifiedConfig.server.cors).toBe(false); // Should not be touched
      expect(modifiedConfig.server.host).toBeUndefined();
    });
  });

  describe("transform hook", () => {
    let plugin;
    let mockViteServer;
    const mockModuleId = `${mockCwd}/src/main.ts`;
    const mockModuleCode = "console.log(\"hello\");";

    beforeEach(() => {
      plugin = logseqDevPlugin();
      mockViteServer = {
        moduleGraph: {
          getModuleById: vi.fn().mockReturnValue({ importers: new Set() }), // Default: entry module
        },
      };
      plugin.configureServer(mockViteServer); // Simulate server configuration
    });

    it("should transform entry modules not in node_modules and within cwd", () => {
      const result = plugin.transform(mockModuleCode, mockModuleId);
      expect(result).toBeDefined();
      expect(result.code).toContain(`import.meta.hot.accept`);
      expect(result.code).toContain(`top?.LSPluginCore.reload("${mockPluginId}");`);
      expect(result.code).toContain(`console.log("✨Plugin ${mockPluginId} reloaded ✨");`);
      expect(result.code).toContain(`top.eval(\``);
      expect(result.map).toBeDefined();
    });

    it("should not transform modules in node_modules", () => {
      const nodeId = `${mockCwd}/node_modules/some-lib/index.js`;
      const result = plugin.transform(mockModuleCode, nodeId);
      expect(result).toBeUndefined();
    });

    it("should not transform non-entry modules (with importers)", () => {
      mockViteServer.moduleGraph.getModuleById.mockReturnValue({ importers: new Set(["importer.js"]) });
      const result = plugin.transform(mockModuleCode, mockModuleId);
      expect(result).toBeUndefined();
    });

    it("should not transform modules outside process.cwd()", () => {
      const externalId = "/external/path/file.js";
      const result = plugin.transform(mockModuleCode, externalId);
      expect(result).toBeUndefined();
    });

    it("should return undefined if server is not configured (e.g. build mode)", () => {
      const freshPlugin = logseqDevPlugin(); // No server configured
      const result = freshPlugin.transform(mockModuleCode, mockModuleId);
      expect(result).toBeUndefined();
    });
  });

  describe("buildStart hook", () => {
    let plugin;
    let mockResolvedConfig;
    let mockConfigEnv;
    let mockViteDevServer;
    let mockHttpServer;
    let listeningCallback;

    beforeEach(async () => {
      vi.mocked(mkdir).mockClear();
      vi.mocked(writeFile).mockClear();

      mockResolvedConfig = {
        build: { outDir: `${mockCwd}/dist` },
      };
      mockConfigEnv = { command: "serve" }; // Default to serve

      // Setup for http.get mock
      const mockRes = new EventEmitter();
      vi.mocked(http.get).mockImplementation((url, options, callback) => {
        if (callback) {
          callback(mockRes);
        }
        // Simulate async data
        process.nextTick(() => {
          mockRes.emit("data", Buffer.from("<html><head></head><body>"));
          mockRes.emit("data", Buffer.from("</body></html>"));
          mockRes.emit("end");
        });
        return { on: vi.fn() }; // Mock request object
      });

      plugin = logseqDevPlugin();
      // Simulate Vite's hook calling order
      await plugin.config(mockResolvedConfig, mockConfigEnv); // Sets configEnv
      plugin.configResolved(mockResolvedConfig); // Sets config

      mockHttpServer = {
        address: vi.fn().mockReturnValue({ address: "127.0.0.1", port: 3000, family: "IPv4" }),
        once: vi.fn((event, callback) => {
          if (event === "listening") {
            listeningCallback = callback; // Capture the callback
          }
        }),
      };
      mockViteDevServer = {
        httpServer: mockHttpServer,
      };
      plugin.configureServer(mockViteDevServer);
    });

    it("should do nothing if command is not \"serve\"", async () => {
      mockConfigEnv.command = "build";
      await plugin.config(mockResolvedConfig, mockConfigEnv); // Re-run with new env
      plugin.configResolved(mockResolvedConfig);

      await plugin.buildStart();
      expect(mockHttpServer.once).not.toHaveBeenCalled();
    });

    it("should throw if httpServer is not available in \"serve\" mode", async () => {
      plugin.configureServer({ httpServer: null }); // Simulate no http server
      await expect(plugin.buildStart()).rejects.toThrow(
        "vite:logseq-dev-plugin Only works for non-middleware mode for now",
      );
    });

    it("should fetch, modify, and write index.html in \"serve\" mode when server is listening", async () => {
      // Call buildStart, which should set up the 'listening' event handler
      const buildStartPromise = plugin.buildStart();

      // Manually trigger the 'listening' event callback
      expect(mockHttpServer.once).toHaveBeenCalledWith("listening", expect.any(Function));
      if (listeningCallback) {
        try {
          await listeningCallback(); // This should trigger tapHtml and the rest
        } catch (e) {
          // Log the actual error to help diagnose
          console.error("Error directly from listeningCallback:", e);
          // Re-throw to ensure the test still fails, but now with more info
          throw e;
        }
      } else {
        throw new Error("Listening callback was not captured");
      }

      await buildStartPromise; // Ensure buildStart itself completes if it has async parts before listener


      // Wait for promises inside the listener to resolve
      // This requires a bit of a tick to let microtasks run
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve)); // Sometimes one tick is not enough

      expect(http.get).toHaveBeenCalledWith("http://localhost:3000", {
        method: "GET",
        headers: { accept: "text/html" },
      });
      expect(mkdir).toHaveBeenCalledWith(`${mockCwd}/dist`, { recursive: true });

      const expectedHtmlContent = "<html><head><base href=\"http://localhost:3000\"></head><body></body></html>";
      expect(writeFile).toHaveBeenCalledWith(
        `${mockCwd}/dist/index.html`,
        expectedHtmlContent,
        { encoding: "utf-8" },
      );
      expect(consoleInfoSpy).toHaveBeenCalledWith("vite:logseq-dev-plugin: Wrote development index.html");
    });

    it("should handle string address from server.httpServer.address()", async () => {
      mockHttpServer.address.mockReturnValue("http://myhost:5432");

      const buildStartPromise = plugin.buildStart();
      if (listeningCallback) {
        await listeningCallback();
      } else {
        throw new Error("Listening callback was not captured");
      }
      await buildStartPromise;
      await new Promise(resolve => process.nextTick(resolve));
      await new Promise(resolve => process.nextTick(resolve));

      expect(http.get).toHaveBeenCalledWith("http://myhost:5432", expect.any(Object));
      const expectedHtmlContent = "<html><head><base href=\"http://myhost:5432\"></head><body></body></html>";
      expect(writeFile).toHaveBeenCalledWith(
        `${mockCwd}/dist/index.html`,
        expectedHtmlContent,
        { encoding: "utf-8" },
      );
    });
  });
});

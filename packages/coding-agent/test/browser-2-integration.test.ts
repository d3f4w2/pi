import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { BrowserController } from "../src/extensions/browser/service.ts";

const PAGE = `<!doctype html><html><head><title>Browser 2 fixture</title></head><body>
<button id="mutate" onclick="document.querySelector('#state').textContent='clicked'">Mutate</button>
<button id="hover" onmouseover="document.querySelector('#state').textContent='hovered'">Hover</button>
<input id="text" aria-label="Text input" onkeydown="document.querySelector('#key').textContent=event.key">
<select id="select"><option value="one">One</option><option value="two">Two</option></select>
<input id="upload" type="file" aria-label="Upload">
<a id="download" href="/download">Download</a>
<div id="state">ready</div><div id="key"></div>
</body></html>`;

function listen(server: Server): Promise<number> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") reject(new Error("Local fixture server has no TCP address."));
			else resolve(address.port);
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("Browser 2.0 real Chromium integration", () => {
	const controllers: BrowserController[] = [];
	const servers: Server[] = [];
	const workspaces: string[] = [];

	afterEach(async () => {
		for (const controller of controllers.splice(0)) await controller.close();
		for (const server of servers.splice(0)) await closeServer(server);
		for (const workspace of workspaces.splice(0)) await rm(workspace, { recursive: true, force: true });
	}, 30_000);

	test(
		"executes navigation, versioned interactions, tabs, protected files, diagnostics, and screenshots",
		{ timeout: 120_000, retry: 1 },
		async () => {
			const experimentStartedAt = performance.now();
			const server = createServer((request, response) => {
				if (request.url === "/next") {
					response.writeHead(200, { "content-type": "text/html" });
					response.end("<!doctype html><title>Next</title><p>next page</p>");
					return;
				}
				if (request.url === "/errors") {
					response.writeHead(200, { "content-type": "text/html" });
					response.end(
						"<!doctype html><title>Errors</title><script>fetch('/missing'); setTimeout(() => { throw new Error('fixture boom') }, 0)</script>",
					);
					return;
				}
				if (request.url === "/download") {
					response.writeHead(200, {
						"content-type": "text/plain",
						"content-disposition": "attachment; filename=fixture-download.txt",
					});
					response.end("download fixture");
					return;
				}
				if (request.url === "/missing") {
					response.writeHead(503, { "content-type": "text/plain" });
					response.end("expected failure");
					return;
				}
				response.writeHead(200, { "content-type": "text/html" });
				response.end(PAGE);
			});
			servers.push(server);
			const port = await listen(server);
			const origin = `http://127.0.0.1:${port}`;
			const workspace = await mkdtemp(path.join(tmpdir(), "pi-browser-real-"));
			workspaces.push(workspace);
			const uploadPath = path.join(workspace, "upload.txt");
			await writeFile(uploadPath, "upload fixture");
			const controller = new BrowserController(undefined, workspace);
			controllers.push(controller);

			let snapshot = await controller.open(origin);
			expect(snapshot.version).toBeTypeOf("number");
			const mutate = snapshot.elements.find((element) => element.name === "Mutate");
			if (!mutate || snapshot.version === undefined) throw new Error("Mutate fixture ref missing.");
			const oldVersion = snapshot.version;
			snapshot = await controller.click(mutate.ref, oldVersion, 0);
			expect(snapshot.text).toContain("clicked");
			await expect(controller.click(mutate.ref, oldVersion, 0)).rejects.toThrow("stale");

			const input = snapshot.elements.find((element) => element.name === "Text input");
			if (!input || snapshot.version === undefined) throw new Error("Input fixture ref missing.");
			snapshot = await controller.type(input.ref, snapshot.version, "typed", false, 0);
			expect(snapshot.elements.find((element) => element.name === "Text input")?.value).toBe("typed");

			const hover = snapshot.elements.find((element) => element.name === "Hover");
			if (!hover || snapshot.version === undefined) throw new Error("Hover fixture ref missing.");
			snapshot = await controller.hover(hover.ref, snapshot.version);
			expect(snapshot.text).toContain("hovered");

			const currentInput = snapshot.elements.find((element) => element.name === "Text input");
			if (!currentInput || snapshot.version === undefined) throw new Error("Current input fixture ref missing.");
			snapshot = await controller.press(currentInput.ref, snapshot.version, "Enter");
			expect(snapshot.text).toContain("Enter");

			const select = snapshot.elements.find((element) => element.tag === "select");
			if (!select || snapshot.version === undefined) throw new Error("Select fixture ref missing.");
			snapshot = await controller.select(select.ref, snapshot.version, ["two"]);
			expect(snapshot.elements.find((element) => element.tag === "select")?.value).toBe("two");

			const upload = snapshot.elements.find((element) => element.name === "Upload");
			if (!upload || snapshot.version === undefined) throw new Error("Upload fixture ref missing.");
			snapshot = await controller.upload(upload.ref, snapshot.version, [uploadPath]);
			expect(snapshot.elements.find((element) => element.name === "Upload")?.value).toContain("upload.txt");
			await expect(
				controller.upload(upload.ref, snapshot.version, [path.resolve(workspace, "..", "outside.txt")]),
			).rejects.toThrow("outside the workspace");

			await controller.navigate(`${origin}/next`);
			await expect(controller.wait({ kind: "text", value: "next page" }, 2_000)).resolves.toMatchObject({
				title: "Next",
			});
			await expect(controller.back()).resolves.toMatchObject({ title: "Browser 2 fixture" });
			await expect(controller.forward()).resolves.toMatchObject({ title: "Next" });
			await expect(controller.reload()).resolves.toMatchObject({ title: "Next" });

			const firstTab = (await controller.tabs()).find((tab) => tab.active);
			if (!firstTab) throw new Error("Active fixture tab missing.");
			const second = await controller.newTab(origin);
			expect(second.tabId).not.toBe(firstTab.id);
			expect(await controller.tabs()).toHaveLength(2);
			await expect(controller.switchTab(firstTab.id)).resolves.toMatchObject({ title: "Next" });
			await controller.closeTab(second.tabId ?? "");
			expect(await controller.tabs()).toHaveLength(1);

			await controller.navigate(origin);
			snapshot = await controller.snapshot();
			const download = snapshot.elements.find((element) => element.name === "Download");
			if (!download || snapshot.version === undefined) throw new Error("Download fixture ref missing.");
			await controller.click(download.ref, snapshot.version, 100);
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect((await controller.downloads()).some((item) => item.name === "fixture-download.txt")).toBe(true);

			await controller.navigate(`${origin}/errors`);
			await controller.wait({ kind: "network_idle" }, 3_000);
			const diagnostics = await controller.errors();
			expect(diagnostics.pageErrors.some((entry) => entry.text.includes("fixture boom"))).toBe(true);
			expect(diagnostics.failedRequests.some((entry) => entry.url.includes("/missing"))).toBe(true);
			const viewportScreenshot = await controller.screenshot(false);
			const fullPageScreenshot = await controller.screenshot(true);
			expect(viewportScreenshot.length).toBeGreaterThan(100);
			expect(fullPageScreenshot.length).toBeGreaterThan(100);
			console.info(
				"BROWSER_2_REAL_METRICS",
				JSON.stringify({
					fixture: "local-http-and-installed-chromium",
					elapsedMs: performance.now() - experimentStartedAt,
					capabilities: 18,
					staleRefRejected: true,
					outsideUploadRejected: true,
					viewportScreenshotBytes: Buffer.from(viewportScreenshot, "base64").length,
					fullPageScreenshotBytes: Buffer.from(fullPageScreenshot, "base64").length,
				}),
			);
		},
	);
});

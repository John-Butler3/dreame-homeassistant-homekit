import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import QRCode from "qrcode";
import { createLogger } from "../logger.js";
import type { MatterVacuumNode } from "../matter/node.js";
import type { VacuumController } from "../vacuum/controller.js";

const log = createLogger("web");

/** Small status page served through Home Assistant ingress. */
export function startWebServer(port: number, controller: VacuumController, matter: MatterVacuumNode) {
  const server = createServer(async (req, res) => {
    try {
      await handle(req, res, controller, matter);
    } catch (err) {
      log.error("Request failed", err);
      res.writeHead(500, { "content-type": "text/plain" }).end("Internal error");
    }
  });
  server.listen(port, "0.0.0.0", () => log.info(`Status page listening on ${port}`));
  return server;
}

async function handle(req: IncomingMessage, res: ServerResponse, controller: VacuumController, matter: MatterVacuumNode) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "GET" && path === "/api/status") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(status(controller, matter)));
    return;
  }
  if (req.method === "POST" && path === "/factory-reset") {
    await matter.factoryReset();
    res.writeHead(303, { location: "./" }).end();
    return;
  }
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await page(controller, matter));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}

function status(controller: VacuumController, matter: MatterVacuumNode) {
  const view = controller.view();
  return {
    vacuum: controller.options.vacuumEntity,
    available: view.available,
    state: view.snapshot.vacuum?.state ?? null,
    operationalState: view.operational.state,
    error: view.operational.errorText,
    battery: view.power.percentRemaining === null ? null : view.power.percentRemaining / 2,
    cleanMode: view.currentCleanMode.label,
    cleanModes: view.cleanModes.map((m) => m.label),
    rooms: view.layout.areas.map((a) => ({ id: a.areaId, name: a.name, map: a.mapName })),
    currentArea: view.currentAreaId,
    helpers: controller.helpers,
    pairing: matter.pairingInfo() ?? null,
  };
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

async function page(controller: VacuumController, matter: MatterVacuumNode): Promise<string> {
  const s = status(controller, matter);
  let qr = "";
  if (s.pairing && !s.pairing.commissioned) {
    qr = await QRCode.toString(s.pairing.qrPairingCode, { type: "svg", margin: 1, width: 240 });
  }
  const rooms = s.rooms.map((r) => `<li>${esc(r.name)}${r.map ? ` <small>(${esc(r.map)})</small>` : ""}</li>`).join("");
  const modes = s.cleanModes.map((m) => `<li>${esc(m)}</li>`).join("");
  const pairing = s.pairing
    ? s.pairing.commissioned
      ? `<p class="ok">Paired with ${s.pairing.fabrics} controller(s).</p>`
      : `<div class="qr">${qr}</div>
         <p>Manual pairing code: <code>${esc(s.pairing.manualPairingCode)}</code></p>
         <p>In the Home app choose <b>Add Accessory</b> and scan the code.</p>`
    : "<p>Matter node not started.</p>";
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dreame Matter Vacuum</title>
<style>
 body{font-family:-apple-system,system-ui,sans-serif;margin:2rem;max-width:720px;color:#222}
 h1{font-size:1.4rem} h2{font-size:1.1rem;margin-top:2rem} code{background:#eee;padding:.1rem .3rem;border-radius:4px}
 .ok{color:#1b7f3b} .qr svg{width:240px;height:240px} table{border-collapse:collapse} td{padding:.2rem .8rem .2rem 0}
 button{background:#c0392b;color:#fff;border:0;padding:.5rem 1rem;border-radius:6px}
</style></head><body>
<h1>Dreame Matter Vacuum</h1>
<h2>Pairing</h2>${pairing}
<h2>Vacuum</h2>
<table>
<tr><td>Entity</td><td><code>${esc(s.vacuum)}</code></td></tr>
<tr><td>State</td><td>${esc(s.state)}${s.error ? ` (${esc(s.error)})` : ""}</td></tr>
<tr><td>Battery</td><td>${s.battery === null ? "unknown" : `${s.battery} %`}</td></tr>
<tr><td>Cleaning mode</td><td>${esc(s.cleanMode)}</td></tr>
<tr><td>Cleaning mode select</td><td><code>${esc(s.helpers.cleaningModeEntity ?? "not found")}</code></td></tr>
<tr><td>Suction select</td><td><code>${esc(s.helpers.suctionLevelEntity ?? "not found")}</code></td></tr>
<tr><td>Water volume select</td><td><code>${esc(s.helpers.waterVolumeEntity ?? "not found")}</code></td></tr>
<tr><td>Selected map select</td><td><code>${esc(s.helpers.selectedMapEntity ?? "not found")}</code></td></tr>
<tr><td>CleanGenius select</td><td><code>${esc(s.helpers.cleanGeniusEntity ?? "not found")}</code></td></tr>
</table>
<h2>Rooms exposed to Apple Home (${s.rooms.length})</h2><ul>${rooms || "<li>none, open the map in the Dreame app once</li>"}</ul>
<h2>Cleaning modes</h2><ul>${modes}</ul>
<h2>Factory reset</h2>
<p>Removes all pairings so the vacuum can be added to a home again.</p>
<form method="post" action="factory-reset" onsubmit="return confirm('Remove all pairings?')"><button>Factory reset</button></form>
</body></html>`;
}

#!/usr/bin/env node
// Standalone fake npm registry for assets/api-compat-demo.tape — serves the
// acme-utils package doc + pre-built tarballs from assets/api-compat-demo-setup.js.
// Not a test double reused from test/unit/features.test.js on purpose: this
// runs standalone via `node`, no build step, no test harness dependency.
//
// Launched detached by the setup script and self-terminates after a couple
// of minutes so repeated demo regenerations don't accumulate orphaned
// background processes.

const http = require("http");
const fs = require("fs");
const path = require("path");

const registryDataDir = process.argv[2];

const manifest = JSON.parse(
  fs.readFileSync(path.join(registryDataDir, "manifest.json"), "utf-8"),
);

let port; // assigned once listen()'s callback fires with the OS-picked port

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url);

  if (url === "/acme-utils") {
    const versions = {};
    for (const version of Object.keys(manifest.versions)) {
      versions[version] = {
        version,
        dist: { tarball: `http://127.0.0.1:${port}/tarballs/acme-utils/${version}.tgz` },
      };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ name: "acme-utils", versions }));
    return;
  }

  const match = url.match(/^\/tarballs\/acme-utils\/(.+)\.tgz$/);
  if (match && manifest.versions[match[1]]) {
    res.setHeader("content-type", "application/octet-stream");
    fs.createReadStream(path.join(registryDataDir, `${match[1]}.tgz`)).pipe(res);
    return;
  }

  res.statusCode = 404;
  res.end();
});

// Port 0 — let the OS pick a free one, so a leftover server from a previous
// (self-terminating) demo run can never block a new one with EADDRINUSE.
server.listen(0, "127.0.0.1", () => {
  port = server.address().port;
  // Signal readiness (and the actual port) to the setup script, which polls
  // for this marker file.
  fs.writeFileSync(path.join(registryDataDir, "server.ready"), String(port));
});

server.on("error", (err) => {
  fs.writeFileSync(path.join(registryDataDir, "server.error"), String(err));
  process.exit(1);
});

// Self-terminate — this is a demo fixture, not a long-running service.
setTimeout(() => process.exit(0), 3 * 60 * 1000).unref();

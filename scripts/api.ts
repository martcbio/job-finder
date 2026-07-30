import { serveJobFinderApi } from "../src/api/server";

const server = serveJobFinderApi();

console.log(`jobsradar API listening on http://${server.hostname}:${server.port}`);
console.log("Routes are under /api. Stop with Ctrl-C.");

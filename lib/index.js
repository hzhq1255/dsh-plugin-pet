/**
 * dsh-plugin-pet — host half.
 *
 * Serves two loopback-only routes so the browser half can render a pet that
 * lives on disk instead of inside a build artifact:
 *
 *   GET /plugins/dsh-plugin-pet/pets
 *   GET /plugins/dsh-plugin-pet/pets/:id/spritesheet
 *
 * Nothing here reaches the network, reads credentials, or looks at `~/.codex`.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import {
  ATLAS_BASE,
  PET_ID_RE,
  MAX_ATLAS_BYTES,
  assetPathFor,
  atlasFor,
  contentTypeFor,
  listPets,
  parseManifest,
  pickDefaultPet,
  resolvePetsRoot,
} from "./pet-store.js";

const name = "dsh-plugin-pet";
const inject = ["webServer"];

const LIST_PATH = `${ATLAS_BASE}/pets`;
const ATLAS_ROUTE_RE = /^\/plugins\/dsh-plugin-pet\/pets\/([^/]+)\/spritesheet$/;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const TRUSTED_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Bare hostname of a Host header, handling `[::1]:port` and case. */
export function hostnameOf(hostHeader) {
  if (typeof hostHeader !== "string") return "";
  const value = hostHeader.trim().toLowerCase();
  if (value === "") return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end > 0 ? value.slice(0, end + 1) : "";
  }
  return value.split(":")[0];
}

/** Loopback-only posture: the pet routes serve this machine's browser, nothing else. */
export function isTrustedHost(hostHeader) {
  return TRUSTED_HOSTS.has(hostnameOf(hostHeader));
}

function json(status, body) {
  return { status, headers: JSON_HEADERS, body: JSON.stringify(body) };
}

/**
 * Build the two handlers without touching `ctx`, so tests can drive them.
 * @param {{root: string, defaultPet?: string}} options
 */
export function createHandlers({ root, defaultPet = "" }) {
  const petRoot = resolve(root);
  return {
    async list() {
      const { pets, errors, missing } = await listPets(petRoot);
      return json(200, {
        ok: true,
        petsRoot: missing ? null : petRoot,
        defaultPet: pickDefaultPet(pets, defaultPet),
        pets,
        errors,
      });
    },

    /**
     * @param {string} id
     * @param {{ifNoneMatch?: string}} [request]
     */
    async atlas(id, request = {}) {
      if (!PET_ID_RE.test(id)) return json(400, { ok: false, error: "invalid-pet-id" });
      const petDir = resolve(petRoot, id);
      if (!petDir.startsWith(petRoot + sep)) return json(400, { ok: false, error: "invalid-pet-id" });

      let manifestRaw = null;
      try {
        manifestRaw = JSON.parse(await readFile(resolve(petDir, "pet.json"), "utf8"));
      } catch {
        /* manifest is optional; the folder name is the identity */
      }
      const parsed = parseManifest(manifestRaw, id);
      if (!parsed.ok) return json(400, { ok: false, error: parsed.error });

      const file = assetPathFor(petDir, parsed.pet);
      if (file === null) return json(400, { ok: false, error: "invalid-spritesheet-path" });

      const type = contentTypeFor(file);
      if (type === null) return json(415, { ok: false, error: "unsupported-spritesheet-type" });

      let info;
      try {
        info = await stat(file);
      } catch {
        return json(404, { ok: false, error: "spritesheet-not-found" });
      }
      if (!info.isFile()) return json(404, { ok: false, error: "spritesheet-not-found" });
      if (info.size > MAX_ATLAS_BYTES) return json(413, { ok: false, error: "spritesheet-too-large" });

      const etag = `W/"${info.size}-${Math.floor(info.mtimeMs)}"`;
      if (request.ifNoneMatch === etag) {
        return { status: 304, headers: { etag, "cache-control": "public, max-age=300" }, body: null };
      }

      return {
        status: 200,
        headers: {
          "content-type": type,
          "cache-control": "public, max-age=300",
          "content-length": String(info.size),
          etag,
          "x-content-type-options": "nosniff",
        },
        body: await readFile(file),
        atlas: atlasFor(parsed.pet.spriteVersionNumber),
      };
    },
  };
}

function send(res, result) {
  if (res.writableEnded === true) return;
  res.writeHead(result.status, result.headers);
  if (result.body === null || result.body === undefined) res.end();
  else res.end(result.body);
}

/**
 * @param {import("@deepseek-ai/cordis").Context} ctx
 * @param {{dir?: string, defaultPet?: string}} [config]
 */
function apply(ctx, config = {}) {
  const configuredDir = typeof config.dir === "string" && config.dir.trim() !== "" ? config.dir : "";
  const root = configuredDir !== "" ? configuredDir : resolvePetsRoot();
  const handlers = createHandlers({ root, defaultPet: config.defaultPet });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: LIST_PATH,
        handler: async (req, res) => {
          if (!isTrustedHost(req.headers.host)) {
            send(res, json(403, { ok: false, error: "forbidden-host" }));
            return;
          }
          if (req.method !== "GET" && req.method !== "HEAD") {
            send(res, json(405, { ok: false, error: "method-not-allowed" }));
            return;
          }
          send(res, await handlers.list());
        },
      }),
    "dsh-plugin-pet: pet list",
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        // No trailing slash: the server matches `pathname === prefix || startsWith(prefix + "/")`,
        // so `/pets/` would never match `/pets/<id>/spritesheet`.
        path: LIST_PATH,
        handler: async (req, res) => {
          if (!isTrustedHost(req.headers.host)) {
            send(res, json(403, { ok: false, error: "forbidden-host" }));
            return;
          }
          if (req.method !== "GET" && req.method !== "HEAD") {
            send(res, json(405, { ok: false, error: "method-not-allowed" }));
            return;
          }
          let pathname;
          try {
            pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          } catch {
            send(res, json(400, { ok: false, error: "bad-request" }));
            return;
          }
          const match = ATLAS_ROUTE_RE.exec(pathname);
          if (match === null) {
            send(res, json(404, { ok: false, error: "not-found" }));
            return;
          }
          send(res, await handlers.atlas(match[1], { ifNoneMatch: req.headers["if-none-match"] }));
        },
      }),
    "dsh-plugin-pet: spritesheet",
  );

  ctx.logger?.info?.(`dsh-plugin-pet: serving pets from ${root}`);
}

export { name, inject, apply };

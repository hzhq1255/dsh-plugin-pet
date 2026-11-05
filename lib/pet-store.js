/**
 * dsh-plugin-pet — pet store primitives (host side, pure + fs).
 *
 * A pet is a directory under `${DSH_HOME:-~/.dsh}/pets/<id>/`:
 *
 *   pet.json          { id?, displayName?, description?, spritesheetPath?, spriteVersionNumber?, kind? }
 *   spritesheet.webp  Codex Pet atlas: 8 columns, 192x208 cells,
 *                     v1 = 9 rows (1536x1872), v2 = 11 rows (1536x2288).
 *
 * The format is Codex Pet compatible; the location is DSH's own. This module
 * never looks at `~/.codex`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

export const PET_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CELL_W = 192;
export const CELL_H = 208;
export const COLS = 8;
export const MAX_ATLAS_BYTES = 8 * 1024 * 1024;
export const DEFAULT_SPRITESHEET = "spritesheet.webp";
export const ATLAS_BASE = "/plugins/dsh-plugin-pet";

export const CONTENT_TYPES = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".gif": "image/gif",
};

const ATLAS = {
  1: { rows: 9, width: 1536, height: 1872 },
  2: { rows: 11, width: 1536, height: 2288 },
};

/** @typedef {"idle"|"runRight"|"runLeft"|"wave"|"jump"|"failed"|"wait"|"run"|"review"|"lookA"|"lookB"} PetState */

const row = (name, index, durations, options = {}) => ({
  name,
  row: index,
  durations,
  once: options.once === true,
  v2: options.v2 === true,
});

/** Animation rows, durations in ms straight from the Codex Pet v2 contract. */
const ROWS = [
  row("idle", 0, [280, 110, 110, 140, 140, 320]),
  row("runRight", 1, [120, 120, 120, 120, 120, 120, 120, 220]),
  row("runLeft", 2, [120, 120, 120, 120, 120, 120, 120, 220]),
  row("wave", 3, [140, 140, 140, 280], { once: true }),
  row("jump", 4, [140, 140, 140, 140, 280], { once: true }),
  row("failed", 5, [140, 140, 140, 140, 140, 140, 140, 240], { once: true }),
  row("wait", 6, [150, 150, 150, 150, 150, 260]),
  row("run", 7, [120, 120, 120, 120, 120, 220]),
  row("review", 8, [150, 150, 150, 150, 150, 280]),
  row("lookA", 9, [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5], { v2: true }),
  row("lookB", 10, [180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5], { v2: true }),
];

/** The animation table for one atlas version (1 = legacy, 2 = current). */
export function statesFor(version) {
  const max = version === 2 ? 2 : 1;
  const out = {};
  for (const entry of ROWS) {
    if ((entry.v2 ? 2 : 1) > max) continue;
    out[entry.name] = {
      row: entry.row,
      frames: entry.durations.length,
      durations: entry.durations.slice(),
      once: entry.once,
    };
  }
  return out;
}

export const STATES = { 1: statesFor(1), 2: statesFor(2) };

/** Atlas geometry for a manifest's declared version. */
export function atlasFor(version) {
  return ATLAS[version === 2 ? 2 : 1];
}

/** Resolve the pet root: configured dir wins, then `$DSH_HOME/pets`, then `~/.dsh/pets`. */
export function resolvePetsRoot(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return configured ? join(configured, "pets") : join(homedir(), ".dsh", "pets");
}

/** True when `value` is a safe relative asset path (no absolute, drive, or `..` escape). */
export function isSafeRelativeAssetPath(value) {
  if (typeof value !== "string") return false;
  const candidate = value.trim();
  if (candidate === "" || candidate.length > 160) return false;
  if (candidate.startsWith("/") || candidate.startsWith("\\")) return false;
  if (/^[a-zA-Z]:/.test(candidate)) return false;
  if (/[\u0000-\u001f]/.test(candidate)) return false;
  const segments = candidate.split(/[\\/]/);
  return segments.every((part) => part !== "" && part !== "." && part !== "..");
}

/**
 * Parse one pet.json into the canonical record.
 * The directory name is the identity; a manifest `id` is accepted but ignored.
 * @returns {{ok: true, pet: object} | {ok: false, error: string}}
 */
export function parseManifest(raw, folderId) {
  if (!PET_ID_RE.test(folderId)) return { ok: false, error: "invalid-id" };
  const source = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const displayName =
    typeof source.displayName === "string" && source.displayName.trim() !== ""
      ? source.displayName.trim().slice(0, 80)
      : folderId;
  const description =
    typeof source.description === "string" ? source.description.trim().slice(0, 280) : "";
  const kind = typeof source.kind === "string" ? source.kind.trim().slice(0, 32) : "";
  const spriteVersionNumber = source.spriteVersionNumber === 2 ? 2 : 1;
  // A declared-but-unsafe path is a broken pet, not something to paper over.
  if (source.spritesheetPath !== undefined && !isSafeRelativeAssetPath(source.spritesheetPath)) {
    return { ok: false, error: "spritesheet-unsafe" };
  }
  const spritesheetPath =
    typeof source.spritesheetPath === "string" && source.spritesheetPath.trim() !== ""
      ? source.spritesheetPath.trim()
      : DEFAULT_SPRITESHEET;
  return {
    ok: true,
    pet: {
      id: folderId,
      displayName,
      description,
      kind,
      spriteVersionNumber,
      spritesheetPath,
    },
  };
}

/** Resolve a pet's spritesheet inside its own directory, or null when it would escape. */
export function assetPathFor(petDir, pet) {
  const absolute = resolve(petDir, pet.spritesheetPath);
  if (absolute === petDir) return null;
  if (!absolute.startsWith(petDir + sep)) return null;
  return absolute;
}

/** Content type for a sprite file, or null when the extension is not a still-image format. */
export function contentTypeFor(filePath) {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? null;
}

/** URL the browser fetches a pet's atlas from. */
export function atlasUrlFor(id) {
  return `${ATLAS_BASE}/pets/${id}/spritesheet`;
}

/**
 * Read every pet under `root`. Missing directories are not an error.
 * @returns {Promise<{pets: object[], errors: {id: string, error: string}[], missing: boolean}>}
 */
export async function listPets(root) {
  const pets = [];
  const errors = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { pets, errors, missing: true };
    throw error;
  }

  const directories = entries
    .filter((entry) => entry.isDirectory() && PET_ID_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const id of directories) {
    const petDir = join(root, id);
    let raw = null;
    let hasManifest = false;
    try {
      raw = JSON.parse(await readFile(join(petDir, "pet.json"), "utf8"));
      hasManifest = true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        // A pet.json that exists but cannot be read is a broken package: skip it
        // rather than silently rendering a half-configured pet.
        errors.push({ id, error: "manifest-invalid" });
        continue;
      }
    }
    const parsed = parseManifest(raw, id);
    if (!parsed.ok) {
      errors.push({ id, error: parsed.error });
      continue;
    }
    const atlasFile = assetPathFor(petDir, parsed.pet);
    if (atlasFile === null) {
      errors.push({ id, error: "spritesheet-unsafe" });
      continue;
    }
    let info;
    try {
      info = await stat(atlasFile);
    } catch {
      // A directory with neither pet.json nor a sheet is not a pet at all.
      if (hasManifest) errors.push({ id, error: "spritesheet-missing" });
      continue;
    }
    if (!info.isFile()) {
      if (hasManifest) errors.push({ id, error: "spritesheet-missing" });
      continue;
    }
    if (info.size > MAX_ATLAS_BYTES) {
      errors.push({ id, error: "spritesheet-too-large" });
      continue;
    }
    if (contentTypeFor(atlasFile) === null) {
      errors.push({ id, error: "spritesheet-type" });
      continue;
    }
    pets.push({
      id: parsed.pet.id,
      displayName: parsed.pet.displayName,
      description: parsed.pet.description,
      kind: parsed.pet.kind,
      spriteVersionNumber: parsed.pet.spriteVersionNumber,
      atlasUrl: atlasUrlFor(parsed.pet.id),
      atlasBytes: info.size,
    });
  }
  return { pets, errors, missing: false };
}

/** Pick the configured default pet when it exists, else the first one. */
export function pickDefaultPet(pets, requested) {
  if (!Array.isArray(pets) || pets.length === 0) return "";
  if (typeof requested === "string" && pets.some((pet) => pet.id === requested)) return requested;
  return pets[0].id;
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_ATLAS_BYTES,
  PET_ID_RE,
  STATES,
  assetPathFor,
  atlasFor,
  contentTypeFor,
  isSafeRelativeAssetPath,
  listPets,
  parseManifest,
  pickDefaultPet,
  resolvePetsRoot,
} from "../lib/pet-store.js";

const WEBP = Buffer.from("RIFF0000WEBPVP8 ", "utf8");

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "dsh-pet-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function writePet(root, id, manifest, atlas = WEBP) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  if (manifest !== null) await writeFile(join(dir, "pet.json"), JSON.stringify(manifest));
  if (atlas !== null) await writeFile(join(dir, "spritesheet.webp"), atlas);
  return dir;
}

test("atlas geometry follows the version field", () => {
  assert.deepEqual(atlasFor(1), { rows: 9, width: 1536, height: 1872 });
  assert.deepEqual(atlasFor(2), { rows: 11, width: 1536, height: 2288 });
  assert.equal(STATES[1].lookA, undefined, "v1 has no look rows");
  assert.equal(STATES[2].lookA.row, 9);
  assert.equal(STATES[2].lookB.row, 10);
  assert.equal(STATES[2].wait.frames, 6);
  assert.equal(STATES[2].runRight.durations.reduce((a, b) => a + b, 0), 1060);
});

test("manifest parsing is defensive and defaults to the folder id", () => {
  const defaults = parseManifest(null, "blue-whale-maid");
  assert.equal(defaults.ok, true);
  assert.equal(defaults.pet.displayName, "blue-whale-maid");
  assert.equal(defaults.pet.spriteVersionNumber, 1);
  assert.equal(defaults.pet.spritesheetPath, "spritesheet.webp");

  const unsafe = parseManifest({ spritesheetPath: "../escape.webp" }, "blue-whale-maid");
  assert.equal(unsafe.ok, false);
  assert.equal(unsafe.error, "spritesheet-unsafe");

  const declared = parseManifest(
    { displayName: "  蓝鲸女仆  ", description: "  maid  ", spriteVersionNumber: 2, kind: "person" },
    "blue-whale-maid"
  );
  assert.equal(declared.pet.displayName, "蓝鲸女仆");
  assert.equal(declared.pet.description, "maid");
  assert.equal(declared.pet.spriteVersionNumber, 2);
  assert.equal(declared.pet.kind, "person");

  const badId = parseManifest({}, "Blue Whale");
  assert.equal(badId.ok, false);
  assert.equal(badId.error, "invalid-id");
});

test("pet ids stay filesystem-safe", () => {
  assert.equal(PET_ID_RE.test("blue-whale-maid"), true);
  assert.equal(PET_ID_RE.test("a"), true);
  assert.equal(PET_ID_RE.test("../etc"), false);
  assert.equal(PET_ID_RE.test("Blue"), false);
  assert.equal(PET_ID_RE.test("a".repeat(65)), false);
});

test("asset paths cannot escape the pet directory", () => {
  assert.equal(isSafeRelativeAssetPath("spritesheet.webp"), true);
  assert.equal(isSafeRelativeAssetPath("art/sheet.png"), true);
  assert.equal(isSafeRelativeAssetPath("../sheet.webp"), false);
  assert.equal(isSafeRelativeAssetPath("/etc/passwd"), false);
  assert.equal(isSafeRelativeAssetPath("C:\\sheet.webp"), false);
  assert.equal(isSafeRelativeAssetPath("a/../../b"), false);
  assert.equal(isSafeRelativeAssetPath(""), false);

  const dir = join(tmpdir(), "pets", "demo");
  assert.equal(assetPathFor(dir, { spritesheetPath: "sheet.webp" }), join(dir, "sheet.webp"));
  assert.equal(assetPathFor(dir, { spritesheetPath: "../x.webp" }), null);
});

test("content types cover only still images", () => {
  assert.equal(contentTypeFor("a.webp"), "image/webp");
  assert.equal(contentTypeFor("a.PNG"), "image/png");
  assert.equal(contentTypeFor("a.gif"), "image/gif");
  assert.equal(contentTypeFor("a.svg"), null);
  assert.equal(contentTypeFor("a.mp4"), null);
});

test("pets root resolves DSH_HOME before the home default", () => {
  assert.equal(resolvePetsRoot({ DSH_HOME: "/tmp/home" }), join("/tmp/home", "pets"));
  assert.equal(resolvePetsRoot({ DSH_HOME: "   " }).endsWith(join(".dsh", "pets")), true);
});

test("listPets reads manifests, enforces limits, and reports errors", async () => {
  const { root, cleanup } = await makeRoot();
  try {
    await writePet(root, "good-v2", { displayName: "Good", spriteVersionNumber: 2 });
    await writePet(root, "no-manifest", null);
    await writePet(root, "bad-manifest", null);
    await writeFile(join(root, "bad-manifest", "pet.json"), "{not json");
    await writePet(root, "missing-sheet", {}, null);
    await writePet(root, "too-big", {}, Buffer.alloc(MAX_ATLAS_BYTES + 1));
    await mkdir(join(root, "not-a-pet"), { recursive: true });

    const { pets, errors, missing } = await listPets(root);
    assert.equal(missing, false);
    assert.deepEqual(
      pets.map((pet) => pet.id),
      ["good-v2", "no-manifest"]
    );
    assert.equal(pets[0].spriteVersionNumber, 2);
    assert.equal(pets[0].atlasUrl, "/plugins/dsh-plugin-pet/pets/good-v2/spritesheet");
    const codes = errors.map((entry) => `${entry.id}:${entry.error}`).sort();
    assert.deepEqual(codes, ["bad-manifest:manifest-invalid", "missing-sheet:spritesheet-missing", "too-big:spritesheet-too-large"]);
  } finally {
    await cleanup();
  }
});

test("a missing pets directory is an empty catalog, not a failure", async () => {
  const { root, cleanup } = await makeRoot();
  try {
    const result = await listPets(join(root, "nope"));
    assert.equal(result.missing, true);
    assert.deepEqual(result.pets, []);
  } finally {
    await cleanup();
  }
});

test("default pet selection prefers an existing request", () => {
  const pets = [{ id: "a" }, { id: "b" }];
  assert.equal(pickDefaultPet(pets, "b"), "b");
  assert.equal(pickDefaultPet(pets, "zzz"), "a");
  assert.equal(pickDefaultPet([], "a"), "");
});

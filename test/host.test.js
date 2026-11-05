import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, createHandlers, hostnameOf, isTrustedHost } from "../lib/index.js";
import { MAX_ATLAS_BYTES } from "../lib/pet-store.js";

const WEBP = Buffer.from("RIFF0000WEBPVP8 ", "utf8");

async function withPets(fn) {
  const root = await mkdtemp(join(tmpdir(), "dsh-pet-host-"));
  const dir = join(root, "blue-whale-maid");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pet.json"), JSON.stringify({ displayName: "蓝鲸女仆", spriteVersionNumber: 2 }));
  await writeFile(join(dir, "spritesheet.webp"), WEBP);
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("host header parsing accepts loopback only", () => {
  assert.equal(hostnameOf("127.0.0.1:64432"), "127.0.0.1");
  assert.equal(hostnameOf("LOCALHOST:1"), "localhost");
  assert.equal(hostnameOf("[::1]:64432"), "[::1]");
  assert.equal(isTrustedHost("127.0.0.1:64432"), true);
  assert.equal(isTrustedHost("localhost:3000"), true);
  assert.equal(isTrustedHost("192.168.1.10:3000"), false);
  assert.equal(isTrustedHost("evil.example.com"), false);
  assert.equal(isTrustedHost(undefined), false);
});

test("list returns the catalog with atlas urls", async () => {
  await withPets(async (root) => {
    const handlers = createHandlers({ root, defaultPet: "blue-whale-maid" });
    const out = await handlers.list();
    assert.equal(out.status, 200);
    const body = JSON.parse(out.body);
    assert.equal(body.ok, true);
    assert.equal(body.defaultPet, "blue-whale-maid");
    assert.equal(body.pets.length, 1);
    assert.equal(body.pets[0].displayName, "蓝鲸女仆");
    assert.equal(body.pets[0].atlasUrl, "/plugins/dsh-plugin-pet/pets/blue-whale-maid/spritesheet");
    assert.equal(body.pets[0].atlasBytes, WEBP.length);
  });
});

test("atlas serves image bytes, type, and a matching etag", async () => {
  await withPets(async (root) => {
    const handlers = createHandlers({ root });
    const first = await handlers.atlas("blue-whale-maid");
    assert.equal(first.status, 200);
    assert.equal(first.headers["content-type"], "image/webp");
    assert.equal(first.headers["cache-control"], "public, max-age=300");
    assert.equal(Buffer.compare(first.body, WEBP), 0);
    assert.deepEqual(first.atlas, { rows: 11, width: 1536, height: 2288 });

    const cached = await handlers.atlas("blue-whale-maid", { ifNoneMatch: first.headers.etag });
    assert.equal(cached.status, 304);
    assert.equal(cached.body, null);
  });
});

test("atlas rejects traversal-shaped ids and unknown pets", async () => {
  await withPets(async (root) => {
    const handlers = createHandlers({ root });
    const traversal = await handlers.atlas("..%2f..%2fetc");
    assert.equal(traversal.status, 400);

    const slash = await handlers.atlas("../etc");
    assert.equal(slash.status, 400);

    const missing = await handlers.atlas("ghost");
    assert.equal(missing.status, 404);
  });
});

test("atlas rejects an oversized sheet and a non-image extension", async () => {
  await withPets(async (root) => {
    const big = join(root, "big");
    await mkdir(big);
    await writeFile(join(big, "spritesheet.webp"), Buffer.alloc(MAX_ATLAS_BYTES + 1));
    const svg = join(root, "vector");
    await mkdir(svg);
    await writeFile(join(svg, "pet.json"), JSON.stringify({ spritesheetPath: "sheet.svg" }));
    await writeFile(join(svg, "sheet.svg"), "<svg/>");

    const handlers = createHandlers({ root });
    assert.equal((await handlers.atlas("big")).status, 413);
    assert.equal((await handlers.atlas("vector")).status, 415);
  });
});

test("atlas refuses a spritesheetPath that escapes the pet folder", async () => {
  await withPets(async (root) => {
    const unsafe = join(root, "unsafe");
    await mkdir(unsafe);
    await writeFile(join(unsafe, "pet.json"), JSON.stringify({ spritesheetPath: "../blue-whale-maid/spritesheet.webp" }));
    const handlers = createHandlers({ root });
    const out = await handlers.atlas("unsafe");
    assert.equal(out.status, 400);
  });
});

test("registers an exact list route and a slash-free prefix route", async () => {
  await withPets(async (root) => {
    const routes = [];
    const ctx = {
      effect: (fn) => fn(),
      webServer: { register: (route) => (routes.push(route), () => {}) },
      logger: { info() {} },
    };
    apply(ctx, { dir: root });
    assert.deepEqual(
      routes.map((route) => `${route.kind} ${route.path}`),
      [
        "exact /plugins/dsh-plugin-pet/pets",
        "prefix /plugins/dsh-plugin-pet/pets",
      ]
    );
    // The server appends "/" when matching, so a trailing slash would break the atlas route.
    assert.equal(routes[1].path.endsWith("/"), false);
  });
});

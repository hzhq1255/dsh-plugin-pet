import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "lib", "client.js"), "utf8");

const REACT_STUB = {
  createElement: () => null,
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
};

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

/** Evaluate the ModuleLoader bundle the way the browser shell does. */
function loadClient({ storage = makeStorage() } = {}) {
  let exported = null;
  const sandbox = {
    console,
    performance,
    setTimeout,
    clearTimeout,
    window: {
      innerWidth: 1280,
      innerHeight: 800,
      localStorage: storage,
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      __ModuleLoader__: {
        load: ({ id, factory }) => {
          assert.equal(id, "dsh-plugin-pet");
          exported = factory((request) => {
            if (request === "react") return REACT_STUB;
            throw new Error(`unexpected module request: ${request}`);
          });
        },
      },
    },
  };
  vm.runInNewContext(SOURCE, sandbox);
  return exported;
}

test("bundle exposes the plugin contract", () => {
  const plugin = loadClient();
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual([...plugin.inject], ["slots", "sessions"]);
});

test("frame table advances by duration, not by equal steps", () => {
  const { frameAt } = loadClient().__test;
  assert.equal(frameAt("idle", 0, 2).index, 0);
  assert.equal(frameAt("idle", 279, 2).index, 0);
  assert.equal(frameAt("idle", 280, 2).index, 1);
  assert.equal(frameAt("idle", 1099, 2).index, 5);
  assert.equal(frameAt("idle", 1100, 2).index, 0, "idle loops");
  assert.equal(frameAt("idle", 1100, 2).done, false);
});

test("one-shot rows report completion and clamp to the last frame", () => {
  const { frameAt } = loadClient().__test;
  const wave = frameAt("wave", 700, 2);
  assert.deepEqual({ index: wave.index, done: wave.done }, { index: 3, done: true });
  const early = frameAt("wave", 0, 2);
  assert.equal(early.done, false);
});

test("v1 falls back to the idle row when a v2 action is requested", () => {
  const { frameAt, STATES } = loadClient().__test;
  assert.equal(STATES[1].lookA, undefined);
  assert.equal(frameAt("lookA", 10, 1).index, frameAt("idle", 10, 1).index);
});

test("animation follows the current session; other sessions only notify", () => {
  const { deriveMode } = loadClient().__test;
  const rows = [
    { id: "a", running: true, pending: false, blank: false },
    { id: "b", running: false, pending: true, blank: false },
  ];

  const onA = deriveMode(rows, "a");
  assert.equal(onA.mode, "run");
  assert.equal(onA.row.id, "a");
  assert.equal(onA.pendingOther.id, "b");

  const onB = deriveMode(rows, "b");
  assert.equal(onB.mode, "wait");
  assert.equal(onB.row.id, "b");
  assert.equal(onB.pendingOther, null);

  assert.equal(deriveMode(rows, undefined).mode, "idle");
  assert.equal(deriveMode(rows, "ghost").mode, "idle");
  assert.equal(deriveMode([{ id: "c", running: true, pending: true, blank: true }], "c").mode, "idle");
});

test("look frames map 16 directions onto rows 9 and 10", () => {
  const { lookFrameFor } = loadClient().__test;
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(lookFrameFor(0, -10)), { row: 9, col: 0 }, "up = 0°");
  assert.deepEqual(plain(lookFrameFor(10, 0)), { row: 9, col: 4 }, "right = 90°");
  assert.deepEqual(plain(lookFrameFor(0, 10)), { row: 10, col: 0 }, "down = 180°");
  assert.deepEqual(plain(lookFrameFor(-10, 0)), { row: 10, col: 4 }, "left = 270°");
  assert.deepEqual(plain(lookFrameFor(10, -10)), { row: 9, col: 2 }, "45°");
});

test("position clamps into the viewport", () => {
  const { clampPosition, PET_W, PET_H } = loadClient().__test;
  // VM-realm objects carry a foreign prototype; compare their plain shape.
  const plain = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(plain(clampPosition({ x: -50, y: -50 }, { width: 1280, height: 800 })), { x: 0, y: 0 });
  assert.deepEqual(plain(clampPosition({ x: 9999, y: 9999 }, { width: 1280, height: 800 })), {
    x: 1280 - PET_W,
    y: 800 - PET_H,
  });
  assert.deepEqual(plain(clampPosition({ x: 10, y: 20 }, { width: 1280, height: 800 })), { x: 10, y: 20 });
  assert.deepEqual(plain(clampPosition({ x: 10, y: 20 }, { width: 100, height: 100 })), { x: 0, y: 0 });
});

test("pet choice prefers the stored id, then the host default", () => {
  const pets = [
    { id: "blue-whale-maid", displayName: "蓝鲸女仆" },
    { id: "pixel-whale", displayName: "Pixel Whale" },
  ];
  const storage = makeStorage({ "dsh-plugin-pet:pet": "pixel-whale" });
  const stored = loadClient({ storage }).__test;
  assert.equal(stored.choosePet(pets, "blue-whale-maid").id, "pixel-whale");

  const fresh = loadClient().__test;
  assert.equal(fresh.choosePet(pets, "pixel-whale").id, "pixel-whale");
  assert.equal(fresh.choosePet(pets, "missing").id, "blue-whale-maid");
  assert.equal(fresh.choosePet([], "x"), null);
});

test("pet cycling wraps, tolerates one pet, and ignores an unknown current id", () => {
  const { cyclePet } = loadClient().__test;
  const pets = [{ id: "a" }, { id: "b" }, { id: "c" }];
  assert.equal(cyclePet(pets, "a"), "b");
  assert.equal(cyclePet(pets, "b"), "c");
  assert.equal(cyclePet(pets, "c"), "a");
  assert.equal(cyclePet(pets, "zzz"), "a");
  assert.equal(cyclePet([{ id: "a" }], "a"), "a");
  assert.equal(cyclePet([], "a"), "");
  assert.equal(cyclePet(undefined, "a"), "");
});

test("registers both the overlay occupant and the settings section", () => {
  const plugin = loadClient();
  const registered = [];
  const ctx = {
    slots: {
      inject: (_name, make) => make(),
      register: (options) => {
        registered.push(options);
        return () => {};
      },
    },
    sessions: { open() {} },
    logger: { warn() {} },
  };
  plugin.apply(ctx);
  assert.equal(registered.length, 2);
  assert.equal(registered[0].name, "settings.section");
  assert.equal(registered[0].id, "pet");
  assert.equal(registered[1].name, "shell.overlay");
  assert.equal(registered[1].id, "pet");
});

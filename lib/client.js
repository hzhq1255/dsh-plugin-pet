/**
 * dsh-plugin-pet — browser half.
 *
 * Codex-Pet-compatible companion for the DSH web GUI. Registers one
 * `shell.overlay` occupant and reads session state through the root
 * `sessions` hook. The atlas is served by the host half from
 * `$DSH_HOME/pets/<id>/`, never embedded in this bundle.
 *
 * The animation table mirrors lib/pet-store.js — keep both in sync.
 *
 * Adapted from the browser engine of dsh-blue-whale-maid (MIT,
 * Copyright (c) 2026 yuxino): the frame scheduler, bubble controller, drag
 * handling, and the "only report what is certain" copy rules. Changes:
 * external atlas URL, no billing panel, no Codex-directory scanning,
 * v1/v2 atlas versions, and pet cycling.
 */

window.__ModuleLoader__.load({
	id: "dsh-plugin-pet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const react = require("react");
		const { useCallback, useEffect, useMemo, useRef, useState } = react;

		const BASE = "/plugins/dsh-plugin-pet";
		const CELL_W = 192;
		const CELL_H = 208;
		const SCALE = 0.75;
		const PET_W = CELL_W * SCALE;
		const PET_H = CELL_H * SCALE;
		const MARGIN = 24;
		const STORE_POS = "dsh-plugin-pet:pos";
		const STORE_PET = "dsh-plugin-pet:pet";

		const SIZES = {
			1: { width: 1536, height: 1872, rows: 9 },
			2: { width: 1536, height: 2288, rows: 11 }
		};

		const ROWS = [
			["idle", 0, [280, 110, 110, 140, 140, 320], false, false],
			["runRight", 1, [120, 120, 120, 120, 120, 120, 120, 220], false, false],
			["runLeft", 2, [120, 120, 120, 120, 120, 120, 120, 220], false, false],
			["wave", 3, [140, 140, 140, 280], true, false],
			["jump", 4, [140, 140, 140, 140, 280], true, false],
			["failed", 5, [140, 140, 140, 140, 140, 140, 140, 240], true, false],
			["wait", 6, [150, 150, 150, 150, 150, 260], false, false],
			["run", 7, [120, 120, 120, 120, 120, 220], false, false],
			["review", 8, [150, 150, 150, 150, 150, 280], false, false],
			["lookA", 9, [0, 22.5, 45, 67.5, 90, 112.5, 135, 157.5], true, true],
			["lookB", 10, [180, 202.5, 225, 247.5, 270, 292.5, 315, 337.5], true, true]
		];

		function buildStates(version) {
			const max = version === 2 ? 2 : 1;
			const out = {};
			for (const [name, row, durations, once, v2] of ROWS) {
				if ((v2 ? 2 : 1) > max) continue;
				out[name] = {
					row,
					durations,
					total: durations.reduce((sum, value) => sum + value, 0),
					once
				};
			}
			return out;
		}

		const STATES = { 1: buildStates(1), 2: buildStates(2) };

		const LINES = {
			pending: "有个任务在等你确认。",
			ended: "这一轮结束了。",
			failed: "这次没有跑完。",
			wave: ["在呢。", "听见啦。", "需要我做什么？"],
			jump: ["好耶。", "收到。"],
			switched: (name) => `换成「${name}」了。`,
			onlyOne: "现在只有一只宠物。",
			noPets: "没有找到宠物包。",
			offline: "暂时连不上宠物目录。"
		};

		function pick(list) {
			return list[Math.floor(Math.random() * list.length)];
		}

		function truncate(text, max) {
			return typeof text === "string" && text.length > max ? `${text.slice(0, max)}…` : text;
		}

		/** Frame index for one state at `elapsed` ms, plus whether a one-shot finished. */
		function frameAt(state, elapsed, version) {
			const table = STATES[version === 2 ? 2 : 1];
			const spec = table[state] ?? table.idle;
			if (spec.once && elapsed >= spec.total) {
				return { index: spec.durations.length - 1, done: true };
			}
			const time = spec.once ? Math.max(0, elapsed) : Math.max(0, elapsed) % spec.total;
			let acc = 0;
			for (let index = 0; index < spec.durations.length; index += 1) {
				acc += spec.durations[index];
				if (time < acc) return { index, done: false };
			}
			return { index: spec.durations.length - 1, done: false };
		}

		/**
		 * Animation follows the CURRENT session only. Other sessions surface as
		 * bubbles (pending / run stopped), never by hijacking the animation.
		 */
		function deriveMode(rows, current) {
			const list = (rows ?? []).filter((row) => row && row.blank !== true);
			const currentRow = list.find((row) => row.id === current) ?? null;
			const pending = list.find((row) => row.pending === true) ?? null;
			const running = list.find((row) => row.running === true) ?? null;
			const mode = currentRow?.pending === true ? "wait" : currentRow?.running === true ? "run" : "idle";
			return {
				mode,
				row: currentRow,
				pending,
				running,
				pendingOther: pending !== null && pending.id !== current ? pending : null
			};
		}

		/**
		 * 16-way look direction: 0° = up, clockwise. Row 9 holds 0–157.5°,
		 * row 10 holds 180–337.5°, eight columns each.
		 */
		function lookFrameFor(dx, dy) {
			const degrees = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
			const index = Math.round(degrees / 22.5) % 16;
			return { row: index < 8 ? 9 : 10, col: index % 8 };
		}

		/** Keep the pet fully inside the viewport. */
		function clampPosition(position, viewport) {
			const maxX = Math.max(0, viewport.width - PET_W);
			const maxY = Math.max(0, viewport.height - PET_H);
			return {
				x: Math.min(Math.max(0, position.x), maxX),
				y: Math.min(Math.max(0, position.y), maxY)
			};
		}

		function readPosition() {
			try {
				const raw = window.localStorage.getItem(STORE_POS);
				if (raw === null) return null;
				const parsed = JSON.parse(raw);
				if (Number.isFinite(parsed?.x) && Number.isFinite(parsed?.y)) return { x: parsed.x, y: parsed.y };
			} catch {
				/* a corrupt position is not worth a broken pet */
			}
			return null;
		}

		function savePosition(position) {
			try {
				window.localStorage.setItem(STORE_POS, JSON.stringify(position));
			} catch {
				/* private mode */
			}
		}

		function defaultPosition() {
			return {
				x: Math.max(MARGIN, window.innerWidth - PET_W - MARGIN),
				y: Math.max(MARGIN, window.innerHeight - PET_H - MARGIN)
			};
		}

		/** Next pet id in catalog order; an unknown current id falls back to the first. */
		function cyclePet(pets, currentId) {
			if (!Array.isArray(pets) || pets.length === 0) return "";
			const index = pets.findIndex((pet) => pet?.id === currentId);
			const next = pets[(index + 1) % pets.length];
			return typeof next?.id === "string" ? next.id : "";
		}

		/** Prefer the locally chosen pet, then the host default, then the first one. */
		function choosePet(pets, hostDefault) {
			if (!Array.isArray(pets) || pets.length === 0) return null;
			let stored = "";
			try {
				stored = window.localStorage.getItem(STORE_PET) ?? "";
			} catch {
				/* ignore */
			}
			if (stored !== "" && pets.some((pet) => pet.id === stored)) {
				return pets.find((pet) => pet.id === stored);
			}
			if (typeof hostDefault === "string" && pets.some((pet) => pet.id === hostDefault)) {
				return pets.find((pet) => pet.id === hostDefault);
			}
			return pets[0];
		}

		function titleOf(row) {
			const title = typeof row?.title === "string" && row.title.trim() !== "" ? row.title : "";
			return title === "" ? "当前会话" : truncate(title, 18);
		}

		const VIEW_KEY = (rows) =>
			(rows ?? [])
				.map((row) => `${row?.id ?? ""}:${row?.blank ? 1 : 0}${row?.pending ? 1 : 0}${row?.running ? 1 : 0}`)
				.join("|");

		const CSS = `
.dpet-root{position:fixed;z-index:1200;width:144px;height:156px;pointer-events:auto;touch-action:none;cursor:grab;outline:none}
.dpet-root[data-dragging]{cursor:grabbing}
.dpet-sprite{width:192px;height:208px;transform:scale(.75);transform-origin:top left;background-repeat:no-repeat;filter:drop-shadow(0 6px 10px rgba(0,0,0,.18));will-change:background-position}
.dpet-root:focus-visible .dpet-sprite{outline:2px solid var(--dsw-alias-accent,#4c8dff);outline-offset:2px;border-radius:10px}
.dpet-bubble{position:absolute;right:0;bottom:calc(100% + 6px);max-width:260px;padding:8px 10px;border-radius:12px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#1f2329);border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgba(0,0,0,.16));font-size:12px;line-height:18px;display:flex;flex-direction:column;gap:6px;pointer-events:auto;animation:dpet-pop .14s ease-out}
.dpet-bubble[hidden]{display:none}
.dpet-bubble button{align-self:flex-start;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));background:var(--dsw-alias-fill-l2,#f2f4f7);color:inherit;border-radius:8px;padding:2px 8px;font-size:12px;cursor:pointer}
.dpet-bubble button:hover{background:var(--dsw-alias-fill-l3,#e6e9ef)}
@keyframes dpet-pop{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion: reduce){.dpet-bubble{animation:none}}
.dpet-settings{display:flex;flex-direction:column;gap:10px;padding:4px 0;max-width:620px}
.dpet-settings h3{margin:0;font-size:14px;line-height:20px}
.dpet-settings p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#6b7280)}
.dpet-settings-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
.dpet-settings-card{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));background:var(--dsw-alias-fill-l1,transparent);cursor:pointer;text-align:left;color:inherit;font:inherit}
.dpet-settings-card[data-active=true]{border-color:var(--dsw-alias-accent,#4c8dff);box-shadow:inset 0 0 0 1px var(--dsw-alias-accent,#4c8dff)}
.dpet-settings-thumb{width:48px;height:52px;background-repeat:no-repeat;flex:none;border-radius:6px}
.dpet-settings-name{font-size:12px;line-height:16px}
.dpet-settings-meta{font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary,#6b7280)}
`;

		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById("dsh-plugin-pet-style") !== null) return;
			const style = document.createElement("style");
			style.id = "dsh-plugin-pet-style";
			style.textContent = CSS;
			document.head.appendChild(style);
		}

		// ------------------------------------------------------------ component
		function PetLayer(props) {
			const [catalog, setCatalog] = useState(null);
			const [petId, setPetId] = useState("");
			const [position, setPosition] = useState(null);
			const [bubble, setBubble] = useState(null);
			const [dragging, setDragging] = useState(false);

			const rootRef = useRef(null);
			const spriteRef = useRef(null);
			const modeRef = useRef({ mode: "idle", row: null });
			const gestureRef = useRef(null);
			const hideTimerRef = useRef(0);
			const posRef = useRef(null);
			const dragRef = useRef(null);
			const runMapRef = useRef(new Map());
			const pendingSeenRef = useRef(new Set());
			const notifyQueueRef = useRef([]);
			const pointerRef = useRef({ x: -1, y: -1, at: 0 });
			const shownIntroRef = useRef(false);

			posRef.current = position;

			ensureStyle();

			// --- catalog
			// The catalog is re-read on demand (right-click / window focus), not just at
			// mount: a pet dropped into $DSH_HOME/pets later must become visible without
			// forcing a page reload.
			const fetchCatalog = useCallback(async () => {
				const response = await fetch(`${BASE}/pets`, { cache: "no-store" });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const payload = await response.json();
				setCatalog(payload);
				return payload;
			}, []);

			useEffect(() => {
				let alive = true;
				fetchCatalog()
					.then((payload) => {
						if (!alive) return;
						const pet = choosePet(payload?.pets, payload?.defaultPet);
						if (pet === null) {
							console.info("[dsh-plugin-pet] no pet packages found under $DSH_HOME/pets");
							return;
						}
						setPetId(pet.id);
					})
					.catch((error) => {
						if (!alive) return;
						console.warn("[dsh-plugin-pet] pet catalog unavailable:", error);
						setCatalog({ ok: false, pets: [], errors: [] });
					});
				return () => {
					alive = false;
				};
			}, [fetchCatalog]);

			useEffect(() => {
				const onFocus = () => {
					fetchCatalog().catch(() => {});
				};
				window.addEventListener("focus", onFocus);
				return () => window.removeEventListener("focus", onFocus);
			}, [fetchCatalog]);

			const pets = catalog?.pets ?? [];
			const pet = useMemo(() => pets.find((entry) => entry.id === petId) ?? null, [pets, petId]);
			const version = pet?.spriteVersionNumber === 2 ? 2 : 1;
			const size = SIZES[version];

			// --- initial position + viewport clamping
			useEffect(() => {
				const start = readPosition() ?? defaultPosition();
				setPosition(clampPosition(start, { width: window.innerWidth, height: window.innerHeight }));
				const onResize = () => {
					const current = posRef.current ?? defaultPosition();
					setPosition(clampPosition(current, { width: window.innerWidth, height: window.innerHeight }));
				};
				window.addEventListener("resize", onResize);
				const onPointerMove = (event) => {
					pointerRef.current = { x: event.clientX, y: event.clientY, at: performance.now() };
				};
				window.addEventListener("pointermove", onPointerMove, { passive: true });
				return () => {
					window.removeEventListener("resize", onResize);
					window.removeEventListener("pointermove", onPointerMove);
				};
			}, []);

			// --- session view
			const view = props.useSessions
				? props.useSessions((snapshot) => {
						const byId = snapshot?.byId ?? {};
						const rows = Object.values(byId).map((row) => ({
							id: row?.id,
							title: row?.displayTitle ?? row?.title,
							blank: row?.blank === true,
							running: row?.running === true,
							pending: row?.pendingInteraction === true
						}));
						return { rows, current: snapshot?.current };
					})
				: { rows: [], current: undefined };

			const viewKey = VIEW_KEY(view?.rows);
			const currentId = view?.current;
			const derived = useMemo(() => deriveMode(view?.rows, currentId), [viewKey, currentId]);

			// --- bubble controller
			const show = useCallback(
				(text, options = {}) => {
					window.clearTimeout(hideTimerRef.current);
					setBubble({ text, kind: options.kind ?? "", sessionId: options.sessionId ?? "" });
					hideTimerRef.current = window.setTimeout(() => setBubble(null), options.ms ?? 5000);
				},
				[]
			);

			// --- notifications: other sessions never hijack the animation
			const queueNotice = useCallback((text, options = {}) => {
				notifyQueueRef.current.push({ text, options });
				if (notifyQueueRef.current.length > 8) notifyQueueRef.current.shift();
			}, []);

			useEffect(() => {
				modeRef.current = derived;
				const rows = view?.rows ?? [];
				const now = Date.now();
				const present = new Set();

				for (const row of rows) {
					if (row === null || row === undefined || row.blank === true) continue;
					present.add(row.id);

					if (row.running === true) {
						if (!runMapRef.current.has(row.id)) {
							runMapRef.current.set(row.id, { since: now, title: titleOf(row) });
						}
					} else {
						const previous = runMapRef.current.get(row.id);
						if (previous !== undefined) {
							runMapRef.current.delete(row.id);
							// The session list exposes activity, not an outcome: never claim success.
							if (now - previous.since > 2000) queueNotice(`${previous.title} ${LINES.ended}`, { sessionId: row.id });
						}
					}

					if (row.pending === true) {
						if (!pendingSeenRef.current.has(row.id)) {
							pendingSeenRef.current.add(row.id);
							queueNotice(`${titleOf(row)} 正在等你确认。`, { kind: "wait", sessionId: row.id });
						}
					} else {
						pendingSeenRef.current.delete(row.id);
					}
				}

				for (const id of [...runMapRef.current.keys()]) {
					if (!present.has(id)) runMapRef.current.delete(id);
				}
			}, [viewKey, derived, view, queueNotice]);

			// Drain one queued notice at a time so simultaneous sessions cannot overwrite each other.
			useEffect(() => {
				if (bubble !== null || notifyQueueRef.current.length === 0) return;
				const next = notifyQueueRef.current.shift();
				show(next.text, { ...next.options, ms: 2600 });
			}, [bubble, show]);

			useEffect(() => {
				if (shownIntroRef.current || pet === null) return;
				shownIntroRef.current = true;
				show(`${pet.displayName} 在呢。`, { ms: 3200 });
			}, [pet, show]);

			useEffect(() => {
				const onSelect = (event) => {
					const id = event?.detail?.id;
					if (typeof id === "string" && id !== "") setPetId(id);
				};
				window.addEventListener("dsh-plugin-pet:select", onSelect);
				return () => window.removeEventListener("dsh-plugin-pet:select", onSelect);
			}, []);

			useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

			// --- animation loop
			useEffect(() => {
				if (pet === null) return;
				const sprite = spriteRef.current;
				if (sprite === null) return;
				const table = STATES[version];
				const reduceMotion =
					typeof window.matchMedia === "function" &&
					window.matchMedia("(prefers-reduced-motion: reduce)").matches;

				sprite.style.width = `${CELL_W}px`;
				sprite.style.height = `${CELL_H}px`;
				sprite.style.backgroundSize = `${size.width}px ${size.height}px`;

				// The host validates the manifest; the browser is the only side that can
				// see the decoded atlas, so a wrong-sized sheet is reported once here.
				const probe = new window.Image();
				probe.onload = () => {
					if (probe.naturalWidth !== size.width || probe.naturalHeight !== size.height) {
						console.warn(
							`[dsh-plugin-pet] ${pet.id}: expected ${size.width}x${size.height} atlas, got ${probe.naturalWidth}x${probe.naturalHeight}`
						);
					}
				};
				probe.onerror = () => console.warn(`[dsh-plugin-pet] ${pet.id}: spritesheet failed to load (${pet.atlasUrl})`);
				probe.src = pet.atlasUrl;

				let raf = 0;
				let startedAt = performance.now();
				let painted = -1;
				let paintedRow = -1;

				const paint = (state, elapsed, now) => {
					const spec = table[state] ?? table.idle;
					const { index, done } = frameAt(state, elapsed, version);
					if (index !== painted || spec.row !== paintedRow) {
						painted = index;
						paintedRow = spec.row;
						sprite.style.backgroundPosition = `${-index * CELL_W}px ${-spec.row * CELL_H}px`;
					}
					if (done) {
						gestureRef.current = null;
						startedAt = now;
						painted = -1;
					}
				};

				const tick = (now) => {
					const gesture = gestureRef.current;
					const state = gesture !== null ? gesture.state : modeRef.current.mode === "run" ? "run" : modeRef.current.mode === "wait" ? "wait" : "idle";
					if (gesture !== null && now >= gesture.until) {
						gestureRef.current = null;
						startedAt = now;
					}
					// v2 look rows: the pet turns its eyes toward a nearby cursor while idle.
					const pointer = pointerRef.current;
					const dx = pointer.x - ((posRef.current?.x ?? 0) + PET_W / 2);
					const dy = pointer.y - ((posRef.current?.y ?? 0) + PET_H / 2);
					const distance = Math.hypot(dx, dy);
					const canLook =
						version === 2 &&
						gesture === null &&
						modeRef.current.mode === "idle" &&
						dragRef.current === null &&
						!reduceMotion &&
						pointer.at > 0 &&
						now - pointer.at < 1500 &&
						distance > 12 &&
						distance < 320;
					if (canLook) {
						const look = lookFrameFor(dx, dy);
						if (painted !== look.col || paintedRow !== look.row) {
							painted = look.col;
							paintedRow = look.row;
							sprite.style.backgroundPosition = `${-look.col * CELL_W}px ${-look.row * CELL_H}px`;
						}
						raf = window.requestAnimationFrame(tick);
						return;
					}

					if (reduceMotion) {
						if (painted !== 0 || paintedRow !== table[state].row) {
							painted = 0;
							paintedRow = table[state].row;
							sprite.style.backgroundPosition = `0px ${-table[state].row * CELL_H}px`;
						}
					} else {
						paint(state, now - startedAt, now);
					}
					raf = window.requestAnimationFrame(tick);
				};
				raf = window.requestAnimationFrame(tick);
				return () => window.cancelAnimationFrame(raf);
			}, [pet, version, size.width, size.height]);

			// --- gestures
			const gesture = useCallback((state, ms) => {
				gestureRef.current = { state, until: performance.now() + ms };
			}, []);

			// --- drag + click
			const onPointerDown = (event) => {
				if (event.button !== 0) return;
				const node = rootRef.current;
				if (node === null) return;
				const rect = node.getBoundingClientRect();
				dragRef.current = { startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top, moved: false };
				node.setPointerCapture?.(event.pointerId);
			};

			const onPointerMove = (event) => {
				const drag = dragRef.current;
				if (drag === null) return;
				const dx = event.clientX - drag.startX;
				const dy = event.clientY - drag.startY;
				if (!drag.moved && Math.hypot(dx, dy) < 4) return;
				if (!drag.moved) {
					drag.moved = true;
					setDragging(true);
				}
				setPosition(clampPosition({ x: drag.originX + dx, y: drag.originY + dy }, { width: window.innerWidth, height: window.innerHeight }));
			};

			const onPointerUp = (event) => {
				const drag = dragRef.current;
				dragRef.current = null;
				setDragging(false);
				if (drag === null) return;
				rootRef.current?.releasePointerCapture?.(event.pointerId);
				if (drag.moved) {
					savePosition(posRef.current ?? defaultPosition());
					return;
				}
				gesture("wave", 1200);
				show(pick(LINES.wave), { ms: 2400 });
			};

			const onDoubleClick = () => {
				gesture("jump", 1400);
				show(pick(LINES.jump), { ms: 1800 });
			};

			const onContextMenu = async (event) => {
				event.preventDefault();
				let payload = catalog;
				try {
					payload = await fetchCatalog();
				} catch {
					show(LINES.offline, { ms: 2400 });
					return;
				}
				const list = Array.isArray(payload?.pets) ? payload.pets : [];
				if (list.length === 0) {
					show(LINES.noPets, { ms: 2000 });
					return;
				}
				const nextId = cyclePet(list, petId);
				if (nextId === "" ) return;
				if (nextId === petId) {
					show(LINES.onlyOne, { ms: 2000 });
					return;
				}
				const next = list.find((entry) => entry.id === nextId);
				setPetId(nextId);
				try {
					window.localStorage.setItem(STORE_PET, nextId);
				} catch {
					/* ignore */
				}
				show(LINES.switched(next?.displayName ?? nextId), { ms: 2400 });
			};

			const onKeyDown = (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				gesture("wave", 1200);
				show(pick(LINES.wave), { ms: 2400 });
			};

			if (pet === null || position === null) return null;

			const bubbleNode =
				bubble === null
					? null
					: react.createElement(
							"div",
							{ className: "dpet-bubble", role: "status" },
							react.createElement("span", null, bubble.text),
							bubble.sessionId !== "" && typeof props.openSession === "function"
								? react.createElement(
										"button",
										{
											type: "button",
											onPointerDown: (event) => event.stopPropagation(),
											onClick: () => props.openSession(bubble.sessionId)
										},
										"去看看 →"
									)
								: null
						);

			return react.createElement(
				"div",
				{
					ref: rootRef,
					className: "dpet-root",
					role: "button",
					tabIndex: 0,
					"aria-label": `桌宠：${pet.displayName}`,
					"data-dragging": dragging ? "true" : undefined,
					style: { left: `${position.x}px`, top: `${position.y}px` },
					onPointerDown,
					onPointerMove,
					onPointerUp,
					onPointerCancel: onPointerUp,
					onDoubleClick,
					onContextMenu,
					onKeyDown
				},
				react.createElement("div", {
					ref: spriteRef,
					className: "dpet-sprite",
					"aria-hidden": "true",
					style: { backgroundImage: `url("${pet.atlasUrl}")` }
				}),
				bubbleNode
			);
		}

		// ------------------------------------------------------- settings page
		function thumbStyle(pet) {
			const height = pet.spriteVersionNumber === 2 ? 2288 : 1872;
			const scale = 0.25;
			return {
				backgroundImage: `url("${pet.atlasUrl}")`,
				backgroundSize: `${1536 * scale}px ${height * scale}px`,
				backgroundPosition: "0px 0px"
			};
		}

		function PetSettingsSection() {
			ensureStyle();
			const [payload, setPayload] = useState(null);
			const [error, setError] = useState("");
			const [selected, setSelected] = useState(() => {
				try {
					return window.localStorage.getItem(STORE_PET) ?? "";
				} catch {
					return "";
				}
			});

			useEffect(() => {
				let alive = true;
				fetch(`${BASE}/pets`, { cache: "no-store" })
					.then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
					.then((data) => {
						if (alive) setPayload(data);
					})
					.catch((reason) => {
						if (alive) setError(String(reason));
					});
				return () => {
					alive = false;
				};
			}, []);

			const pets = payload?.pets ?? [];
			const active = selected !== "" ? selected : payload?.defaultPet ?? "";

			const pick = (id) => {
				setSelected(id);
				try {
					window.localStorage.setItem(STORE_PET, id);
				} catch {
					/* ignore */
				}
				window.dispatchEvent(new CustomEvent("dsh-plugin-pet:select", { detail: { id } }));
			};

			const cards = pets.map((pet) =>
				react.createElement(
					"button",
					{
						key: pet.id,
						type: "button",
						className: "dpet-settings-card",
						"data-active": pet.id === active ? "true" : undefined,
						onClick: () => pick(pet.id)
					},
					react.createElement("span", { className: "dpet-settings-thumb", style: thumbStyle(pet), "aria-hidden": "true" }),
					react.createElement(
						"span",
						null,
						react.createElement("span", { className: "dpet-settings-name", style: { display: "block" } }, pet.displayName),
						react.createElement("span", { className: "dpet-settings-meta" }, pet.id)
					)
				)
			);

			return react.createElement(
				"div",
				{ className: "dpet-settings" },
				react.createElement("h3", null, "桌宠"),
				react.createElement("p", null, "选择右下角显示哪只宠物。选择保存在本机浏览器，点选后即时切换。"),
				error !== "" ? react.createElement("p", null, `宠物目录读取失败：${error}`) : null,
				pets.length === 0
					? react.createElement("p", null, "还没有宠物包：把 pet.json + spritesheet 放进 $DSH_HOME/pets/<id>/ 即可。")
					: null,
				react.createElement("div", { className: "dpet-settings-list" }, cards)
			);
		}

		// ------------------------------------------------------------- plugin
		const inject = ["slots", "sessions"];

		function apply(ctx) {
			const openSession = (id) => {
				try {
					ctx.sessions.open(id);
				} catch (error) {
					ctx.logger?.warn?.(error);
				}
			};
			ctx.slots.inject("settings.section", () =>
				ctx.slots.register({ name: "settings.section", id: "pet", order: 60, label: "桌宠" }, PetSettingsSection)
			);
			ctx.slots.inject(
				"shell.overlay",
				() =>
					ctx.slots.register(
						{ name: "shell.overlay", id: "pet", order: 100, label: "桌宠" },
						(props) => react.createElement(PetLayer, { ...props, openSession })
					)
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__test = {
			STATES,
			frameAt,
			deriveMode,
			lookFrameFor,
			clampPosition,
			choosePet,
			cyclePet,
			PET_W,
			PET_H
		};
		return module.exports;
	}
});

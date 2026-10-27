import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem, TAbstractFile, TFile, TFolder, getIcon, moment, normalizePath } from "obsidian";

const GAUGE_DELAY = 120; // 꾹 누르기 게이지를 띄우기까지 ms(짧은 클릭에는 안 보이게)
const MOVE_SLOP = 4;     // 이만큼 넘게 움직이면 꾹 누르기가 아니다(끌어서 옮기기)
const TITLE = ".nav-file-title, .nav-folder-title";
const EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]';
const BAD_CHARS = /[\\/:*?"<>|]/; // 파일 이름에 쓸 수 없는 글자(Windows 기준, 다른 OS에서도 Obsidian이 막는다)

interface Settings {
	longPressMs: number; // 꾹 누르기로 치는 시간(ms)
}

const DEFAULT_SETTINGS: Settings = { longPressMs: 400 };
const clampMs = (v: number) => Math.min(1000, Math.max(200, v));

// 이벤트 때마다 읽는다: 설정을 바꾸면 바로 적용된다
const settings: Settings = { ...DEFAULT_SETTINGS };

const STRINGS = {
	en: {
		longPressMs: ["Long-press time", "How long to hold a file or folder in the file explorer, in milliseconds, before it turns into a name field."],
		badChars: "A name can't contain any of these characters: \\ / : * ? \" < > |",
		exists: "Something with that name is already there.",
	},
	ko: {
		longPressMs: ["꾹 누르기 시간", "파일 탐색기에서 파일이나 폴더를 이만큼(밀리초) 누르고 있으면 이름 입력 칸으로 바뀐다."],
		badChars: "이름에는 다음 글자를 쓸 수 없다: \\ / : * ? \" < > |",
		exists: "같은 이름이 이미 있다.",
	},
};
const t = () => moment.locale().startsWith("ko") ? STRINGS.ko : STRINGS.en;

export default class ExplorerUxfixPlugin extends Plugin {
	win: Window = window;            // 지금 누르고 있는 창(따로 띄운 창일 수 있다)
	timer: number | null = null;     // 꾹 누르기
	cleanup: (() => void) | null = null; // 누르는 동안 건 리스너를 뗀다
	gauge: HTMLElement | null = null;
	gaugeTimer: number | null = null;
	release: (() => void) | null = null; // 꾹 누르기 뒤 holdUntilRelease가 건 것을 푼다
	closeRename: (() => void) | null = null; // 열려 있는 이름 입력 칸을 (바꾸지 않고) 닫는다

	async onload() {
		// 없어진 설정 항목이 남아 있어도 읽지 않는다
		const data: unknown = await this.loadData();
		const saved = (typeof data === "object" && data !== null ? data : {}) as Partial<Record<keyof Settings, unknown>>;
		if (typeof saved.longPressMs === "number") settings.longPressMs = clampMs(saved.longPressMs);
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerDomEvent(document, "mousedown", this.onDown, true);
		this.registerEvent(this.app.workspace.on("window-open", (_, win) => this.registerDomEvent(win.document, "mousedown", this.onDown, true)));
	}

	onunload() {
		this.cancel();
		this.release?.();
		this.closeRename?.();
	}

	async saveSettings() { await this.saveData(settings); }

	onDown = (e: MouseEvent) => {
		this.cancel();
		// 다른 단추나 보조키를 함께 누른 것(새 탭에 열기, 여러 개 고르기 등)은 그대로 둔다
		if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
		const title = (e.target as Element | null)?.closest<HTMLElement>(TITLE);
		if (!title || !title.closest(EXPLORER)) return;
		// Obsidian 자체의 이름 바꾸기가 열려 있으면 건드리지 않는다
		if (title.querySelector('[contenteditable="true"]')) return;
		const file = this.app.vault.getAbstractFileByPath(title.getAttr("data-path") ?? "");
		if (!file || (file instanceof TFolder && file.isRoot())) return;
		const win = this.win = title.ownerDocument.defaultView || window;
		this.track(win, e);
		this.timer = win.setTimeout(() => {
			this.timer = null;
			this.cancel();
			this.holdUntilRelease(win);
			this.startRename(title, file);
		}, settings.longPressMs);
		this.startGauge(win, e.clientX, e.clientY);
	};

	// 누르는 동안: 움직이거나(끌어서 옮기기), 떼거나, 스크롤하거나, 창을 벗어나면 꾹 누르기로 치지 않는다
	track(win: Window, e: MouseEvent) {
		const x = e.clientX, y = e.clientY;
		const onMove = (m: MouseEvent) => { if (Math.abs(m.clientX - x) > MOVE_SLOP || Math.abs(m.clientY - y) > MOVE_SLOP) this.cancel(); };
		const stop = () => this.cancel();
		win.addEventListener("mousemove", onMove, true);
		for (const type of ["mouseup", "dragstart", "scroll"]) win.addEventListener(type, stop, true);
		win.addEventListener("blur", stop);
		this.cleanup = () => {
			win.removeEventListener("mousemove", onMove, true);
			for (const type of ["mouseup", "dragstart", "scroll"]) win.removeEventListener(type, stop, true);
			win.removeEventListener("blur", stop);
		};
	}

	cancel() {
		if (this.timer !== null) { this.win.clearTimeout(this.timer); this.timer = null; }
		if (this.cleanup) { this.cleanup(); this.cleanup = null; }
		this.stopGauge();
	}

	// 꾹 누르기가 된 뒤 손을 뗄 때까지: 끌어서 옮기기가 시작되지 않게 하고, 뗄 때의 클릭도 삼킨다
	// (파일이 열리거나 폴더가 접히고 펴지지 않게). 떼는 신호를 놓쳤어도 새로 누르면 바로 푼다
	holdUntilRelease(win: Window) {
		const stop = (ev: Event) => { ev.preventDefault(); ev.stopPropagation(); };
		const off = () => {
			win.removeEventListener("dragstart", stop, true);
			win.removeEventListener("mouseup", up, true);
			win.removeEventListener("mousedown", off, true);
			win.removeEventListener("click", stop, true);
			this.release = null;
		};
		const up = () => {
			win.removeEventListener("dragstart", stop, true);
			win.removeEventListener("mouseup", up, true);
			// click은 mouseup 바로 뒤에 온다
			win.setTimeout(off, 0);
		};
		win.addEventListener("dragstart", stop, true);
		win.addEventListener("mouseup", up, true);
		win.addEventListener("mousedown", off, true);
		win.addEventListener("click", stop, true);
		this.release = off;
	}

	// 항목 이름 자리에 입력 칸을 띄운다. Enter나 다른 곳 클릭이면 바꾸고, Esc면 그대로 둔다.
	// 탐색기 안의 요소는 Obsidian이 다시 그리면서 갈아 끼울 수 있어서, 입력 칸은 body에 따로 두고 자리만 맞춘다
	startRename(title: HTMLElement, file: TAbstractFile) {
		this.closeRename?.();
		const win = this.win, doc = title.ownerDocument;
		const nameEl = title.querySelector<HTMLElement>(".nav-file-title-content, .nav-folder-title-content") ?? title;
		const list = title.closest<HTMLElement>(".nav-files-container") ?? title;
		const input = doc.body.createEl("input", { cls: "explorer-uxfix-rename", type: "text" });
		input.value = file instanceof TFile ? file.basename : file.name;
		input.setCssProps({ font: win.getComputedStyle(nameEl).font });
		const place = () => {
			// 스크롤하다 Obsidian이 그 자리를 다른 항목에 쓰거나 지웠으면 닫는다
			if (!title.isConnected || title.getAttr("data-path") !== file.path) { close(); return; }
			const r = nameEl.getBoundingClientRect(), box = list.getBoundingClientRect();
			input.toggleClass("explorer-uxfix-hidden", r.bottom < box.top || r.top > box.bottom);
			input.setCssProps({
				left: `${r.left}px`,
				top: `${r.top}px`,
				width: `${Math.max(r.width, box.right - r.left - 8)}px`,
				height: `${r.height}px`,
			});
		};
		let frame: number | null = null;
		const onScroll = () => { if (frame === null) frame = win.requestAnimationFrame(() => { frame = null; place(); }); };
		const onKey = (e: KeyboardEvent) => {
			if (e.isComposing) return; // 한글 등을 조합하는 중의 Enter는 글자를 끝내는 것
			if (e.key === "Enter") { e.preventDefault(); input.blur(); }
			else if (e.key === "Escape") { e.preventDefault(); close(); }
			else return;
			e.stopPropagation();
		};
		const close = () => {
			if (frame !== null) win.cancelAnimationFrame(frame);
			win.removeEventListener("scroll", onScroll, true);
			win.removeEventListener("resize", onScroll);
			input.removeEventListener("blur", commit);
			input.remove();
			this.closeRename = null;
		};
		const commit = () => {
			const name = input.value.trim();
			close();
			void this.rename(file, name);
		};
		win.addEventListener("scroll", onScroll, true);
		win.addEventListener("resize", onScroll);
		input.addEventListener("keydown", onKey);
		input.addEventListener("blur", commit);
		this.closeRename = close;
		place();
		input.focus();
		input.select();
	}

	async rename(file: TAbstractFile, name: string) {
		const old = file instanceof TFile ? file.basename : file.name;
		if (!name || name === old) return;
		if (BAD_CHARS.test(name)) { new Notice(t().badChars); return; }
		const ext = file instanceof TFile && file.extension ? `.${file.extension}` : "";
		const dir = file.parent && !file.parent.isRoot() ? `${file.parent.path}/` : "";
		const path = normalizePath(dir + name + ext);
		// 대소문자만 바꾸는 것은 같은 파일이 걸리므로 막지 않는다
		const there = this.app.vault.getAbstractFileByPath(path);
		if (there && there !== file) { new Notice(t().exists); return; }
		try {
			await this.app.fileManager.renameFile(file, path);
		} catch (err) {
			new Notice(err instanceof Error ? err.message : String(err));
		}
	}

	// 꾹 누르는 동안 마우스 오른쪽 아래에 연필 아이콘(Obsidian의 이름 바꾸기 아이콘)이 선을 따라 차오른다.
	// 짧은 클릭에는 안 보이게 조금 뒤에 빈 채로 띄워 남은 시간 동안 채운다
	startGauge(win: Window, x: number, y: number) {
		this.gaugeTimer = win.setTimeout(() => {
			this.gaugeTimer = null;
			const icon = getIcon("pencil");
			if (!icon) return;
			// 모양과 차오르는 애니메이션은 styles.css. 여기서는 자리와 걸리는 시간을 넘긴다
			const doc = win.document, ns = "http://www.w3.org/2000/svg";
			const el = doc.body.createDiv({ cls: "explorer-uxfix-gauge" });
			el.setAttribute("aria-hidden", "true");
			el.setCssProps({
				left: `${x + 10}px`,
				top: `${y + 10}px`,
				"--explorer-uxfix-gauge-time": `${settings.longPressMs - GAUGE_DELAY}ms`,
			});
			const svg = doc.createElementNS(ns, "svg");
			svg.setAttribute("viewBox", icon.getAttribute("viewBox") ?? "0 0 24 24");
			const shapes = Array.from(icon.querySelectorAll("path, line, polyline, polygon, circle, rect"));
			for (const cls of ["explorer-uxfix-gauge-track", "explorer-uxfix-gauge-bar"]) {
				for (const shape of shapes) {
					const copy = shape.cloneNode() as SVGElement;
					copy.setAttribute("pathLength", "1");
					copy.setAttribute("class", cls);
					svg.appendChild(copy);
				}
			}
			el.appendChild(svg);
			this.gauge = el;
		}, GAUGE_DELAY);
	}

	stopGauge() {
		if (this.gaugeTimer !== null) { this.win.clearTimeout(this.gaugeTimer); this.gaugeTimer = null; }
		if (this.gauge) { this.gauge.remove(); this.gauge = null; }
	}
}

class SettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: ExplorerUxfixPlugin) { super(app, plugin); }

	getSettingDefinitions(): SettingDefinitionItem[] {
		const text = t();
		return [
			{ name: text.longPressMs[0], desc: text.longPressMs[1], control: { type: "slider", key: "longPressMs", min: 200, max: 1000, step: 50 } },
		];
	}

	// 값은 플러그인 객체가 아니라 모듈의 settings에 있다
	getControlValue(key: string): unknown {
		return key in settings ? settings[key as keyof Settings] : undefined;
	}

	async setControlValue(key: string, value: unknown) {
		if (key !== "longPressMs" || typeof value !== "number") return;
		settings.longPressMs = clampMs(value);
		await this.plugin.saveSettings();
	}
}

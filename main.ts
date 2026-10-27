import { App, Notice, Plugin, PluginSettingTab, SettingDefinitionItem, TAbstractFile, TFile, TFolder, getIcon, moment, normalizePath } from "obsidian";

const GAUGE_DELAY = 120; // 길게 누르기 게이지를 띄우기까지 ms(짧은 클릭에는 안 보이게)
const MOVE_SLOP = 4;     // 누르는 동안 이 픽셀 수보다 많이 움직이면 길게 누르기가 아니다(끌어서 옮기기)
const TITLE = ".nav-file-title, .nav-folder-title";
const EXPLORER = '.workspace-leaf-content[data-type="file-explorer"]';
const BAD_CHARS = /[\\/:*?"<>|]/; // 파일 이름에 쓸 수 없는 글자(Windows 기준, 다른 OS에서도 Obsidian이 막는다)

interface Settings {
	longPressMs: number; // 길게 누르기로 치는 시간(ms)
	previewGap: number;  // 탐색기 가장자리와 미리보기 사이 간격(px)
}

const DEFAULT_SETTINGS: Settings = { longPressMs: 800, previewGap: 8 };
const clampMs = (v: number) => Math.min(1500, Math.max(300, v));
const clampGap = (v: number) => Math.min(48, Math.max(0, Math.round(v)));

// 이벤트 때마다 읽는다: 설정을 바꾸면 바로 적용된다
const settings: Settings = { ...DEFAULT_SETTINGS };

const STRINGS = {
	en: {
		longPressMs: ["Long-press time", "How long to hold a file or folder in the file explorer, in milliseconds, before it turns into a name field."],
		previewGap: ["Preview gap", "Space in pixels between the file explorer and a page preview opened from it."],
		badChars: "A name can't contain any of these characters: \\ / : * ? \" < > |",
		exists: "Something with that name is already there.",
	},
	ko: {
		longPressMs: ["길게 누르기 시간", "파일 탐색기에서 파일이나 폴더를 누르고 있으면 이름 입력 칸으로 바뀌기까지 걸리는 시간(밀리초)."],
		previewGap: ["미리보기 간격", "파일 탐색기와 거기서 띄운 페이지 미리보기 사이의 간격(픽셀)."],
		badChars: "이름에는 다음 글자를 쓸 수 없다: \\ / : * ? \" < > |",
		exists: "같은 이름이 이미 있다.",
	},
};
const t = () => moment.locale().startsWith("ko") ? STRINGS.ko : STRINGS.en;

export default class ExplorerUxfixPlugin extends Plugin {
	win: Window = window;            // 지금 누르고 있는 창(따로 띄운 창일 수 있다)
	timer: number | null = null;     // 길게 누르기
	cleanup: (() => void) | null = null; // 누르는 동안 건 리스너를 뗀다
	gauge: HTMLElement | null = null;
	gaugeTimer: number | null = null;
	release: (() => void) | null = null; // 길게 누르기 뒤 holdUntilRelease가 건 것을 푼다
	closeRename: (() => void) | null = null; // 열려 있는 이름 입력 칸을 (바꾸지 않고) 닫는다

	async onload() {
		// 없어진 설정 항목이 남아 있어도 읽지 않는다
		const data: unknown = await this.loadData();
		const saved = (typeof data === "object" && data !== null ? data : {}) as Partial<Record<keyof Settings, unknown>>;
		if (typeof saved.longPressMs === "number") settings.longPressMs = clampMs(saved.longPressMs);
		if (typeof saved.previewGap === "number") settings.previewGap = clampGap(saved.previewGap);
		this.addSettingTab(new SettingTab(this.app, this));
		this.registerDomEvent(document, "mousedown", this.onDown, true);
		this.watchPreviews(document);
		this.registerEvent(this.app.workspace.on("window-open", (_, win) => {
			this.registerDomEvent(win.document, "mousedown", this.onDown, true);
			this.watchPreviews(win.document);
		}));
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

	// 누르는 동안: 움직이거나(끌어서 옮기기), 떼거나, 스크롤하거나, 창을 벗어나면 길게 누르기로 치지 않는다
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

	// 길게 누르기가 된 뒤 손을 뗄 때까지: 끌어서 옮기기가 시작되지 않게 하고, 뗄 때의 클릭도 삼킨다
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
				// 오른쪽 끝은 목록의 내용 영역까지(getBoundingClientRect는 스크롤바까지 넣는다)
				width: `${Math.max(r.width, box.left + list.clientLeft + list.clientWidth - r.left - 8)}px`,
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

	// 길게 누르는 동안 마우스 오른쪽 아래에 네모에 연필이 걸친 편집 아이콘을 그려 두고, 그 선을 왼쪽에서
	// 오른쪽으로 훑듯이 칠한다. 짧은 클릭에는 안 보이게 조금 뒤에 빈 채로 띄워 남은 시간 동안 채운다
	startGauge(win: Window, x: number, y: number) {
		this.gaugeTimer = win.setTimeout(() => {
			this.gaugeTimer = null;
			// 네모 위에 연필(macOS의 square.and.pencil, Material의 edit_square와 같은 꼴). 옛 아이콘 묶음이면 연필만
			const icon = getIcon("square-pen") ?? getIcon("pencil");
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
			// 회색 연필 위에 강조색 연필을 겹치고, 강조색 쪽을 감싼 칸의 폭을 0에서 끝까지 늘려 왼쪽에서부터 드러낸다
			const shapes = Array.from(icon.querySelectorAll("path, line, polyline, polygon, circle, rect"));
			const pencil = (parent: HTMLElement, cls: string) => {
				const svg = parent.appendChild(doc.createElementNS(ns, "svg"));
				svg.setAttribute("viewBox", icon.getAttribute("viewBox") ?? "0 0 24 24");
				svg.setAttribute("class", cls);
				for (const shape of shapes) svg.appendChild(shape.cloneNode());
			};
			pencil(el, "explorer-uxfix-gauge-track");
			pencil(el.createDiv({ cls: "explorer-uxfix-gauge-scan" }), "explorer-uxfix-gauge-bar");
			this.gauge = el;
		}, GAUGE_DELAY);
	}

	stopGauge() {
		if (this.gaugeTimer !== null) { this.win.clearTimeout(this.gaugeTimer); this.gaugeTimer = null; }
		if (this.gauge) { this.gauge.remove(); this.gauge = null; }
	}

	// 파일 탐색기에서 띄운 페이지 미리보기가 탐색기를 가리지 않게 탐색기 바로 옆으로 옮긴다.
	// 미리보기 창에는 어디서 띄웠는지 표시가 없어서, 마우스가 마지막으로 올라간 곳이 탐색기 안이었는지로 가린다.
	// 본문 링크에서 띄운 미리보기는 건드리지 않고, 세로 위치와 크기도 Obsidian에 맡긴다
	watchPreviews(doc: Document) {
		let explorer: HTMLElement | null = null;
		this.registerDomEvent(doc, "mouseover", (e: MouseEvent) => {
			explorer = (e.target as Element | null)?.closest<HTMLElement>(EXPLORER) ?? null;
		}, { passive: true });
		// 미리보기 창은 필요할 때 body 바로 아래에 붙는다
		const observer = new MutationObserver((records) => {
			if (!explorer) return;
			for (const record of records) for (const node of Array.from(record.addedNodes))
				if (node.instanceOf(HTMLElement) && node.hasClass("hover-popover")) this.placePreview(node, explorer);
		});
		observer.observe(doc.body, { childList: true });
		this.register(() => observer.disconnect());
	}

	placePreview(popover: HTMLElement, explorer: HTMLElement) {
		const r = explorer.getBoundingClientRect();
		if (r.width === 0) return;
		// 오른쪽 사이드바에 둔 탐색기면 왼쪽에 띄운다
		const right = explorer.closest(".mod-right-split") !== null;
		const win = explorer.win;
		popover.setCssProps({
			"--explorer-uxfix-preview-x": `${Math.round(right ? win.innerWidth - r.left + settings.previewGap : r.right + settings.previewGap)}px`,
		});
		popover.addClass(right ? "explorer-uxfix-preview-left" : "explorer-uxfix-preview-right");
	}
}

class SettingTab extends PluginSettingTab {
	constructor(app: App, readonly plugin: ExplorerUxfixPlugin) { super(app, plugin); }

	getSettingDefinitions(): SettingDefinitionItem[] {
		const text = t();
		return [
			{ name: text.longPressMs[0], desc: text.longPressMs[1], control: { type: "slider", key: "longPressMs", min: 300, max: 1500, step: 50 } },
			{ name: text.previewGap[0], desc: text.previewGap[1], control: { type: "slider", key: "previewGap", min: 0, max: 48, step: 1 } },
		];
	}

	// 값은 플러그인 객체가 아니라 모듈의 settings에 있다
	getControlValue(key: string): unknown {
		return key in settings ? settings[key as keyof Settings] : undefined;
	}

	async setControlValue(key: string, value: unknown) {
		if (typeof value !== "number") return;
		if (key === "longPressMs") settings.longPressMs = clampMs(value);
		else if (key === "previewGap") settings.previewGap = clampGap(value);
		else return;
		await this.plugin.saveSettings();
	}
}

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Sampling only runs while the menu is open: a quick first sample so the
// numbers aren't stale, then every REFRESH_MS.
const REFRESH_MS = 1000;
const FIRST_SAMPLE_MS = 300;
const PAGE_KB = 4;
// Loopback, VPN tunnels and virtual bridges: traffic over a VPN also crosses
// the physical interface, so counting tunnels too would double it.
const NET_IGNORED = /^(lo|tun|tap|wg|virbr|docker|br-|veth|vnet)/;
const TOP_N = 10;
const PROTECTED = new Set(['gnome-shell', 'systemd', 'Xwayland', 'gnome-session-b', 'gdm', 'dbus-broker']);
// Entries below both thresholds are idle and not worth listing.
const MIN_CPU = 0.5;
const MIN_RSS_KB = 30 * 1024;
const TERMINAL_ICON = 'utilities-terminal-symbolic';
const MY_UID = GLib.getenv('UID') ? Number(GLib.getenv('UID')) : null;
const CLK_TCK = 100;
const NUM_CPUS = GLib.get_num_processors();
const decoder = new TextDecoder();

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? decoder.decode(bytes) : null;
    } catch (e) {
        return null;
    }
}

function fmtBytes(kb) {
    const mb = kb / 1024;
    return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// Compact "176K", "1.2M", "48M" for the net row's value column.
function fmtRateShort(bps) {
    const k = bps / 1024;
    if (k < 999.5) return `${Math.round(k)}K`;
    const m = k / 1024;
    return m < 9.95 ? `${m.toFixed(1)}M` : `${Math.round(m)}M`;
}

// Log scale so 5 KB/s and 50 MB/s both register: 0 at 0, full at 100 MB/s.
const NET_LOG_MAX = Math.log1p(100 * 1024);
function netFrac(bps) {
    return Math.min(1, Math.log1p(bps / 1024) / NET_LOG_MAX);
}

// {iface: {rx, tx}} byte counters since boot, for real interfaces only.
function readNetCounters() {
    const out = {};
    for (const line of (readText('/proc/net/dev') ?? '').split('\n').slice(2)) {
        const m = line.match(/^\s*([^:]+):\s*(.*)$/);
        if (!m || NET_IGNORED.test(m[1])) continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        out[m[1]] = {rx: f[0], tx: f[8]};
    }
    return out;
}

// Name of the systemd unit a process runs in, e.g. "app-gnome-firefox-1234.scope".
// Chrome (via cgroupify) puts each child in a sub-cgroup named by its pid
// below the unit, so take the innermost path segment that is a unit.
function unitOf(pid) {
    const line = readText(`/proc/${pid}/cgroup`)?.split('\n').find(l => l.startsWith('0::'));
    return line?.split('/').findLast(s => /\.(scope|service)$/.test(s)) ?? '';
}

// Processes from one launch share the pid in their scope name even when the
// app moves some of them to a scope of its own (Chrome's main process goes from
// app-gnome-google\x2dchrome-N.scope to app-com.google.Chrome-N.scope).
function launchKey(unit) {
    return unit.match(/^app-.*-(\d+)\.scope$/)?.[1] ?? unit;
}

// Candidate desktop IDs encoded in a unit name. Follows the XDG/systemd naming:
// app[-<launcher>]-<appid>-<rand>.scope, app[-<launcher>]-<appid>@<rand>.service
// and dbus-:<bus>-<appid>@<n>.service for D-Bus activated apps.
function appIdsFromUnit(unit) {
    unit = unit.replace(/\\x([0-9a-f]{2})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    let m = unit.match(/^dbus-:[\d.]+-(.+?)(?:@\d+)?\.service$/);
    if (m) return [m[1]];
    m = unit.match(/^app-(.+?)(?:-\d+\.scope|@[^.]*\.service|\.service)$/);
    if (!m) return [];
    const id = m[1];
    const dash = id.indexOf('-');
    return dash > 0 ? [id, id.slice(dash + 1)] : [id];
}

// Directory of the first entry under `base` whose `file` exists (and whose
// `name` file matches, if given). hwmon/card numbers change between boots.
function findSysDir(base, file, name = null) {
    try {
        const en = Gio.File.new_for_path(base).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = en.next_file(null))) {
            const dir = `${base}/${info.get_name()}`;
            if (name && readText(`${dir}/name`)?.trim() !== name) continue;
            if (GLib.file_test(`${dir}/${file}`, GLib.FileTest.EXISTS)) {
                en.close(null);
                return dir;
            }
        }
        en.close(null);
    } catch (e) {}
    return null;
}

class Bar {
    constructor(name, iconName) {
        this.actor = new St.BoxLayout({style_class: 'sysmon-stat-row'});
        this.actor.add_child(new St.Icon({icon_name: iconName, style_class: 'sysmon-stat-icon', y_align: Clutter.ActorAlign.CENTER}));
        this.actor.add_child(new St.Label({text: name, style_class: 'sysmon-stat-name', y_align: Clutter.ActorAlign.CENTER}));
        this._bg = new St.Widget({style_class: 'sysmon-bar-bg', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._fg = new St.Widget({style_class: 'sysmon-bar-fg'});
        this._bg.add_child(this._fg);
        this._bg.connect('notify::width', () => this._apply());
        this.actor.add_child(this._bg);
        this._text = new St.Label({style_class: 'sysmon-stat-val', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._text);
        this._frac = 0;
    }

    set(frac, text) {
        this._frac = Math.min(1, Math.max(0, frac));
        this._text.text = text;
        this._fg.remove_style_class_name('warn');
        this._fg.remove_style_class_name('crit');
        if (this._frac > 0.9) this._fg.add_style_class_name('crit');
        else if (this._frac > 0.75) this._fg.add_style_class_name('warn');
        this._apply();
    }

    _apply() {
        this._fg.width = Math.round(this._bg.width * this._frac);
    }
}

// Same row as Bar, but the track is split: download grows in from the left,
// upload in from the right, and the two meet in the middle at full load.
class NetBar {
    constructor() {
        this.actor = new St.BoxLayout({style_class: 'sysmon-stat-row'});
        this.actor.add_child(new St.Icon({icon_name: 'network-transmit-receive-symbolic', style_class: 'sysmon-stat-icon', y_align: Clutter.ActorAlign.CENTER}));
        this.actor.add_child(new St.Label({text: 'Net', style_class: 'sysmon-stat-name', y_align: Clutter.ActorAlign.CENTER}));
        this._bg = new St.Widget({style_class: 'sysmon-bar-bg', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._down = new St.Widget({style_class: 'sysmon-bar-fg sysmon-net-down'});
        this._up = new St.Widget({style_class: 'sysmon-bar-fg sysmon-net-up'});
        this._bg.add_child(this._down);
        this._bg.add_child(this._up);
        this._bg.connect('notify::width', () => this._apply());
        this.actor.add_child(this._bg);
        this._text = new St.Label({style_class: 'sysmon-stat-val', y_align: Clutter.ActorAlign.CENTER});
        this.actor.add_child(this._text);
        this._downFrac = this._upFrac = 0;
        this.set(0, 0, '–', '–');
    }

    set(down, up, downText, upText) {
        this._downFrac = netFrac(down);
        this._upFrac = netFrac(up);
        this._text.clutter_text.set_markup(
            `<span foreground="#62a0ea">↓</span> ${downText}   <span foreground="#57e389">↑</span> ${upText}`);
        this._apply();
    }

    _apply() {
        // Each direction owns half the track, with a 2px gap at the centre.
        const half = Math.max(0, this._bg.width / 2 - 1);
        const dw = Math.round(half * this._downFrac);
        const uw = Math.round(half * this._upFrac);
        this._down.set_position(0, 0);
        this._down.width = dw;
        this._up.set_position(this._bg.width - uw, 0);
        this._up.width = uw;
    }
}

class ProcRow {
    constructor(onKill) {
        this.actor = new St.BoxLayout({style_class: 'sysmon-proc-row', reactive: true, track_hover: true});
        this._icon = new St.Icon({style_class: 'sysmon-proc-icon', icon_size: 20, y_align: Clutter.ActorAlign.CENTER});
        this._name = new St.Label({style_class: 'sysmon-proc-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = 3;
        this._cpu = new St.Label({style_class: 'sysmon-proc-val', y_align: Clutter.ActorAlign.CENTER});
        this._mem = new St.Label({style_class: 'sysmon-proc-val', y_align: Clutter.ActorAlign.CENTER});
        this._btn = new St.Button({
            style_class: 'sysmon-kill',
            child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 14}),
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._btn.connect('clicked', () => this._entry && onKill(this._entry));
        this.actor.add_child(this._icon);
        this.actor.add_child(this._name);
        this.actor.add_child(this._cpu);
        this.actor.add_child(this._mem);
        this.actor.add_child(this._btn);
        this._entry = null;
    }

    // A web app row sits under its browser and has no numbers of its own:
    // its usage is part of the browser's.
    set(entry) {
        this._entry = entry ?? null;
        if (!entry) {
            this.actor.hide();
            return;
        }
        this.actor.show();
        if (entry.app) this._icon.gicon = entry.app.get_icon();
        else this._icon.icon_name = TERMINAL_ICON;
        this._name.text = entry.name;
        if (entry.webApp) this.actor.add_style_class_name('sysmon-web-app');
        else this.actor.remove_style_class_name('sysmon-web-app');
        this._cpu.text = entry.webApp ? '–' : entry.cpu < 1 ? '<1%' : `${entry.cpu.toFixed(0)}%`;
        this._mem.text = entry.webApp ? '–' : fmtBytes(entry.rss);
        this._cpu.remove_style_class_name('hot');
        if (!entry.webApp && entry.cpu >= 25) this._cpu.add_style_class_name('hot');
        this._btn.accessible_name = `Quit ${entry.name}`;
    }
}

export default class SystemMonitorPanel extends Extension {
    enable() {
        this._prevTotal = 0;
        this._prevIdle = 0;
        this._prevProc = new Map();
        this._prevTime = 0;
        this._cpuPct = 0;
        this._uid = this._getUid();
        this._appCache = new Map();
        this._unitCache = new Map();
        this._tempDir = findSysDir('/sys/class/hwmon', 'temp1_input', 'coretemp') ??
            findSysDir('/sys/class/hwmon', 'temp1_input', 'k10temp');

        this._button = new PanelMenu.Button(0.5, this.metadata.name, false);
        this._button.add_child(new St.Icon({icon_name: 'power-profile-performance-symbolic', style_class: 'system-status-icon'}));

        const menu = this._button.menu;
        menu.box.add_style_class_name('sysmon-menu');

        this._bars = {
            cpu: new Bar('CPU', 'processes-symbolic'),
            temp: new Bar('Temp', 'temperature-symbolic'),
            ram: new Bar('RAM', 'drive-harddisk-solidstate-symbolic'),
        };
        const statsItem = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const statsBox = new St.BoxLayout({vertical: true, x_expand: true});
        for (const b of Object.values(this._bars)) statsBox.add_child(b.actor);
        this._net = new NetBar();
        statsBox.add_child(this._net.actor);
        statsItem.add_child(statsBox);
        menu.addMenuItem(statsItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._procRows = this._buildSection(menu, 'Top Apps');

        // Nothing is sampled while the menu is closed.
        menu.connect('open-state-changed', (_m, open) => {
            if (open) this._startMonitoring();
            else this._stopMonitoring();
        });

        // Directly right of the workspace indicator (else of Now Playing) when
        // it's loaded, whatever the load order.
        const rightBox = Main.panel._rightBox;
        const left = Main.panel.statusArea['workspace-indicator']?.container
            ?? Main.panel.statusArea['now-playing@arjun']?.container;
        const idx = left ? rightBox.get_children().indexOf(left) + 1 : 0;
        Main.panel.addToStatusArea(this.uuid, this._button, idx, 'right');
    }

    // Take a baseline (CPU, per-process time and net counters are all
    // deltas), show the first real numbers shortly after, then refresh every second.
    _startMonitoring() {
        this._stopMonitoring();
        this._updateCpu();
        this._scanProcesses();
        this._netPrev = readNetCounters();
        this._netPrevTime = GLib.get_monotonic_time();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FIRST_SAMPLE_MS, () => {
            this._tick();
            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopMonitoring() {
        if (this._timeoutId) GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._killId) GLib.source_remove(this._killId);
        this._killId = 0;
        // Drop per-process state; it's rebuilt on the next open.
        this._prevProc?.clear();
        this._unitCache?.clear();
    }

    _getUid() {
        const status = readText('/proc/self/status');
        const m = status?.match(/^Uid:\s+(\d+)/m);
        return m ? Number(m[1]) : MY_UID;
    }

    _buildSection(menu, title) {
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const box = new St.BoxLayout({vertical: true, x_expand: true});
        const header = new St.BoxLayout({style_class: 'sysmon-proc-header'});
        header.add_child(new St.Label({text: title, style_class: 'sysmon-section', x_expand: true}));
        header.add_child(new St.Label({text: 'CPU', style_class: 'sysmon-col sysmon-proc-val'}));
        header.add_child(new St.Label({text: 'Memory', style_class: 'sysmon-col sysmon-proc-val'}));
        header.add_child(new St.Widget({style_class: 'sysmon-kill-spacer'}));
        box.add_child(header);
        this._emptyLabel = new St.Label({text: 'Nothing heavy running', style_class: 'sysmon-empty'});
        box.add_child(this._emptyLabel);
        const rows = [];
        for (let i = 0; i < TOP_N; i++) {
            const r = new ProcRow(entry => this._kill(entry));
            rows.push(r);
            box.add_child(r.actor);
        }
        item.add_child(box);
        menu.addMenuItem(item);
        return rows;
    }

    // A web app shares the browser's processes, so it's closed through its
    // windows rather than killed.
    _kill(entry) {
        if (entry.webApp) {
            entry.app.request_quit();
        } else {
            try {
                Gio.Subprocess.new(['kill', '-TERM', ...entry.pids.map(String)], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.error(`system-monitor-panel: kill failed: ${e}`);
            }
        }
        if (this._killId) GLib.source_remove(this._killId);
        this._killId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
            this._killId = 0;
            if (this._button?.menu.isOpen) this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _tick() {
        this._updateCpu();
        const mem = this._readMem();

        this._bars.cpu.set(this._cpuPct / 100, `${this._cpuPct.toFixed(0)}%`);
        this._bars.ram.set(mem.usedFrac, `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`);
        this._updateTemp();

        const apps = this._groupApps(this._scanProcesses())
            .filter(a => a.cpu >= MIN_CPU || a.rss >= MIN_RSS_KB);
        // CPU% and memory are both shares of the whole machine, so rank by the heavier.
        const load = a => Math.max(a.cpu / 100, mem.total ? a.rss / mem.total : 0);
        const top = apps.sort((a, b) => load(b) - load(a)).flatMap(a => [a, ...a.webApps.map(app => ({
            name: app.get_name().replace(/\s*\(PWA\)$/, ''), app, webApp: true,
        }))]);
        this._procRows.forEach((r, i) => r.set(top[i]));
        this._emptyLabel.visible = top.length === 0;
        this._updateNet();
    }

    // Package temperature; the bar's 75%/90% warn/crit colours line up with 75/90 °C.
    _updateTemp() {
        const milli = this._tempDir ? Number(readText(`${this._tempDir}/temp1_input`)) : 0;
        if (!milli) {
            this._bars.temp.set(0, 'n/a');
            return;
        }
        const c = milli / 1000;
        this._bars.temp.set(c / 100, `${c.toFixed(0)} °C`);
    }

    _updateNet() {
        const cur = readNetCounters();
        const now = GLib.get_monotonic_time();
        const dt = (now - this._netPrevTime) / 1e6;
        let rx = 0, tx = 0;
        for (const [name, c] of Object.entries(cur)) {
            const p = this._netPrev[name];
            if (!p) continue;
            // Counters reset when an interface goes down and up again.
            rx += Math.max(0, c.rx - p.rx);
            tx += Math.max(0, c.tx - p.tx);
        }
        this._net.set(rx / dt, tx / dt, fmtRateShort(rx / dt), fmtRateShort(tx / dt));
        this._netPrev = cur;
        this._netPrevTime = now;
    }

    _updateCpu() {
        const line = readText('/proc/stat')?.split('\n')[0];
        if (!line) return;
        const f = line.trim().split(/\s+/).slice(1).map(Number);
        const idle = f[3] + (f[4] || 0);
        const total = f.reduce((a, b) => a + b, 0);
        const dt = total - this._prevTotal;
        if (this._prevTotal && dt > 0)
            this._cpuPct = 100 * (1 - (idle - this._prevIdle) / dt);
        this._prevTotal = total;
        this._prevIdle = idle;
    }

    _readMem() {
        const txt = readText('/proc/meminfo') ?? '';
        const get = k => Number(txt.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0);
        const total = get('MemTotal');
        const used = total - get('MemAvailable');
        return {
            total, used, usedFrac: total ? used / total : 0,
        };
    }

    // Looks up the installed, user-visible app a unit was launched from.
    _lookupApp(unit) {
        if (this._appCache.has(unit)) return this._appCache.get(unit);
        const appSys = Shell.AppSystem.get_default();
        let app = null;
        for (const id of appIdsFromUnit(unit)) {
            const a = appSys.lookup_app(`${id}.desktop`);
            if (a?.get_app_info()?.should_show()) {
                app = a;
                break;
            }
        }
        this._appCache.set(unit, app);
        return app;
    }

    // Groups processes into user-facing apps by their systemd unit. Background
    // services (gvfs, portals, evolution, gnome-software's daemon, ...) are
    // dropped unless they own an open window. Commands run in a terminal are
    // listed individually so one runaway shell can be stopped on its own.
    //
    // Chrome web apps (Spotify, Teams, ...) live inside the browser's processes,
    // and Chrome doesn't expose which process serves which, so their usage
    // stays in the browser's entry and they're listed under it.
    _groupApps(procs) {
        const windowApps = new Map();
        for (const app of Shell.AppSystem.get_default().get_running()) {
            for (const pid of app.get_pids()) {
                if (!windowApps.has(pid)) windowApps.set(pid, []);
                windowApps.get(pid).push(app);
            }
        }

        const byLaunch = new Map();
        for (const p of procs) {
            const key = launchKey(p.unit);
            if (!byLaunch.has(key)) byLaunch.set(key, []);
            byLaunch.get(key).push(p);
        }

        const groups = [];
        for (const list of byLaunch.values()) {
            if (/-spawn-.*\.scope$/.test(list[0].unit)) {
                for (const p of list)
                    groups.push({name: p.name, app: null, webApps: [], pids: [p.pid], cpu: p.cpu, rss: p.rss});
                continue;
            }
            // A pid owning windows of several apps is a host process (the
            // browser), so only a single-app pid identifies the app directly.
            const app = list.map(p => windowApps.get(p.pid)).find(a => a?.length === 1)?.[0] ??
                [...new Set(list.map(p => p.unit))].map(u => this._lookupApp(u)).find(a => a);
            if (!app) continue;
            const hosted = new Set(list.flatMap(p => windowApps.get(p.pid) ?? []));
            hosted.delete(app);
            groups.push({
                webApps: [...hosted].sort((a, b) => a.get_name().localeCompare(b.get_name())),
                name: app.get_name(),
                app,
                pids: list.map(p => p.pid),
                cpu: list.reduce((s, p) => s + p.cpu, 0),
                rss: list.reduce((s, p) => s + p.rss, 0),
            });
        }

        // An app can span several units (e.g. a second launch); merge them.
        const merged = new Map();
        for (const g of groups) {
            const key = g.app ? g.app.get_id() : `pid:${g.pids[0]}`;
            const m = merged.get(key);
            if (!m) {
                merged.set(key, g);
                continue;
            }
            m.pids.push(...g.pids);
            m.webApps.push(...g.webApps.filter(a => !m.webApps.includes(a)));
            m.cpu += g.cpu;
            m.rss += g.rss;
        }
        return [...merged.values()];
    }

    // Scans /proc for this user's processes and computes CPU% since the last scan.
    _scanProcesses() {
        const now = GLib.get_monotonic_time() / 1e6;
        const dt = this._prevTime ? now - this._prevTime : 0;
        const cur = new Map();
        const procs = [];

        const dir = Gio.File.new_for_path('/proc');
        let en;
        try {
            en = dir.enumerate_children('standard::name,unix::uid', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return [];
        }
        let info;
        while ((info = en.next_file(null))) {
            const pid = info.get_name();
            if (!/^\d+$/.test(pid)) continue;
            // Owner comes with the directory listing, so other users'
            // processes are skipped without opening any of their files.
            if (info.get_attribute_uint32('unix::uid') !== this._uid) continue;
            const stat = readText(`/proc/${pid}/stat`);
            if (!stat) continue;
            const open = stat.indexOf('(');
            const close = stat.lastIndexOf(')');
            const name = stat.slice(open + 1, close);
            const f = stat.slice(close + 2).split(' ');
            const ticks = Number(f[11]) + Number(f[12]);
            const rss = Number(f[21]) * PAGE_KB;
            cur.set(pid, ticks);
            if (PROTECTED.has(name)) continue;

            let cpu = 0;
            const prev = this._prevProc.get(pid);
            if (dt > 0 && prev !== undefined)
                cpu = Math.max(0, (ticks - prev) / CLK_TCK / dt * 100 / NUM_CPUS);

            // A process never changes unit, so read its cgroup once.
            let unit = this._unitCache.get(pid);
            if (unit === undefined) {
                unit = unitOf(pid);
                this._unitCache.set(pid, unit);
            }
            procs.push({pid: Number(pid), name, unit, cpu, rss});
        }
        en.close(null);
        for (const pid of this._unitCache.keys()) {
            if (!cur.has(pid)) this._unitCache.delete(pid);
        }
        this._prevProc = cur;
        this._prevTime = now;
        return procs;
    }

    disable() {
        this._stopMonitoring();
        this._button?.destroy();
        this._button = null;
        this._bars = this._procRows = this._emptyLabel = null;
        this._prevProc = null;
        this._appCache = this._unitCache = null;
        this._net = this._netPrev = null;
    }
}

// Material Design Icons (the set Home Assistant uses) as GNOME symbolic icons.
//
// Lookup order: icons bundled with the extension, the user cache, then a
// one-time download from the @mdi/svg package on jsDelivr. Files are named
// "<name>-symbolic.svg" so GNOME Shell recolors them like any symbolic icon.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup?version=3.0';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

export const MDI_VERSION = '7.4.47';
const CDN = `https://cdn.jsdelivr.net/npm/@mdi/svg@${MDI_VERSION}/svg`;
const FALLBACK = 'applications-system-symbolic';

export class IconCache extends Signals.EventEmitter {
    constructor(bundledDir) {
        super();
        this._bundledDir = bundledDir;
        this._cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'ha-tiles', 'mdi']);
        GLib.mkdir_with_parents(this._cacheDir, 0o755);
        this._icons = new Map();
        this._failed = new Set();
        this._downloading = new Set();
        this._session = new Soup.Session({timeout: 15});
        this._cancellable = new Gio.Cancellable();
    }

    // Returns a Gio.Icon now; emits 'changed' later if the icon had to be downloaded
    lookup(name) {
        if (!name || !/^[a-z0-9-]+$/.test(name) || this._failed.has(name))
            return Gio.ThemedIcon.new(FALLBACK);

        const cached = this._icons.get(name);
        if (cached)
            return cached;

        for (const dir of [this._bundledDir, this._cacheDir]) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([dir, `${name}-symbolic.svg`]));
            if (file.query_exists(null)) {
                const icon = new Gio.FileIcon({file});
                this._icons.set(name, icon);
                return icon;
            }
        }

        this._download(name);
        return Gio.ThemedIcon.new(FALLBACK);
    }

    _download(name) {
        if (this._downloading.has(name))
            return;
        this._downloading.add(name);

        const msg = Soup.Message.new('GET', `${CDN}/${name}.svg`);
        this._session.send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancellable, (session, res) => {
            this._downloading.delete(name);
            try {
                const bytes = session.send_and_read_finish(res);
                const svg = new TextDecoder().decode(bytes.toArray());
                if (msg.get_status() !== Soup.Status.OK || !svg.trimStart().startsWith('<svg'))
                    throw new Error(`HTTP ${msg.get_status()}`);
                const path = GLib.build_filenamev([this._cacheDir, `${name}-symbolic.svg`]);
                GLib.file_set_contents(path, svg);
                this._icons.set(name, new Gio.FileIcon({file: Gio.File.new_for_path(path)}));
                this.emit('changed');
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                console.warn(`[Home Assistant Tiles] Icon mdi:${name} unavailable: ${e.message}`);
                this._failed.add(name);
            }
        });
    }

    destroy() {
        this._cancellable.cancel();
        this.disconnectAll();
    }
}

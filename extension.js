/* extension.js
 *
 * Home Assistant Quick Settings
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {HaClient, State} from './lib/haClient.js';
import {IconCache} from './lib/icons.js';
import * as E from './lib/entities.js';
import {DeviceHeaderItem, EntityItem, SectionHeaderItem} from './lib/widgets.js';

const DEFAULT_TILE = {id: 'default', title: 'Home Assistant', icon: 'mdi:home-assistant', primary: '', sections: 'all', wide: false, indicator: false};

function parseJson(text, fallback) {
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

const HaTile = GObject.registerClass(
class HaTile extends QuickMenuToggle {
    constructor(ctx, config) {
        super({title: config.title || 'Home Assistant', toggleMode: false});
        this._ctx = ctx;
        this._config = config;
        this._items = [];
        this._sectionsKey = '';

        this.connect('clicked', () => this._onClicked());

        // Scrollable body so long entity lists don't overflow the screen
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);
        this.menu.box.remove_child(this._section.actor);
        this._scroll = new St.ScrollView({
            style_class: 'haqs-scroll vfade',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            child: this._section.actor,
        });
        this.menu.box.add_child(this._scroll);

        // Size the list to the space below the tile each time the menu opens
        const open = this.menu.open.bind(this.menu);
        this.menu.open = animate => {
            this._fitToScreen();
            open(animate);
        };

        // Header buttons instead of menu rows, to leave the height to the list
        this._headerButtons = new St.BoxLayout({
            style_class: 'haqs-header-buttons',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const [icon, name, action] of [
            ['open-in-new', 'Open Home Assistant', () => ctx.openHomeAssistant()],
            ['cog', 'Settings', () => ctx.openPreferences()],
        ]) {
            const headerButton = new St.Button({
                style_class: 'icon-button haqs-header-button',
                child: new St.Icon({gicon: ctx.icons.lookup(icon)}),
                accessible_name: name,
                can_focus: true,
            });
            headerButton.connect('clicked', action);
            this._headerButtons.add_child(headerButton);
        }

        this.rebuild();
    }

    // The menu opens below this tile's row; give the list whatever height is left
    // on the monitor after the menu header and footer.
    _fitToScreen() {
        const monitor = Main.layoutManager.findMonitorForActor(this) ?? Main.layoutManager.primaryMonitor;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const [, tileY] = this.get_transformed_position();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;

        this._scroll.style = null;
        const [, boxHeight] = this.menu.box.get_preferred_height(-1);
        const [, listHeight] = this._scroll.get_preferred_height(-1);
        const chrome = boxHeight - listHeight + 48; // header, footer, menu padding and spacing
        const available = workArea.y + workArea.height - (tileY + this.height) - chrome;
        const maxHeight = Math.max(160 * scale, available);
        this._scroll.style = `max-height: ${Math.floor(maxHeight / scale)}px;`;
    }

    get config() {
        return this._config;
    }

    _sectionRefs() {
        const refs = this._config.sections;
        if (refs === 'all' || !Array.isArray(refs))
            return E.allSections(this._ctx.client, this._ctx.settings.groups).map(s => s.ref);
        return refs;
    }

    _resolve() {
        return E.resolveSections(this._ctx.client, this._sectionRefs(), this._ctx.settings);
    }

    rebuild() {
        const {client} = this._ctx;
        this._section.removeAll();
        this._items = [];

        const sections = client.registryLoaded ? this._resolve() : [];
        this._sectionsKey = JSON.stringify(sections.map(s => [s.ref, s.entities]));
        this._toggleIds = sections.flatMap(s => s.entities).filter(id => E.domainOf(id) === 'light');

        sections.forEach((section, index) => {
            if (index > 0)
                this._section.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            const header = new SectionHeaderItem(this._ctx, section);
            this._addItem(header);

            for (const cluster of E.clusterByDevice(client, section.entities)) {
                if (cluster.deviceId)
                    this._addItem(new DeviceHeaderItem(this._ctx, cluster));
                for (const id of cluster.entities) {
                    const row = new EntityItem(this._ctx, id, [cluster.name, section.name]);
                    if (cluster.deviceId)
                        row.add_style_class_name('haqs-in-device');
                    this._addItem(row);
                }
            }
        });

        if (!sections.length && client.state === State.CONNECTED) {
            const empty = new PopupMenu.PopupMenuItem('Nothing to show. Choose sections in Settings.');
            empty.reactive = false;
            this._section.addMenuItem(empty);
        }
        this.sync();
    }

    _addItem(item) {
        this._section.addMenuItem(item);
        if (item.colorPanel)
            this._section.addMenuItem(item.colorPanel);
        this._items.push(item);
    }

    // Rebuilds when section membership changed, otherwise syncs the changed rows
    update(changedIds) {
        if (this._ctx.client.registryLoaded) {
            const key = JSON.stringify(this._resolve().map(s => [s.ref, s.entities]));
            if (key !== this._sectionsKey) {
                this.rebuild();
                return;
            }
        }
        const changed = new Set(changedIds);
        for (const item of this._items) {
            if (!item.entityId || changed.has(item.entityId))
                item.sync();
        }
        this.sync();
    }

    refreshIcons() {
        for (const item of this._items)
            item.refreshIcon ? item.refreshIcon() : item.sync();
        this.sync();
    }

    _tileIcon() {
        const {client} = this._ctx;
        const {icon, primary} = this._config;
        if (icon && icon !== 'auto')
            return icon.replace(/^mdi:/, '');
        if (primary) {
            const areaId = E.entityAreaId(client, primary);
            if (areaId && client.areas.get(areaId)?.icon)
                return E.areaIconOf(client, areaId);
            if (client.states.has(primary))
                return E.entityIcon(client, primary);
        }
        return 'home-assistant';
    }

    sync() {
        const {client, icons} = this._ctx;
        const {primary} = this._config;
        const connected = client.state === State.CONNECTED;

        const gicon = icons.lookup(this._tileIcon());
        this.gicon = gicon;

        const lightsOn = this._toggleIds.filter(id => E.isOn(client.states.get(id))).length;
        let subtitle;
        if (!connected)
            subtitle = client.state === State.AUTH_FAILED ? 'Login failed' : client.state === State.IDLE ? 'Not set up' : 'Connecting…';
        else if (primary)
            subtitle = E.stateLabel(client, primary);
        else
            subtitle = lightsOn ? `${lightsOn} on` : 'All off';

        this.checked = connected && (primary ? E.isOn(client.states.get(primary)) : lightsOn > 0);
        this.subtitle = subtitle;
        this.reactive = connected;

        const menuSubtitle = connected
            ? (this._toggleIds.length ? `${lightsOn} of ${this._toggleIds.length} lights on` : '')
            : subtitle;
        this.menu.setHeader(gicon, this._config.title || 'Home Assistant', menuSubtitle);
        if (!this._headerButtons.get_parent()) {
            this.menu.addHeaderSuffix(this._headerButtons);
            // The header keeps an expanding spacer after the suffix; hide it so
            // the buttons, not the spacer, take the free width and sit at the end
            this.menu._headerSpacer?.hide();
        }
    }

    _onClicked() {
        const {client} = this._ctx;
        const {primary} = this._config;
        if (primary) {
            const on = E.isOn(client.states.get(primary));
            this.checked = !on; // optimistic
            client.callService('homeassistant', on ? 'turn_off' : 'turn_on', primary);
        } else if (this._toggleIds.length) {
            // Without a main entity, the tile switches this tile's lights only
            const anyOn = this._toggleIds.some(id => E.isOn(client.states.get(id)));
            this.checked = !anyOn;
            client.callService('light', anyOn ? 'turn_off' : 'turn_on', this._toggleIds);
        }
    }
});

const HaIndicator = GObject.registerClass(
class HaIndicator extends SystemIndicator {
    constructor(ctx, config) {
        super();
        this._indicator = this._addIndicator();
        this.tile = new HaTile(ctx, config);
        this.quickSettingsItems.push(this.tile);

        this.tile.bind_property('gicon', this._indicator, 'gicon', GObject.BindingFlags.SYNC_CREATE);
        const syncVisible = () => {
            this._indicator.visible = !!config.indicator && this.tile.checked;
        };
        this.tile.connect('notify::checked', syncVisible);
        syncVisible();
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

export default class HaQuickSettingsExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const log = msg => {
            if (this._settings?.get_boolean('debug'))
                console.log(`[HA Quick Settings] ${msg}`);
        };

        this._client = new HaClient({log});
        this._icons = new IconCache(GLib.build_filenamev([this.path, 'icons', 'mdi']));
        this._ctx = {
            client: this._client,
            icons: this._icons,
            settings: {},
            openPreferences: () => {
                Main.panel.closeQuickSettings();
                this.openPreferences();
            },
            openHomeAssistant: () => {
                Main.panel.closeQuickSettings();
                const url = this._settings.get_string('url');
                if (url)
                    Gio.AppInfo.launch_default_for_uri(url, null);
            },
        };
        this._indicators = [];
        this._readSettings();
        this._createTiles();

        this._client.connectObject(
            'notify::state', () => this._indicators.forEach(i => i.tile.sync()),
            'states-changed', (_c, ids) => this._indicators.forEach(i => i.tile.update(ids)),
            'registry-changed', () => this._indicators.forEach(i => i.tile.rebuild()),
            this);
        this._icons.connectObject('changed', () => this._queueIconRefresh(), this);

        this._settings.connectObject(
            'changed::url', () => this._configureClient(),
            'changed::token', () => this._configureClient(),
            'changed::tiles', () => this._createTiles(),
            'changed::groups', () => this._settingsChanged(),
            'changed::domains', () => this._settingsChanged(),
            'changed::hidden-entities', () => this._settingsChanged(),
            'changed::show-ha-hidden', () => this._settingsChanged(),
            'changed::group-controls', () => this._settingsChanged(),
            'changed::hide-unavailable', () => this._settingsChanged(),
            this);

        this._configureClient();
    }

    _configureClient() {
        this._client.configure(this._settings.get_string('url').trim(), this._settings.get_string('token').trim());
    }

    _readSettings() {
        const s = this._settings;
        Object.assign(this._ctx.settings, {
            groups: parseJson(s.get_string('groups'), []),
            domains: new Set(s.get_strv('domains')),
            hiddenEntities: new Set(s.get_strv('hidden-entities')),
            showHaHidden: s.get_boolean('show-ha-hidden'),
            groupControls: s.get_boolean('group-controls'),
            hideUnavailable: s.get_boolean('hide-unavailable'),
        });
    }

    _settingsChanged() {
        this._readSettings();
        this._indicators.forEach(i => i.tile.rebuild());
    }

    _createTiles() {
        this._destroyTiles();
        let tiles = parseJson(this._settings.get_string('tiles'), []);
        if (!tiles.length)
            tiles = [DEFAULT_TILE];
        for (const config of tiles) {
            const indicator = new HaIndicator(this._ctx, config);
            this._indicators.push(indicator);
            Main.panel.statusArea.quickSettings.addExternalIndicator(indicator, config.wide ? 2 : 1);
        }
    }

    _destroyTiles() {
        this._indicators?.forEach(i => i.destroy());
        this._indicators = [];
    }

    _queueIconRefresh() {
        if (this._iconRefreshId)
            return;
        // Downloads finish in bursts; refresh once they settle
        this._iconRefreshId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this._iconRefreshId = 0;
            this._indicators.forEach(i => i.tile.refreshIcons());
            return GLib.SOURCE_REMOVE;
        });
    }

    disable() {
        if (this._iconRefreshId) {
            GLib.Source.remove(this._iconRefreshId);
            this._iconRefreshId = 0;
        }
        this._destroyTiles();
        this._settings.disconnectObject(this);
        this._client.disconnectObject(this);
        this._client.destroy();
        this._icons.destroy();
        this._client = null;
        this._icons = null;
        this._ctx = null;
        this._settings = null;
    }
}

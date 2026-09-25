/* prefs.js
 *
 * Home Assistant Quick Settings - preferences
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {HaClient} from './lib/haClient.js';
import * as E from './lib/entities.js';

const SMART_HOME_UUID = 'smart-home@chlumskyvaclav.gmail.com';
const MAIN_ENTITY_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean', 'cover', 'automation', 'lock']);

const newId = () => GLib.uuid_string_random().slice(0, 8);

function parseJson(text) {
    try {
        const value = JSON.parse(text);
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

// Home Assistant connections saved by the Smart Home extension, as [{name, url, token}]
function smartHomeConnections() {
    const dirs = [
        GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-shell', 'extensions', SMART_HOME_UUID, 'schemas']),
        GLib.build_filenamev(['/usr/share/gnome-shell/extensions', SMART_HOME_UUID, 'schemas']),
    ];
    for (const dir of dirs) {
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
            continue;
        try {
            const source = Gio.SettingsSchemaSource.new_from_directory(dir, Gio.SettingsSchemaSource.get_default(), false);
            const schema = source.lookup('org.gnome.shell.extensions.smart-home', false);
            if (!schema?.has_key('home-assistant'))
                continue;
            const value = new Gio.Settings({settings_schema: schema}).get_value('home-assistant').recursiveUnpack();
            return Object.values(value).filter(c => c.ip && c.accessToken).map(c => {
                let url = c.ip.includes('://') ? c.ip : `http://${c.ip}`;
                const defaultPort = url.startsWith('https') ? '443' : '80';
                if (c.port && c.port !== defaultPort && !/:\d+$/.test(url))
                    url = `${url}:${c.port}`;
                return {name: c.name || url, url, token: c.accessToken};
            });
        } catch (e) {
            console.warn(`[HA Quick Settings] Could not read Smart Home settings: ${e.message}`);
        }
    }
    return [];
}

function button(label, {icon = null, css = []} = {}) {
    const b = icon
        ? new Gtk.Button({icon_name: icon, tooltip_text: label, valign: Gtk.Align.CENTER})
        : new Gtk.Button({label, valign: Gtk.Align.CENTER});
    css.forEach(c => b.add_css_class(c));
    if (icon)
        b.add_css_class('flat');
    return b;
}

export default class HaQuickSettingsPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;
        window.set_default_size(720, 820);
        window.search_enabled = true;

        this._client = new HaClient({subscribe: false});
        window.connect('close-request', () => {
            this._client.destroy();
            return false;
        });

        this._tilesPage = new Adw.PreferencesPage({title: 'Tiles', icon_name: 'view-grid-symbolic'});
        this._groupsPage = new Adw.PreferencesPage({title: 'Groups', icon_name: 'view-list-symbolic'});
        this._displayPage = new Adw.PreferencesPage({title: 'Display', icon_name: 'preferences-desktop-display-symbolic'});

        window.add(this._buildConnectionPage());
        window.add(this._tilesPage);
        window.add(this._groupsPage);
        window.add(this._displayPage);

        this._dynamicGroups = new Map();
        this._refreshAll();
        this._connect();
    }

    //#region Data
    get _ready() {
        return this._client.registryLoaded;
    }

    _connect() {
        const url = this._settings.get_string('url').trim();
        const token = this._settings.get_string('token').trim();
        if (!url || !token) {
            this._setStatus('Enter the URL and access token, then press Enter or Apply', 'dialog-information-symbolic');
            return;
        }
        this._setStatus('Connecting…', 'content-loading-symbolic');
        this._client.configure(url, token);
        this._client.whenReady(10).then(() => {
            const c = this._client;
            this._setStatus(`Connected to ${c.config?.location_name ?? 'Home Assistant'} · Home Assistant ${c.config?.version ?? ''} · ${c.states.size} entities, ${c.areas.size} areas`,
                'emblem-ok-symbolic');
            this._refreshAll();
        }).catch(e => {
            this._setStatus(`Could not connect: ${e.message}`, 'dialog-error-symbolic');
            this._client.configure('', '');
        });
    }

    _entitiesSorted(filter = () => true) {
        const ids = [...this._client.states.keys()].filter(filter);
        return ids.sort((a, b) => E.friendlyName(this._client, a).localeCompare(E.friendlyName(this._client, b)));
    }

    _entitySubtitle(id) {
        const areaId = E.entityAreaId(this._client, id);
        const area = areaId ? this._client.areas.get(areaId)?.name : null;
        return area ? `${id} · ${area}` : id;
    }

    _load(key) {
        return parseJson(this._settings.get_string(key));
    }

    _save(key, value) {
        this._settings.set_string(key, JSON.stringify(value));
    }

    _refreshAll() {
        this._refreshTiles();
        this._refreshGroups();
        this._refreshDisplay();
    }

    // Swap a page's dynamic content group for a freshly built one
    _replaceGroups(page, key, groups) {
        for (const g of this._dynamicGroups.get(key) ?? [])
            page.remove(g);
        groups.forEach(g => page.add(g));
        this._dynamicGroups.set(key, groups);
    }

    _notConnectedGroup(what) {
        const group = new Adw.PreferencesGroup();
        group.add(new Adw.ActionRow({
            title: 'Not connected',
            subtitle: `Connect to Home Assistant on the Connection page to choose ${what}.`,
            activatable: false,
        }));
        return group;
    }
    //#endregion Data

    //#region Connection page
    _buildConnectionPage() {
        const page = new Adw.PreferencesPage({title: 'Connection', icon_name: 'network-server-symbolic'});

        const group = new Adw.PreferencesGroup({
            title: 'Home Assistant',
            description: 'Create a long-lived access token in Home Assistant under your profile → Security.',
        });
        const urlRow = new Adw.EntryRow({title: 'URL', text: this._settings.get_string('url'), show_apply_button: true});
        urlRow.connect('apply', () => {
            this._settings.set_string('url', urlRow.text.trim());
            this._connect();
        });
        const tokenRow = new Adw.PasswordEntryRow({title: 'Access token', text: this._settings.get_string('token'), show_apply_button: true});
        tokenRow.connect('apply', () => {
            this._settings.set_string('token', tokenRow.text.trim());
            this._connect();
        });
        group.add(urlRow);
        group.add(tokenRow);

        this._statusRow = new Adw.ActionRow({title: 'Status', activatable: false});
        this._statusIcon = new Gtk.Image({valign: Gtk.Align.CENTER});
        this._statusRow.add_prefix(this._statusIcon);
        const retry = button('Reconnect', {icon: 'view-refresh-symbolic'});
        retry.connect('clicked', () => this._connect());
        this._statusRow.add_suffix(retry);
        group.add(this._statusRow);
        page.add(group);

        const imports = smartHomeConnections();
        if (imports.length) {
            const importGroup = new Adw.PreferencesGroup({
                title: 'Import',
                description: 'Use a connection already saved by the Smart Home extension.',
            });
            for (const conn of imports) {
                const row = new Adw.ActionRow({title: conn.name, subtitle: conn.url});
                const importButton = button('Use this connection', {css: ['suggested-action']});
                importButton.connect('clicked', () => {
                    urlRow.text = conn.url;
                    tokenRow.text = conn.token;
                    this._settings.set_string('url', conn.url);
                    this._settings.set_string('token', conn.token);
                    this._connect();
                });
                row.add_suffix(importButton);
                importGroup.add(row);
            }
            page.add(importGroup);
        }
        return page;
    }

    _setStatus(text, icon) {
        this._statusRow.subtitle = GLib.markup_escape_text(text, -1);
        this._statusIcon.icon_name = icon;
    }
    //#endregion Connection page

    //#region Tiles page
    _refreshTiles() {
        const tiles = this._load('tiles');
        const groups = [];

        const list = new Adw.PreferencesGroup({
            title: 'Quick Settings tiles',
            description: 'Each tile is a button in Quick Settings. Its arrow opens a menu with the sections you choose.',
        });
        const add = button('Add tile', {icon: 'list-add-symbolic'});
        add.connect('clicked', () => {
            tiles.push({id: newId(), title: 'New tile', icon: 'auto', primary: '', sections: 'all', wide: false, indicator: false});
            this._save('tiles', tiles);
            this._refreshTiles();
        });
        list.set_header_suffix(add);
        groups.push(list);

        if (!tiles.length) {
            list.add(new Adw.ActionRow({
                title: 'No tiles yet',
                subtitle: 'A default "Home Assistant" tile showing every section is used until you add one.',
                activatable: false,
            }));
        }
        tiles.forEach((tile, index) => list.add(this._tileRow(tiles, tile, index)));

        if (!this._ready)
            groups.push(this._notConnectedGroup('main entities and sections'));
        this._replaceGroups(this._tilesPage, 'tiles', groups);
    }

    _tileRow(tiles, tile, index) {
        const save = () => this._save('tiles', tiles);
        const expander = new Adw.ExpanderRow({title: GLib.markup_escape_text(tile.title || 'Untitled', -1), subtitle: this._tileSummary(tile)});
        const resummarize = () => {
            expander.title = GLib.markup_escape_text(tile.title || 'Untitled', -1);
            expander.subtitle = this._tileSummary(tile);
        };

        // Reorder and delete
        const up = button('Move up', {icon: 'go-up-symbolic'});
        const down = button('Move down', {icon: 'go-down-symbolic'});
        const del = button('Remove tile', {icon: 'user-trash-symbolic'});
        up.sensitive = index > 0;
        down.sensitive = index < tiles.length - 1;
        const move = delta => {
            tiles.splice(index + delta, 0, ...tiles.splice(index, 1));
            save();
            this._refreshTiles();
        };
        up.connect('clicked', () => move(-1));
        down.connect('clicked', () => move(1));
        del.connect('clicked', () => {
            tiles.splice(index, 1);
            save();
            this._refreshTiles();
        });
        [up, down, del].forEach(b => expander.add_suffix(b));

        const title = new Adw.EntryRow({title: 'Name', text: tile.title ?? ''});
        title.connect('changed', () => {
            tile.title = title.text;
            save();
            resummarize();
        });
        expander.add_row(title);

        const icon = new Adw.EntryRow({title: 'Icon: "auto" or an mdi: name, e.g. mdi:desk', text: tile.icon ?? 'auto'});
        icon.connect('changed', () => {
            tile.icon = icon.text.trim() || 'auto';
            save();
        });
        expander.add_row(icon);

        if (this._ready) {
            const candidates = this._entitiesSorted(id => MAIN_ENTITY_DOMAINS.has(E.domainOf(id)));
            const labels = ['None — the tile switches its lights', ...candidates.map(id => `${E.friendlyName(this._client, id)}  (${id})`)];
            const primary = new Adw.ComboRow({
                title: 'Main entity',
                subtitle: 'What the tile button toggles. With "auto", the tile uses this entity\'s area icon.',
                model: Gtk.StringList.new(labels),
                enable_search: true,
                selected: Math.max(0, candidates.indexOf(tile.primary) + 1),
            });
            primary.connect('notify::selected', () => {
                tile.primary = primary.selected > 0 ? candidates[primary.selected - 1] : '';
                save();
                resummarize();
            });
            expander.add_row(primary);

            const groups = this._load('groups');
            const sections = E.allSections(this._client, groups);
            const all = new Adw.SwitchRow({title: 'All sections', subtitle: 'Every area and custom group, including new ones', active: tile.sections === 'all'});
            expander.add_row(all);
            const sectionRows = sections.map(section => {
                const selected = Array.isArray(tile.sections) ? tile.sections.includes(section.ref) : true;
                const row = new Adw.SwitchRow({
                    title: GLib.markup_escape_text(section.name, -1),
                    subtitle: section.ref.startsWith('group:') ? 'Custom group' : section.ref === 'unassigned' ? 'Entities without an area' : 'Area',
                    active: selected,
                    sensitive: tile.sections !== 'all',
                });
                row.connect('notify::active', () => {
                    if (tile.sections === 'all')
                        return;
                    // Keep HA/section order regardless of click order
                    tile.sections = sections.filter((s, i) => sectionRows[i].active).map(s => s.ref);
                    save();
                    resummarize();
                });
                expander.add_row(row);
                return row;
            });
            all.connect('notify::active', () => {
                tile.sections = all.active ? 'all' : sections.map(s => s.ref);
                sectionRows.forEach(r => {
                    r.sensitive = !all.active;
                    r.active = true;
                });
                save();
                resummarize();
            });
        }

        const wide = new Adw.SwitchRow({title: 'Wide tile', subtitle: 'Span both Quick Settings columns', active: !!tile.wide});
        wide.connect('notify::active', () => {
            tile.wide = wide.active;
            save();
        });
        expander.add_row(wide);

        const indicator = new Adw.SwitchRow({title: 'Top bar icon', subtitle: 'Show the tile icon in the top bar while it is on', active: !!tile.indicator});
        indicator.connect('notify::active', () => {
            tile.indicator = indicator.active;
            save();
        });
        expander.add_row(indicator);
        return expander;
    }

    _tileSummary(tile) {
        const parts = [];
        if (tile.primary)
            parts.push(this._ready ? E.friendlyName(this._client, tile.primary) : tile.primary);
        parts.push(tile.sections === 'all' ? 'all sections' : `${tile.sections?.length ?? 0} sections`);
        return GLib.markup_escape_text(parts.join(' · '), -1);
    }
    //#endregion Tiles page

    //#region Groups page
    _refreshGroups() {
        const groups = this._load('groups');
        const result = [];

        const list = new Adw.PreferencesGroup({
            title: 'Custom groups',
            description: 'Group devices and entities your own way, e.g. all beacons together. ' +
                'Members of a custom group are not shown in their Home Assistant area. ' +
                'Areas themselves are managed in Home Assistant.',
        });
        const add = button('Add group', {icon: 'list-add-symbolic'});
        add.connect('clicked', () => {
            groups.push({id: newId(), name: 'New group', icon: 'mdi:group', devices: [], entities: []});
            this._save('groups', groups);
            this._refreshGroups();
            this._refreshTiles();
        });
        list.set_header_suffix(add);
        result.push(list);

        if (!groups.length)
            list.add(new Adw.ActionRow({title: 'No custom groups', subtitle: 'Sections follow your Home Assistant areas.', activatable: false}));
        groups.forEach((group, index) => list.add(this._groupRow(groups, group, index)));

        if (!this._ready)
            result.push(this._notConnectedGroup('devices and entities'));
        this._replaceGroups(this._groupsPage, 'groups', result);
    }

    _groupRow(groups, group, index) {
        const save = () => this._save('groups', groups);
        const summary = () => GLib.markup_escape_text(`${group.devices.length} devices, ${group.entities.length} entities`, -1);
        const expander = new Adw.ExpanderRow({title: GLib.markup_escape_text(group.name || 'Untitled', -1), subtitle: summary()});

        const del = button('Remove group', {icon: 'user-trash-symbolic'});
        del.connect('clicked', () => {
            groups.splice(index, 1);
            save();
            this._refreshGroups();
            this._refreshTiles();
        });
        expander.add_suffix(del);

        const name = new Adw.EntryRow({title: 'Name', text: group.name ?? ''});
        name.connect('changed', () => {
            group.name = name.text;
            expander.title = GLib.markup_escape_text(group.name || 'Untitled', -1);
            save();
        });
        expander.add_row(name);

        const icon = new Adw.EntryRow({title: 'Icon: an mdi: name, e.g. mdi:map-marker-radius', text: group.icon ?? ''});
        icon.connect('changed', () => {
            group.icon = icon.text.trim();
            save();
        });
        expander.add_row(icon);

        if (!this._ready)
            return expander;

        const toggleMember = (list, id, active) => {
            const set = new Set(group[list]);
            active ? set.add(id) : set.delete(id);
            group[list] = [...set];
            save();
            expander.subtitle = summary();
        };

        // Devices that have at least one entity, with their entities as the subtitle
        const deviceEntities = new Map();
        for (const [id, e] of this._client.entities) {
            if (e.deviceId && this._client.states.has(id) && !e.category)
                deviceEntities.set(e.deviceId, [...deviceEntities.get(e.deviceId) ?? [], id]);
        }
        const devices = [...deviceEntities.keys()]
            .sort((a, b) => (this._client.devices.get(a)?.name ?? '').localeCompare(this._client.devices.get(b)?.name ?? ''));
        const deviceRow = new Adw.ExpanderRow({title: 'Devices', subtitle: 'A device brings all of its entities'});
        for (const deviceId of devices) {
            const device = this._client.devices.get(deviceId);
            const area = device?.areaId ? this._client.areas.get(device.areaId)?.name : null;
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(device?.name || deviceId, -1),
                subtitle: GLib.markup_escape_text([area, `${deviceEntities.get(deviceId).length} entities`].filter(Boolean).join(' · '), -1),
                active: group.devices.includes(deviceId),
            });
            row.connect('notify::active', () => toggleMember('devices', deviceId, row.active));
            deviceRow.add_row(row);
        }
        expander.add_row(deviceRow);

        const entityRow = new Adw.ExpanderRow({title: 'Single entities'});
        for (const id of this._entitiesSorted(id => !this._client.entities.get(id)?.category)) {
            const row = new Adw.SwitchRow({
                title: GLib.markup_escape_text(E.friendlyName(this._client, id), -1),
                subtitle: GLib.markup_escape_text(this._entitySubtitle(id), -1),
                active: group.entities.includes(id),
            });
            row.connect('notify::active', () => toggleMember('entities', id, row.active));
            entityRow.add_row(row);
        }
        expander.add_row(entityRow);
        return expander;
    }
    //#endregion Groups page

    //#region Display page
    _refreshDisplay() {
        const result = [];

        const domains = new Adw.PreferencesGroup({
            title: 'Entity types in areas',
            description: 'Which kinds of entities area sections show. Custom groups always show all of their members.',
        });
        const enabled = new Set(this._settings.get_strv('domains'));
        for (const [domain, label] of Object.entries(E.DOMAIN_LABELS)) {
            const row = new Adw.SwitchRow({title: label, active: enabled.has(domain)});
            row.connect('notify::active', () => {
                const current = new Set(this._settings.get_strv('domains'));
                row.active ? current.add(domain) : current.delete(domain);
                this._settings.set_strv('domains', [...current]);
            });
            domains.add(row);
        }
        result.push(domains);

        const behaviour = new Adw.PreferencesGroup({title: 'Behaviour'});
        const switches = [
            ['group-controls', 'Section controls', 'A switch for sections with two or more toggleable members; a brightness slider or color picker only when two or more lights support it'],
            ['hide-unavailable', 'Hide unavailable entities', ''],
            ['show-ha-hidden', 'Show entities hidden in Home Assistant', 'Hidden entities are usually duplicates, e.g. the switch behind a light'],
            ['debug', 'Debug logging', 'Log connection details to the system journal'],
        ];
        for (const [key, title, subtitle] of switches) {
            const row = new Adw.SwitchRow({title, subtitle});
            this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            behaviour.add(row);
        }
        result.push(behaviour);

        if (this._ready) {
            const hiddenGroup = new Adw.PreferencesGroup({title: 'Visible entities'});
            const hidden = new Set(this._settings.get_strv('hidden-entities'));
            const expander = new Adw.ExpanderRow({title: 'Entities', subtitle: `${hidden.size} hidden`});
            for (const id of this._entitiesSorted()) {
                const row = new Adw.SwitchRow({
                    title: GLib.markup_escape_text(E.friendlyName(this._client, id), -1),
                    subtitle: GLib.markup_escape_text(this._entitySubtitle(id), -1),
                    active: !hidden.has(id),
                });
                row.connect('notify::active', () => {
                    row.active ? hidden.delete(id) : hidden.add(id);
                    this._settings.set_strv('hidden-entities', [...hidden]);
                    expander.subtitle = `${hidden.size} hidden`;
                });
                expander.add_row(row);
            }
            hiddenGroup.add(expander);
            result.push(hiddenGroup);
        }
        this._replaceGroups(this._displayPage, 'display', result);
    }
    //#endregion Display page
}

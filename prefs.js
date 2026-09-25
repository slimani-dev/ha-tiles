/* prefs.js
 *
 * Home Assistant Tiles - preferences
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
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
            console.warn(`[Home Assistant Tiles] Could not read Smart Home settings: ${e.message}`);
        }
    }
    return [];
}

const escape = text => GLib.markup_escape_text(text, -1);

const CSS = `
.haqs-badge {
    background-color: var(--accent-bg-color);
    color: var(--accent-fg-color);
    border-radius: 999px;
    padding: 2px 9px;
    font-weight: bold;
    transition: transform 200ms ease-out, background-color 200ms;
}
.haqs-badge.empty {
    background-color: alpha(currentColor, 0.15);
    color: inherit;
}
.haqs-badge.pulse {
    transform: scale(1.3);
}
`;

// Drag-and-drop reordering within one list. The drag carries "<scope>\n<ref>" so
// rows only accept drops from their own list (tiles, a tile's sections, a group's members).
function makeReorderable(row, scope, ref, onMove) {
    row.add_prefix(new Gtk.Image({icon_name: 'list-drag-handle-symbolic', css_classes: ['dim-label']}));

    const source = new Gtk.DragSource({actions: Gdk.DragAction.MOVE});
    source.connect('prepare', () => {
        const value = new GObject.Value();
        value.init(GObject.TYPE_STRING);
        value.set_string(`${scope}\n${ref}`);
        return Gdk.ContentProvider.new_for_value(value);
    });
    source.connect('drag-begin', src => src.set_icon(new Gtk.WidgetPaintable({widget: row}), 0, 0));
    row.add_controller(source);

    const target = Gtk.DropTarget.new(GObject.TYPE_STRING, Gdk.DragAction.MOVE);
    target.connect('drop', (_target, value) => {
        const [fromScope, fromRef] = value.split('\n');
        if (fromScope !== scope || fromRef === ref)
            return false;
        onMove(fromRef, ref);
        return true;
    });
    row.add_controller(target);
}

// Items for entity drop-downs: "name\tentity id". The selected value shows the name;
// the open list shows the full name with the entity id underneath.
function entityItemFactory(inList) {
    const factory = new Gtk.SignalListItemFactory();
    factory.connect('setup', (_f, item) => {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        const name = new Gtk.Label({xalign: 0});
        if (inList) {
            name.set({wrap: true, max_width_chars: 40, width_chars: 28});
            const id = new Gtk.Label({xalign: 0, css_classes: ['dim-label', 'caption']});
            box.append(name);
            box.append(id);
        } else {
            name.set({ellipsize: 3 /* Pango.EllipsizeMode.END */, max_width_chars: 24});
            box.append(name);
        }
        item.child = box;
    });
    factory.connect('bind', (_f, item) => {
        const [name, id] = item.item.string.split('\t');
        const box = item.child;
        box.get_first_child().label = name;
        const idLabel = box.get_first_child().get_next_sibling();
        if (idLabel) {
            idLabel.label = id;
            idLabel.visible = !!id;
        }
    });
    return factory;
}

// A search entry that filters rows by title and subtitle
function searchGroup(rows) {
    const group = new Adw.PreferencesGroup();
    const entry = new Gtk.SearchEntry({placeholder_text: 'Search by name, entity ID or area'});
    entry.connect('search-changed', () => {
        const query = entry.text.trim().toLowerCase();
        for (const row of rows)
            row.visible = !query || `${row.title} ${row.subtitle}`.toLowerCase().includes(query);
    });
    group.add(entry);
    return group;
}

// Move `from` to where `to` is: after it when dragging down, before it when dragging up
function moveRef(list, from, to) {
    const result = list.filter(r => r !== from);
    const at = result.indexOf(to);
    result.splice(list.indexOf(from) < list.indexOf(to) ? at + 1 : at, 0, from);
    return result;
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

export default class HaTilesPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._settings = this.getSettings();
        this._window = window;

        const css = new Gtk.CssProvider();
        css.load_from_string(CSS);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
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
        this._expanded = new Set(); // expander rows kept open across rebuilds
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

    // Opens a page on top of the window (with a back button). build(render) returns
    // the page's groups; call render() to rebuild them, e.g. after a reorder.
    _pushSubpage(title, build, onHidden) {
        const page = new Adw.PreferencesPage();
        const toolbar = new Adw.ToolbarView({content: page});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const nav = new Adw.NavigationPage({title, child: toolbar});
        let groups = [];
        const render = () => {
            groups.forEach(g => page.remove(g));
            groups = build(render);
            groups.forEach(g => page.add(g));
        };
        render();
        if (onHidden)
            nav.connect('hidden', onHidden);
        this._window.push_subpage(nav);
    }

    // [search, list] for a list group whose rows are SwitchRows
    _withSearch(list) {
        const rows = [];
        const collect = w => {
            for (let c = w.get_first_child(); c; c = c.get_next_sibling())
                c instanceof Adw.SwitchRow ? rows.push(c) : collect(c);
        };
        collect(list);
        return [searchGroup(rows), list];
    }

    _subpageRow(title, subtitle, onActivate, suffix = null) {
        const row = new Adw.ActionRow({title: escape(title), subtitle: escape(subtitle), activatable: true});
        if (suffix)
            row.add_suffix(suffix);
        row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
        row.connect('activated', onActivate);
        return row;
    }

    _trackExpanded(row, key) {
        row.expanded = this._expanded.has(key);
        row.connect('notify::expanded', () => {
            row.expanded ? this._expanded.add(key) : this._expanded.delete(key);
        });
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
        const save = () => this._save('tiles', tiles);

        const list = new Adw.PreferencesGroup({
            title: 'Quick Settings tiles',
            description: 'Each tile is a button in Quick Settings; its arrow opens a menu with the sections you choose. Drag tiles to reorder them.',
        });
        const add = new Adw.ButtonRow({title: 'Add tile'});
        add.connect('activated', () => {
            const tile = {id: newId(), title: 'New tile', icon: 'auto', primary: '', sections: 'all', wide: false, indicator: false};
            tiles.push(tile);
            this._expanded.add(`tile:${tile.id}`);
            save();
            this._refreshTiles();
        });
        groups.push(list);

        if (!tiles.length) {
            list.add(new Adw.ActionRow({
                title: 'No tiles yet',
                subtitle: 'A default "Home Assistant" tile showing every section is used until you add one.',
                activatable: false,
            }));
        }
        for (const tile of tiles) {
            const row = this._tileRow(tiles, tile, save);
            makeReorderable(row, 'tiles', tile.id, (from, to) => {
                const ids = moveRef(tiles.map(t => t.id), from, to);
                tiles.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
                save();
                this._refreshTiles();
            });
            list.add(row);
        }
        list.add(add);

        if (!this._ready)
            groups.push(this._notConnectedGroup('what tile buttons switch, and sections'));
        this._replaceGroups(this._tilesPage, 'tiles', groups);
    }

    _tileRow(tiles, tile, save) {
        const expander = new Adw.ExpanderRow({title: escape(tile.title || 'Untitled'), subtitle: this._tileSummary(tile)});
        this._trackExpanded(expander, `tile:${tile.id}`);
        const resummarize = () => {
            expander.title = escape(tile.title || 'Untitled');
            expander.subtitle = this._tileSummary(tile);
        };

        const del = button('Remove tile', {icon: 'user-trash-symbolic'});
        del.connect('clicked', () => {
            tiles.splice(tiles.indexOf(tile), 1);
            save();
            this._refreshTiles();
        });
        expander.add_suffix(del);

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
            // Areas, then devices, then single entities. Entities hidden in Home Assistant
            // (e.g. the switch behind a light) only clutter the list.
            const {areas, devices} = E.targetCandidates(this._client);
            const entities = this._entitiesSorted(id => MAIN_ENTITY_DOMAINS.has(E.domainOf(id)) &&
                (!this._client.entities.get(id)?.hidden || id === tile.primary));
            const count = ids => {
                const noun = ids.every(id => E.domainOf(id) === 'light') ? 'light' : 'entity';
                return `${ids.length} ${ids.length === 1 ? noun : noun === 'light' ? 'lights' : 'entities'}`;
            };
            const refs = ['', ...areas.map(a => a.ref), ...devices.map(d => d.ref), ...entities];
            // Each item is "name\tsecond line"; search matches either part
            const items = [
                'None — the tile switches its lights\t',
                ...areas.map(a => `${a.name}\tArea · ${count(a.ids)}`),
                ...devices.map(d => `${d.name}\tDevice · ${count(d.ids)}`),
                ...entities.map(id => `${E.friendlyName(this._client, id)}\t${id}`),
            ];
            const primary = new Adw.ComboRow({
                title: 'Tile button',
                subtitle: 'What clicking the tile switches: an area, a device or a single entity. With icon "auto", the tile uses its area icon.',
                model: Gtk.StringList.new(items),
                enable_search: true,
                // Search needs to know which text to match; StringList items expose it as "string"
                expression: new Gtk.PropertyExpression(Gtk.StringObject, null, 'string'),
                search_match_mode: Gtk.StringFilterMatchMode.SUBSTRING,
                factory: entityItemFactory(false),
                list_factory: entityItemFactory(true),
                selected: Math.max(0, refs.indexOf(tile.primary)),
            });
            primary.connect('notify::selected', () => {
                // The name follows the target while it is still the default or the previous
                // target's name; a name the user typed is kept
                const previous = tile.primary ? E.resolveTarget(this._client, tile.primary).name : null;
                tile.primary = refs[primary.selected] ?? '';
                if (!tile.title || tile.title === 'New tile' || tile.title === previous) {
                    tile.title = tile.primary ? E.resolveTarget(this._client, tile.primary).name : 'New tile';
                    title.text = tile.title;
                }
                save();
                resummarize();
            });
            expander.add_row(primary);
            expander.add_row(this._subpageRow('Sections', 'Which areas and groups the menu shows, and their order',
                () => this._pushSubpage(`${tile.title || 'Tile'} · Sections`,
                    render => this._tileSectionsGroups(tile, save, render),
                    () => this._refreshTiles())));
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

    // Which sections the tile shows, in menu order; drag to reorder
    _tileSectionsGroups(tile, save, render) {
        const sections = E.allSections(this._client, this._load('groups'));
        const allRefs = sections.map(s => s.ref);
        const byRef = new Map(sections.map(s => [s.ref, s]));

        const allGroup = new Adw.PreferencesGroup();
        const allRow = new Adw.SwitchRow({
            title: 'All sections',
            subtitle: 'Includes areas and groups added later',
            active: tile.sections === 'all',
        });
        allGroup.add(allRow);

        const list = new Adw.PreferencesGroup({title: 'Sections', description: 'Drag to set the menu order.'});
        let syncing = false;
        const rows = [];
        const selected = () => tile.sections === 'all' ? [...allRefs] : [...tile.sections];
        for (const ref of E.orderRefs(allRefs, tile.sectionOrder)) {
            const section = byRef.get(ref);
            const row = new Adw.SwitchRow({
                title: escape(section.name),
                subtitle: ref.startsWith('group:') ? 'Custom group' : ref === 'unassigned' ? 'Entities without an area' : 'Area',
                active: selected().includes(ref),
            });
            row.connect('notify::active', () => {
                if (syncing)
                    return;
                const current = selected();
                tile.sections = row.active ? [...new Set([...current, ref])] : current.filter(r => r !== ref);
                syncing = true;
                allRow.active = false;
                syncing = false;
                save();
            });
            makeReorderable(row, `sections:${tile.id}`, ref, (from, to) => {
                tile.sectionOrder = moveRef(E.orderRefs(allRefs, tile.sectionOrder), from, to);
                save();
                render();
            });
            rows.push(row);
            list.add(row);
        }

        allRow.connect('notify::active', () => {
            if (syncing)
                return;
            tile.sections = allRow.active ? 'all' : [...allRefs];
            syncing = true;
            rows.forEach(r => (r.active = true));
            syncing = false;
            save();
        });
        return [allGroup, list];
    }

    _tileSummary(tile) {
        const parts = [];
        if (tile.primary)
            parts.push(this._ready ? E.resolveTarget(this._client, tile.primary).name : tile.primary);
        parts.push(tile.sections === 'all' ? 'all sections' : `${tile.sections?.length ?? 0} sections`);
        return escape(parts.join(' · '));
    }
    //#endregion Tiles page

    //#region Groups page
    _refreshGroups() {
        const groups = this._load('groups');
        const result = [];
        const save = () => this._save('groups', groups);

        const list = new Adw.PreferencesGroup({
            title: 'Custom groups',
            description: 'Group devices and entities your own way, e.g. all beacons together. ' +
                'Members of a custom group are not shown in their Home Assistant area. ' +
                'Areas themselves are managed in Home Assistant.',
        });
        const add = new Adw.ButtonRow({title: 'Add group'});
        add.connect('activated', () => {
            const group = {id: newId(), name: 'New group', icon: 'mdi:group', devices: [], entities: [], order: [], exclude: []};
            groups.push(group);
            this._expanded.add(`group:${group.id}`);
            save();
            this._refreshGroups();
            this._refreshTiles();
        });
        result.push(list);

        if (!groups.length)
            list.add(new Adw.ActionRow({title: 'No custom groups', subtitle: 'Sections follow your Home Assistant areas.', activatable: false}));
        for (const group of groups) {
            const row = this._groupRow(groups, group, save);
            makeReorderable(row, 'groups', group.id, (from, to) => {
                const ids = moveRef(groups.map(g => g.id), from, to);
                groups.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
                save();
                this._refreshGroups();
                this._refreshTiles();
            });
            list.add(row);
        }
        list.add(add);

        if (!this._ready)
            result.push(this._notConnectedGroup('devices and entities'));
        this._replaceGroups(this._groupsPage, 'groups', result);
    }

    _groupRow(groups, group, save) {
        group.devices ??= [];
        group.entities ??= [];
        group.exclude ??= [];
        const summary = () => escape(`${group.devices.length} devices, ${group.entities.length} entities`);
        const expander = new Adw.ExpanderRow({title: escape(group.name || 'Untitled'), subtitle: summary()});
        this._trackExpanded(expander, `group:${group.id}`);

        const del = button('Remove group', {icon: 'user-trash-symbolic'});
        del.connect('clicked', () => {
            groups.splice(groups.indexOf(group), 1);
            save();
            this._refreshGroups();
            this._refreshTiles();
        });
        expander.add_suffix(del);

        const name = new Adw.EntryRow({title: 'Name', text: group.name ?? ''});
        name.connect('changed', () => {
            group.name = name.text;
            expander.title = escape(group.name || 'Untitled');
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

        // The name follows the group's only member while it is still "New group" or that
        // automatic name; a name the user typed is kept
        const autoName = () => {
            if (!this._ready)
                return null;
            const refs = E.groupMemberRefs(group);
            if (refs.length !== 1)
                return null;
            const id = refs[0].slice(refs[0].indexOf(':') + 1);
            return refs[0].startsWith('device:') ? this._client.devices.get(id)?.name ?? null : E.friendlyName(this._client, id);
        };
        let lastAutoName = autoName();

        // Member count badge, updated live while devices and entities are switched on and off
        const badge = new Gtk.Label({css_classes: ['haqs-badge'], valign: Gtk.Align.CENTER});
        let pulseId = 0;
        const updateMembers = (animate = true) => {
            if (animate) {
                const next = autoName();
                if (next && (!group.name || group.name === 'New group' || group.name === lastAutoName)) {
                    group.name = next;
                    name.text = group.name;
                    lastAutoName = next;
                }
            }
            const count = String(E.groupMemberRefs(group).length);
            expander.subtitle = summary();
            if (badge.label === count)
                return;
            badge.label = count;
            count === '0' ? badge.add_css_class('empty') : badge.remove_css_class('empty');
            if (!animate)
                return;
            badge.add_css_class('pulse');
            if (pulseId)
                GLib.Source.remove(pulseId);
            pulseId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                pulseId = 0;
                badge.remove_css_class('pulse');
                return GLib.SOURCE_REMOVE;
            });
        };
        badge.connect('destroy', () => pulseId && GLib.Source.remove(pulseId));
        updateMembers(false);

        const refresh = () => this._refreshGroups();
        const title = what => `${group.name || 'Group'} · ${what}`;
        expander.add_row(this._subpageRow('Add devices', 'A device brings all of its entities',
            () => this._pushSubpage(title('Add devices'), () => this._withSearch(this._deviceChoiceGroup(group, save, updateMembers)), refresh)));
        expander.add_row(this._subpageRow('Add single entities', 'Entities without their whole device',
            () => this._pushSubpage(title('Add single entities'), () => this._withSearch(this._entityChoiceGroup(group, save, updateMembers)), refresh)));
        expander.add_row(this._subpageRow('Members', 'Devices and entities in menu order; choose what each device shows',
            () => this._pushSubpage(title('Members'), render => [this._membersGroup(group, save, render)], refresh),
            badge));
        return expander;
    }

    _toggleMember(group, list, id, active, save, onChange) {
        const set = new Set(group[list]);
        active ? set.add(id) : set.delete(id);
        group[list] = [...set];
        save();
        onChange();
    }

    _deviceChoiceGroup(group, save, onChange) {
        const list = new Adw.PreferencesGroup({description: 'A device brings all of its entities; choose which ones show under Members.'});
        const deviceIds = [...this._client.devices.keys()]
            .filter(id => E.deviceEntities(this._client, id).length)
            .sort((a, b) => (this._client.devices.get(a)?.name ?? '').localeCompare(this._client.devices.get(b)?.name ?? ''));
        for (const deviceId of deviceIds) {
            const device = this._client.devices.get(deviceId);
            const area = device?.areaId ? this._client.areas.get(device.areaId)?.name : null;
            const row = new Adw.SwitchRow({
                title: escape(device?.name || deviceId),
                subtitle: escape([area, `${E.deviceEntities(this._client, deviceId).length} entities`].filter(Boolean).join(' · ')),
                active: group.devices.includes(deviceId),
            });
            row.connect('notify::active', () => this._toggleMember(group, 'devices', deviceId, row.active, save, onChange));
            list.add(row);
        }
        return list;
    }

    _entityChoiceGroup(group, save, onChange) {
        const list = new Adw.PreferencesGroup();
        for (const id of this._entitiesSorted(id => !this._client.entities.get(id)?.category)) {
            const row = new Adw.SwitchRow({
                title: escape(E.friendlyName(this._client, id)),
                subtitle: escape(this._entitySubtitle(id)),
                active: group.entities.includes(id),
            });
            row.connect('notify::active', () => this._toggleMember(group, 'entities', id, row.active, save, onChange));
            list.add(row);
        }
        return list;
    }

    _membersGroup(group, save, render) {
        const list = new Adw.PreferencesGroup({description: 'Drag to set the menu order. Open a device to choose which of its entities show.'});
        const refs = E.groupMemberRefs(group);
        if (!refs.length)
            list.add(new Adw.ActionRow({title: 'No members yet', subtitle: 'Use Add devices or Add single entities.', activatable: false}));
        refs.forEach(ref => list.add(this._memberRow(group, ref, save, render)));
        return list;
    }

    _memberRow(group, ref, save, render) {
        const client = this._client;
        const id = ref.slice(ref.indexOf(':') + 1);
        let row;
        if (ref.startsWith('device:')) {
            const deviceName = client.devices.get(id)?.name || id;
            const ids = E.deviceEntities(client, id);
            const shown = () => `${ids.filter(e => !group.exclude.includes(e)).length} of ${ids.length} entities shown`;
            row = new Adw.ExpanderRow({title: escape(deviceName), subtitle: shown()});
            this._trackExpanded(row, `member:${group.id}:${ref}`);
            for (const entityId of ids) {
                const entityRow = new Adw.SwitchRow({
                    title: escape(E.shortName(client, entityId, [deviceName])),
                    subtitle: escape(entityId),
                    active: !group.exclude.includes(entityId),
                });
                entityRow.connect('notify::active', () => {
                    const exclude = new Set(group.exclude);
                    entityRow.active ? exclude.delete(entityId) : exclude.add(entityId);
                    group.exclude = [...exclude];
                    row.subtitle = shown();
                    save();
                });
                row.add_row(entityRow);
            }
        } else {
            row = new Adw.ActionRow({title: escape(E.friendlyName(client, id)), subtitle: escape(this._entitySubtitle(id))});
        }
        makeReorderable(row, `members:${group.id}`, ref, (from, to) => {
            group.order = moveRef(E.groupMemberRefs(group), from, to);
            save();
            render();
        });
        return row;
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
            const summary = () => `${this._settings.get_strv('hidden-entities').length} hidden`;
            const open = this._subpageRow('Entities', summary(), () => this._pushSubpage('Visible entities', () => {
                const hidden = new Set(this._settings.get_strv('hidden-entities'));
                const list = new Adw.PreferencesGroup({description: 'Hidden entities are left out of every menu.'});
                const rows = this._entitiesSorted().map(id => {
                    const row = new Adw.SwitchRow({
                        title: escape(E.friendlyName(this._client, id)),
                        subtitle: escape(this._entitySubtitle(id)),
                        active: !hidden.has(id),
                    });
                    row.connect('notify::active', () => {
                        row.active ? hidden.delete(id) : hidden.add(id);
                        this._settings.set_strv('hidden-entities', [...hidden]);
                        open.subtitle = summary();
                    });
                    list.add(row);
                    return row;
                });
                return [searchGroup(rows), list];
            }));
            hiddenGroup.add(open);
            result.push(hiddenGroup);
        }
        this._replaceGroups(this._displayPage, 'display', result);
    }
    //#endregion Display page
}

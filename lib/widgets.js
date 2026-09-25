// Menu items for entities, devices and sections. Every control is created only
// when the entity (or, for section headers, at least two members) supports it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import * as E from './entities.js';
import {ColorWheel, TemperatureBar} from './color.js';

const SLIDER_COMMIT_MS = 300;
const INTERACTION_GRACE_MS = 1500;

// A slider that commits after the user pauses, and ignores state echoes while in use
class ManagedSlider {
    constructor(onCommit) {
        this.actor = new Slider(0);
        this.actor.add_style_class_name('haqs-slider');
        this.actor.x_expand = true;
        this._onCommit = onCommit;
        this._syncing = false;
        this._lastUser = 0;
        this.actor.connect('notify::value', () => {
            if (this._syncing)
                return;
            this._lastUser = GLib.get_monotonic_time();
            this._queueCommit();
        });
        this.actor.connect('drag-end', () => this._commit());
        this.actor.connect('destroy', () => this._clearTimer());
    }

    set(value) {
        if (GLib.get_monotonic_time() - this._lastUser < INTERACTION_GRACE_MS * 1000)
            return;
        this._syncing = true;
        this.actor.value = Math.min(1, Math.max(0, value));
        this._syncing = false;
    }

    _queueCommit() {
        this._clearTimer();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SLIDER_COMMIT_MS, () => {
            this._timer = 0;
            this._commit();
            return GLib.SOURCE_REMOVE;
        });
    }

    _commit() {
        this._clearTimer();
        this._lastUser = GLib.get_monotonic_time();
        this._onCommit(this.actor.value);
    }

    _clearTimer() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
    }
}

// GNOME's switch knob has its own drag gesture, so a click on the knob flips the
// switch without activating the row. Like PopupSwitchMenuItem, act on the switch's
// state change for every user change; updates from Home Assistant use set().
class StateSwitch {
    constructor(onUserChange) {
        this.actor = new PopupMenu.Switch(false);
        this.actor.add_style_class_name('haqs-switch');
        this.actor.y_align = Clutter.ActorAlign.CENTER;
        this._syncing = false;
        this.actor.connect('notify::state', () => {
            if (!this._syncing)
                onUserChange(this.actor.state);
        });
    }

    toggle() {
        this.actor.toggle();
    }

    set(state) {
        this._syncing = true;
        this.actor.state = state;
        this._syncing = false;
    }
}

function iconButton(ctx, mdiName, accessibleName, onClick) {
    const icon = new St.Icon({gicon: ctx.icons.lookup(mdiName), style_class: 'popup-menu-icon'});
    const button = new St.Button({
        style_class: 'haqs-icon-button button',
        child: icon,
        accessible_name: accessibleName,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    button._mdi = mdiName;
    return button;
}

//#region Color panel
// Hidden below its row until the palette button is pressed
export const ColorPanelItem = GObject.registerClass(
class ColorPanelItem extends PopupMenu.PopupBaseMenuItem {
    constructor(ctx, {colorIds, tempIds}) {
        super({reactive: false, can_focus: false, style_class: 'haqs-color-panel'});
        this._ctx = ctx;
        this._colorIds = colorIds;
        this._tempIds = tempIds;
        this.visible = false;

        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'haqs-color-box'});
        this.add_child(box);

        if (colorIds.length) {
            this._wheel = new ColorWheel();
            this._wheel.connect('picked', (_w, hue, sat) =>
                ctx.client.callService('light', 'turn_on', this._colorIds, {hs_color: [hue, sat]}));
            box.add_child(this._wheel);
        }
        if (tempIds.length) {
            const st = ctx.client.states.get(tempIds[0])?.attributes ?? {};
            this._temp = new TemperatureBar(st.min_color_temp_kelvin, st.max_color_temp_kelvin);
            this._temp.connect('picked', (_b, kelvin) =>
                ctx.client.callService('light', 'turn_on', this._tempIds, {color_temp_kelvin: kelvin}));
            box.add_child(this._temp);
        }
        this.sync();
    }

    sync() {
        const a = this._ctx.client.states.get(this._colorIds[0] ?? this._tempIds[0])?.attributes ?? {};
        this._wheel?.setColor(a.color_mode === 'color_temp' ? null : a.hs_color);
        this._temp?.setKelvin(a.color_mode === 'color_temp' ? a.color_temp_kelvin : null);
    }

    activate() {}
});
//#endregion Color panel

//#region Entity row
export const EntityItem = GObject.registerClass(
class EntityItem extends PopupMenu.PopupBaseMenuItem {
    constructor(ctx, id, nameContext) {
        const domain = E.domainOf(id);
        const readOnly = ['sensor', 'binary_sensor', 'climate'].includes(domain);
        super({style_class: 'haqs-entity-item', reactive: !readOnly, can_focus: !readOnly});
        this._ctx = ctx;
        this.entityId = id;
        this._domain = domain;
        this._nameContext = nameContext;

        const st = ctx.client.states.get(id);
        this._caps = E.caps(id, st);

        this._icon = new St.Icon({style_class: 'popup-menu-icon haqs-entity-icon', y_align: Clutter.ActorAlign.CENTER});

        // First line: icon, name, state and the main control; second line: slider and color
        const body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._top = new St.BoxLayout({x_expand: true, style_class: 'haqs-line'});
        this._bottom = new St.BoxLayout({x_expand: true, style_class: 'haqs-control-line'});
        this._name = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'haqs-entity-name'});
        this._name.clutter_text.ellipsize = 3; // Pango.EllipsizeMode.END
        this._state = new St.Label({y_align: Clutter.ActorAlign.CENTER, style_class: 'haqs-entity-state'});
        this._top.add_child(this._icon);
        this._top.add_child(this._name);
        this._top.add_child(this._state);
        body.add_child(this._top);
        this.add_child(body);

        this._buildControls();
        if (this._bottom.get_n_children())
            body.add_child(this._bottom);
        this.sync();
    }

    _buildControls() {
        const {client} = this._ctx;
        const id = this.entityId;
        const c = this._caps;

        switch (this._domain) {
        case 'light':
            if (c.brightness) {
                this._slider = new ManagedSlider(v =>
                    v < 0.01
                        ? client.callService('light', 'turn_off', id)
                        : client.callService('light', 'turn_on', id, {brightness_pct: Math.round(v * 100)}));
                this._bottom.add_child(this._slider.actor);
            }
            if (c.color || c.colorTemp) {
                this.colorPanel = new ColorPanelItem(this._ctx, {
                    colorIds: c.color ? [id] : [],
                    tempIds: c.colorTemp ? [id] : [],
                });
                (this._slider ? this._bottom : this._top).add_child(iconButton(this._ctx, 'palette', 'Color', () => {
                    this.colorPanel.visible = !this.colorPanel.visible;
                }));
            }
            break;
        case 'fan':
            if (c.brightness) {
                this._slider = new ManagedSlider(v =>
                    client.callService('fan', 'set_percentage', id, {percentage: Math.round(v * 100)}));
                this._bottom.add_child(this._slider.actor);
            }
            break;
        case 'cover':
            if (c.position) {
                this._slider = new ManagedSlider(v =>
                    client.callService('cover', 'set_cover_position', id, {position: Math.round(v * 100)}));
                this._bottom.add_child(this._slider.actor);
            }
            if (c.open)
                this._top.add_child(iconButton(this._ctx, 'arrow-up', 'Open', () => client.callService('cover', 'open_cover', id)));
            if (c.stop)
                this._top.add_child(iconButton(this._ctx, 'stop', 'Stop', () => client.callService('cover', 'stop_cover', id)));
            if (c.close)
                this._top.add_child(iconButton(this._ctx, 'arrow-down', 'Close', () => client.callService('cover', 'close_cover', id)));
            break;
        case 'number':
        case 'input_number': {
            this._slider = new ManagedSlider(v => {
                const a = client.states.get(id)?.attributes ?? {};
                const min = a.min ?? 0, max = a.max ?? 100, step = a.step || 1;
                const value = Math.round((min + v * (max - min)) / step) * step;
                client.callService(this._domain, 'set_value', id, {value});
            });
            this._bottom.add_child(this._slider.actor);
            break;
        }
        case 'media_player':
            if (c.volume) {
                this._slider = new ManagedSlider(v =>
                    client.callService('media_player', 'volume_set', id, {volume_level: v}));
                this._bottom.add_child(this._slider.actor);
            }
            if (c.playPause) {
                this._playButton = iconButton(this._ctx, 'play-pause', 'Play or pause',
                    () => client.callService('media_player', 'media_play_pause', id));
                this._top.add_child(this._playButton);
            }
            break;
        case 'scene':
        case 'script':
        case 'button':
            this._top.add_child(new St.Icon({
                icon_name: 'media-playback-start-symbolic',
                style_class: 'popup-menu-icon haqs-run-icon',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            break;
        case 'lock':
            this._lockButton = new St.Button({style_class: 'button haqs-text-button', y_align: Clutter.ActorAlign.CENTER, can_focus: true});
            this._lockButton.connect('clicked', () => {
                const locked = client.states.get(id)?.state === 'locked';
                client.callService('lock', locked ? 'unlock' : 'lock', id);
            });
            this._top.add_child(this._lockButton);
            break;
        }

        if (E.isToggleable(id)) {
            this._switch = new StateSwitch(on =>
                client.callService('homeassistant', on ? 'turn_on' : 'turn_off', id));
            this._top.add_child(this._switch.actor);
        }
    }

    // Row click runs the entity's main action without closing the menu
    activate() {
        const {client} = this._ctx;
        const id = this.entityId;
        const st = client.states.get(id);
        if (E.isUnavailable(st) && this._domain !== 'scene')
            return;
        switch (this._domain) {
        case 'scene':
        case 'script':
            client.callService(this._domain, 'turn_on', id);
            break;
        case 'button':
            client.callService('button', 'press', id);
            break;
        case 'cover':
            client.callService('cover', 'toggle', id);
            break;
        default:
            if (E.isToggleable(id)) {
                this._switch.toggle();
            }
        }
    }

    sync() {
        const {client, icons} = this._ctx;
        const id = this.entityId;
        const st = client.states.get(id);
        if (!st)
            return;
        const on = E.isOn(st);
        const unavailable = E.isUnavailable(st);
        const a = st.attributes;

        this._icon.gicon = icons.lookup(E.entityIcon(client, id));
        this._name.text = E.shortName(client, id, this._nameContext);
        this._state.text = E.stateLabel(client, id);
        this[on ? 'add_style_class_name' : 'remove_style_class_name']('haqs-on');
        this[unavailable ? 'add_style_class_name' : 'remove_style_class_name']('haqs-unavailable');

        if (this._switch) {
            this._switch.set(on);
            this._switch.actor.visible = !unavailable;
        }
        if (this._slider) {
            let value = 0;
            switch (this._domain) {
            case 'light': value = on ? (a.brightness ?? 0) / 255 : 0; break;
            case 'fan': value = on ? (a.percentage ?? 0) / 100 : 0; break;
            case 'cover': value = (a.current_position ?? 0) / 100; break;
            case 'media_player': value = a.volume_level ?? 0; break;
            default: {
                const min = a.min ?? 0, max = a.max ?? 100;
                value = max > min ? (parseFloat(st.state) - min) / (max - min) : 0;
            }
            }
            this._slider.set(Number.isFinite(value) ? value : 0);
            this._slider.actor.reactive = !unavailable;
        }
        if (this._lockButton)
            this._lockButton.label = st.state === 'locked' ? 'Unlock' : 'Lock';
        this.colorPanel?.sync();
    }
});
//#endregion Entity row

//#region Headers
// Device name, plus its battery level when the device reports one
export const DeviceHeaderItem = GObject.registerClass(
class DeviceHeaderItem extends PopupMenu.PopupBaseMenuItem {
    constructor(ctx, cluster) {
        super({reactive: false, can_focus: false, style_class: 'haqs-device-header'});
        this._ctx = ctx;
        this.entityId = cluster.battery;
        this.add_child(new St.Label({text: cluster.name, x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        if (cluster.battery) {
            this._batteryIcon = new St.Icon({style_class: 'popup-menu-icon haqs-battery-icon', y_align: Clutter.ActorAlign.CENTER});
            this._batteryLabel = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            this.add_child(this._batteryIcon);
            this.add_child(this._batteryLabel);
        }
        this.sync();
    }

    sync() {
        if (!this.entityId)
            return;
        const {client, icons} = this._ctx;
        this._batteryIcon.gicon = icons.lookup(E.entityIcon(client, this.entityId));
        this._batteryLabel.text = E.stateLabel(client, this.entityId);
    }

    activate() {}
});

// Section title with combined controls; each control only when members support it
export const SectionHeaderItem = GObject.registerClass(
class SectionHeaderItem extends PopupMenu.PopupBaseMenuItem {
    constructor(ctx, section) {
        super({style_class: 'haqs-section-header', can_focus: true});
        this._ctx = ctx;
        const {client} = ctx;
        const ids = section.entities;
        this._toggleIds = ids.filter(E.isToggleable);
        this._dimmableIds = ids.filter(id => E.domainOf(id) === 'light' && E.lightCaps(client.states.get(id)).brightness);
        const colorIds = ids.filter(id => E.domainOf(id) === 'light' && E.lightCaps(client.states.get(id)).color);
        const tempIds = ids.filter(id => E.domainOf(id) === 'light' && E.lightCaps(client.states.get(id)).colorTemp);
        const groupControls = ctx.settings.groupControls;

        this._icon = new St.Icon({gicon: ctx.icons.lookup(section.icon), style_class: 'popup-menu-icon haqs-section-icon', y_align: Clutter.ActorAlign.CENTER});
        this._iconName = section.icon;

        const body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const top = new St.BoxLayout({x_expand: true, style_class: 'haqs-line'});
        const bottom = new St.BoxLayout({x_expand: true, style_class: 'haqs-control-line haqs-section-control-line'});
        top.add_child(this._icon);
        top.add_child(new St.Label({text: section.name, x_expand: true, style_class: 'haqs-section-title', y_align: Clutter.ActorAlign.CENTER}));
        this._summary = new St.Label({style_class: 'haqs-entity-state', y_align: Clutter.ActorAlign.CENTER});
        top.add_child(this._summary);
        body.add_child(top);
        this.add_child(body);

        if (groupControls && this._dimmableIds.length >= 2) {
            this._slider = new ManagedSlider(v =>
                v < 0.01
                    ? client.callService('light', 'turn_off', this._dimmableIds)
                    : client.callService('light', 'turn_on', this._dimmableIds, {brightness_pct: Math.round(v * 100)}));
            bottom.add_child(this._slider.actor);
        }
        if (groupControls && (colorIds.length >= 2 || tempIds.length >= 2)) {
            this.colorPanel = new ColorPanelItem(ctx, {
                colorIds: colorIds.length >= 2 ? colorIds : [],
                tempIds: tempIds.length >= 2 ? tempIds : [],
            });
            bottom.add_child(iconButton(ctx, 'palette', 'Color for the whole section', () => {
                this.colorPanel.visible = !this.colorPanel.visible;
            }));
        }
        if (groupControls && this._toggleIds.length >= 2) {
            this._switch = new StateSwitch(on =>
                client.callService('homeassistant', on ? 'turn_on' : 'turn_off', this._toggleIds));
            top.add_child(this._switch.actor);
        } else {
            this.reactive = false;
            this.can_focus = false;
        }
        if (bottom.get_n_children())
            body.add_child(bottom);
        this.sync();
    }

    activate() {
        if (!this._switch)
            return;
        this._switch.toggle();
    }

    sync() {
        const {client} = this._ctx;
        const onCount = this._toggleIds.filter(id => E.isOn(client.states.get(id))).length;
        this._summary.text = this._toggleIds.length >= 2 ? `${onCount} of ${this._toggleIds.length} on` : '';
        this._switch?.set(onCount > 0);
        if (this._slider) {
            const on = this._dimmableIds.map(id => client.states.get(id)).filter(E.isOn);
            const avg = on.length ? on.reduce((sum, st) => sum + (st.attributes.brightness ?? 0), 0) / on.length / 255 : 0;
            this._slider.set(avg);
        }
        this.colorPanel?.sync();
    }

    refreshIcon() {
        this._icon.gicon = this._ctx.icons.lookup(this._iconName);
    }
});
//#endregion Headers

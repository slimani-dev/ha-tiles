// Pure helpers over HaClient data: capabilities, icons, labels and section membership.
// Shared by the extension and the preferences window.

export const DOMAIN_LABELS = {
    light: 'Lights',
    switch: 'Switches',
    fan: 'Fans',
    cover: 'Covers',
    scene: 'Scenes',
    script: 'Scripts',
    input_boolean: 'Toggles (input_boolean)',
    lock: 'Locks',
    number: 'Numbers',
    input_number: 'Numbers (input_number)',
    media_player: 'Media players',
    climate: 'Climate',
    sensor: 'Sensors',
    binary_sensor: 'Binary sensors',
    automation: 'Automations',
    button: 'Buttons',
};

const TOGGLE_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean', 'automation', 'climate']);
const ON_STATES = new Set(['on', 'open', 'opening', 'unlocked', 'playing', 'home', 'heat', 'cool', 'heat_cool', 'auto', 'dry', 'fan_only']);

export const domainOf = id => id.slice(0, id.indexOf('.'));

export function isUnavailable(st) {
    return !st || st.state === 'unavailable' || st.state === 'unknown';
}

export function isOn(st) {
    return !!st && ON_STATES.has(st.state);
}

export function isToggleable(id) {
    return TOGGLE_DOMAINS.has(domainOf(id));
}

//#region Capabilities
const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];

export function lightCaps(st) {
    const modes = st?.attributes?.supported_color_modes ?? [];
    return {
        brightness: modes.some(m => m !== 'onoff'),
        colorTemp: modes.includes('color_temp'),
        color: modes.some(m => COLOR_MODES.includes(m)),
    };
}

// Capabilities that get a control; group-level controls use the same checks
export function caps(id, st) {
    const domain = domainOf(id);
    const f = st?.attributes?.supported_features ?? 0;
    switch (domain) {
    case 'light':
        return lightCaps(st);
    case 'fan':
        return {brightness: !!(f & 1)}; // SET_SPEED -> percentage slider
    case 'cover':
        return {position: !!(f & 4), open: !!(f & 1), close: !!(f & 2), stop: !!(f & 8)};
    case 'media_player':
        return {volume: !!(f & 4), playPause: !!(f & (1 | 16384))};
    default:
        return {};
    }
}
//#endregion Capabilities

//#region Icons
const COVER_ICONS = {
    garage: ['garage-open', 'garage'],
    blind: ['blinds-open', 'blinds'],
    curtain: ['curtains', 'curtains-closed'],
    shutter: ['window-shutter-open', 'window-shutter'],
    door: ['door-open', 'door-closed'],
    gate: ['gate-open', 'gate'],
};
const SENSOR_ICONS = {
    temperature: 'thermometer', humidity: 'water-percent', power: 'flash', energy: 'lightning-bolt',
    voltage: 'sine-wave', current: 'current-ac', battery: 'battery', illuminance: 'brightness-5',
    pressure: 'gauge', co2: 'molecule-co2', signal_strength: 'wifi',
};
const BINARY_SENSOR_ICONS = {
    door: ['door-open', 'door-closed'], window: ['window-open', 'window-closed'],
    motion: ['motion-sensor', 'motion-sensor-off'], occupancy: ['home-account', 'home-outline'],
    battery_charging: ['battery-charging', 'battery'], plug: ['power-plug', 'power-plug-off'],
    connectivity: ['check-network-outline', 'close-network-outline'], moisture: ['water', 'water-off'],
};

function batteryIcon(level) {
    if (!Number.isFinite(level))
        return 'battery-unknown';
    const step = Math.round(level / 10) * 10;
    if (step >= 100)
        return 'battery';
    if (step <= 0)
        return 'battery-outline';
    return `battery-${step}`;
}

// Icon names are MDI names without the "mdi:" prefix
export function entityIcon(client, id) {
    const st = client.states.get(id);
    const custom = client.entities.get(id)?.icon ?? st?.attributes?.icon;
    if (custom?.startsWith('mdi:'))
        return custom.slice(4);

    const on = isOn(st);
    const dc = st?.attributes?.device_class;
    switch (domainOf(id)) {
    case 'light': return on ? 'lightbulb' : 'lightbulb-outline';
    case 'switch': return dc === 'outlet'
        ? (on ? 'power-plug' : 'power-plug-off')
        : (on ? 'toggle-switch-variant' : 'toggle-switch-variant-off');
    case 'fan': return on ? 'fan' : 'fan-off';
    case 'cover': {
        const [open, closed] = COVER_ICONS[dc] ?? ['window-open', 'window-closed'];
        return on ? open : closed;
    }
    case 'scene': return 'palette';
    case 'script': return 'script-text';
    case 'automation': return on ? 'robot' : 'robot-off';
    case 'input_boolean': return on ? 'toggle-switch-outline' : 'toggle-switch-off-outline';
    case 'lock': return on ? 'lock-open' : 'lock';
    case 'number':
    case 'input_number': return 'ray-vertex';
    case 'media_player': return dc === 'tv' ? 'television' : dc === 'speaker' ? 'speaker' : on ? 'cast-connected' : 'cast';
    case 'climate': return 'thermostat';
    case 'button': return 'gesture-tap-button';
    case 'sensor':
        if (dc === 'battery')
            return batteryIcon(parseFloat(st?.state));
        return SENSOR_ICONS[dc] ?? 'eye';
    case 'binary_sensor': {
        const pair = BINARY_SENSOR_ICONS[dc];
        return pair ? (on ? pair[0] : pair[1]) : (on ? 'checkbox-marked-circle' : 'radiobox-blank');
    }
    default: return 'help-circle-outline';
    }
}

export function areaIconOf(client, areaId) {
    const icon = client.areas.get(areaId)?.icon;
    return icon?.startsWith('mdi:') ? icon.slice(4) : 'texture-box';
}

// Every icon entityIcon() can return without a custom icon; bundled with the extension
export const DEFAULT_ICONS = [
    'lightbulb', 'lightbulb-outline', 'power-plug', 'power-plug-off', 'toggle-switch-variant',
    'toggle-switch-variant-off', 'fan', 'fan-off', 'window-open', 'window-closed', 'palette',
    'script-text', 'robot', 'robot-off', 'toggle-switch-outline', 'toggle-switch-off-outline',
    'lock', 'lock-open', 'ray-vertex', 'television', 'speaker', 'cast', 'cast-connected',
    'thermostat', 'gesture-tap-button', 'eye', 'checkbox-marked-circle', 'radiobox-blank',
    'help-circle-outline', 'texture-box', 'battery', 'battery-outline', 'battery-unknown',
    ...[10, 20, 30, 40, 50, 60, 70, 80, 90].map(n => `battery-${n}`),
    ...Object.values(COVER_ICONS).flat(), ...Object.values(SENSOR_ICONS),
    ...Object.values(BINARY_SENSOR_ICONS).flat(),
    'home-assistant', 'home', 'sofa', 'bed', 'desk', 'stove', 'door-open', 'group',
    // Buttons used by the widgets
    'arrow-up', 'stop', 'arrow-down', 'play-pause', 'open-in-new', 'cog',
];
//#endregion Icons

//#region Labels
const capitalize = s => s ? s[0].toUpperCase() + s.slice(1).replace(/_/g, ' ') : '';

export function friendlyName(client, id) {
    return client.states.get(id)?.attributes?.friendly_name ?? client.entities.get(id)?.name ?? id;
}

// Name shown inside a section: drop the device or area name the section already shows
export function shortName(client, id, context) {
    const full = friendlyName(client, id);
    for (const prefix of context) {
        if (prefix && full.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
            const rest = full.slice(prefix.length + 1).trim();
            if (rest)
                return capitalize(rest);
        }
    }
    return full;
}

export function stateLabel(client, id) {
    const st = client.states.get(id);
    if (!st)
        return '';
    if (st.state === 'unavailable')
        return 'Unavailable';
    const a = st.attributes;
    switch (domainOf(id)) {
    case 'light':
        if (st.state === 'on' && Number.isFinite(a.brightness))
            return `${Math.round(a.brightness / 2.55)}%`;
        break;
    case 'fan':
        if (st.state === 'on' && Number.isFinite(a.percentage))
            return `${a.percentage}%`;
        break;
    case 'cover':
        if (Number.isFinite(a.current_position))
            return `${a.current_position}%`;
        break;
    case 'sensor':
    case 'number':
    case 'input_number': {
        const n = parseFloat(st.state);
        const value = Number.isFinite(n) && !Number.isInteger(n) ? n.toFixed(1) : st.state;
        return a.unit_of_measurement ? `${value} ${a.unit_of_measurement}` : value;
    }
    case 'scene':
    case 'button':
        return '';
    }
    return capitalize(st.state);
}
//#endregion Labels

//#region Sections
export function entityAreaId(client, id) {
    const e = client.entities.get(id);
    if (!e)
        return null;
    return e.areaId ?? client.devices.get(e.deviceId)?.areaId ?? null;
}

function isVisible(client, id, settings) {
    const e = client.entities.get(id);
    if (!client.states.has(id))
        return false;
    if (settings.hiddenEntities.has(id))
        return false;
    if (e?.hidden && !settings.showHaHidden)
        return false;
    if (settings.hideUnavailable && isUnavailable(client.states.get(id)))
        return false;
    return true;
}

//#region Tile button target
// Domains a device or area target switches together
const TARGET_DOMAINS = new Set(['light', 'switch', 'fan', 'input_boolean']);

function targetable(client, id) {
    const e = client.entities.get(id);
    return TARGET_DOMAINS.has(domainOf(id)) && client.states.has(id) && !e?.hidden && !e?.category;
}

// What a tile button switches. target is "area:ID", "device:ID" or an entity id
// (entity ids never contain ':'). Returns {kind, name, areaId, ids} or null.
export function resolveTarget(client, target) {
    if (!target)
        return null;
    if (target.startsWith('area:')) {
        const areaId = target.slice(5);
        return {
            kind: 'area', areaId,
            name: client.areas.get(areaId)?.name ?? areaId,
            ids: [...client.entities.keys()].filter(id => targetable(client, id) && entityAreaId(client, id) === areaId),
        };
    }
    if (target.startsWith('device:')) {
        const deviceId = target.slice(7);
        const device = client.devices.get(deviceId);
        return {
            kind: 'device', areaId: device?.areaId ?? null,
            name: device?.name ?? deviceId,
            ids: deviceEntities(client, deviceId).filter(id => targetable(client, id)),
        };
    }
    return {
        kind: 'entity', areaId: entityAreaId(client, target),
        name: friendlyName(client, target),
        ids: client.states.has(target) ? [target] : [],
    };
}

// Areas and devices that have something to switch, for the tile button list
export function targetCandidates(client) {
    const areas = [...client.areas.keys()]
        .map(areaId => resolveTarget(client, `area:${areaId}`))
        .filter(t => t.ids.length)
        .map(t => ({ref: `area:${t.areaId}`, ...t}));
    const devices = [...client.devices.keys()]
        .map(deviceId => ({ref: `device:${deviceId}`, ...resolveTarget(client, `device:${deviceId}`)}))
        .filter(t => t.ids.length)
        .sort((a, b) => a.name.localeCompare(b.name));
    return {areas, devices};
}
//#endregion Tile button target

// Stable-sort refs by their position in order; refs missing from order keep
// their relative position after the ordered ones
export function orderRefs(refs, order) {
    const index = new Map((order ?? []).map((ref, i) => [ref, i]));
    const unordered = index.size;
    return refs
        .map((ref, i) => [ref, index.get(ref) ?? unordered + i])
        .sort((a, b) => a[1] - b[1])
        .map(([ref]) => ref);
}

// Entities a device brings to a custom group, before the group's exclusions
export function deviceEntities(client, deviceId) {
    const ids = [];
    for (const [id, e] of client.entities) {
        if (e.deviceId === deviceId && !e.category && client.states.has(id))
            ids.push(id);
    }
    return ids.sort((a, b) => friendlyName(client, a).localeCompare(friendlyName(client, b)));
}

// Members of a custom group as "device:ID" / "entity:ID" refs, in the group's order
export function groupMemberRefs(group) {
    const refs = [
        ...(group.devices ?? []).map(id => `device:${id}`),
        ...(group.entities ?? []).map(id => `entity:${id}`),
    ];
    return orderRefs(refs, group.order);
}

function customGroupMembers(client, group) {
    const members = new Set(group.entities ?? []);
    const exclude = new Set(group.exclude ?? []);
    for (const deviceId of group.devices ?? []) {
        for (const id of deviceEntities(client, deviceId)) {
            if (!exclude.has(id))
                members.add(id);
        }
    }
    return members;
}

// All available sections, in display order: HA areas, custom groups, then unassigned
export function allSections(client, groups) {
    const sections = [];
    for (const [areaId, area] of client.areas)
        sections.push({ref: `area:${areaId}`, name: area.name, icon: areaIconOf(client, areaId)});
    for (const g of groups)
        sections.push({ref: `group:${g.id}`, name: g.name || 'Group', icon: g.icon?.replace(/^mdi:/, '') || 'group'});
    sections.push({ref: 'unassigned', name: 'Other', icon: 'home-assistant'});
    return sections;
}

// Resolve a tile's sections to [{ref, name, icon, entities: [id]}], skipping empty ones.
// settings: {groups, domains: Set, hiddenEntities: Set, showHaHidden, hideUnavailable}
export function resolveSections(client, sectionRefs, settings) {
    const claimed = new Set();
    const groupMembers = new Map();
    for (const g of settings.groups) {
        const members = customGroupMembers(client, g);
        groupMembers.set(g.id, members);
        members.forEach(id => claimed.add(id));
    }

    const byRef = new Map(allSections(client, settings.groups).map(s => [s.ref, s]));
    const sortByName = ids => ids.sort((a, b) => friendlyName(client, a).localeCompare(friendlyName(client, b)));
    const areaEntities = areaId => {
        const ids = [];
        for (const id of client.entities.keys()) {
            if (claimed.has(id) || !settings.domains.has(domainOf(id)))
                continue;
            if (client.entities.get(id).category)
                continue;
            if (entityAreaId(client, id) === areaId && isVisible(client, id, settings))
                ids.push(id);
        }
        return sortByName(ids);
    };

    const result = [];
    for (const ref of sectionRefs) {
        const section = byRef.get(ref);
        if (!section)
            continue;
        let entities;
        if (ref.startsWith('area:'))
            entities = areaEntities(ref.slice(5));
        else if (ref === 'unassigned')
            entities = areaEntities(null);
        else
            entities = sortByName([...groupMembers.get(ref.slice(6)) ?? []].filter(id => isVisible(client, id, settings)));
        const group = ref.startsWith('group:') ? settings.groups.find(g => `group:${g.id}` === ref) : null;
        if (entities.length)
            result.push({...section, entities, order: group ? groupMemberRefs(group) : null});
    }
    return result;
}

// A device's battery sensor, usually a diagnostic entity that sections don't list
export function deviceBattery(client, deviceId) {
    for (const [id, e] of client.entities) {
        if (e.deviceId === deviceId && domainOf(id) === 'sensor' &&
            client.states.get(id)?.attributes?.device_class === 'battery')
            return id;
    }
    return null;
}

// Split a section's entities into device clusters so multi-entity devices read as one card.
// order ("device:ID" / "entity:ID" refs) sets the cluster order, e.g. a custom group's.
export function clusterByDevice(client, entities, order = null) {
    const clusters = [];
    const byDevice = new Map();
    for (const id of entities) {
        const deviceId = client.entities.get(id)?.deviceId;
        if (deviceId && !byDevice.has(deviceId)) {
            const cluster = {deviceId, name: client.devices.get(deviceId)?.name ?? '', entities: []};
            byDevice.set(deviceId, cluster);
            clusters.push(cluster);
        }
        if (deviceId)
            byDevice.get(deviceId).entities.push(id);
        else
            clusters.push({deviceId: null, name: '', entities: [id]});
    }
    if (order) {
        const index = new Map(order.map((ref, i) => [ref, i]));
        const rank = c => Math.min(
            index.get(`device:${c.deviceId}`) ?? Infinity,
            ...c.entities.map(id => index.get(`entity:${id}`) ?? Infinity));
        clusters.sort((a, b) => rank(a) - rank(b));
    }
    // Single-entity devices don't need a device header
    return clusters.map(c => c.entities.length > 1
        ? {...c, battery: deviceBattery(client, c.deviceId)}
        : {...c, deviceId: null, name: ''});
}
//#endregion Sections

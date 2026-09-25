// Home Assistant WebSocket client, shared by the extension and the preferences window.
//
// One connection carries everything: authentication, the registries (areas,
// devices, entities), a subscription to every entity's state, registry update
// events, and service calls. The connection reconnects with backoff and uses
// application-level pings to notice dead connections (e.g. after suspend).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Soup from 'gi://Soup?version=3.0';

export const State = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    AUTH_FAILED: 'auth-failed',
    DISCONNECTED: 'disconnected',
};

const CALL_TIMEOUT_S = 15;
const PING_INTERVAL_S = 30;
const PONG_TIMEOUT_S = 10;
const MAX_BACKOFF_S = 30;
const REGISTRY_EVENTS = ['area_registry_updated', 'device_registry_updated', 'entity_registry_updated'];

export function websocketUrl(url) {
    let base = url.trim().replace(/\/+$/, '');
    if (!/^[a-z]+:\/\//i.test(base))
        base = `http://${base}`;
    return `${base.replace(/^http/i, 'ws')}/api/websocket`;
}

export const HaClient = GObject.registerClass({
    GTypeName: 'HaTilesClient',
    Properties: {
        'state': GObject.ParamSpec.string('state', null, null,
            GObject.ParamFlags.READABLE, State.IDLE),
    },
    Signals: {
        // Array of changed entity ids
        'states-changed': {param_types: [GObject.TYPE_JSOBJECT]},
        'registry-changed': {},
    },
}, class HaClient extends GObject.Object {
    constructor({subscribe = true, log = null} = {}) {
        super();
        this._subscribe = subscribe;
        this._log = log ?? (() => {});
        this._state = State.IDLE;
        this._session = new Soup.Session({timeout: 20});
        this._pending = new Map();
        this._nextId = 1;
        this._backoff = 1;

        this.states = new Map();   // entity_id -> {state, attributes}
        this.areas = new Map();    // area_id -> {name, icon}  (HA order)
        this.devices = new Map();  // device_id -> {name, areaId}
        this.entities = new Map(); // entity_id -> {areaId, deviceId, icon, hidden, category, name}
        this.config = null;
        this.registryLoaded = false;

        this._network = Gio.NetworkMonitor.get_default();
        this._networkId = this._network.connect('network-changed', (_m, available) => {
            if (available && this._url && this._state !== State.CONNECTED && this._state !== State.AUTH_FAILED)
                this._reconnectNow();
        });
    }

    get state() {
        return this._state;
    }

    _setState(state) {
        if (this._state === state)
            return;
        this._state = state;
        this.notify('state');
    }

    configure(url, token) {
        if (url === this._url && token === this._token && this._state !== State.IDLE)
            return;
        this._url = url;
        this._token = token;
        this._teardown();
        this._backoff = 1;
        if (url && token)
            this._connect();
        else
            this._setState(State.IDLE);
    }

    // Resolves once connected and the registries are loaded; rejects on auth failure or timeout.
    whenReady(timeoutS = 10) {
        if (this._state === State.CONNECTED && this.registryLoaded)
            return Promise.resolve();
        return new Promise((resolve, reject) => {
            const done = err => {
                this.disconnect(stateId);
                this.disconnect(regId);
                GLib.Source.remove(timer);
                err ? reject(err) : resolve();
            };
            const stateId = this.connect('notify::state', () => {
                if (this._state === State.AUTH_FAILED)
                    done(new Error(this._authMessage || 'Authentication failed'));
            });
            const regId = this.connect('registry-changed', () => done());
            const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutS, () => {
                done(new Error(this._lastError || 'Timed out connecting to Home Assistant'));
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    //#region Connection
    _connect() {
        this._setState(State.CONNECTING);
        // Returns null for an invalid URL
        const msg = Soup.Message.new('GET', websocketUrl(this._url));
        if (!msg) {
            this._lastError = 'Invalid Home Assistant URL';
            this._setState(State.DISCONNECTED);
            return;
        }

        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        this._session.websocket_connect_async(msg, null, null, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
            let conn;
            try {
                conn = session.websocket_connect_finish(res);
            } catch (e) {
                if (cancellable.is_cancelled())
                    return;
                this._lastError = e.message;
                this._log(`Connection failed: ${e.message}`);
                this._scheduleReconnect();
                return;
            }
            if (cancellable.is_cancelled()) {
                conn.close(Soup.WebsocketCloseCode.NORMAL, null);
                return;
            }
            this._conn = conn;
            conn.max_incoming_payload_size = 0; // full state dumps exceed the 128 KiB default
            this._connIds = [
                conn.connect('message', (_c, _type, bytes) => this._onMessage(bytes)),
                conn.connect('closed', () => this._onClosed()),
                conn.connect('error', (_c, err) => {
                    this._lastError = err.message;
                    this._log(`WebSocket error: ${err.message}`);
                }),
            ];
        });
    }

    _onClosed() {
        this._log('Connection closed');
        this._dropConnection();
        if (this._state !== State.AUTH_FAILED)
            this._scheduleReconnect();
    }

    _scheduleReconnect() {
        this._dropConnection();
        this._setState(State.DISCONNECTED);
        if (this._reconnectId || !this._url)
            return;
        const delay = this._backoff;
        this._backoff = Math.min(this._backoff * 2, MAX_BACKOFF_S);
        this._reconnectId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._reconnectId = 0;
            this._connect();
            return GLib.SOURCE_REMOVE;
        });
    }

    _reconnectNow() {
        this._teardown();
        this._backoff = 1;
        this._connect();
    }

    _dropConnection() {
        if (this._pingId) {
            GLib.Source.remove(this._pingId);
            this._pingId = 0;
        }
        if (this._pongTimeoutId) {
            GLib.Source.remove(this._pongTimeoutId);
            this._pongTimeoutId = 0;
        }
        if (this._registryReloadId) {
            GLib.Source.remove(this._registryReloadId);
            this._registryReloadId = 0;
        }
        if (this._conn) {
            this._connIds.forEach(id => this._conn.disconnect(id));
            if (this._conn.get_state() === Soup.WebsocketState.OPEN)
                this._conn.close(Soup.WebsocketCloseCode.NORMAL, null);
            this._conn = null;
        }
        for (const {reject, timer} of this._pending.values()) {
            GLib.Source.remove(timer);
            reject(new Error('Disconnected'));
        }
        this._pending.clear();
        this._entitySubId = null;
        this._registrySubIds = new Set();
    }

    _teardown() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._reconnectId) {
            GLib.Source.remove(this._reconnectId);
            this._reconnectId = 0;
        }
        this._dropConnection();
    }

    destroy() {
        this._teardown();
        this._url = null;
        if (this._networkId) {
            this._network.disconnect(this._networkId);
            this._networkId = 0;
        }
    }
    //#endregion Connection

    //#region Messages
    _send(obj) {
        this._conn?.send_text(JSON.stringify(obj));
    }

    _onMessage(bytes) {
        let msg;
        try {
            msg = JSON.parse(new TextDecoder().decode(bytes.toArray()));
        } catch (e) {
            this._log(`Invalid message: ${e.message}`);
            return;
        }
        // HA may batch messages into an array when coalescing is enabled
        for (const m of Array.isArray(msg) ? msg : [msg])
            this._handle(m);
    }

    _handle(msg) {
        switch (msg.type) {
        case 'auth_required':
            this._send({type: 'auth', access_token: this._token});
            break;
        case 'auth_ok':
            this._onAuthenticated(msg);
            break;
        case 'auth_invalid':
            this._authMessage = msg.message;
            this._log(`Authentication failed: ${msg.message}`);
            this._setState(State.AUTH_FAILED);
            this._teardown();
            break;
        case 'result': {
            const pending = this._pending.get(msg.id);
            if (!pending)
                break;
            this._pending.delete(msg.id);
            GLib.Source.remove(pending.timer);
            if (msg.success)
                pending.resolve(msg.result);
            else
                pending.reject(new Error(msg.error?.message ?? 'Request failed'));
            break;
        }
        case 'event':
            if (msg.id === this._entitySubId)
                this._applyEntityEvent(msg.event);
            else if (this._registrySubIds.has(msg.id))
                this._queueRegistryReload();
            break;
        case 'pong':
            if (this._pongTimeoutId) {
                GLib.Source.remove(this._pongTimeoutId);
                this._pongTimeoutId = 0;
            }
            break;
        }
    }

    call(payload) {
        if (!this._conn)
            return Promise.reject(new Error('Not connected'));
        const id = this._nextId++;
        return new Promise((resolve, reject) => {
            const timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CALL_TIMEOUT_S, () => {
                this._pending.delete(id);
                reject(new Error(`Request timed out: ${payload.type}`));
                return GLib.SOURCE_REMOVE;
            });
            this._pending.set(id, {resolve, reject, timer});
            this._send({id, ...payload});
        });
    }

    callService(domain, service, entityIds, data = {}) {
        const ids = Array.isArray(entityIds) ? entityIds : [entityIds];
        return this.call({
            type: 'call_service', domain, service,
            service_data: data,
            target: {entity_id: ids},
        }).catch(e => this._log(`${domain}.${service} failed: ${e.message}`));
    }
    //#endregion Messages

    //#region Session setup
    async _onAuthenticated(msg) {
        this._log(`Connected to Home Assistant ${msg.ha_version}`);
        this._backoff = 1;
        this._lastError = null;
        this._registrySubIds = new Set();
        this._startPing();

        try {
            this.config = await this.call({type: 'get_config'});
            await this._loadRegistries();
            if (this._subscribe) {
                for (const eventType of REGISTRY_EVENTS) {
                    const id = this._nextId;
                    this._registrySubIds.add(id);
                    await this.call({type: 'subscribe_events', event_type: eventType});
                }
                this._entitySubId = this._nextId;
                await this.call({type: 'subscribe_entities'});
            } else {
                const states = await this.call({type: 'get_states'});
                this.states.clear();
                for (const s of states)
                    this.states.set(s.entity_id, {state: s.state, attributes: s.attributes});
            }
            this._setState(State.CONNECTED);
            this.emit('registry-changed');
        } catch (e) {
            this._log(`Session setup failed: ${e.message}`);
            this._lastError = e.message;
            this._scheduleReconnect();
        }
    }

    _startPing() {
        this._pingId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PING_INTERVAL_S, () => {
            if (this._pongTimeoutId)
                return GLib.SOURCE_CONTINUE;
            this._send({id: this._nextId++, type: 'ping'});
            this._pongTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, PONG_TIMEOUT_S, () => {
                this._pongTimeoutId = 0;
                this._log('No pong received, reconnecting');
                this._reconnectNow();
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _loadRegistries() {
        const [areas, devices, display] = await Promise.all([
            this.call({type: 'config/area_registry/list'}),
            this.call({type: 'config/device_registry/list'}),
            this.call({type: 'config/entity_registry/list_for_display'}),
        ]);

        this.areas = new Map(areas.map(a => [a.area_id, {name: a.name, icon: a.icon ?? null}]));
        this.devices = new Map(devices.map(d => [d.id, {
            name: d.name_by_user || d.name || '',
            areaId: d.area_id ?? null,
        }]));
        this.entities = new Map(display.entities.map(e => [e.ei, {
            areaId: e.ai ?? null,
            deviceId: e.di ?? null,
            icon: e.ic ?? null,
            hidden: !!e.hb,
            category: e.ec ?? null,
            name: e.en ?? null,
        }]));
        this.registryLoaded = true;
    }

    _queueRegistryReload() {
        if (this._registryReloadId)
            return;
        // Registry events arrive in bursts; reload once they settle
        this._registryReloadId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            this._registryReloadId = 0;
            this._loadRegistries()
                .then(() => this.emit('registry-changed'))
                .catch(e => this._log(`Registry reload failed: ${e.message}`));
            return GLib.SOURCE_REMOVE;
        });
    }

    // subscribe_entities sends compressed events:
    //   a: {id: {s, a}}                  full state (initial dump and new entities)
    //   c: {id: {'+': {s, a}, '-': {a}}} changes
    //   r: [id]                          removed entities
    _applyEntityEvent(event) {
        const changed = [];
        for (const [id, s] of Object.entries(event.a ?? {})) {
            this.states.set(id, {state: s.s, attributes: s.a ?? {}});
            changed.push(id);
        }
        for (const [id, diff] of Object.entries(event.c ?? {})) {
            const cur = this.states.get(id);
            if (!cur)
                continue;
            const plus = diff['+'] ?? {};
            if ('s' in plus)
                cur.state = plus.s;
            if (plus.a)
                Object.assign(cur.attributes, plus.a);
            for (const key of diff['-']?.a ?? [])
                delete cur.attributes[key];
            changed.push(id);
        }
        for (const id of event.r ?? []) {
            this.states.delete(id);
            changed.push(id);
        }
        if (changed.length)
            this.emit('states-changed', changed);
    }
    //#endregion Session setup
});

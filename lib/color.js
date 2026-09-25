// Color wheel (hue/saturation) and color temperature bar, drawn with cairo.
// Picked values come from the pointer position, not from reading screen pixels.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Cairo from 'cairo';

export function hsvToRgb(h, s, v) {
    const f = n => {
        const k = (n + h / 60) % 6;
        return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return [f(5), f(3), f(1)];
}

// Approximate sRGB of black-body radiation (Tanner Helland), components 0..1
export function kelvinToRgb(kelvin) {
    const t = kelvin / 100;
    const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
    const g = t <= 66
        ? 99.4708025861 * Math.log(t) - 161.1195681661
        : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
    return [r, g, b].map(c => Math.min(255, Math.max(0, c)) / 255);
}

function localCoords(actor, event) {
    const [x, y] = event.get_coords();
    const [ax, ay] = actor.get_transformed_position();
    return [x - ax, y - ay];
}

// Emits 'picked' (hue 0..360, saturation 0..100)
export const ColorWheel = GObject.registerClass({
    Signals: {'picked': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]}},
}, class ColorWheel extends St.DrawingArea {
    constructor(size = 150) {
        super({
            style_class: 'haqs-color-wheel',
            width: size, height: size,
            reactive: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._marker = null;
    }

    setColor(hs) {
        this._marker = hs ? [hs[0], hs[1] / 100] : null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 2;

        for (let deg = 0; deg < 360; deg += 2) {
            cr.moveTo(cx, cy);
            cr.arc(cx, cy, r, (deg - 1.5) * Math.PI / 180, (deg + 2.5) * Math.PI / 180);
            cr.closePath();
            const [red, green, blue] = hsvToRgb(deg, 1, 1);
            const gradient = new Cairo.RadialGradient(cx, cy, 0, cx, cy, r);
            gradient.addColorStopRGB(0, 1, 1, 1);
            gradient.addColorStopRGB(1, red, green, blue);
            cr.setSource(gradient);
            cr.fill();
        }

        if (this._marker) {
            const [hue, sat] = this._marker;
            const a = hue * Math.PI / 180;
            drawMarker(cr, cx + Math.cos(a) * r * sat, cy + Math.sin(a) * r * sat);
        }
        cr.$dispose();
    }

    vfunc_button_release_event(event) {
        const [x, y] = localCoords(this, event);
        const cx = this.width / 2, cy = this.height / 2, r = Math.min(cx, cy) - 2;
        const hue = (Math.atan2(y - cy, x - cx) * 180 / Math.PI + 360) % 360;
        const sat = Math.min(1, Math.hypot(x - cx, y - cy) / r) * 100;
        this.setColor([hue, sat]);
        this.emit('picked', hue, sat);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_press_event() {
        return Clutter.EVENT_STOP;
    }
});

// Emits 'picked' (kelvin)
export const TemperatureBar = GObject.registerClass({
    Signals: {'picked': {param_types: [GObject.TYPE_DOUBLE]}},
}, class TemperatureBar extends St.DrawingArea {
    constructor(minK = 2000, maxK = 6500) {
        super({
            style_class: 'haqs-temperature-bar',
            height: 22,
            x_expand: true,
            reactive: true,
        });
        this.setRange(minK, maxK);
        this._kelvin = null;
    }

    setRange(minK, maxK) {
        this._min = minK || 2000;
        this._max = maxK && maxK > this._min ? maxK : 6500;
        this.queue_repaint();
    }

    setKelvin(kelvin) {
        this._kelvin = kelvin ?? null;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        const radius = h / 2;

        const gradient = new Cairo.LinearGradient(0, 0, w, 0);
        for (let i = 0; i <= 8; i++) {
            const [r, g, b] = kelvinToRgb(this._min + (this._max - this._min) * i / 8);
            gradient.addColorStopRGB(i / 8, r, g, b);
        }
        cr.newSubPath();
        cr.arc(w - radius, radius, radius, -Math.PI / 2, Math.PI / 2);
        cr.arc(radius, radius, radius, Math.PI / 2, 3 * Math.PI / 2);
        cr.closePath();
        cr.setSource(gradient);
        cr.fill();

        if (this._kelvin) {
            const pos = (this._kelvin - this._min) / (this._max - this._min);
            drawMarker(cr, radius + Math.min(1, Math.max(0, pos)) * (w - 2 * radius), h / 2);
        }
        cr.$dispose();
    }

    vfunc_button_release_event(event) {
        const [x] = localCoords(this, event);
        const pos = Math.min(1, Math.max(0, x / this.width));
        const kelvin = Math.round(this._min + pos * (this._max - this._min));
        this.setKelvin(kelvin);
        this.emit('picked', kelvin);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_press_event() {
        return Clutter.EVENT_STOP;
    }
});

function drawMarker(cr, x, y) {
    cr.arc(x, y, 6, 0, 2 * Math.PI);
    cr.setSourceRGBA(1, 1, 1, 1);
    cr.setLineWidth(2.5);
    cr.strokePreserve();
    cr.setSourceRGBA(0, 0, 0, 0.35);
    cr.setLineWidth(1);
    cr.stroke();
}

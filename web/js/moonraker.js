// Moonraker JSON-RPC over the websocket nginx proxies at /websocket.
// Keeps one merged copy of the subscribed Klipper objects in `printer`
// and tells listeners when it changes.

const OBJECTS = {
  webhooks: null, print_stats: null, virtual_sdcard: null, display_status: null,
  toolhead: null, gcode_move: null, extruder: null, heater_bed: null, fan: null,
  idle_timeout: null, pause_resume: null, z_guard: null, bed_mesh: null,
  exclude_object: null, motion_report: ['live_position', 'live_velocity'],
  probe: ['last_query', 'last_z_result'], manual_probe: null, configfile: ['save_config_pending'],
};

export class Moonraker extends EventTarget {
  constructor() {
    super();
    this.printer = {};          // merged Klipper object state
    this.klippy = 'disconnected';
    this.klippyMessage = '';
    this.connected = false;
    this.nextId = 1;
    this.pending = new Map();
    this.connect();
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  on(type, fn) { this.addEventListener(type, (e) => fn(e.detail)); }

  connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/websocket`);
    this.ws = ws;
    ws.onopen = async () => {
      this.connected = true;
      this.emit('connection', true);
      try {
        await this.call('server.connection.identify', {
          client_name: 'Ender Studio', version: '1.0', type: 'web', url: location.href });
      } catch (e) { /* older Moonraker */ }
      this.refreshKlippy();
    };
    ws.onclose = () => {
      this.connected = false;
      this.klippy = 'disconnected';
      for (const { reject } of this.pending.values()) reject(new Error('Connection lost'));
      this.pending.clear();
      this.emit('connection', false);
      this.emit('klippy', this.klippy);
      setTimeout(() => this.connect(), 2000);
    };
    ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
  }

  call(method, params = {}, timeout = 0) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Not connected to the Pi'));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
      if (timeout) setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, timeout);
    });
  }

  // Run G-code. Long commands (G28, PID, mesh) resolve when Klipper finishes.
  gcode(script) { return this.call('printer.gcode.script', { script }); }

  onMessage(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'Request failed'));
      else resolve(msg.result);
      return;
    }
    const p = msg.params;
    switch (msg.method) {
      case 'notify_status_update': this.merge(p[0]); break;
      case 'notify_gcode_response': this.emit('gcode', p[0]); break;
      case 'notify_klippy_ready': this.refreshKlippy(); break;
      case 'notify_klippy_shutdown': this.refreshKlippy(); break;
      case 'notify_klippy_disconnected':
        this.klippy = 'disconnected'; this.klippyMessage = 'Klipper is restarting…';
        this.emit('klippy', this.klippy); setTimeout(() => this.refreshKlippy(), 2000); break;
      case 'notify_filelist_changed': this.emit('files', p[0]); break;
      case 'notify_history_changed': this.emit('history', p[0]); break;
      case 'notify_job_queue_changed': this.emit('queue', p[0]); break;
      case 'notify_proc_stat_update': this.emit('procstat', p[0]); break;
    }
  }

  merge(status) {
    for (const [k, v] of Object.entries(status)) {
      this.printer[k] = Object.assign(this.printer[k] || {}, v);
    }
    this.emit('status', status);
  }

  async refreshKlippy() {
    clearTimeout(this.klippyTimer);
    try {
      const info = await this.call('printer.info');
      this.klippy = info.state;
      this.klippyMessage = info.state_message;
      if (info.state === 'ready') {
        const avail = await this.call('printer.objects.list');
        const objs = {};
        for (const [k, v] of Object.entries(OBJECTS)) if (avail.objects.includes(k)) objs[k] = v;
        // Every [gcode_macro] so the Control page can offer them.
        this.macros = avail.objects.filter((o) => o.startsWith('gcode_macro '))
          .map((o) => o.slice(12)).filter((m) => !m.startsWith('_'));
        const res = await this.call('printer.objects.subscribe', { objects: objs });
        this.printer = {};
        this.merge(res.status);
      } else {
        this.klippyTimer = setTimeout(() => this.refreshKlippy(), 3000);
      }
    } catch (e) {
      this.klippy = 'disconnected';
      this.klippyMessage = 'Klipper is not running';
      this.klippyTimer = setTimeout(() => this.refreshKlippy(), 3000);
    }
    this.emit('klippy', this.klippy);
  }

  get ready() { return this.klippy === 'ready'; }
  get printState() { return this.printer.print_stats?.state || 'standby'; }
  get busy() { return ['printing', 'paused'].includes(this.printState); }

  async upload(file, root = 'gcodes', name = file.name) {
    const fd = new FormData();
    fd.append('file', file, name);
    fd.append('root', root);
    const r = await fetch('/server/files/upload', { method: 'POST', body: fd });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    return r.json();
  }

  fileUrl(root, path) {
    return `/server/files/${root}/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
}

export const mr = new Moonraker();

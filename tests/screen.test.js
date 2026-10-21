'use strict';
// Coverage for pure helpers in screen.js: WS URL building, arrangement
// resolution/defaulting, panel-prefs snapshot/migration, range clamping.
// Runs under the org reusable CI as `node tests/screen.test.js`.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

function makeLocalStorage() {
    const store = new Map();
    return {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
    };
}

function freshPlugin({ search = '', protocol = 'http:' } = {}) {
    const location = { search, host: 'localhost:8420', protocol };
    global.window = { location, addEventListener: () => {} };
    global.document = {
        getElementById: () => null,
        addEventListener: () => {},
        body: { appendChild: () => {} },
        createElement: () => ({
            style: {}, classList: { add() {}, remove() {} },
            addEventListener() {}, appendChild() {}, setAttribute() {},
        }),
        readyState: 'loading',
    };
    global.localStorage = makeLocalStorage();
    global.location = location;
    const file = path.join(__dirname, '..', 'screen.js');
    delete require.cache[require.resolve(file)];
    return require(file);
}

test('getWsUrl decodes percent-encoded filenames and builds a ws:// URL', () => {
    const { getWsUrl } = freshPlugin();
    assert.equal(
        getWsUrl('sloppak%2Fperfouts.sloppak', 0),
        'ws://localhost:8420/ws/highway/sloppak/perfouts.sloppak?arrangement=0');
});

test('getWsUrl omits the arrangement param when undefined', () => {
    const { getWsUrl } = freshPlugin();
    assert.equal(getWsUrl('song.sloppak'), 'ws://localhost:8420/ws/highway/song.sloppak');
});

test('getWsUrl uses wss:// under https', () => {
    const { getWsUrl } = freshPlugin({ protocol: 'https:' });
    assert.match(getWsUrl('a.sloppak', 1), /^wss:\/\//);
});

test('resolveArrIndex is case-insensitive and finds by name', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Rhythm' }, { name: 'Bass' }]);
    assert.equal(mod.resolveArrIndex('rhythm'), 1);
    assert.equal(mod.resolveArrIndex('BASS'), 2);
    assert.equal(mod.resolveArrIndex('nope'), -1);
});

test('resolveArrIndex treats special modes as non-arrangements', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    assert.equal(mod.resolveArrIndex(''), -1);
    assert.equal(mod.resolveArrIndex(null), -1);
    assert.equal(mod.resolveArrIndex('__lyrics__'), -1); // LYRICS_VALUE sentinel used at runtime; harmless if it isn't this literal
});

test('getDefaultArrangements prioritizes lead/rhythm/bass then fills and wraps', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([
        { name: 'Bass Guitar' }, { name: 'Rhythm Guitar' }, { name: 'Lead Guitar' }, { name: 'Extra' },
    ]);
    // indices: 0=bass, 1=rhythm, 2=lead, 3=extra
    assert.deepEqual(mod.getDefaultArrangements(2), [2, 1]); // lead, rhythm
    assert.deepEqual(mod.getDefaultArrangements(4), [2, 1, 0, 3]); // lead, rhythm, bass, extra
    assert.deepEqual(mod.getDefaultArrangements(5), [2, 1, 0, 3, 2]); // wraps around
});

test('getDefaultArrangements falls back to arrangement order with no named matches', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Arr A' }, { name: 'Arr B' }]);
    assert.deepEqual(mod.getDefaultArrangements(2), [0, 1]);
});

test('_ctlRange fills defaults for missing/non-finite bounds', () => {
    const { _ctlRange } = freshPlugin();
    assert.deepEqual(_ctlRange({}), { lo: 0, hi: 1, st: 0.05 });
    assert.deepEqual(_ctlRange({ min: -1, max: 2, step: 0.1 }), { lo: -1, hi: 2, st: 0.1 });
    assert.deepEqual(_ctlRange({ min: NaN, max: Infinity }), { lo: 0, hi: 1, st: 0.05 });
});

// Per-panel controls must use the renderer's effective value and scoped writer:
// the inherited camera lead can differ from the descriptor's default.
const cameraStartControl = {
    key: 'stableCameraStartBeforeMs', type: 'range', default: 700, min: 25, max: 3000,
};

function installPanelFactory(properties, { legacy = false } = {}) {
    const factory = Object.assign(function () {}, {
        panelControls: [cameraStartControl], ...properties,
    });
    global.window[legacy ? 'slopsmithViz_highway_3d' : 'feedBackViz_highway_3d'] = factory;
    return factory;
}

test('panel reads use the renderer bridge instead of stale storage/defaults', () => {
    const { _vizPanelGet } = freshPlugin();
    global.localStorage.setItem('h3d_bg_stableCameraStartBeforeMs', '900');
    const calls = [];
    installPanelFactory({ getPanelSetting: (index, key) => { calls.push([index, key]); return 400; } });
    assert.equal(_vizPanelGet('highway_3d', 1, cameraStartControl), 400);
    assert.deepEqual(calls, [[1, cameraStartControl.key]]);
});

test('panel writes preserve the value type and never invoke a global setter', () => {
    const { _vizPanelSet } = freshPlugin();
    const calls = [];
    const controls = [cameraStartControl, { key: 'stableCameraFollow', type: 'toggle', default: true }];
    installPanelFactory({ panelControls: controls, setPanelSetting: (...args) => { calls.push(args); return true; } });
    let globalWrites = 0;
    global.window.h3dBgSetStableCameraStartBeforeMs = () => { globalWrites++; };
    global.window.h3dBgSetStableCameraFollow = () => { globalWrites++; };
    assert.equal(_vizPanelSet('highway_3d', 0, controls[0], 600), true);
    assert.equal(_vizPanelSet('highway_3d', 1, controls[1], false), true);
    assert.deepEqual(calls, [[0, controls[0].key, 600], [1, controls[1].key, false]]);
    assert.equal(global.localStorage.getItem('h3d_bg_panel0_' + controls[0].key), null);
    assert.equal(global.localStorage.getItem('h3d_bg_panel1_' + controls[1].key), null);
    assert.equal(globalWrites, 0);
});

test('the canonical factory bridge wins when both factory names exist', () => {
    const { _vizPanelGet, _vizPanelSet } = freshPlugin();
    installPanelFactory({ getPanelSetting: () => 400, setPanelSetting: () => true });
    installPanelFactory({
        getPanelSetting: () => assert.fail('legacy getter called'),
        setPanelSetting: () => assert.fail('legacy setter called'),
    }, { legacy: true });
    assert.equal(_vizPanelGet('highway_3d', 0, cameraStartControl), 400);
    assert.equal(_vizPanelSet('highway_3d', 0, cameraStartControl, 600), true);
});

test('a legacy-named factory can expose the scoped bridge', () => {
    const { _vizPanelGet, _vizPanelSet } = freshPlugin();
    const calls = [];
    const toggle = { key: 'stableCameraFollow', type: 'toggle', default: true };
    installPanelFactory({
        panelControls: [toggle],
        getPanelSetting: () => false,
        setPanelSetting: (...args) => { calls.push(args); return true; },
    }, { legacy: true });
    assert.equal(_vizPanelGet('highway_3d', 2, toggle), false);
    assert.equal(_vizPanelSet('highway_3d', 2, toggle, false), true);
    assert.deepEqual(calls, [[2, toggle.key, false]]);
});

test('invalid panel indices and controls neither call the bridge nor write storage', () => {
    const { _vizPanelGet, _vizPanelSet } = freshPlugin();
    installPanelFactory({
        getPanelSetting: () => assert.fail('invalid get forwarded'),
        setPanelSetting: () => assert.fail('invalid set forwarded'),
    });
    global.localStorage.setItem = () => assert.fail('invalid storage write');
    for (const index of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null, undefined]) {
        assert.equal(_vizPanelGet('highway_3d', index, cameraStartControl), undefined);
        assert.equal(_vizPanelSet('highway_3d', index, cameraStartControl, 600), false);
    }
    assert.equal(_vizPanelGet('other', 0, cameraStartControl), undefined);
    assert.equal(_vizPanelSet('other', 0, cameraStartControl, 600), false);
    assert.equal(_vizPanelGet('highway_3d', 0, { key: 'unexposed' }), undefined);
    assert.equal(_vizPanelSet('highway_3d', 0, { key: 'unexposed' }, 600), false);
});

test('bridge rejections and exceptions do not fall back to raw storage writes', () => {
    const { _vizPanelGet, _vizPanelSet } = freshPlugin();
    const factory = installPanelFactory({ getPanelSetting: () => undefined, setPanelSetting: () => false });
    global.localStorage.setItem = () => assert.fail('rejected write fell through');
    assert.equal(_vizPanelGet('highway_3d', 0, cameraStartControl), undefined);
    assert.equal(_vizPanelSet('highway_3d', 0, cameraStartControl, 600), false);
    factory.getPanelSetting = factory.setPanelSetting = () => { throw new Error('unavailable'); };
    assert.equal(_vizPanelGet('highway_3d', 0, cameraStartControl), undefined);
    assert.equal(_vizPanelSet('highway_3d', 0, cameraStartControl, 600), false);
});

test('legacy storage-only writes stay scoped and cannot reset another panel lead', () => {
    const { _vizPanelGet, _vizPanelSet } = freshPlugin();
    installPanelFactory({});
    global.localStorage.setItem('h3d_bg_stableCameraPreparationMs', '400');
    global.localStorage.setItem('h3d_bg_panel1_stableCameraStartBeforeMs', '450');
    global.window.h3dBgSetStableCameraStartBeforeMs = value =>
        global.localStorage.setItem('h3d_bg_stableCameraStartBeforeMs', value);
    assert.equal(_vizPanelSet('highway_3d', 0, cameraStartControl, 600), true);
    assert.equal(_vizPanelGet('highway_3d', 0, cameraStartControl), 600);
    assert.equal(global.localStorage.getItem('h3d_bg_stableCameraStartBeforeMs'), null);
    assert.equal(global.localStorage.getItem('h3d_bg_stableCameraPreparationMs'), '400');
    assert.equal(global.localStorage.getItem('h3d_bg_panel1_stableCameraStartBeforeMs'), '450');
});

test('legacy fallback retains toggle/range coercion and reports blocked writes', () => {
    const { _vizPanelGet, _vizPanelSet } = freshPlugin();
    const toggle = { key: 'cameraLockLow', type: 'toggle', default: false };
    const range = { key: 'cameraSmoothing', type: 'range', default: 0.5 };
    global.localStorage.setItem('h3d_bg_cameraLockLow', 'false');
    global.localStorage.setItem('h3d_bg_cameraSmoothing', '2');
    assert.equal(_vizPanelGet('highway_3d', 0, toggle), false);
    assert.equal(_vizPanelGet('highway_3d', 0, range), 1);
    global.localStorage.setItem('h3d_bg_panel0_cameraSmoothing', 'invalid');
    assert.equal(_vizPanelGet('highway_3d', 0, range), 0.5);
    global.localStorage.setItem = () => { throw new Error('storage blocked'); };
    assert.equal(_vizPanelSet('highway_3d', 0, range, 0.6), false);
});

test('panelToPrefs encodes a plain arrangement panel', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0,
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0.5 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, 'Lead');
    assert.equal(prefs.inverted, false);
    assert.equal(prefs.mastery, 0.5);
    assert.equal(prefs.barHidden, false);
});

test('panelToPrefs encodes lyrics mode', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }]);
    const panel = {
        arrIndex: 0, lyricsMode: true, lyricsOverlayOn: true,
        hw: { getInverted: () => true, getLefty: () => true, getMastery: () => 0 },
        bar: { style: { display: 'none' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__lyrics__'); // LYRICS_VALUE sentinel captured verbatim
    assert.equal(prefs.lyrics, true);
    assert.equal(prefs.barHidden, true);
});

test('panelToPrefs encodes viz mode with the underlying arrangement name', () => {
    const mod = freshPlugin();
    mod._setArrangementsForTest([{ name: 'Lead' }, { name: 'Bass' }]);
    const panel = {
        arrIndex: 1, vizMode: 'highway_3d',
        hw: { getInverted: () => false, getLefty: () => false, getMastery: () => 0 },
        bar: { style: { display: '' } },
    };
    const prefs = mod.panelToPrefs(panel);
    assert.equal(prefs.arrName, '__viz__:highway_3d:Bass');
});

test('migratePanelPrefs passes through non-array input unchanged', () => {
    const { migratePanelPrefs } = freshPlugin();
    assert.equal(migratePanelPrefs(null), null);
    assert.equal(migratePanelPrefs('nope'), 'nope');
});

test('migratePanelPrefs resets lyrics on first migration (v<2) and preserves other fields', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: 'Lead', lyrics: true, inverted: true }]);
    assert.equal(out[0].lyrics, false);
    assert.equal(out[0].inverted, true);
});

test('migratePanelPrefs migrates the legacy 3D-highway sentinel prefix', () => {
    const { migratePanelPrefs } = freshPlugin();
    const out = migratePanelPrefs([{ arrName: '__3d_highway__:Lead', lyrics: false }]);
    assert.equal(out[0].arrName, '__viz__:highway_3d:Lead');
});

test('migratePanelPrefs does not reset lyrics once already migrated to v2', () => {
    global.location = { search: '', host: 'x', protocol: 'http:' };
    const mod = freshPlugin();
    global.localStorage.setItem('splitscreenPrefsMigrationV', '2');
    const out = mod.migratePanelPrefs([{ arrName: 'Lead', lyrics: true }]);
    assert.equal(out[0].lyrics, true);
});

// ── LAN share helpers (splitscreen#21) ──

test('ROOM_KEY_ALPHABET excludes every lookalike glyph', () => {
    const { ROOM_KEY_ALPHABET } = freshPlugin();
    for (const c of '0O1IlLuU') {
        assert.equal(ROOM_KEY_ALPHABET.indexOf(c.toUpperCase()), -1, `alphabet must not contain ${c}`);
    }
});

test('generateRoomKey emits 6 chars drawn from the alphabet', () => {
    const mod = freshPlugin();
    for (let i = 0; i < 20; i++) {
        const key = mod.generateRoomKey();
        assert.equal(key.length, 6);
        for (const c of key) assert.notEqual(mod.ROOM_KEY_ALPHABET.indexOf(c), -1);
    }
});

test('normalizeRoomKey is case-insensitive, trims, and rejects junk', () => {
    const { normalizeRoomKey } = freshPlugin();
    assert.equal(normalizeRoomKey('k7tr4m'), 'K7TR4M');
    assert.equal(normalizeRoomKey('  K7TR4M  '), 'K7TR4M');
    assert.equal(normalizeRoomKey('K7TR4'), null);      // too short
    assert.equal(normalizeRoomKey('K7TR4MM'), null);    // too long
    assert.equal(normalizeRoomKey('K7TR40'), null);     // 0 not in alphabet
    assert.equal(normalizeRoomKey('K7TR4O'), null);     // O not in alphabet
    assert.equal(normalizeRoomKey(null), null);
    assert.equal(normalizeRoomKey(undefined), null);
    assert.equal(normalizeRoomKey(123456), null);
});

test('ensureRoomKey persists a key and returns the same one thereafter', () => {
    const mod = freshPlugin();
    const first = mod.ensureRoomKey();
    assert.equal(mod.normalizeRoomKey(first), first);
    assert.equal(mod.ensureRoomKey(), first);
    assert.equal(global.localStorage.getItem('splitscreenRoomKey'), first);
});

test('ensureRoomKey replaces an invalid stored key', () => {
    const mod = freshPlugin();
    global.localStorage.setItem('splitscreenRoomKey', 'not a key!!');
    const key = mod.ensureRoomKey();
    assert.notEqual(key, 'not a key!!');
    assert.equal(mod.normalizeRoomKey(key), key);
});

test('buildShareUrl joins origin and key, stripping trailing slashes', () => {
    const { buildShareUrl } = freshPlugin();
    assert.equal(buildShareUrl('http://192.168.1.20:8000', 'K7TR4M'), 'http://192.168.1.20:8000/?ss=K7TR4M');
    assert.equal(buildShareUrl('http://192.168.1.20:8000/', 'K7TR4M'), 'http://192.168.1.20:8000/?ss=K7TR4M');
});

test('getSyncUrl targets the core relay endpoint, wss under https', () => {
    assert.equal(freshPlugin().getSyncUrl('K7TR4M'), 'ws://localhost:8420/ws/sync/K7TR4M');
    assert.equal(freshPlugin({ protocol: 'https:' }).getSyncUrl('K7TR4M'), 'wss://localhost:8420/ws/sync/K7TR4M');
});

test('makeRemoteFollowerCfg builds a remote FOLLOWER with detect stripped', () => {
    const { makeRemoteFollowerCfg } = freshPlugin();
    const cfg = makeRemoteFollowerCfg({
        type: 'config',
        filename: 'song.sloppak',
        cfg: {
            // `mode` uses the _captureMode() encoding (`viz:<pluginId>`), the
            // shape a real relay config carries — NOT the saved-prefs
            // `__viz__:` sentinel form.
            arrangement: 2, mode: 'viz:highway_3d', inverted: 1, lefty: true,
            mastery: 0.7, lyrics: true, barHidden: true, name: 'Lead',
            detectChannel: 'left', detectDeviceName: 'Scarlett', detectVerifierOffsetMs: 40,
        },
    }, 'lan-abc');
    assert.equal(cfg.remote, true);
    assert.equal(cfg.popupId, 'lan-abc');
    assert.equal(cfg.filename, 'song.sloppak');
    assert.equal(cfg.arrangement, 2);
    assert.equal(cfg.mode, 'viz:highway_3d');
    assert.equal(cfg.inverted, true);
    assert.equal(cfg.lefty, true);
    assert.equal(cfg.mastery, 0.7);
    assert.equal(cfg.lyrics, true);
    assert.equal(cfg.barHidden, true);
    assert.equal(cfg.name, 'Lead');
    // Viewers are passive mirrors — never inherit the host's mic bindings.
    assert.equal(cfg.detectChannel, 'mono');
    assert.equal(cfg.detectDeviceName, '');
    assert.equal(cfg.detectVerifierOffsetMs, 0);
});

test('makeRemoteFollowerCfg defaults sanely on a minimal config message', () => {
    const { makeRemoteFollowerCfg } = freshPlugin();
    const cfg = makeRemoteFollowerCfg({ type: 'config', filename: 'x.sloppak' }, '');
    assert.equal(cfg.remote, true);
    assert.equal(cfg.arrangement, 0);
    assert.equal(cfg.mode, '2d');
    assert.equal(cfg.inverted, false);
    assert.equal(Number.isNaN(cfg.mastery), true);
});

test('loading with ?ss=<key> under the node test harness does not boot or throw', () => {
    // Modern node DOES ship a global WebSocket, so the runtime gates the
    // remote-join boot (and share auto-resume) behind _nodeTestEnv — this
    // pins that the module loads inertly under the harness and still
    // exports its helpers, rather than opening real sockets / building DOM.
    const mod = freshPlugin({ search: '?ss=k7tr4m' });
    assert.equal(typeof mod.getSyncUrl, 'function');
});

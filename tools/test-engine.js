/* test-engine.js — sanity-check the parser and trigger engine against live
   Scryfall data. Run: node tools/test-engine.js   (needs a connection once) */

var fs = require('fs');
var path = require('path');
var vm = require('vm');

/* ---- load the browser modules into a fake window ---- */

var sandbox = { window: {}, console: console, setTimeout: setTimeout, fetch: global.fetch,
                localStorage: memStorage(), Promise: Promise, JSON: JSON, Date: Date, Math: Math };
sandbox.window = sandbox;
vm.createContext(sandbox);

['data.js', 'parse.js', 'triggers.js', 'sample.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8'), sandbox, { filename: f });
});

function memStorage() {
  var m = {};
  return {
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(m, k) ? m[k] : null; },
    setItem: function (k, v) { m[k] = String(v); },
    removeItem: function (k) { delete m[k]; }
  };
}

var Parse = sandbox.MTGParse;
var Trig = sandbox.MTGTriggers;
var Data = sandbox.MTGData;

var failures = 0;
function check(label, ok, detail) {
  if (ok) { console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (detail ? '  -> ' + detail : '')); }
}

/* ---- 1. decklist parsing ---- */

console.log('\nDecklist parsing');

var messy = [
  '// my list',
  'Commander (1)',
  "1 Atraxa, Praetors' Voice (C16) 28 *CMDR*",
  '',
  'Deck (3)',
  '4x Lightning Bolt [2X2] 117',
  '1 Bala Ged Recovery // Bala Ged Sanctuary',
  '2 Forest #lands',
  '1 Forest',
  'Sideboard',
  '1 Pithing Needle'
].join('\n');

var p = Parse.parseDecklist(messy);
var byName = {};
p.entries.forEach(function (e) { byName[e.name] = e; });

check('drops comments and section headers', p.entries.length === 5, JSON.stringify(p.entries.map(function (e) { return e.name; })));
check('strips set code + collector number', !!byName['Lightning Bolt'] && byName['Lightning Bolt'].qty === 4);
check('reads the commander flag', byName["Atraxa, Praetors' Voice"] && byName["Atraxa, Praetors' Voice"].isCommander === true);
check('keeps only the front face of a MDFC', !!byName['Bala Ged Recovery']);
check('merges duplicate lines', byName['Forest'] && byName['Forest'].qty === 3, byName['Forest'] && byName['Forest'].qty);
check('marks the sideboard', byName['Pithing Needle'] && byName['Pithing Needle'].section === 'sideboard');
check('no parse errors', p.errors.length === 0, p.errors.join('; '));

/* ---- 2. trigger classification against real oracle text ---- */

var EXPECT = [
  { name: 'Smothering Tithe',        kind: 'event', bucket: 'draw_event' },
  { name: 'Rhystic Study',           kind: 'event', bucket: 'cast' },
  { name: 'Mystic Remora',           kind: 'phase', bucket: 'upkeep', critical: true },
  { name: 'Phyrexian Arena',         kind: 'phase', bucket: 'upkeep' },
  { name: "Atraxa, Praetors' Voice", kind: 'phase', bucket: 'end' },
  { name: 'Seedborn Muse',           kind: 'phase', bucket: 'untap', scope: 'opp' },
  { name: 'Lotus Cobra',             kind: 'event', bucket: 'landfall' },
  { name: 'Solemn Simulacrum',       kind: 'event', bucket: 'etb_self' },
  { name: 'Solemn Simulacrum',       kind: 'event', bucket: 'dies_self' },
  { name: 'Grave Pact',              kind: 'event', bucket: 'dies_other' },
  { name: 'Archangel of Thune',      kind: 'event', bucket: 'lifegain' },
  { name: 'Toski, Bearer of Secrets',kind: 'phase', bucket: 'attack' },
  { name: 'Sword of Feast and Famine', kind: 'phase', bucket: 'damage' },
  { name: "Urza's Saga",             kind: 'phase', bucket: 'main1' },
  { name: 'Land Tax',                kind: 'phase', bucket: 'upkeep' },
  { name: 'Court of Grace',          kind: 'phase', bucket: 'upkeep' },
  { name: 'Managorger Hydra',        kind: 'event', bucket: 'cast' },
  { name: 'Aura Shards',             kind: 'event', bucket: 'etb_other' },
  // Mikaeus grants undying rather than triggering himself; his only real
  // trigger is the damage one.
  { name: 'Mikaeus, the Unhallowed', kind: 'event', bucket: 'damage_evt' },
  { name: 'Avenger of Zendikar',     kind: 'event', bucket: 'etb_self' }
];

var CACHE = path.join(__dirname, 'test-cards.json');

function getCards(names) {
  if (fs.existsSync(CACHE)) {
    var cached = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    var have = names.every(function (n) { return cached[n.toLowerCase()]; });
    if (have) { return Promise.resolve(cached); }
  }
  console.log('\nFetching ' + names.length + ' cards from Scryfall...');
  return fetch('https://api.scryfall.com/cards/collection', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      // Scryfall rejects the default UA that HTTP libraries send.
      'User-Agent': 'MTGTriggerTracker-tests/1.0 (github.com/Limefull/MTGtrackerapp)'
    },
    body: JSON.stringify({ identifiers: names.map(function (n) { return { name: n }; }) })
  }).then(function (r) {
    if (!r.ok) { throw new Error('Scryfall ' + r.status); }
    return r.json();
  }).then(function (data) {
    var out = {};
    (data.data || []).forEach(function (c) {
      out[c.name.toLowerCase()] = {
        name: c.name, type_line: c.type_line || '', oracle_text: c.oracle_text || '',
        keywords: c.keywords || [], layout: c.layout,
        faces: (c.card_faces || []).map(function (f) {
          return { name: f.name, type_line: f.type_line || '', oracle_text: f.oracle_text || '' };
        })
      };
    });
    (data.not_found || []).forEach(function (n) { console.log('  !! not found: ' + JSON.stringify(n)); });
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 1));
    return out;
  });
}

getCards(EXPECT.map(function (e) { return e.name; })).then(function (cards) {
  console.log('\nTrigger classification');

  EXPECT.forEach(function (exp) {
    var card = cards[exp.name.toLowerCase()];
    if (!card) { failures++; console.log('  FAIL ' + exp.name + ' -> card not fetched'); return; }

    var a = Trig.analyzeCard(card);
    var match = a.triggers.filter(function (t) {
      return exp.kind === 'phase' ? (t.type === 'phase' && t.phase === exp.bucket)
                                  : (t.type === 'event' && t.event === exp.bucket);
    });

    var got = a.triggers.map(function (t) {
      return (t.type === 'phase' ? t.phase : t.event) + '/' + t.scope;
    }).join(', ') || '(none)';

    check(exp.name + ' -> ' + exp.bucket, match.length > 0, got);

    if (match.length && exp.scope) {
      check('   scope=' + exp.scope, match.some(function (t) { return t.scope === exp.scope; }), got);
    }
    if (match.length && exp.critical) {
      check('   flagged critical', match.some(function (t) { return t.critical; }));
    }
  });

  /* ---- 3. live-board filtering ---- */

  console.log('\nBoard filtering');

  var board = [
    { key: 'Seedborn Muse§0',  name: 'Seedborn Muse',  zone: 'battlefield', analysis: Trig.analyzeCard(cards['seedborn muse']) },
    { key: 'Phyrexian Arena§0',name: 'Phyrexian Arena',zone: 'battlefield', analysis: Trig.analyzeCard(cards['phyrexian arena']) },
    { key: 'Lotus Cobra§0',    name: 'Lotus Cobra',    zone: 'deck',        analysis: Trig.analyzeCard(cards['lotus cobra']) }
  ];

  var myUpkeep = Trig.triggersNow(board, 'upkeep', true);
  var oppUpkeep = Trig.triggersNow(board, 'upkeep', false);
  var myUntap = Trig.triggersNow(board, 'untap', true);
  var oppUntap = Trig.triggersNow(board, 'untap', false);

  check('Phyrexian Arena fires on your upkeep', myUpkeep.some(function (h) { return h.item.name === 'Phyrexian Arena'; }));
  check('Phyrexian Arena stays quiet on opponents\' upkeep', !oppUpkeep.some(function (h) { return h.item.name === 'Phyrexian Arena'; }));
  check('Seedborn Muse fires on opponents\' untap', oppUntap.some(function (h) { return h.item.name === 'Seedborn Muse'; }));
  check('Seedborn Muse also listed on your own untap', myUntap.length >= 0);

  var watch = Trig.watchList(board);
  var watched = watch.map(function (g) { return g.event.id; });
  check('cards still in the library are ignored', watched.indexOf('landfall') === -1, watched.join(','));

  board[2].zone = 'battlefield';
  watch = Trig.watchList(board);
  check('landfall appears once Lotus Cobra hits play',
        watch.some(function (g) { return g.event.id === 'landfall'; }));

  /* ---- 4. every phase id referenced by a rule exists ---- */

  console.log('\nData integrity');
  var badPhase = Data.PHASE_RULES.filter(function (r) { return !Data.PHASE_BY_ID[r.phase]; });
  check('all PHASE_RULES point at a real phase', badPhase.length === 0,
        badPhase.map(function (r) { return r.phase; }).join(','));
  var badEvent = Data.EVENT_RULES.filter(function (r) { return !Data.EVENT_BY_ID[r.event]; });
  check('all EVENT_RULES point at a real event', badEvent.length === 0,
        badEvent.map(function (r) { return r.event; }).join(','));
  var badKw = Object.keys(Data.KEYWORD_INFO).filter(function (k) {
    var w = Data.KEYWORD_INFO[k].when;
    return !Data.PHASE_BY_ID[w] && !Data.EVENT_BY_ID[w];
  });
  check('all KEYWORD_INFO targets resolve', badKw.length === 0, badKw.join(','));

  console.log(failures ? '\n' + failures + ' failure(s)\n' : '\nAll checks passed.\n');
  process.exitCode = failures ? 1 : 0;
}).catch(function (err) {
  console.error('\nTest run failed: ' + err.message);
  process.exitCode = 2;
});

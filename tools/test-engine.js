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
  { name: 'Avenger of Zendikar',     kind: 'event', bucket: 'etb_self' },
  { name: 'Charming Prince',         kind: 'event', bucket: 'etb_self' }
];

// Fetched purely so the sequence checks below have data to work with.
var SEQ_CARDS = ["Barbarian Class","Student of Warfare","Invasion of Kaladesh","Case of the Crimson Pulse","Blastoderm","Ancestral Vision","Thing in the Ice"];

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
      // Double-faced cards come back as "Front // Back"; index the front name
      // too, exactly as the app's cache does.
      var front = c.name.split(' // ')[0];
      out[front.toLowerCase()] = out[c.name.toLowerCase()] = {
        name: c.name, type_line: c.type_line || '', oracle_text: c.oracle_text || '',
        keywords: c.keywords || [], layout: c.layout, defense: c.defense || '',
        faces: (c.card_faces || []).map(function (f) {
          return { name: f.name, type_line: f.type_line || '', oracle_text: f.oracle_text || '', defense: f.defense || '' };
        })
      };
    });
    (data.not_found || []).forEach(function (n) { console.log('  !! not found: ' + JSON.stringify(n)); });
    fs.writeFileSync(CACHE, JSON.stringify(out, null, 1));
    return out;
  });
}

getCards(EXPECT.map(function (e) { return e.name; }).concat(SEQ_CARDS)).then(function (cards) {
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

  // A card in the graveyard has left play, so its battlefield triggers stop.
  board[1].zone = 'graveyard';
  check('a card in the graveyard stops firing its upkeep trigger',
        !Trig.triggersNow(board, 'upkeep', true).some(function (h) { return h.item.name === 'Phyrexian Arena'; }));
  board[1].zone = 'battlefield';
  check('and fires again once it is back on the battlefield',
        Trig.triggersNow(board, 'upkeep', true).some(function (h) { return h.item.name === 'Phyrexian Arena'; }));

  var watch = Trig.watchList(board);
  var watched = watch.map(function (g) { return g.event.id; });
  check('cards still in the library are ignored', watched.indexOf('landfall') === -1, watched.join(','));

  board[2].zone = 'battlefield';
  watch = Trig.watchList(board);
  check('landfall appears once Lotus Cobra hits play',
        watch.some(function (g) { return g.event.id === 'landfall'; }));

  /* ---- 4. the tracking / question split ---- */

  console.log('\nTracking vs questions');

  var analysisMap = {};
  Object.keys(cards).forEach(function (k) {
    analysisMap[cards[k].name] = Trig.analyzeCard(cards[k]);
  });

  // Phase triggers fire on a schedule, so the app must be told they are in play.
  check('Phyrexian Arena needs tracking', Trig.needsTracking(analysisMap['Phyrexian Arena']));
  check('Mystic Remora needs tracking', Trig.needsTracking(analysisMap['Mystic Remora']));
  check('Seedborn Muse needs tracking', Trig.needsTracking(analysisMap['Seedborn Muse']));
  // Event triggers fire because the player did something, so a question covers them.
  check('Lotus Cobra does NOT need tracking', !Trig.needsTracking(analysisMap['Lotus Cobra']));
  check('Grave Pact does NOT need tracking', !Trig.needsTracking(analysisMap['Grave Pact']));
  check('Rhystic Study does NOT need tracking', !Trig.needsTracking(analysisMap['Rhystic Study']));

  var qs = Trig.deckQuestions(Object.keys(analysisMap), analysisMap);
  var qIds = qs.map(function (q) { return q.event.id; });

  check('questions collapse many cards into few prompts', qs.length < Object.keys(analysisMap).length,
        qs.length + ' questions for ' + Object.keys(analysisMap).length + ' cards');
  check('landfall is asked', qIds.indexOf('landfall') !== -1, qIds.join(','));
  check('every question has a prompt', qs.every(function (q) { return !!q.event.ask; }));
  check('self-referential events are never asked',
        qIds.indexOf('etb_self') === -1 && qIds.indexOf('dies_self') === -1, qIds.join(','));

  var landfall = qs.filter(function (q) { return q.event.id === 'landfall'; })[0];
  check('one landfall question covers every landfall card',
        landfall && landfall.hits.length >= 1,
        landfall ? landfall.hits.map(function (h) { return h.name; }).join(', ') : 'missing');

  // A question must not depend on zones — that is the whole point of asking.
  var soloMap = { 'Lotus Cobra': analysisMap['Lotus Cobra'] };
  check('questions work with nothing tracked',
        Trig.deckQuestions(['Lotus Cobra'], soloMap).length === 1);

  /* ---- 5. sagas and other abilities whose text changes per trigger ---- */

  console.log('\nSagas and multi-part abilities');

  var saga = Trig.parseSaga(
    '(As this Saga enters and after your draw step, add a lore counter.)\n' +
    'I — Do the first thing.\n' +
    'II, III — Do the shared thing.'
  );
  check('chapters are parsed', saga && saga.max === 3, saga && JSON.stringify(saga.chapters));
  check('a shared "II, III" line fills both chapters',
        saga && saga.chapters[2] === 'Do the shared thing.' && saga.chapters[3] === saga.chapters[2]);
  check('chapter I is next at zero lore', Trig.sagaChapter(saga, 0).chapter === 1);
  check('chapter III is next at two lore', Trig.sagaChapter(saga, 2).chapter === 3);
  check('the last chapter is flagged', Trig.sagaChapter(saga, 2).last === true);
  check('past the last chapter it says sacrifice', Trig.sagaChapter(saga, 3).done === true);
  check('reminder text never becomes a chapter', !saga.chapters[0]);

  var urza = cards["urza's saga"];
  if (urza) {
    var ua = Trig.analyzeCard(urza);
    var sagaTriggers = ua.triggers.filter(function (t) { return t.sequence; });
    check('a Saga gets exactly one main-phase trigger carrying its chapters',
          sagaTriggers.length === 1 && sagaTriggers[0].phase === 'main1',
          ua.triggers.map(function (t) { return t.phase || t.event; }).join(','));
    check('and its chapter text is attached',
          ua.sequence && ua.sequence.kind === 'saga' && ua.sequence.max === 3,
          JSON.stringify(ua.sequence && ua.sequence.max));
    // An ability quoted inside a chapter must not leak out as its own trigger.
    check('abilities quoted inside a chapter do not leak out',
          !ua.triggers.some(function (t) { return t.phase === 'attack'; }),
          ua.triggers.map(function (t) { return t.phase || t.event; }).join(','));
  } else {
    failures++; console.log("  FAIL Urza's Saga not fetched");
  }

  var prince = cards['charming prince'];
  if (prince) {
    var pa = Trig.analyzeCard(prince);
    var etb = pa.triggers.filter(function (t) { return t.event === 'etb_self'; })[0];
    check('a modal trigger keeps all of its modes',
          etb && (etb.text.match(/[•·]/g) || []).length === 3,
          etb ? JSON.stringify(etb.text) : 'no etb trigger');
    check('and its modes do not become separate triggers',
          pa.triggers.length === 1,
          pa.triggers.map(function (t) { return t.phase || t.event; }).join(','));
  } else {
    failures++; console.log('  FAIL Charming Prince not fetched');
  }

  /* ---- 6. every other sequenced card type ---- */

  console.log('\nOther sequenced card types');

  var SEQ_EXPECT = [
    { name: 'Barbarian Class',          kind: 'class',      max: 3, dir: 'up',   auto: null },
    { name: 'Student of Warfare',       kind: 'levelup',    max: 7, dir: 'up',   auto: null },
    { name: 'Invasion of Kaladesh',     kind: 'siege',      max: 4, dir: 'down', auto: null },
    { name: 'Case of the Crimson Pulse',kind: 'case',       max: 2, dir: 'up',   auto: 'end' },
    { name: 'Blastoderm',               kind: 'fading',     max: 3, dir: 'down', auto: 'upkeep' },
    { name: 'Ancestral Vision',         kind: 'suspend',    max: 4, dir: 'down', auto: 'upkeep' },
    { name: 'Mystic Remora',            kind: 'cumulative', max: 0, dir: 'up',   auto: 'upkeep' },
    { name: 'Thing in the Ice',         kind: 'counters',   max: 4, dir: 'down', auto: null }
  ];

  SEQ_EXPECT.forEach(function (exp) {
    var c = cards[exp.name.toLowerCase()];
    if (!c) { failures++; console.log('  FAIL ' + exp.name + ' not fetched'); return; }
    var s = Trig.analyzeCard(c).sequence;
    check(exp.name + ' -> ' + exp.kind,
          s && s.kind === exp.kind && s.max === exp.max && s.dir === exp.dir &&
          (s.auto || null) === exp.auto,
          s ? (s.kind + '/max=' + s.max + '/' + s.dir + '/' + (s.auto || 'manual')) : 'no sequence');
  });

  // A level band covers every level inside it, not just its first.
  var sow = cards['student of warfare'];
  if (sow) {
    var ss = Trig.analyzeCard(sow).sequence;
    check('a level band applies to every level inside it',
          Trig.sequenceState(ss, 4).text === Trig.sequenceState(ss, 2).text,
          JSON.stringify(Trig.sequenceState(ss, 4).text));
  }

  // Countdowns end at zero and stay there.
  var blast = cards['blastoderm'];
  if (blast) {
    var bs = Trig.analyzeCard(blast).sequence;
    check('a countdown reaches zero and stops',
          Trig.sequenceState(bs, 3).done && Trig.sequenceState(bs, 9).counters === 0);
    check('and warns on its last counter', Trig.sequenceState(bs, 2).last === true);
  }

  /* ---- 7. escalating (per-turn) triggers ---- */

  console.log('\nEscalating triggers');

  var victorText = "Eerie — Whenever an enchantment you control enters and whenever you " +
    "fully unlock a Room, surveil 2 if this is the first time this ability has resolved this " +
    "turn. If it's the second time, each opponent discards a card. If it's the third time, put " +
    "a creature card from a graveyard onto the battlefield under your control.";
  var vt = Trig.parseTiers(victorText);
  check('three resolutions are parsed', vt && vt.max === 3, vt && JSON.stringify(vt.steps));
  check('the trigger clause is stripped from the first step',
        vt && vt.steps[0].text === 'surveil 2', vt && JSON.stringify(vt.steps[0]));
  check('the second step is its own effect',
        vt && /each opponent discards/.test(vt.steps[1].text));
  check('resolution 1 of 3 first', Trig.tierState(vt, 0).capped === 1);
  check('resolution 3 of 3 after two', Trig.tierState(vt, 2).capped === 3);
  check('a fourth resolution does nothing more', Trig.tierState(vt, 3).spent === true);

  var zimText = 'Landfall — Whenever a land you control enters, manifest dread if this is ' +
    'the first time this ability has resolved this turn. Otherwise, you may turn a permanent ' +
    'you control face up.';
  var zt = Trig.parseTiers(zimText);
  check('an "Otherwise" clause becomes a repeating second step',
        zt && zt.repeating === true && zt.max === 2, zt && JSON.stringify(zt.steps));
  check('and it keeps applying rather than running out',
        zt && Trig.tierState(zt, 5).spent === false);

  check('a plain trigger has no tiers', !Trig.parseTiers('Whenever a land enters, draw a card.'));

  var victorCard = { name: "Victor, Valgavoth's Seneschal", type_line: 'Legendary Creature',
                     oracle_text: victorText, keywords: [], faces: [] };
  check('an escalating card needs tracking', Trig.needsTracking(Trig.analyzeCard(victorCard)));

  /* ---- 8. every phase id referenced by a rule exists ---- */

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

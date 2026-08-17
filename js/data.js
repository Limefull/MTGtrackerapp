/* data.js — static game model: phases, trigger rules, keyword reference.
   Loaded as a classic script so the app also runs from file:// */
(function (global) {
  'use strict';

  /* ---------- Turn structure ---------- */

  var PHASES = [
    { id: 'untap',     name: 'Untap',        short: 'UNT', group: 'beginning' },
    { id: 'upkeep',    name: 'Upkeep',       short: 'UPK', group: 'beginning' },
    { id: 'draw',      name: 'Draw',         short: 'DRW', group: 'beginning' },
    { id: 'main1',     name: 'Main 1',       short: 'M1',  group: 'main' },
    { id: 'combat',    name: 'Begin Combat', short: 'BC',  group: 'combat' },
    { id: 'attack',    name: 'Attackers',    short: 'ATK', group: 'combat' },
    { id: 'block',     name: 'Blockers',     short: 'BLK', group: 'combat' },
    { id: 'damage',    name: 'Damage',       short: 'DMG', group: 'combat' },
    { id: 'endcombat', name: 'End Combat',   short: 'EOC', group: 'combat' },
    { id: 'main2',     name: 'Main 2',       short: 'M2',  group: 'main' },
    { id: 'end',       name: 'End Step',     short: 'END', group: 'ending' },
    { id: 'cleanup',   name: 'Cleanup',      short: 'CLN', group: 'ending' }
  ];

  var PHASE_BY_ID = {};
  PHASES.forEach(function (p, i) { p.index = i; PHASE_BY_ID[p.id] = p; });

  /* ---------- Event buckets (can fire at any time) ---------- */

  var EVENTS = [
    { id: 'etb_self',   name: 'This enters the battlefield' },
    { id: 'etb_other',  name: 'Another permanent enters' },
    { id: 'landfall',   name: 'Landfall - a land enters' },
    { id: 'token',      name: 'Tokens are created' },
    { id: 'dies_self',  name: 'This dies / leaves' },
    { id: 'dies_other', name: 'Another creature dies' },
    { id: 'graveyard',  name: 'Cards hit a graveyard' },
    { id: 'cast',       name: 'A spell is cast' },
    { id: 'draw_event', name: 'You draw a card' },
    { id: 'discard',    name: 'You discard' },
    { id: 'lifegain',   name: 'You gain life' },
    { id: 'lifeloss',   name: 'Life is lost' },
    { id: 'damage_evt', name: 'Damage is dealt' },
    { id: 'sacrifice',  name: 'You sacrifice something' },
    { id: 'counters',   name: 'Counters are placed' },
    { id: 'tapped',     name: 'Permanents tap / untap' },
    { id: 'targeted',   name: 'Something becomes targeted' },
    { id: 'exiled',     name: 'Cards are exiled' },
    { id: 'attacked',   name: 'A creature attacks you' },
    { id: 'other_evt',  name: 'Other triggered ability' }
  ];

  var EVENT_BY_ID = {};
  EVENTS.forEach(function (e, i) { e.index = i; EVENT_BY_ID[e.id] = e; });

  /* ---------- Trigger detection rules ----------
     Each rule runs against a single lowercased ability line where the card's own
     name has been replaced with "~". The first matching rule wins.
     scope: 'you'  -> only fires on your own turn
            'each' -> fires on every player's turn (the most-forgotten kind)
            'opp'  -> only on opponents' turns                              */

  var PHASE_RULES = [
    { phase: 'untap',     scope: 'each', re: /at the beginning of each (player'?s )?untap step/ },
    { phase: 'untap',     scope: 'you',  re: /at the beginning of your untap step/ },
    // Seedborn Muse and friends are static, but they only matter at untap.
    { phase: 'untap',     scope: 'opp',  re: /during each other (player'?s|opponent'?s)? ?untap step/ },
    { phase: 'untap',     scope: 'each', re: /during each (player'?s )?untap step/ },
    { phase: 'untap',     scope: 'you',  re: /(don'?t|doesn'?t) untap during (your|its controller'?s) (next )?untap step/ },

    { phase: 'upkeep',    scope: 'opp',  re: /at the beginning of each opponent'?s? upkeep/ },
    { phase: 'upkeep',    scope: 'each', re: /at the beginning of each (player'?s )?upkeep/ },
    { phase: 'upkeep',    scope: 'you',  re: /at the beginning of (your|the) (next )?upkeep/ },

    { phase: 'draw',      scope: 'each', re: /at the beginning of each (player'?s )?draw step/ },
    { phase: 'draw',      scope: 'you',  re: /at the beginning of your draw step/ },

    { phase: 'main2',     scope: 'each', re: /at the beginning of each (player'?s )?postcombat main phase/ },
    { phase: 'main2',     scope: 'you',  re: /at the beginning of your postcombat main phase/ },

    { phase: 'main1',     scope: 'each', re: /at the beginning of each (player'?s )?(precombat |first )?main phase/ },
    { phase: 'main1',     scope: 'you',  re: /at the beginning of your (precombat |first )?main phase/ },

    { phase: 'combat',    scope: 'opp',  re: /at the beginning of combat on each opponent'?s? turn/ },
    { phase: 'combat',    scope: 'each', re: /at the beginning of (each|every) combat/ },
    { phase: 'combat',    scope: 'you',  re: /at the beginning of combat on your turn/ },
    { phase: 'combat',    scope: 'you',  re: /at the beginning of (your )?combat/ },

    { phase: 'attack',    scope: 'you',  re: /whenever you attack\b/ },
    { phase: 'attack',    scope: 'each', re: /whenever a creature attacks(?! you)/ },
    { phase: 'attack',    scope: 'you',  re: /whenever .{0,50}\battacks\b/ },
    { phase: 'attack',    scope: 'you',  re: /attacks (each combat )?if able/ },

    { phase: 'block',     scope: 'each', re: /whenever .{0,50}(blocks|becomes blocked)/ },

    { phase: 'damage',    scope: 'each', re: /deals combat damage/ },

    { phase: 'endcombat', scope: 'each', re: /at (the beginning of )?(the )?end of combat/ },

    { phase: 'end',       scope: 'opp',  re: /at the beginning of each opponent'?s? end step/ },
    { phase: 'end',       scope: 'each', re: /at the beginning of each (player'?s )?end step/ },
    { phase: 'end',       scope: 'you',  re: /at the beginning of (your|the) (next )?end step/ },

    { phase: 'cleanup',   scope: 'you',  re: /maximum hand size/ }
  ];

  var EVENT_RULES = [
    { event: 'landfall',   re: /whenever a land( you control)? enters/ },
    { event: 'landfall',   re: /\blandfall\b/ },
    { event: 'etb_self',   re: /^when(ever)? (~|this creature|this permanent|this artifact|this enchantment|this land|this token) enters/ },
    { event: 'token',      re: /whenever one or more tokens? (are|is) created/ },
    { event: 'etb_other',  re: /whenever (another|a|one or more|.{0,30}) ?(creature|permanent|artifact|enchantment|token|planeswalker)s?.{0,40} enters/ },
    { event: 'dies_self',  re: /when(ever)? (~|this creature|this permanent) (dies|leaves the battlefield|is put into)/ },
    { event: 'dies_other', re: /whenever (another|a|one or more).{0,50}\bdies\b/ },
    { event: 'dies_other', re: /\bdies\b/ },
    { event: 'graveyard',  re: /whenever .{0,50}is put into (a|your|an opponent'?s?) graveyard/ },
    { event: 'graveyard',  re: /whenever .{0,40}leaves the battlefield/ },
    { event: 'cast',       re: /whenever (you|a player|an opponent|another player) cast/ },
    { event: 'cast',       re: /whenever .{0,40}\bcasts?\b/ },
    { event: 'draw_event', re: /whenever (you|a player|an opponent) draws?/ },
    { event: 'discard',    re: /whenever (you|a player|an opponent) discards?/ },
    { event: 'lifegain',   re: /whenever (you|a player|an opponent) gains? life/ },
    { event: 'lifeloss',   re: /whenever (you|a player|an opponent) loses? life/ },
    { event: 'damage_evt', re: /whenever .{0,50}deals damage/ },
    { event: 'damage_evt', re: /whenever .{0,50}is dealt damage/ },
    { event: 'sacrifice',  re: /whenever (you|a player|an opponent) sacrifices?/ },
    { event: 'counters',   re: /whenever one or more .{0,25}counters? (are|is) (put|placed|removed)/ },
    { event: 'tapped',     re: /whenever .{0,40}becomes? (tapped|untapped)/ },
    { event: 'tapped',     re: /whenever (you|a player) taps?/ },
    { event: 'targeted',   re: /becomes the target of/ },
    { event: 'exiled',     re: /whenever .{0,50}(is|are) exiled/ },
    { event: 'attacked',   re: /whenever a creature attacks you/ },
    { event: 'attacked',   re: /whenever .{0,40}attacks? you/ }
  ];

  /* ---------- Non-trigger reminders you still forget ---------- */

  var STATIC_RULES = [
    { kind: 'extra_land',  label: 'Extra land drop',        re: /play an additional land/ },
    { kind: 'cost',        label: 'Cost reduction',         re: /costs? (\{[^}]*\}|\w+) less to cast/ },
    { kind: 'cost',        label: 'Cost increase',          re: /costs? (\{[^}]*\}|\w+) more to cast/ },
    { kind: 'replacement', label: 'Modified draw',          re: /if you would draw/ },
    { kind: 'replacement', label: 'Replacement effect',     re: /\binstead\b/ },
    { kind: 'handsize',    label: 'No maximum hand size',   re: /no maximum hand size/ },
    { kind: 'play_from',   label: 'Play from another zone', re: /you may (cast|play) .{0,60}(from|in) your (graveyard|library|exile|hand)/ },
    { kind: 'play_from',   label: 'Play off the top',       re: /play (with )?the top card of your library/ },
    { kind: 'extra_turn',  label: 'Extra turn',             re: /take an extra turn/ },
    { kind: 'alt_cost',    label: 'Alternative cost',       re: /(rather than pay|without paying its mana cost)/ },
    { kind: 'anthem',      label: 'Static buff / anthem',   re: /(other )?creatures you control get/ },
    { kind: 'lose_game',   label: 'Loses you the game',     re: /you lose the game/ }
  ];

  /* ---------- Cards that will kill you if you forget the upkeep cost ---------- */

  var CRITICAL_RULES = [
    /unless you (pay|sacrifice|discard|exile)/,
    /sacrifice ~ (unless|at the beginning)/,
    /cumulative upkeep/,
    /you lose the game/,
    /\bvanishing\b/,
    /\bfading\b/,
    /remove a (time|fade|age) counter/,
    /if you (don'?t|can'?t)/
  ];

  /* ---------- Keyword mechanics worth surfacing separately ---------- */

  var KEYWORD_INFO = {
    'Cascade':           { when: 'cast',       note: 'Exile until you hit a cheaper nonland card, cast it free.' },
    'Storm':             { when: 'cast',       note: 'Copy it for each spell cast before it this turn.' },
    'Prowess':           { when: 'cast',       note: '+1/+1 until EOT whenever you cast a noncreature spell.' },
    'Exalted':           { when: 'attack',     note: 'If exactly one creature attacks, it gets +1/+1.' },
    'Extort':            { when: 'cast',       note: 'Pay {W/B} on each spell you cast to drain each opponent.' },
    'Annihilator':       { when: 'attack',     note: 'Defending player sacrifices permanents on attack.' },
    'Battle cry':        { when: 'attack',     note: 'Other attacking creatures get +1/+0.' },
    'Melee':             { when: 'attack',     note: '+1/+1 for each opponent you attacked this combat.' },
    'Myriad':            { when: 'attack',     note: 'Token copies attacking each other opponent.' },
    'Afflict':           { when: 'block',      note: 'Defending player loses life when it becomes blocked.' },
    'Cumulative upkeep': { when: 'upkeep',     note: 'Add an age counter and pay, or sacrifice it.' },
    'Echo':              { when: 'upkeep',     note: 'Pay echo on your next upkeep or sacrifice it.' },
    'Vanishing':         { when: 'upkeep',     note: 'Remove a time counter; sacrifice at the last one.' },
    'Fading':            { when: 'upkeep',     note: 'Remove a fade counter; sacrifice if you cannot.' },
    'Suspend':           { when: 'upkeep',     note: 'Remove a time counter; cast it free at zero.' },
    'Rebound':           { when: 'upkeep',     note: 'Cast it again free from exile next upkeep.' },
    'Saga':              { when: 'main1',      note: 'Add a lore counter in your precombat main phase.' },
    'Undying':           { when: 'dies_self',  note: 'Returns with a +1/+1 counter if it had none.' },
    'Persist':           { when: 'dies_self',  note: 'Returns with a -1/-1 counter if it had none.' },
    'Haunt':             { when: 'dies_self',  note: 'Exile haunting a creature when it dies.' },
    'Dredge':            { when: 'draw',       note: 'Replace a draw by milling instead.' },
    'Miracle':           { when: 'draw',       note: 'Reveal it as the first card drawn to cast it cheap.' },
    'Madness':           { when: 'discard',    note: 'Cast it for the madness cost when discarded.' },
    'Flashback':         { when: 'graveyard',  note: 'Castable from your graveyard.' },
    'Escape':            { when: 'graveyard',  note: 'Castable from your graveyard by exiling cards.' },
    'Disturb':           { when: 'graveyard',  note: 'Cast the back face from your graveyard.' },
    'Embalm':            { when: 'graveyard',  note: 'Exile from graveyard for a token copy.' },
    'Eternalize':        { when: 'graveyard',  note: 'Exile from graveyard for a 4/4 token copy.' },
    'Unearth':           { when: 'graveyard',  note: 'Return it for one turn, then exile it.' },
    'Aftermath':         { when: 'graveyard',  note: 'Cast the second half from your graveyard.' },
    'Ninjutsu':          { when: 'block',      note: 'Swap it in for an unblocked attacker.' },
    'Evoke':             { when: 'cast',       note: 'Cast it cheap, then sacrifice it.' },
    'Bloodthirst':       { when: 'etb_self',   note: 'Enters bigger if an opponent was dealt damage.' },
    'Convoke':           { when: 'cast',       note: 'Tap creatures to help cast it.' },
    'Improvise':         { when: 'cast',       note: 'Tap artifacts to help cast it.' },
    'Delve':             { when: 'cast',       note: 'Exile graveyard cards to help cast it.' },
    'Affinity':          { when: 'cast',       note: 'Costs less for each matching permanent.' },
    'Buyback':           { when: 'cast',       note: 'Pay extra to return it to your hand.' },
    'Kicker':            { when: 'cast',       note: 'Optional extra cost for a bonus effect.' },
    'Overload':          { when: 'cast',       note: 'Alternative cost that hits everything.' },
    'Adventure':         { when: 'cast',       note: 'Cast the adventure half, then exile-cast the creature.' }
  };

  global.MTGData = {
    PHASES: PHASES,
    PHASE_BY_ID: PHASE_BY_ID,
    EVENTS: EVENTS,
    EVENT_BY_ID: EVENT_BY_ID,
    PHASE_RULES: PHASE_RULES,
    EVENT_RULES: EVENT_RULES,
    STATIC_RULES: STATIC_RULES,
    CRITICAL_RULES: CRITICAL_RULES,
    KEYWORD_INFO: KEYWORD_INFO
  };
})(window);

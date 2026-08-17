# MTG Trigger Tracker

Paste a Commander decklist, and the app tells you which triggers fire in the step
you're currently in — and nags you before you move on.

It only reminds you about cards you actually control, so a 100-card deck doesn't
turn into 100 lines of noise.

**No build step, no backend, no account.** It's plain HTML/CSS/JS, installs to
your phone as a PWA, and works with no signal once a deck has been loaded.

---

## What it does

**Phase-by-phase reminders.** Walk the turn with one button. At each step the app
lists the triggers that fire *right now*, from permanents you actually have in
play. Tick them off as they resolve.

**It stops you skipping a step.** Try to advance with unresolved triggers and it
warns you first. Cards that lose you the game if you forget them — cumulative
upkeep, "sacrifice unless you pay", vanishing, fading — are flagged in red and
sorted to the top.

**It catches other players' turns.** The triggers people forget most are the ones
that fire on *every* turn: Seedborn Muse untapping, Rhystic Study taxing, an
"at the beginning of each upkeep" clause. Flip to *Opponent's turn* and the app
shows only what's live during someone else's turn.

**You only track a handful of cards.** Tapping every permanent into an app while
you're actually playing is too much work, so the app splits the deck in two:

- **Phase triggers** fire *to* you on a schedule — upkeep, end step, combat. The
  app can't know they're out unless you say so, so these are the only cards you
  ever tap in. On the sample list that's **13 cards out of 55**.
- **Event triggers** fire *because* something happened — a land entered, a
  creature died, someone cast a spell. You already know when that happened, so
  the app just asks.

**Turn questions.** Everything not tracked becomes a short list of prompts:
*A land entered · A creature died · A spell was cast.* Tap one when it happens
and it names the cards that care and counts the occurrence, so a board wipe
registers as eight Grave Pact triggers rather than one. Twenty event cards
collapse into eight questions, and the list doesn't grow with deck size — it's
bounded by the number of event *types*, not cards.

Cards you have told the app about are highlighted inside the questions, so a
tracked Rhystic Study shows as "1 in play" under *A spell was cast*.

**A sweep before you pass.** Ending a turn opens the question list one last time
so a missed trigger gets caught before the turn is gone. Both the questions and
the sweep can be switched off in settings.

**A visual card picker.** Tracking a card means picking it off a grid of real
card images pulled from Scryfall, split into Creatures, Instants, Sorceries,
Artifacts, Enchantments, Planeswalkers, Battles and Lands. It defaults to
*Needs tracking* so you only see the handful that matter, with *Any trigger* and
*All cards* a tap away. Each tile carries a badge with its reminder count, and
cards already on the board are greyed out.

**Cards that die stop nagging you.** Every tracked card has a one-tap ⏵ button
that sends it to the graveyard. It drops out of the tracked count, stops firing
its triggers, and moves to a dimmed *Left play* row — but it stays available in
the picker, so reanimating or recasting it is one tap. Anything explicitly
written to work from the yard (flashback, escape, disturb, unearth) keeps
reminding you.

**Real mana symbols.** Costs and rules text render with proper symbol art
instead of `{2}{W}{U}` — in the card detail, the trigger list and the trigger
sheet. Bundled locally, so they work offline.

**Zone tracking.** Move a card between battlefield, graveyard, exile, hand and the
command zone from the card detail sheet.

**Trigger sheet.** The whole deck's reminders on one page, grouped by phase and
event — for studying a new list before you sleeve it up.

---

## Getting started

Open the app, paste a decklist, hit **Import**. Or press **Load sample** to try it
with a pre-built list.

Decklist formats that work:

```
Commander
1 Atraxa, Praetors' Voice (C16) 28 *CMDR*

Deck
1 Sol Ring
4x Lightning Bolt [2X2] 117
1 Bala Ged Recovery // Bala Ged Sanctuary
2 Forest #lands
```

Exports from Moxfield, Archidekt, MTGO and Arena all paste in directly. Set codes,
collector numbers, foil markers and category tags are stripped automatically.
Your commander is detected from a `Commander` header or a `*CMDR*` flag.

### During a game

| Action | Phone | Laptop |
| --- | --- | --- |
| Next step | **Next step →** | `→` or `Space` |
| Previous step | **←** | `←` |
| Track a card | **+ Card** | `A` |
| Log an event | tap a question | tap a question |
| End the turn | **End turn ↻** | `T` |
| Jump to any step | tap the rail | tap the rail |
| Close a popup | tap outside | `Esc` |

Tap any card chip in the **Battlefield** row to read its triggers or move it to
another zone.

---

## Running it

It's a static site — no install, no build.

**Locally:** any static file server works.

```bash
npx http-server . -p 8099 -c-1
```

Then open <http://localhost:8099>. Opening `index.html` straight off disk works
too, though the service worker (offline mode) only registers over `http`/`https`.

**On GitHub Pages:** push to `main`, then in the repo go to
*Settings → Pages* and set **Source: Deploy from a branch**, **Branch: `main` / `root`**.
The app appears at `https://<user>.github.io/MTGtrackerapp/` within a minute or two.

**On your phone:** open that URL in the browser and choose *Add to Home Screen*.
It then launches full-screen and runs offline.

---

## How the trigger detection works

Card text comes from the [Scryfall](https://scryfall.com) API and is cached in
`localStorage`, so a deck is fetched once and then works offline forever. Card
images are kept as URLs rather than data, in two sizes — `small` for the picker
grid, `normal` for the detail view — and the service worker caches each one the
first time it's shown, so the art is there offline too.

Each ability line is stripped of reminder text, the card's own name is replaced
with `~`, and the line is matched against rule tables in
[`js/data.js`](js/data.js):

- **`PHASE_RULES`** pin a trigger to a step, and carry a scope — `you`, `each` or
  `opp` — which is what makes the opponent's-turn view work. Matching here is
  also what marks a card as needing tracking.
- **`EVENT_RULES`** bucket triggers that fire off events rather than steps. Each
  bucket carries an `ask` string, which is the turn question it becomes; buckets
  with `ask: null` are about the card itself and never become questions.
- **`STATIC_RULES`** catch non-triggers you still forget: extra land drops, cost
  reduction, replacement effects.
- **`CRITICAL_RULES`** flag the ones that cost you the game.
- **`KEYWORD_INFO`** covers mechanics that live in the rules rather than the card
  text — sagas ticking in your main phase, undying, cumulative upkeep, echo.

Adding a rule is a one-line change to those tables.

### Known limits

It reads oracle text with regular expressions, not a rules engine. So:

- **Activated abilities are not triggers** and are not tracked. Sakura-Tribe
  Elder's sacrifice ability won't appear — the full card text is always one tap
  away in the card detail view.
- **Abilities granted by other permanents** aren't propagated. If an anthem gives
  your team a trigger, only the anthem itself is flagged.
- **Unusual wordings can be missed or land in the wrong bucket.** The trigger
  sheet is the fastest way to spot this on a new deck.

It's a memory aid, not a rules engine. When it disagrees with the card, the card
is right.

---

## Testing

```bash
node tools/test-engine.js
```

Checks decklist parsing, trigger classification and board filtering against real
Scryfall data (cached in `tools/test-cards.json` after the first run, so later
runs are offline). Regenerate the app icons with `node tools/make-icons.js`.

---

## Project layout

```
index.html              app shell — every screen
css/app.css             dark, thumb-first styling
js/data.js              phases, events, and the trigger rule tables
js/parse.js             decklist text -> card entries
js/scryfall.js          card lookup + localStorage cache
js/mana.js              {W}{2/U}{T} notation -> symbol art
js/triggers.js          oracle text -> structured reminders
js/store.js             persistence
js/app.js               screens, game loop, rendering
js/sample.js            the sample decklist
sw.js                   offline service worker
tools/                  icon generator and engine tests
```

Scripts are plain classic `<script>` tags with a global namespace rather than ES
modules, so the app also runs straight from the filesystem.

---

## Credits

Card data from [Scryfall](https://scryfall.com). Mana symbol art in `img/mana/`
comes from the companion `custom-mtg-cards` project; `js/mana.js` carries the
list of available filenames, so regenerate that list if you add or remove art.

Unofficial fan content. Not affiliated with, endorsed, or sponsored by Wizards of
the Coast. Magic: The Gathering is a trademark of Wizards of the Coast LLC.

Licensed under the [MIT License](LICENSE).

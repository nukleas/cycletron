# Genre Map — Plan

Goal: a **true map across the electronic-music taxonomy**
([Wikipedia: List of electronic music genres](https://en.wikipedia.org/wiki/List_of_electronic_music_genres)),
where every genre has a **spec** the verified constructive generator turns into
real, non-slop music — aligned drums, in-key harmony, arrangeable form.

Scope (agreed): **families + 1–3 flagship subgenres each** → a playable map of
~60–80 genres. Long tail inherits later.

## The reframe: genres are DATA, not code

Today each genre is a hardcoded `compose::house()` fn. Hand-writing 200 is
untenable. Instead, one parameterized composer reads a **`GenreSpec`**;
**families are base specs, subgenres inherit + override**. Adding a genre = adding
data. Quality stays high because everything routes through the verified generator
(`grid`/`scale`/`melody`/`compose` + `arrange` + `corpus-check`).

### GenreSpec schema (Phase 0 deliverable)

```
GenreSpec {
  lineage:    ["house", "deep house"],   // family → this genre
  bpm:        (u32, u32),                 // range; composer picks/centres
  feel:       { swing: f64 },             // via .late() nudges (no .swingBy)
  scale:      Scale spec + mood tag,      // e.g. c minor / dorian, "warm"|"dark"
  drums:      Vec<DrumArchetype>,         // layered grid archetypes
  bass:       BassStyle,
  harmony:    HarmonyStyle + progression (roman numerals or degree list),
  palette:    { banks, synths, gm instruments },
  form:       arrange sketch (intro/verse/build/drop lengths) — optional,
}
```

### Archetype library (Phase 0 deliverable)

Reusable, composable building blocks so subgenres are cheap:

- **Drum archetypes** — `four_on_floor`, `offbeat_open_hat`, `backbeat_clap`,
  `two_step`, `boom_bap`, `breakbeat`/`amen`, `gabber_kick`, `half_time`,
  `trap_hats` (rolling), `rapid_808` (footwork), `log_drum` (amapiano),
  `shuffled_2step` (garage), `dub_skank`.
- **Bass styles** — `offbeat_root`, `reese`, `rolling_16th`, `acid_303`,
  `sub_wobble`, `sub_808`, `walking`, `octave`.
- **Harmony styles** — `stab_7ths`, `supersaw_chords`, `pads_long`,
  `rhodes_7ths`, `arpeggio`, `none`.

## The map skeleton (target: families → flagship subgenres)

Rough params (bpm · drum archetype · mood) to seed the specs. ✓ = already covered.

| Family | Flagship subgenres (bpm · drums · mood) |
| --- | --- |
| **House** ✓ | deep house (122·four_floor·warm) · tech house (126·four_floor·groovy) · acid house (125·four_floor+303·raw) |
| **Techno** ✓ | detroit (128·four_floor·soulful) · minimal (128·four_floor·hypnotic) · dub techno (120·four_floor·deep) · hard techno (140·four_floor·dark) · acid techno ✓ (130·303) |
| **Trance** | uplifting (138·four_floor+rolling_16th·euphoric) · psytrance (145·four_floor+rolling_16th·psychedelic) · progressive trance (132·four_floor·hypnotic) |
| **Drum & Bass** ✓ | liquid (174·two_step·lush) · neurofunk (174·two_step+reese·dark) · jump-up (174·two_step·bouncy) |
| **Bass / Dubstep** | dubstep (140·half_time+sub_wobble·heavy) · future bass (150·half_time+supersaw·bright) · trap-EDM (140·trap_hats+808·hard) |
| **Breakbeat** | big beat (130·breakbeat·funky) · nu skool breaks (130·breakbeat·electro) · broken beat (120·breakbeat·jazzy) |
| **UK Garage** | 2-step (130·shuffled_2step·shuffled) · speed garage (135·two_step·bassy) · future garage (135·shuffled_2step·moody) · grime (140·half_time·gritty) |
| **Hardcore** | gabber (180·gabber_kick·brutal) · happy hardcore (170·breakbeat·euphoric) · breakcore (200·amen·chaotic) |
| **Hard Dance** | hardstyle (150·gabber_kick·euphoric) · jumpstyle (145·offbeat·bouncy) |
| **Ambient** ✓ | ambient/drone (58·none·spacious) · dark ambient (55·none·ominous) · ambient dub (70·dub_skank·deep) |
| **Chill-out / Downtempo** | trip-hop (88·boom_bap·dusty) · downtempo (100·boom_bap·mellow) · psybient (100·none·psychedelic) |
| **Hip-hop Fusion** ✓ | lo-fi hip-hop ✓ (85·boom_bap·warm) · trap (140·trap_hats+808·dark) · phonk (130·boom_bap+808·cold) |
| **Disco Fusion** | nu-disco (120·four_floor·funky) · italo-disco (120·four_floor+arpeggio·retro) · french house (123·four_floor·filtered) |
| **Industrial / EBM** | EBM (128·four_floor·mechanical) · industrial techno (135·four_floor·harsh) · witch house (100·half_time·occult) |
| **IDM** | idm (variable·breakbeat·glitchy) · drill'n'bass (170·amen·frantic) |
| **Hauntology** ✓ | synthwave ✓ (100·four_floor+gated·nostalgic) · darksynth (110·four_floor·menacing) · vaporwave (70·boom_bap·hazy) |
| **Electronica** | folktronica (110·boom_bap·organic) · nu-jazz (110·boom_bap·jazzy) · berlin-school (variable·arpeggio·cosmic) |
| **Electronic Rock** ✓ | synth-pop (118·four_floor·catchy) · new wave (130·four_floor·angular) · (indie-synth-rock ✓, pop-punk ✓) |
| **Afro / Regional** | amapiano (112·log_drum·smooth) · afro house (120·four_floor·percussive) · gqom (125·four_floor·raw) |
| **Footwork / Juke** | footwork (160·rapid_808·frantic) · juke (160·rapid_808·bouncy) |
| **Dub** | dub (75·dub_skank·spacious) |
| **Video Game** ✓ | chiptune ✓ (variable·square·8bit) · bitpop (128·four_floor·chirpy) |

~24 families, ~65 flagship genres. Covered today: ~8 families / ~9 genres.

## Phases

- **Phase 0 — Foundation. ✅ DONE (2026-07-12).** `GenreSpec` + `compose_from_spec(spec, seed)`
  in `crates/cycletron-gen/src/spec.rs` / `compose.rs`; the archetype library
  (19 drum archetypes incl. ratcheted trap hats, 9 bass styles, swing via
  `.late()` splits); the 5 original genres re-derived as specs with a
  byte-identical regression test against the legacy composers; agent tool +
  `regen_corpus` read the spec registry.
- **Phase 1 — The map. ✅ DONE (2026-07-12).** Skeleton encoded as a spec tree in
  `crates/cycletron-gen/src/map.rs` (22 families / 64 genres, every entry's
  drum stack round-trip verified); `GenreSpec::derive` is the subgenre
  inherit+override mechanism; `gen_map` example renders
  `corpus/genres/_map.{md,json}` with *computed* coverage (spec / recipe /
  sketch); browsable artifact published from `_map.json`.
- **Phase 2 — Populate specs. ✅ DONE (2026-07-12, first pass).** All 64 map
  entries have full specs (`crates/cycletron-gen/src/genres.rs`, ~10 lines of
  data each via helpers): genre-appropriate scale + progression, real palette
  (synths/wavetables/gm_*), swing where styles shuffle, `dist`/`crush` where
  they bite. `MelodySpec::Arpeggio` added for trance/italo/Berlin-school.
  Every spec composes + validates across seeds; corpus-check 151/151 with 65
  generated examples under `corpus/genres/<g>/`. **Refinement backlog**: DB
  tempo/sound mining + `/research-genre` per flagship to deepen individual
  specs beyond this first musical pass.
- **Phase 3 — Generate + validate.** Per spec: recipe `.md` + example `.strudel`,
  gated by `corpus-check`. Store generated works in the DB tagged by genre.
- **Phase 4 — Payoff.** Agent composes in any genre on the map; the corpus is a
  true map.

## Data sources
1. Music knowledge (the spec params above).
2. **Supabase DB** (`MusicRepo`) — tempo bands + sound palettes per genre from
   8.3k real patterns (see project memory).
3. **`/research-genre`** skill — fans across web/theory/corpora, gates via
   corpus-check.

## Definition of done (per genre)
Spec exists → generates a `corpus-check`-passing example → recipe `.md` written →
surfaced in `search_corpus` + agent `generate_pattern(genre)`.

# Demo kit invariants

- Never use a recording under a no-derivatives (ND) licence for the player or the teaching pack: every clip is trimmed and loudness-matched, which is an adaptation the licence forbids. Every chosen recording keeps its credit in the credits list.
- A bigger teaching pack is not safer: at 20 recordings the added calls make the player's tawny owl heard as a boreal owl (3 of 5 hall mixes), while 10 and 15 pass. Change the size only through `teaching_pack.py`'s five-mix search, never by hand.
- A real board picks up a changed sound list only after the check-in that reports the new version, up to about a minute on the live site. Any stage or live step that plays a newly taught sound first waits for each board's sound list number to go up.

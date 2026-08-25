// Snickers Workwear is ordered through the Hultafors Group partner portal — the whole
// module lives in ./hultafors.js. This alias lets the backend dispatch supplier="SNICKERS"
// (and keeps the door open for Solid Gear / Hellberg, same portal) to the same automation.
//
// `export *`, NOT a hand-listed set. It used to name each export, so adding diagnose() to
// hultafors.js left mod.diagnose undefined for SNICKERS — and index.js dispatches on
// `opts.diagnose && mod.diagnose`, so the call silently FELL THROUGH to stage() and filled the
// basket instead. It looked exactly like a deploy that had not landed, and was only pinned down by
// checking which other changes from the same commit range WERE live (2026-08-25).
// Anything hultafors.js exports, Snickers gets. One less way to add a capability and lose it.
export * from './hultafors.js';

// Snickers Workwear is ordered through the Hultafors Group partner portal — the whole
// module lives in ./hultafors.js. This alias lets the backend dispatch supplier="SNICKERS"
// (and keeps the door open for Solid Gear / Hellberg, same portal) to the same automation.
export { config, login, stage, place, checkoutProbe } from './hultafors.js';

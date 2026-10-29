/**
 * One channel's queue: what plays now, and what plays after. Pure, so it can
 * be tested; the player does the playing.
 */

export class Queue {
  constructor({ max = 100, random = Math.random } = {}) {
    this.max = max;
    this.random = random;
    /** @type {object | null} */
    this.current = null;
    /** @type {object[]} */
    this.upcoming = [];
  }

  get size() {
    return this.upcoming.length;
  }

  /** Adds tracks at the end, as many as fit. Returns how many were added. */
  add(tracks) {
    const room = Math.max(0, this.max - this.upcoming.length);
    const added = tracks.slice(0, room);
    this.upcoming.push(...added);
    return added.length;
  }

  /** The next track, now current; null when there is none. */
  next() {
    this.current = this.upcoming.shift() ?? null;
    return this.current;
  }

  /** Shuffles what is still to come; what plays now stays. */
  shuffle() {
    const list = this.upcoming;
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list.length;
  }

  clear() {
    this.upcoming = [];
    this.current = null;
  }
}

// The score (the Web Audio player itself needs a browser): tempo shared with the dance, a steady beat, our own
// melody in C major, and the safety defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BPM, DEFAULT_VOLUME, FADE_IN, hitsAt, STEPS_PER_BAR, type Section } from '../src/audio/score.ts';
import { RAVE_BPM } from '../src/sim/dance.ts';

const SECTIONS: Section[] = ['intro', 'groove', 'build', 'drop', 'outro'];

test('the music and the crab rave share one tempo', () => {
  assert.equal(BPM, RAVE_BPM);
});

test('groove and drop: four on the floor, claps on two and four, offbeat bass', () => {
  for (const section of ['groove', 'drop'] as Section[]) {
    for (let bar = 0; bar < 8; bar++) {
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        const v = hitsAt(section, bar, step).map((h) => h.v);
        assert.equal(v.includes('kick'), step % 4 === 0, `${section} bar ${bar} step ${step}`);
        assert.equal(v.includes('clap'), step === 4 || step === 12);
        if (step % 4 === 2) assert.ok(v.includes('bass'));
      }
    }
  }
});

test('the lead stays in C major, and only plays in the drop', () => {
  const scale = new Set([0, 2, 4, 5, 7, 9, 11]);
  for (const section of SECTIONS) {
    for (let bar = 0; bar < 8; bar++) {
      for (let step = 0; step < STEPS_PER_BAR; step++) {
        for (const h of hitsAt(section, bar, step)) {
          if (h.v !== 'lead') continue;
          assert.equal(section, 'drop');
          assert.ok(scale.has(h.note % 12), `lead note ${h.note}`);
        }
      }
    }
  }
});

test('the build rises into the drop; the outro thins out to nothing', () => {
  assert.ok(hitsAt('build', 0, 0).some((h) => h.v === 'riser'));
  assert.ok(!hitsAt('build', 0, 2).some((h) => h.v === 'bass'), 'no bass while it builds');
  assert.deepEqual(hitsAt('outro', 4, 0), []);
});

test('safe defaults: 75 % volume, never starting at full level', () => {
  assert.equal(DEFAULT_VOLUME, 0.75);
  assert.ok(FADE_IN >= 2);
});

import { describe, expect, it } from 'vitest';
import { cleanForModel, normalize, tokenCount } from '../../../src/core/normalize';

describe('normalize', () => {
  it('folds leetspeak in letter-heavy tokens', () => {
    expect(normalize('fr33 r0bux')).toBe('free robux');
    expect(normalize('FR33 R0BUX')).toBe('free robux');
    expect(normalize('h4x0r')).toBe('haxor');
    expect(normalize('ca$h')).toBe('cash');
  });

  it('leaves numbers alone', () => {
    expect(normalize('game 1 2024')).toBe('game 1 2024');
    expect(normalize('1080p 60fps')).toBe('1080p 60fps');
    expect(normalize('$5 tip')).toBe('$5 tip');
    expect(normalize('1v1 me')).toBe('1v1 me');
  });

  it('lowercases, collapses char runs and whitespace', () => {
    expect(normalize('  SOOOOO   good!!!!!\n\t ')).toBe('soo good!!');
    expect(normalize('😂😂😂😂😂')).toBe('😂😂');
  });

  it('collapses repeated tokens to 3', () => {
    expect(normalize('KEKW KEKW KEKW KEKW KEKW KEKW')).toBe('kekw kekw kekw');
    expect(normalize('a b a b')).toBe('a b a b');
  });

  it('applies NFKC (fullwidth, math alphanumerics, circled)', () => {
    expect(normalize('ｆｒｅｅ　ｒｏｂｕｘ')).toBe('free robux');
    expect(normalize('𝐟𝐫𝐞𝐞 𝓻𝓸𝓫𝓾𝔁')).toBe('free robux');
    expect(normalize('ⓕⓡⓔⓔ')).toBe('free');
  });

  it('folds small caps and negative squared letters', () => {
    expect(normalize('ꜰʀᴇᴇ ʀᴏʙᴜx')).toBe('free robux');
    expect(normalize('🅵🆁🅴🅴')).toBe('free');
  });

  it('folds Cyrillic / Greek lookalikes only in mixed-script tokens', () => {
    // "frее" with Cyrillic е е, "РayPal" with Cyrillic Р
    expect(normalize('frее rоbux')).toBe('free robux');
    expect(normalize('РayPal')).toBe('paypal');
    // Greek omicron inside a Latin word
    expect(normalize('rοbux')).toBe('robux');
  });

  it('keeps non-Latin scripts intact', () => {
    expect(normalize('Здравей, как си?')).toBe('здравей, как си?');
    expect(normalize('сос')).toBe('сос');
    expect(normalize('こんにちは 世界')).toBe('こんにちは 世界');
    expect(normalize('καλημέρα')).toBe('καλημέρα');
    expect(normalize('안녕하세요')).toBe('안녕하세요');
    expect(normalize('مرحبا')).toBe('مرحبا');
    expect(normalize('नमस्ते')).toBe('नमस्ते');
  });

  it('strips zero-width, bidi, tag chars and zalgo', () => {
    expect(normalize('fr​ee r‍obux')).toBe('free robux');
    expect(normalize('KEKW \u{E0000}')).toBe('kekw');
    expect(normalize('‮abc')).toBe('abc');
    expect(normalize('h̷̛e̵l̴l̸o̶')).toBe('hello');
    expect(normalize('⠀⠀ hi ㅤ')).toBe('hi');
  });

  it('masks @mentions', () => {
    expect(normalize('@SomeUser hi there')).toBe('@ hi there');
    expect(normalize('hi @a and @b')).toBe('hi @ and @');
    expect(normalize('@')).toBe('@');
  });

  it('handles empty / whitespace-only input', () => {
    expect(normalize('')).toBe('');
    expect(normalize('   ​ ')).toBe('');
  });

  it('is fast (no per-call regex)', () => {
    const samples = [
      'LUL that was insane',
      'fr33 r0bux at robux.xyz',
      'KEKW KEKW KEKW',
      'Здравей, как си?',
      'こんにちは',
      'soooo goooood!!!!',
      '@streamer when is the next stream?',
      'W',
    ];
    for (let i = 0; i < 2000; i++) normalize(samples[i % samples.length]! + i); // warm up
    const n = 50_000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) normalize(samples[i % samples.length]! + (i & 63));
    const per = (performance.now() - t0) / n;
    expect(per).toBeLessThan(0.02); // < 20 µs (typically ~1 µs)
  });
});

describe('cleanForModel', () => {
  it('keeps case, script and character runs (as in training), removes invisibles', () => {
    expect(cleanForModel('Soooooooooo​ GOOD  \n !!!!!!!')).toBe('Soooooooooo GOOD !!!!!!!');
    expect(cleanForModel('Здравей')).toBe('Здравей');
    expect(cleanForModel('KEKW \u{E0000}')).toBe('KEKW');
  });
  it('caps length', () => {
    expect(cleanForModel('a b '.repeat(500)).length).toBeLessThanOrEqual(400);
  });
});

describe('tokenCount', () => {
  it('counts space separated tokens', () => {
    expect(tokenCount('')).toBe(0);
    expect(tokenCount('a')).toBe(1);
    expect(tokenCount('a b c')).toBe(3);
  });
});

// Ready-made custom filters for the Hush Engine. Each question was tuned
// against Clef-Flash on real chat lines: a definition inside the question
// ("backseating: telling the streamer how to play") keeps the model from
// matching everything that merely mentions the topic.

import type { Action } from '../../core/types';

export interface FilterPreset {
  id: string;
  label: string;
  question: string;
  action: Action;
  /** Works much better with a stream context ("Playing Elden Ring, first time"). */
  wantsContext?: boolean;
}

export const FILTER_PRESETS: FilterPreset[] = [
  {
    id: 'backseat',
    label: 'Backseating',
    question: 'Is this message backseating: telling the streamer how to play or what to do in the game?',
    action: 'hide',
  },
  {
    id: 'spoilers',
    label: 'Spoilers',
    question: 'Does this message reveal story events, plot twists, bosses or the ending that the streamer has not reached yet?',
    action: 'hide',
    wantsContext: true,
  },
  {
    id: 'politics',
    label: 'Politics',
    question: 'Is this message about politics, politicians or political controversy?',
    action: 'collapse',
  },
  {
    id: 'begging',
    label: 'Begging for subs & raids',
    question: "Is this message begging for subs, gifted subs, follows, raids or attention for the sender's own channel?",
    action: 'hide',
  },
  {
    id: 'streamers',
    label: 'Other streamers',
    question: 'Does this message mention or talk about another streamer or content creator?',
    action: 'dim',
  },
  {
    id: 'offtopic',
    label: 'Off-topic',
    question: 'Is this message about something unrelated to the stream, the game or the streamer?',
    action: 'dim',
    wantsContext: true,
  },
];

export const ENGINE_README_URL = 'https://github.com/daradudai/hush/blob/main/engine/README.md';

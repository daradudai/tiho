// Load a saved chat fixture into an isolated happy-dom Window at a given URL.
import { Window } from 'happy-dom';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.resolve(__dirname, '../../fixtures');

export interface Loaded {
  doc: Document;
  win: Window;
  close(): Promise<void>;
}

export function loadFixture(file: string, url: string): Loaded {
  const html = fs.readFileSync(path.join(DIR, file), 'utf8');
  const win = new Window({
    url,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      disableComputedStyleRendering: true,
      navigation: { disableMainFrameNavigation: true, disableChildFrameNavigation: true, disableChildPageNavigation: true },
    },
  });
  const doc = win.document as unknown as Document;
  doc.open();
  doc.write(html);
  doc.close();
  return { doc, win, close: () => win.happyDOM.close() };
}

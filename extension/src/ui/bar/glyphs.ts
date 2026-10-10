// Icons of the compact bar as CSS background images.
//
// The bar sits in a page that paints chat all the time. Every inline <svg>
// in it is a replaced box with its own viewBox transform and clip, i.e. its
// own paint chunk that the page re-walks and re-layerizes on every frame it
// paints; a background image is a single display item (bar A/B in
// tests/stress). Images are serialized once from the regular Icon component,
// with the color baked in (CSS variables do not reach into images), and
// cached per glyph / color / opacity.

import { h, render } from 'preact';
import { svgUrl } from '../brand';
import { Icon, type IconProps } from '../icons';

const cache = new Map<string, string>();

/** `url(…)` of an Icon drawn in `color` (and `opacity`), for background-image. */
export function iconImage(icon: Pick<IconProps, 'name' | 'fill' | 'strokeWidth'>, color: string, opacity = 1): string {
  const key = `${icon.name}|${icon.fill ? 1 : 0}|${icon.strokeWidth ?? ''}|${color}|${opacity}`;
  let url = cache.get(key);
  if (!url) {
    const box = document.createElement('div');
    render(h(Icon, icon), box);
    const svg = box.firstElementChild!;
    svg.removeAttribute('class');
    svg.removeAttribute('aria-hidden');
    svg.setAttribute('color', color); // currentColor inside the image
    if (opacity < 1) svg.setAttribute('opacity', String(opacity));
    url = svgUrl(new XMLSerializer().serializeToString(svg));
    render(null, box);
    cache.set(key, url);
  }
  return url;
}

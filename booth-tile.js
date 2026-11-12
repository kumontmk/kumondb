// ============================================================
// booth-tile.js — injects the "Booth Games Registration" tool
// card into the Centers page by cloning the existing ASHR card,
// so it always matches your current tool-card styling.
// Add to centers.html:  <script src="booth-tile.js" defer></script>
// ============================================================
(function () {
  'use strict';
  const TITLE = 'Booth Games Registration';
  const DESC = 'Public sign-up forms with banner, grade rules, time slots, short links, QR posters & live reports · 攤位遊戲報名';

  function inject() {
    if (document.getElementById('boothGamesTile')) return;

    // Preferred source: the ASHR tool link
    let src = Array.from(document.querySelectorAll('a[href]'))
      .find(a => /(^|\/)ashr\.html/i.test(a.getAttribute('href') || ''));

    // Fallback: a card-like element mentioning ASHR (but not the Stage Presenter)
    if (!src) {
      src = Array.from(document.querySelectorAll('a, div, li, article')).find(el =>
        /\bASHR\b/.test(el.textContent || '') &&
        !/stage/i.test(el.textContent || '') &&
        el.querySelector('h3, h4, strong'));
    }
    if (!src || !src.parentNode) return;

    const tile = src.cloneNode(true);
    tile.id = 'boothGamesTile';
    tile.setAttribute('data-booth-tile', '1');
    tile.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));

    if (tile.tagName === 'A') {
      tile.setAttribute('href', 'booth-games.html');
      tile.removeAttribute('target');
    } else {
      tile.style.cursor = 'pointer';
      tile.addEventListener('click', () => { window.location.href = 'booth-games.html'; });
    }

    // Icon
    const icon = tile.querySelector('[class*="icon"]');
    if (icon) icon.textContent = '🎪';
    else {
      const first = tile.firstElementChild;
      if (first && (first.textContent || '').trim().length <= 6) first.textContent = '🎪';
    }

    // Title
    let title = tile.querySelector('h3, h4, strong, [class*="title"]');
    if (!title) {
      title = Array.from(tile.querySelectorAll('*')).find(n =>
        n.children.length === 0 && /ASHR/.test(n.textContent || ''));
    }
    if (title) title.textContent = TITLE;

    // Description
    const desc = tile.querySelector('p, small, [class*="desc"]');
    if (desc) desc.textContent = DESC;

    src.parentNode.insertBefore(tile, src.nextSibling);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(inject, 0), { once:true });
  } else {
    setTimeout(inject, 0);
  }
})();
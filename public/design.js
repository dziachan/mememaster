/*
 * Design: Schriften, Hintergrundbild, Logo.
 * Wird im Browser (Show, Einsende-Seite, Regie) und vom Server (nur die Schriftliste) benutzt.
 */
(function (root) {
  // Mitgelieferte Schriften. group: 'd' = Überschriften, 'b' = Text. dw = Schriftstärke als Überschrift.
  const FONTS = [
    { name: 'Anton', group: 'd' },
    { name: 'Bebas Neue', group: 'd' },
    { name: 'Archivo Black', group: 'd' },
    { name: 'Bangers', group: 'd' },
    { name: 'Bungee', group: 'd' },
    { name: 'Luckiest Guy', group: 'd' },
    { name: 'Titan One', group: 'd' },
    { name: 'Permanent Marker', group: 'd' },
    { name: 'Press Start 2P', group: 'd' },
    { name: 'Unbounded', group: 'd', dw: 800 },
    { name: 'Space Grotesk', group: 'b', dw: 700 },
    { name: 'Inter', group: 'b', dw: 800 },
    { name: 'DM Sans', group: 'b', dw: 800 },
    { name: 'Outfit', group: 'b', dw: 800 },
    { name: 'Nunito', group: 'b', dw: 900 },
    { name: 'Roboto Mono', group: 'b', dw: 700 },
    { name: 'Comic Neue', group: 'b', dw: 700 },
  ];

  if (typeof module !== 'undefined' && module.exports) { module.exports = { FONTS }; return; }

  const ASSET = /^[a-f0-9]{10,32}$/;
  let faces = null;
  let lastKey = null;

  // Eigene (hochgeladene) Schriften als @font-face bereitstellen
  function ensureFaces(d) {
    if (!faces) { faces = document.createElement('style'); document.head.appendChild(faces); }
    const css = (d.fonts || []).filter((f) => ASSET.test(f.id))
      .map((f) => `@font-face{font-family:'mmc-${f.id}';src:url('/api/asset/${f.id}');font-display:swap;}`).join('');
    if (faces.textContent !== css) faces.textContent = css;
  }

  // Auswahlwert ("Anton" oder "custom:<id>") → CSS-Schriftname + Stärke für Überschriften
  function resolve(value, d) {
    const v = String(value || '');
    if (v.startsWith('custom:')) {
      const f = (d.fonts || []).find((x) => 'custom:' + x.id === v);
      return f && ASSET.test(f.id) ? { family: 'mmc-' + f.id, dw: 400 } : null;
    }
    const f = FONTS.find((x) => x.name === v);
    return f ? { family: f.name, dw: f.dw || 400 } : null;
  }

  // Das Layout ist auf die schmale Schrift "Anton" abgestimmt. Breitere Schriften werden automatisch
  // so weit verkleinert, dass große Texte denselben Platz brauchen.
  async function autoScale(family, dw) {
    if (family === 'Anton') return 1;
    try {
      await Promise.all([document.fonts.load('400 100px "Anton"'), document.fonts.load(`${dw} 100px "${family}"`)]);
    } catch (e) {}
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = 'MEME MASTER #12 7,16';
    ctx.font = '400 100px "Anton"';
    const a = ctx.measureText(sample).width;
    ctx.font = `${dw} 100px "${family}", "Anton"`;
    const b = ctx.measureText(sample).width;
    return b > 0 ? Math.max(0.35, Math.min(1.15, a / b)) : 1;
  }

  // Farben: Hex → RGB, und die besser lesbare Schriftfarbe (dunkel oder hell) für Flächen in dieser Farbe
  function rgb(hex) {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null;
  }
  function inkOn(c) {
    const lin = c.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
    const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#12130c' : '#ffffff';
  }

  async function apply(d) {
    if (!d) return;
    const key = JSON.stringify(d);
    if (key === lastKey) return;
    lastKey = key;
    ensureFaces(d);
    const css = document.documentElement.style;
    const disp = resolve(d.fontDisplay, d) || { family: 'Anton', dw: 400 };
    const body = resolve(d.fontBody, d) || { family: 'Space Grotesk', dw: 700 };
    css.setProperty('--display', `'${disp.family}', 'Anton', Impact, sans-serif`);
    css.setProperty('--body', `'${body.family}', 'Space Grotesk', system-ui, sans-serif`);
    css.setProperty('--dw', disp.dw);

    const acc = rgb(d.accent) || [212, 255, 63];
    css.setProperty('--acid', `rgb(${acc.join(',')})`);
    css.setProperty('--acid-ink', inkOn(acc));
    css.setProperty('--acid-glow', `rgba(${acc.join(',')},.10)`);
    const acc2 = rgb(d.accent2) || [255, 77, 141];
    css.setProperty('--pink', `rgb(${acc2.join(',')})`);

    const hasBg = ASSET.test(d.bg || '');
    css.setProperty('--bgimg', hasBg ? `url('/api/asset/${d.bg}')` : 'none');
    css.setProperty('--bgdim', String(Math.max(0, Math.min(95, Number(d.bgDim) || 0)) / 100));
    document.documentElement.classList.toggle('has-bg', hasBg);

    const hasLogo = ASSET.test(d.logo || '');
    document.querySelectorAll('[data-logo]').forEach((el) => {
      if (el._orig == null) el._orig = el.innerHTML;
      if (hasLogo) {
        if (el.dataset.logoId === d.logo) return;
        el.textContent = '';
        const img = document.createElement('img');
        img.src = '/api/asset/' + d.logo;
        img.alt = 'Logo';
        el.appendChild(img);
        el.dataset.logoId = d.logo;
        el.classList.add('is-logo');
      } else if (el.dataset.logoId) {
        el.innerHTML = el._orig;
        delete el.dataset.logoId;
        el.classList.remove('is-logo');
      }
    });

    const scale = await autoScale(disp.family, disp.dw);
    if (key !== lastKey) return; // inzwischen wurde ein neueres Design angewendet
    const user = Math.max(50, Math.min(140, Number(d.displayScale) || 100)) / 100;
    css.setProperty('--ds', (scale * user).toFixed(3));
  }

  root.MMDesign = { FONTS, apply, resolve, ensureFaces };
})(typeof window !== 'undefined' ? window : globalThis);

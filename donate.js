'use strict';

const api = window.ar;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function init() {
  const { crypto, links } = await api.donate();

  document.getElementById('crypto').append(...crypto.map((c, i) => {
    const copy = el('button', { textContent: 'Копіювати адресу' });
    copy.onclick = async () => {
      await api.donateCopy(i);
      copy.textContent = '✓ Скопійовано';
      copy.classList.add('done');
      setTimeout(() => {
        copy.textContent = 'Копіювати адресу';
        copy.classList.remove('done');
      }, 1600);
    };
    return el('div', { className: 'coin' },
      el('img', { src: c.qr, alt: `QR ${c.name}` }),
      el('div', {},
        el('b', { textContent: c.name }),
        el('span', { className: 'net', textContent: c.network }),
        el('div', { className: 'addr', textContent: c.address }),
        copy));
  }));

  const box = document.getElementById('links');
  box.append(...links.map((name, i) => el('button', { textContent: name, onclick: () => api.donateOpen(i) })));
  box.hidden = !links.length;

  addEventListener('keydown', e => e.key === 'Escape' && window.close());
  await Promise.all([...document.images].map(img => img.decode().catch(() => {})));
  api.donateReady(document.documentElement.scrollHeight);
}

init();

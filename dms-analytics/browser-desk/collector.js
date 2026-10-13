void (async function () {
  'use strict';
  const supported = /^\/work\/web\/r\/libraries\/[^/]+\/folders\/[^/]+$/;
  if (location.origin !== 'https://dms.byrnewallace.com' || !supported.test(location.pathname)) {
    alert('Open a document folder in your signed-in iManage browser first.'); return;
  }
  const folder = location.pathname, started = new Date().toISOString();
  const visible = e => e && !e.closest('.ng-hide') && e.getClientRects().length > 0;
  const rows = selector => [...document.querySelectorAll(selector)].filter(visible);
  const pageNumber = () => Number(new URL(location.href).searchParams.get('p') || 1);
  const signature = () => rows('ws-row').map(e => e.innerText).join('\n');
  const get = (row, label) => { const e = row.querySelector('[title="' + label + '"]'); return visible(e) ? e.innerText.trim() : ''; };
  const read = () => {
    if (location.pathname !== folder) throw Error('Folder changed during collection.');
    const count = document.body.innerText.match(/([\d,]+) items/);
    if (!count) throw Error('Cannot verify the folder item count.');
    return {source_url: location.origin + folder, page: pageNumber(), displayed_total: Number(count[1].replace(/,/g, '')), rendered_items: rows('ws-row').length,
      columns: ['document_number','version','edit_date','file_size','last_user','extension'],
      rows: rows('.ws-document-row').map(r => [get(r,'Document Number').replace(/[^0-9]/g,''), get(r,'Version').replace(/^v/,''), get(r,'Edit Date'), get(r,'File Size'), get(r,'Last User') || get(r,'Checkout User'), (r.querySelector('.ws-name')?.innerText.trim().match(/\.([A-Za-z0-9]+)$/) || [])[1]?.toLowerCase() || 'unknown'])};
  };
  const move = async (selector, expected) => {
    const button = rows(selector)[0], oldSignature = signature();
    if (!button || button.getAttribute('aria-disabled') === 'true') throw Error('Pagination control is unavailable.');
    button.click();
    let stable = '', repeats = 0;
    for (let i = 0; i < 60; i++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      const current = signature();
      if (pageNumber() === expected && current && current !== oldSignature) {
        repeats = current === stable ? repeats + 1 : 0; stable = current;
        if (repeats >= 3) return;
      }
    }
    throw Error('The next page did not finish loading. Nothing was imported.');
  };
  try {
    if (pageNumber() > 200) throw Error('This collector supports at most 200 pages at a time.');
    while (pageNumber() > 1) await move('a.previousButton', pageNumber() - 1);
    const pages = [];
    for (let i = 0; i < 200; i++) {
      pages.push(read());
      if (!rows('a.nextButton').length) break;
      if (i === 199) throw Error('Folder exceeds the 200-page collection limit.');
      await move('a.nextButton', pageNumber() + 1);
    }
    const total = pages[0].displayed_total;
    if (pages.some(p => p.displayed_total !== total) || pages.reduce((s,p) => s+p.rendered_items,0) !== total) throw Error('Folder counts changed or some rows were not rendered. Please refresh and collect again.');
    const capture = {captured_at: started, completed_at: new Date().toISOString(), pages};
    const blob = new Blob([JSON.stringify(capture, null, 2)], {type:'application/json'});
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'imanage-folder-' + started.replace(/[:.]/g,'-') + '.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    alert('Collected ' + pages.reduce((s,p) => s+p.rows.length,0) + ' documents across ' + pages.length + ' pages. Import the downloaded JSON into BWS DMS Desk.');
  } catch (error) { alert('Collection stopped: ' + error.message); }
})();

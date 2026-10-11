/* Toolbar popup: reads the address of the current tab (activeTab grants that on the click) and opens the viewer. */
(async function () {
  'use strict';
  const Url = globalThis.RepoDagUrl;
  const $ = (id) => document.getElementById(id);
  const status = $('status');

  function openViewer(query) {
    chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html' + query) }).then(
      () => window.close(),
      () => {
        status.textContent = 'The viewer tab could not be opened. Try again.';
      }
    );
  }

  $('local').addEventListener('click', () => openViewer('?local=1'));

  let found = null;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    found = tab && typeof tab.url === 'string' ? Url.parseRepoUrl(tab.url) : null;
  } catch (_) {
    found = null;
  }
  if (found) {
    $('repo').textContent = found.owner + '/' + found.repo + (found.ref === 'HEAD' ? '' : ' at ' + found.ref);
    $('on-repo').hidden = false;
    $('map').addEventListener('click', () => openViewer(Url.viewerQuery(found.owner, found.repo, found.ref)));
    $('map').focus();
  } else {
    $('off-repo').hidden = false;
  }
})();

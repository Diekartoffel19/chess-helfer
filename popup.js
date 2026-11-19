const DEFAULTS = {
  enabled: true,
  autoMove: false,
  autoMoveDelay: 0,
  movetime: 1000,
  multipv: 3,
  inaccuracyRate: 0,
  maxLoss: 120,
};
const SELECT_IDS = ['autoMoveDelay', 'movetime', 'multipv', 'inaccuracyRate', 'maxLoss'];

function syncDisabled() {
  document.getElementById('autoMoveDelay').disabled = !document.getElementById('autoMove').checked;
  document.getElementById('maxLoss').disabled = document.getElementById('inaccuracyRate').value === '0';
}

chrome.storage.sync.get(DEFAULTS).then((s) => {
  document.getElementById('enabled').checked = s.enabled;
  document.getElementById('autoMove').checked = s.autoMove;
  for (const id of SELECT_IDS) {
    document.getElementById(id).value = String(s[id]);
  }
  syncDisabled();
});

for (const id of ['enabled', 'autoMove']) {
  document.getElementById(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: e.target.checked });
    if (id === 'autoMove') syncDisabled();
  });
}
for (const id of SELECT_IDS) {
  document.getElementById(id).addEventListener('change', (e) => {
    chrome.storage.sync.set({ [id]: Number(e.target.value) });
    if (id === 'inaccuracyRate') syncDisabled();
  });
}

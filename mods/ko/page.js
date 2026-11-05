// ko mod page script. The loader runs this file as the body of function (omoMods) { ... } in the isolated world.
// It only changes the nodeValue of text nodes and the aria-label/title/placeholder attributes; it never wraps or
// replaces a node, so React keeps its nodes. Translations come from host.mjs. Untranslated text is recorded only
// on the settings screens (#/settings...): chat content is not dictionary material.
var FLIP_LIMIT = 3;
var FLIP_WINDOW_MS = 1000;
var BATCH_MAX = 500;
var ATTRS = ['aria-label', 'title', 'placeholder'];
var exclusion = null;
var queue = [];
var scheduled = false;
var states = new WeakMap();

function stateOf(node, attr) {
  var byKey = states.get(node);
  if (!byKey) states.set(node, (byKey = new Map()));
  var s = byKey.get(attr || '');
  if (!s) byKey.set(attr || '', (s = { origin: null, written: null, flips: [], stopped: false, queued: false }));
  return s;
}
function read(node, attr) {
  return attr ? node.getAttribute(attr) : node.nodeValue;
}
function write(node, attr, value) {
  if (attr) node.setAttribute(attr, value);
  else node.nodeValue = value;
}
function excluded(node, attr) {
  if (!attr) return node.parentElement === null || node.parentElement.closest(exclusion) !== null;
  // An input's own placeholder is translated; only an excluded ancestor stops it.
  if (node.matches('input, textarea')) return node.parentElement !== null && node.parentElement.closest(exclusion) !== null;
  return node.closest(exclusion) !== null;
}
// React writing the English back more than FLIP_LIMIT times within FLIP_WINDOW_MS stops this node for good.
function flipped(s, attr) {
  var now = Date.now();
  s.flips = s.flips.filter(function (t) { return now - t <= FLIP_WINDOW_MS; });
  s.flips.push(now);
  if (s.flips.length > FLIP_LIMIT && !s.stopped) {
    s.stopped = true;
    performance.mark('ko:loop-stopped', { detail: { kind: attr || 'text', text: (s.origin || '').slice(0, 80) } });
  }
  return s.stopped;
}
function consider(node, attr) {
  var s = stateOf(node, attr);
  var value = read(node, attr);
  if (s.stopped || s.queued || value === null || value.trim() === '' || value === s.written) return;
  if (excluded(node, attr)) return;
  if (s.origin !== null && value === s.origin && flipped(s, attr)) return;
  s.queued = true;
  queue.push({ node: node, attr: attr, state: s });
  schedule();
}
function visit(root) {
  if (root.nodeType === Node.TEXT_NODE) return consider(root, null);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  var holders = [root].concat(Array.prototype.slice.call(root.querySelectorAll('[aria-label], [title], [placeholder]')));
  holders.forEach(function (el) {
    ATTRS.forEach(function (a) { if (el.hasAttribute(a)) consider(el, a); });
  });
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (var n = walker.nextNode(); n; n = walker.nextNode()) consider(n, null);
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestIdleCallback(sendBatch, { timeout: 250 });
}
function sendBatch() {
  scheduled = false;
  var items = queue.splice(0, BATCH_MAX);
  if (queue.length > 0) schedule();
  if (items.length === 0) return;
  var sent = items.map(function (item) { return read(item.node, item.attr); });
  var record = location.hash.indexOf('#/settings') === 0;
  omoMods.call('translate', [sent, { record: record }]).then(
    function (out) { requestIdleCallback(function () { apply(items, sent, out); }, { timeout: 250 }); },
    function (err) {
      items.forEach(function (item) { item.state.queued = false; });
      console.error('ko mod: translate failed: ' + err.message);
    },
  );
}
function apply(items, sent, out) {
  items.forEach(function (item, i) {
    var s = item.state;
    s.queued = false;
    if (s.stopped) return;
    var current = read(item.node, item.attr);
    if (current !== sent[i]) return consider(item.node, item.attr);
    if (out[i] === current) return;
    s.origin = current;
    write(item.node, item.attr, out[i]);
    s.written = out[i];
  });
}

var observer = new MutationObserver(function (records) {
  records.forEach(function (r) {
    if (r.type === 'childList') r.addedNodes.forEach(visit);
    else if (r.type === 'characterData') consider(r.target, null);
    else consider(r.target, r.attributeName);
  });
});

omoMods.call('config', []).then(
  function (cfg) {
    exclusion = cfg.exclusionSelectors.join(', ');
    visit(document.documentElement);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  },
  function (err) { console.error('ko mod: config failed: ' + err.message); },
);

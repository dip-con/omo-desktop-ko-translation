// ko mod page. The loader runs this file as the body of function (omoMods) { ... } in the isolated world.
// It changes the nodeValue of text nodes and the value of aria-label/title/placeholder only. It never wraps or
// replaces a node, so React-managed text keeps its node. Translations come from host.mjs (method translate).
var FLIP_LIMIT = 3;
var FLIP_WINDOW_MS = 1000;
var BATCH_MAX = 500;
var ATTRS = ['aria-label', 'title', 'placeholder'];
var ATTR_SELECTOR = '[aria-label], [title], [placeholder]';
var exclusion = null;
var queue = [];
var scheduled = false;
var inflight = 0;
var states = new WeakMap();

function stateOf(node, attr) {
  var byKey = states.get(node);
  if (!byKey) {
    byKey = new Map();
    states.set(node, byKey);
  }
  var key = attr || '';
  var s = byKey.get(key);
  if (!s) {
    s = { origin: null, written: null, flips: [], stopped: false, queued: false };
    byKey.set(key, s);
  }
  return s;
}
function currentValue(node, attr) {
  return attr ? node.getAttribute(attr) : node.nodeValue;
}
function writeValue(node, attr, value) {
  if (attr) node.setAttribute(attr, value);
  else node.nodeValue = value;
}
function excluded(node, attr) {
  if (attr) {
    var el = node;
    // Inputs and textareas are excluded only when an ancestor is in a zone; their own placeholder is a target.
    if (el.matches('input, textarea')) return el.parentElement !== null && el.parentElement.closest(exclusion) !== null;
    return el.closest(exclusion) !== null;
  }
  return node.parentElement === null || node.parentElement.closest(exclusion) !== null;
}
// True once the node has flipped back to English more than FLIP_LIMIT times within FLIP_WINDOW_MS.
function registerFlip(s, node, attr) {
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
  if (s.stopped) return;
  var value = currentValue(node, attr);
  if (value === null || value.trim() === '') return;
  if (value === s.written) return;
  if (excluded(node, attr)) return;
  if (s.origin !== null && value === s.origin && registerFlip(s, node, attr)) return;
  if (s.queued) return;
  s.queued = true;
  queue.push({ node: node, attr: attr, state: s });
  schedule();
}
function visit(root) {
  if (root.nodeType === Node.TEXT_NODE) return consider(root, null);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  var attrHolders = root.querySelectorAll(ATTR_SELECTOR);
  var all = [root].concat(Array.prototype.slice.call(attrHolders));
  all.forEach(function (el) {
    ATTRS.forEach(function (a) { if (el.hasAttribute(a)) consider(el, a); });
  });
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (var n = walker.nextNode(); n; n = walker.nextNode()) consider(n, null);
}
function settle() {
  if (inflight === 0 && queue.length === 0 && !scheduled) performance.mark('ko:idle');
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
  if (items.length === 0) return settle();
  var sent = items.map(function (item) { return currentValue(item.node, item.attr); });
  inflight += 1;
  // Untranslated text is collected only on the settings screens; chat content is not dictionary material.
  var record = location.hash.indexOf('#/settings') === 0;
  omoMods.call('translate', [sent, { record: record }]).then(
    function (out) { applyBatch(items, sent, out); },
    function (err) {
      inflight -= 1;
      items.forEach(function (item) { item.state.queued = false; });
      console.error('ko mod: translate failed: ' + err.message);
      settle();
    },
  );
}
function applyBatch(items, sent, out) {
  requestIdleCallback(function () {
    performance.mark('ko:start');
    items.forEach(function (item, i) {
      var s = item.state;
      s.queued = false;
      if (s.stopped) return;
      var current = currentValue(item.node, item.attr);
      if (current !== sent[i]) return consider(item.node, item.attr);
      if (out[i] === current) return;
      s.origin = current;
      writeValue(item.node, item.attr, out[i]);
      s.written = out[i];
    });
    performance.mark('ko:end');
    performance.measure('ko:batch', 'ko:start', 'ko:end');
    performance.clearMarks('ko:start');
    performance.clearMarks('ko:end');
    inflight -= 1;
    settle();
  }, { timeout: 250 });
}

var observer = new MutationObserver(function (records) {
  records.forEach(function (r) {
    if (r.type === 'childList') r.addedNodes.forEach(visit);
    else if (r.type === 'characterData') consider(r.target, null);
    else if (r.type === 'attributes') consider(r.target, r.attributeName);
  });
});

omoMods.call('config', []).then(
  function (cfg) {
    exclusion = cfg.exclusionSelectors.join(', ');
    visit(document.documentElement);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
    settle();
  },
  function (err) { console.error('ko mod: config failed: ' + err.message); },
);

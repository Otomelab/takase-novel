// 全選択肢を歩き、3つの終わりがすべて到達でき、本文が空にならないことを確認する。
// 使い方: node js/simulate.js
var fs = require('fs');
var path = require('path');
var vm = require('vm');

var Branching = require('./branching.js');
var sandbox = { window: {}, console: console, Branching: Branching };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'scenario.js'), 'utf8'), sandbox);
var scenario = sandbox.window.SCENARIO;

if (!scenario || !scenario.nodes[scenario.start]) {
  console.error('scenario failed to load');
  process.exit(1);
}

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

var counts = { normal: 0, almost: 0, awkward: 0 };
var routes = [];

function readText(line, state, where) {
  var text = typeof line.text === 'function' ? line.text(state) : line.text;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('empty text at ' + where);
  }
  if (typeof line.face === 'function') {
    var face = line.face(state);
    if (typeof face !== 'string' || !face) throw new Error('empty face at ' + where);
  }
  return text;
}

function walk(nodeId, state, route) {
  if (route.length > 12) throw new Error('route too deep ' + route.join(' > '));
  if (nodeId === 'pulseGate' && state.bpm < Branching.PULSE_BPM) {
    throw new Error('pulse gate opened at bpm ' + state.bpm + ' via ' + route.join(' > '));
  }
  var node = scenario.nodes[nodeId];
  if (!node) throw new Error('missing node ' + nodeId + ' via ' + route.join(' > '));
  var lines = node.lines;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line.when && !line.when(state)) {
      if (line.choices || line.goto) throw new Error('cannot skip a branching line at ' + nodeId);
      continue;
    }
    if (line.apply) Branching.applyDelta(state, line.apply);
    if (line.applyFn) line.applyFn(state);
    readText(line, state, nodeId + '#' + i + ' [' + route.join(' > ') + ']');
    if (line.choices) {
      if (i !== lines.length - 1) throw new Error('choices must be the last line of ' + nodeId);
      var visible = line.choices.filter(function (choice) {
        return !choice.when || choice.when(state);
      });
      if (!visible.length) {
        if (!line.fallback) throw new Error('no visible choice and no fallback at ' + nodeId);
        walk(line.fallback, state, route);
        return;
      }
      visible.forEach(function (choice) {
        if (choice.id === 'c_return' && state.bpm < Branching.PULSE_BPM) {
          throw new Error('pulse return offered at bpm ' + state.bpm);
        }
        var next = clone(state);
        if (choice.apply) Branching.applyDelta(next, choice.apply);
        if (choice.applyFn) choice.applyFn(next);
        var nextRoute = route.concat(choice.id);
        if (choice.next === 'resolve') {
          var ending = Branching.resolveEnding(next);
          if (!counts.hasOwnProperty(ending)) throw new Error('unknown ending ' + ending);
          counts[ending] += 1;
          var note = scenario.notes(next, ending);
          if (!note.secretNote || !note.publicNote || !note.title) {
            throw new Error('incomplete note for ' + ending);
          }
          routes.push({
            route: nextRoute.join(' > '),
            ending: ending,
            bpm: next.bpm,
            reason: next.reason,
            cross: next.cross,
            wall: next.wall,
            slip: next.slip,
            pulseReturned: next.pulseReturned,
            secret: note.secretNote
          });
          walk(scenario.endingNode[ending], next, nextRoute.concat(ending));
        } else {
          walk(choice.next, next, nextRoute);
        }
      });
      return;
    }
    if (line.goto) {
      var dest = typeof line.goto === 'function' ? line.goto(state) : line.goto;
      walk(dest, state, route);
      return;
    }
  }
  if (nodeId.indexOf('end_') === 0 && !lines[lines.length - 1].card) {
    throw new Error(nodeId + ' is missing the ending card');
  }
}

Object.keys(scenario.endingNode).forEach(function (key) {
  if (!scenario.nodes[scenario.endingNode[key]]) {
    throw new Error('ending node missing for ' + key);
  }
});

walk(scenario.start, Branching.initialState(), []);

var expected = {
  'c1_train > c2_stay > c3_bed > c4_soften': 'normal',
  'c1_yield > c2_name > c_hold > c3_bed > c4_soften': 'normal',
  'c1_yield > c2_stay > c_return > c3_bed > c4_soften': 'almost',
  'c1_both > c2_name > c_hold > c3_ask > c4_soften': 'almost',
  'c1_train > c2_pull > c3_leave': 'awkward',
  'c1_yield > c2_name > c_hold > c3_bed > c4_stop': 'awkward',
  'c1_yield > c2_stay > c_return > c3_leave': 'awkward',
  'c1_both > c2_stay > c3_leave': 'normal',
  'c1_train > c2_pull > c3_ask > c4_soften': 'normal',
  'c1_train > c2_pull > c3_bed > c4_stop': 'awkward'
};

var byRoute = {};
routes.forEach(function (row) { byRoute[row.route] = row; });
Object.keys(expected).forEach(function (route) {
  var row = byRoute[route];
  if (!row) throw new Error('missing route ' + route);
  if (row.ending !== expected[route]) {
    throw new Error(route + ' → ' + row.ending + ' (expected ' + expected[route] + ') ' + JSON.stringify(row));
  }
});

['normal', 'almost', 'awkward'].forEach(function (ending) {
  if (!counts[ending]) throw new Error(ending + ' is unreachable');
});

var secrets = {};
routes.forEach(function (row) {
  if (!secrets[row.ending]) secrets[row.ending] = row.secret;
});
if (secrets.normal === secrets.almost || secrets.almost === secrets.awkward || secrets.normal === secrets.awkward) {
  throw new Error('secret notes are not distinct');
}

var calm = Branching.initialState();
var hot = Branching.applyDelta(Branching.initialState(), { bpm: 40, reason: -50, cross: 2 });
var calmNote = scenario.notes(calm, null).secretNote;
var hotNote = scenario.notes(hot, null).secretNote;
if (calmNote === hotNote) throw new Error('provisional notes ignore parameters');

routes.forEach(function (row) {
  if (row.route.indexOf('c_return') < 0) return;
  var ok = row.route.indexOf('c1_yield > c2_stay') === 0 ||
    row.route.indexOf('c1_yield > c2_name') === 0 ||
    row.route.indexOf('c1_both > c2_name') === 0;
  if (!ok) throw new Error('pulse return on a cool path: ' + row.route);
});
if (!routes.some(function (row) { return row.route.indexOf('c_return') >= 0; })) {
  throw new Error('pulse return is unreachable');
}
if (byRoute['c1_train > c2_stay > c3_bed > c4_soften'].route.indexOf('c_return') >= 0) {
  throw new Error('low-bpm route offered the pulse return');
}

var voiceLines = [];
Object.keys(scenario.nodes).forEach(function (id) {
  scenario.nodes[id].lines.forEach(function (line) {
    if (line.checkVoice) voiceLines.push(line);
  });
});
if (voiceLines.length < 2) throw new Error('expected voice-checked lines');
voiceLines.forEach(function (line) {
  var samples = [90, 70, 52, 30].map(function (reason) {
    var state = Branching.initialState();
    state.reason = reason;
    state.bpm = 100;
    return line.text(state);
  });
  if (samples[0].indexOf('ます') < 0) throw new Error('polite line missing ます: ' + samples[0]);
  if (samples[1].indexOf('……') < 0) throw new Error('cracked line missing a break: ' + samples[1]);
  if (samples[2].indexOf('俺') < 0) throw new Error('mixed line missing 俺: ' + samples[2]);
  if (samples[3].indexOf('です') >= 0 || samples[3].indexOf('ます') >= 0) {
    throw new Error('casual line still polite: ' + samples[3]);
  }
  var unique = {};
  samples.forEach(function (text) { unique[text] = 1; });
  if (Object.keys(unique).length !== 4) throw new Error('speech bands collapsed: ' + samples.join(' / '));
});

function transcript(choiceIds) {
  var state = Branching.initialState();
  var lines = [];
  var guard = 0;
  var ids = choiceIds.slice();
  function step(nodeId) {
    if (guard++ > 40) throw new Error('transcript loop');
    var node = scenario.nodes[nodeId];
    for (var i = 0; i < node.lines.length; i++) {
      var line = node.lines[i];
      if (line.when && !line.when(state)) {
        if (line.choices || line.goto) throw new Error('cannot skip a branching line at ' + nodeId);
        continue;
      }
      if (line.apply) Branching.applyDelta(state, line.apply);
      if (line.applyFn) line.applyFn(state);
      var text = typeof line.text === 'function' ? line.text(state) : line.text;
      lines.push((line.speaker || '　') + '｜' + text);
      if (line.choices) {
        var id = ids.shift();
        var choice = line.choices.filter(function (item) {
          return item.id === id && (!item.when || item.when(state));
        })[0];
        if (!choice) throw new Error('cannot take ' + id + ' at ' + nodeId + ' bpm=' + state.bpm);
        lines.push('選択｜' + choice.text);
        if (choice.apply) Branching.applyDelta(state, choice.apply);
        if (choice.next === 'resolve') {
          var ending = Branching.resolveEnding(state);
          lines.push('判定｜' + ending + '　脈' + state.bpm + '　理性' + state.reason + '　' + Branching.speechBand(state.reason));
          step(scenario.endingNode[ending]);
        } else {
          step(choice.next);
        }
        return;
      }
      if (line.goto) {
        step(typeof line.goto === 'function' ? line.goto(state) : line.goto);
        return;
      }
    }
  }
  step(scenario.start);
  if (ids.length) throw new Error('unused choices ' + ids.join(','));
  return lines.join('\n');
}

var normalScript = transcript(['c1_train', 'c2_stay', 'c3_bed', 'c4_soften']);
var almostScript = transcript(['c1_yield', 'c2_stay', 'c_return', 'c3_bed', 'c4_soften']);
var awkwardScript = transcript(['c1_train', 'c2_pull', 'c3_leave']);
['大円筋', '小胸筋', '橈骨動脈'].forEach(function (term) {
  if (normalScript.indexOf(term) < 0) throw new Error('normal route never names ' + term);
});
if (almostScript.indexOf('だろ') < 0) throw new Error('almost route never breaks into casual speech');
if (almostScript.indexOf('ます') < 0) throw new Error('almost route never starts polite');
if (almostScript.indexOf('由衣さんが決めて') < 0) throw new Error('almost invite still decides for her');
if (almostScript.indexOf('今のは、施術じゃない。悪い') < 0) throw new Error('almost route never pulls the hand back');
if (almostScript.indexOf('名前のないところには、行かない') < 0) throw new Error('almost route lost the named-muscle line');
['来るだろ', '震えたまま', '止まらない', '漏らせ', '時計、どおり'].forEach(function (banned) {
  if (almostScript.indexOf(banned) >= 0) throw new Error('almost route still contains ' + banned);
});
if (normalScript.indexOf('漏らせ') >= 0 || normalScript.indexOf('時計、どおり') >= 0) {
  throw new Error('typos remain on the normal route');
}
if (normalScript.indexOf('時計どおり') < 0 || normalScript.indexOf('漏らしている') < 0) {
  throw new Error('typo fixes missing on the normal route');
}
if (normalScript.indexOf('施術じゃない') >= 0) throw new Error('calm route showed the slip apology');
if (awkwardScript.indexOf('c_return') >= 0 || awkwardScript.indexOf('橈骨動脈に当てる') >= 0) {
  throw new Error('awkward distance route took his pulse');
}
var stopScript = transcript(['c1_yield', 'c2_name', 'c_hold', 'c3_bed', 'c4_stop']);
if (stopScript.indexOf('今のは、施術じゃない。悪い') < 0) throw new Error('stop route never pulls the hand back');
if (stopScript.indexOf('語尾と同時に離れた') < 0) throw new Error('stop route does not release at her word');
if (stopScript.indexOf('断られたあとに、彼は触っていない') < 0) throw new Error('stop route still reads as ignoring a no');
['居座', '半秒、遅かった', '来るだろ', '震えたまま'].forEach(function (banned) {
  if (stopScript.indexOf(banned) >= 0) throw new Error('stop route still contains ' + banned);
});

console.log('paths ' + routes.length);
console.log('endings ' + JSON.stringify(counts));
console.log('canonical routes ok');
routes.forEach(function (row) {
  console.log(row.ending + '\t' + row.route + '\tbpm=' + row.bpm + ' reason=' + row.reason + ' cross=' + row.cross + ' wall=' + row.wall + ' slip=' + row.slip + ' pulse=' + row.pulseReturned);
});
fs.writeFileSync('/tmp/vn-transcripts.txt',
  '=== 店じまいの笑顔 ===\n' + normalScript +
  '\n\n=== 寸前 ===\n' + almostScript +
  '\n\n=== 空いた枠 ===\n' + awkwardScript +
  '\n\n=== 空いた枠（やめてください） ===\n' + stopScript + '\n');

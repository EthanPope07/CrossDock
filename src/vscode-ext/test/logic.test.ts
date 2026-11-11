import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { FrameDecoder, encodeFrame } from '../src/jsonrpc';
import { checkHostKey } from '../src/knownHosts';
import { PathMapper } from '../src/pathMap';
import { rewriteIncoming, rewriteOutgoing } from '../src/session';

// ---------------------------------------------------------------- framing
test('framing: multi-byte UTF-8, frames split at every byte, several frames per chunk', () => {
  const msgs = ['{"a":"héllo ✓ 日本語"}', '{"b":2}', '{"c":[1,2,3]}'];
  const wire = Buffer.concat(msgs.map((m) => encodeFrame(m)));
  const d = new FrameDecoder();
  const got: string[] = [];
  for (const byte of wire) for (const body of d.push(Buffer.from([byte]))) got.push(body.toString('utf8'));
  assert.deepEqual(got, msgs);
  const d2 = new FrameDecoder();
  assert.deepEqual(d2.push(wire).map((b) => b.toString('utf8')), msgs);
});

test('framing: tolerates extra headers, rejects missing Content-Length', () => {
  const d = new FrameDecoder();
  const body = '{"ok":true}';
  const framed = Buffer.from(`Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  assert.equal(d.push(framed)[0].toString(), body);
  assert.throws(() => new FrameDecoder().push(Buffer.from('Bogus: 1\r\n\r\n{}')), /Content-Length/);
});

// ---------------------------------------------------------------- path map
const WIN = 'C:\\Users\\dev\\proj';
const MAC = '/Users/me/proj';

test('pathmap: URIs round-trip in the forms VS Code and sourcekit-lsp use', () => {
  const m = new PathMapper(WIN, MAC);
  for (const local of ['file:///c%3A/Users/dev/proj/Sources/App.swift', 'file:///c:/Users/dev/proj/Sources/App.swift', 'file:///C%3A/Users/dev/proj/Sources/App.swift']) {
    assert.equal(m.toRemoteString(local), 'file:///Users/me/proj/Sources/App.swift', local);
  }
  assert.equal(m.toLocalString('file:///Users/me/proj/Sources/App.swift'), 'file:///c%3A/Users/dev/proj/Sources/App.swift');
});

test('pathmap: spaces, plain paths with backslashes, and the workspace root itself', () => {
  const m = new PathMapper('C:\\My Projects\\app', '/Users/me/My Projects/app');
  assert.equal(m.toRemoteString('file:///c%3A/My%20Projects/app/a%20b.swift'), 'file:///Users/me/My%20Projects/app/a%20b.swift');
  const m2 = new PathMapper(WIN, MAC);
  assert.equal(m2.toRemoteString('C:\\Users\\dev\\proj\\Sources\\App.swift'), '/Users/me/proj/Sources/App.swift');
  assert.equal(m2.toRemoteString('file:///c%3A/Users/dev/proj'), 'file:///Users/me/proj');
  assert.equal(m2.toLocalString('error in /Users/me/proj/Sources/App.swift:3'), 'error in C:/Users/dev/proj/Sources/App.swift:3');
});

test('pathmap: does not touch look-alike prefixes or unrelated URIs', () => {
  const m = new PathMapper(WIN, MAC);
  assert.equal(m.toRemoteString('file:///c%3A/Users/dev/proj-other/x.swift'), 'file:///c%3A/Users/dev/proj-other/x.swift');
  assert.equal(m.toLocalString('file:///Users/me/proj2/x.swift'), 'file:///Users/me/proj2/x.swift');
  assert.equal(m.toLocalString('file:///Applications/Xcode.app/x.swiftinterface'), 'file:///Applications/Xcode.app/x.swiftinterface');
  assert.equal(m.toRemoteString('untitled:Untitled-1'), 'untitled:Untitled-1');
});

test('pathmap: rewrites deep values and object keys (WorkspaceEdit.changes)', () => {
  const m = new PathMapper(WIN, MAC);
  const edit = { changes: { 'file:///Users/me/proj/a.swift': [{ newText: 'x', range: { start: { line: 1, character: 2 } } }] }, n: 5, ok: true, nothing: null };
  const back = m.toLocal(edit);
  assert.deepEqual(Object.keys(back.changes), ['file:///c%3A/Users/dev/proj/a.swift']);
  assert.equal(back.n, 5);
  assert.equal(back.nothing, null);
  assert.equal(edit.changes['file:///Users/me/proj/a.swift'].length, 1, 'input must not be mutated');
});

test('pathmap: rejects a non-absolute remote root', () => {
  assert.throws(() => new PathMapper(WIN, 'relative/path'), /absolute POSIX path/);
});

// ------------------------------------------------------- message rewriting
test('outgoing: initialize gets processId=null and Mac URIs', () => {
  const m = new PathMapper(WIN, MAC);
  const out = rewriteOutgoing(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: 4242, rootPath: WIN, rootUri: 'file:///c%3A/Users/dev/proj', workspaceFolders: [{ uri: 'file:///c%3A/Users/dev/proj', name: 'proj' }] } },
    m,
  );
  assert.equal(out.params.processId, null);
  assert.equal(out.params.rootUri, 'file:///Users/me/proj');
  assert.equal(out.params.rootPath, '/Users/me/proj');
  assert.equal(out.params.workspaceFolders[0].uri, 'file:///Users/me/proj');
});

test('outgoing: didOpen fixes the language id by extension and maps the URI', () => {
  const m = new PathMapper(WIN, MAC);
  const open = (uri: string, languageId: string) =>
    rewriteOutgoing({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId, version: 1, text: 'let x = 1' } } }, m).params.textDocument;
  assert.deepEqual([open('file:///c%3A/Users/dev/proj/A.swift', 'plaintext').languageId, open('file:///c%3A/Users/dev/proj/B.m', 'plaintext').languageId], ['swift', 'objective-c']);
  assert.equal(open('file:///c%3A/Users/dev/proj/A.swift', 'plaintext').uri, 'file:///Users/me/proj/A.swift');
  assert.equal(open('file:///c%3A/Users/dev/proj/notes.txt', 'plaintext').languageId, 'plaintext');
});

test('incoming: diagnostics from the Mac point at the Windows file', () => {
  const m = new PathMapper(WIN, MAC);
  const out = rewriteIncoming(
    { method: 'textDocument/publishDiagnostics', params: { uri: 'file:///Users/me/proj/Sources/App.swift', diagnostics: [{ message: "expected '}'", severity: 1, range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } }] } },
    m,
  );
  assert.equal(out.params.uri, 'file:///c%3A/Users/dev/proj/Sources/App.swift');
  assert.equal(out.params.diagnostics[0].message, "expected '}'");
});

// -------------------------------------------------------------- host keys
test('hostkey: trust on first use, accept same key, refuse a changed key, honour pinning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossdock-kh-'));
  try {
    const file = path.join(dir, 'known_hosts.json');
    const keyA = Buffer.from('host-key-A');
    const keyB = Buffer.from('host-key-B');
    const first = checkHostKey(file, 'mac.local', 22, keyA);
    assert.ok(first.ok && first.firstUse);
    const again = checkHostKey(file, 'mac.local', 22, keyA);
    assert.ok(again.ok && !again.firstUse);
    const changed = checkHostKey(file, 'mac.local', 22, keyB);
    assert.ok(!changed.ok);
    assert.match(changed.reason ?? '', /HOST KEY CHANGED/);
    assert.ok(checkHostKey(file, 'other.local', 22, keyB).ok, 'a different host is independent');
    assert.ok(checkHostKey(file, 'x', 22, keyA, first.fingerprint).ok, 'matching pin accepted');
    assert.ok(!checkHostKey(file, 'x', 22, keyB, first.fingerprint).ok, 'mismatched pin refused');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
